import com.sun.net.httpserver.HttpExchange;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public class HttpUtil {

    /* ========= CONST ========= */

    static final int MAX_JSON_SIZE = 4096;
    static final int MAX_CONFIG_SIZE = 16 * 1024;
    static final boolean FORCE_SECURE_COOKIE = false; // true если всегда HTTPS

    /* ========= COMMON HEADERS ========= */

    static void applySecurityHeaders(HttpExchange ex) {
        ex.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        ex.getResponseHeaders().set("X-Frame-Options", "DENY");
        ex.getResponseHeaders().set(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; object-src 'none'"
        );
    }

    /* ========= JSON ========= */

    static void sendJson(HttpExchange ex, String json) throws IOException {
        byte[] b = json.getBytes(StandardCharsets.UTF_8);

        ex.getResponseHeaders().set(
                "Content-Type", "application/json; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-store");

        applySecurityHeaders(ex);

        ex.sendResponseHeaders(200, b.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(b);
        }
    }

    static void sendError(HttpExchange ex, int code, String msg) throws IOException {
        String safe = msg.replaceAll("[^a-zA-Z0-9_]", "");
        byte[] b = ("{\"error\":\"" + safe + "\"}")
                .getBytes(StandardCharsets.UTF_8);

        ex.getResponseHeaders().set(
                "Content-Type", "application/json; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-store");

        applySecurityHeaders(ex);

        ex.sendResponseHeaders(code, b.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(b);
        }
    }

    /* ========= JSON PARSE (SAFE, FLAT) ========= */

    static Map<String, String> parseJson(HttpExchange ex) throws IOException {

        if (!"application/json".equalsIgnoreCase(
                Optional.ofNullable(ex.getRequestHeaders()
                                .getFirst("Content-Type"))
                        .orElse(""))
        ) {
            return Map.of();
        }

        byte[] raw = ex.getRequestBody().readAllBytes();
        if (raw.length == 0 || raw.length > MAX_JSON_SIZE) return Map.of();

        String json = new String(raw, StandardCharsets.UTF_8).trim();
        if (!json.startsWith("{") || !json.endsWith("}")) return Map.of();

        Map<String, String> map = new HashMap<>();

        json = json.substring(1, json.length() - 1).trim();
        if (json.isEmpty()) return map;

        for (String pair : json.split(",")) {
            String[] kv = pair.split(":", 2);
            if (kv.length != 2) return Map.of();

            String key = kv[0].trim();
            String val = kv[1].trim();

            if (!key.matches("\"[a-zA-Z0-9_]+\"")) return Map.of();
            if (!val.matches("\"[^\"]*\"")) return Map.of();

            map.put(
                    key.substring(1, key.length() - 1),
                    val.substring(1, val.length() - 1)
            );

            if (map.size() > 10) return Map.of();
        }
        return map;
    }

    /* ========= COOKIES ========= */

    static String getCookie(HttpExchange ex, String name) {
        var cookies = ex.getRequestHeaders().get("Cookie");
        if (cookies == null) return null;

        for (String c : cookies)
            for (String p : c.split(";"))
                if (p.trim().startsWith(name + "="))
                    return p.trim().substring(name.length() + 1);

        return null;
    }

    static void setCookie(HttpExchange ex, String k, String v) {

        boolean https = FORCE_SECURE_COOKIE ||
                "https".equalsIgnoreCase(
                        ex.getRequestHeaders().getFirst("X-Forwarded-Proto")
                );

        String cookie = k + "=" + v +
                "; Path=/" +
                "; HttpOnly" +
                "; SameSite=Strict" +
                (https ? "; Secure" : "");

        ex.getResponseHeaders().add("Set-Cookie", cookie);
    }

    static void clearCookie(HttpExchange ex, String k) {
        ex.getResponseHeaders().add(
                "Set-Cookie",
                k + "=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"
        );
    }

    /* ========= STATIC ========= */

    static void handleStatic(HttpExchange ex) throws IOException {

        Path root = Path.of("web").toAbsolutePath().normalize();

        String reqPath = ex.getRequestURI().getPath();
        if (reqPath.contains("..")) {
            ex.sendResponseHeaders(403, -1);
            return;
        }

        Path path = root.resolve(reqPath.substring(1)).normalize();
        if (!path.startsWith(root)) {
            ex.sendResponseHeaders(403, -1);
            return;
        }

        if (Files.isDirectory(path)) {
            path = path.resolve("panel.html");
        }

        if (!Files.exists(path) || Files.isHidden(path)) {
            ex.sendResponseHeaders(404, -1);
            return;
        }

        String name = path.getFileName().toString();
        if (!isAllowedStatic(name)) {
            ex.sendResponseHeaders(403, -1);
            return;
        }

        long size = Files.size(path);
        if (size > 1_000_000) {
            ex.sendResponseHeaders(413, -1);
            return;
        }

        byte[] data = Files.readAllBytes(path);

        ex.getResponseHeaders().set("Content-Type", getMimeType(name));
        ex.getResponseHeaders().set("Cache-Control", "public, max-age=3600");

        applySecurityHeaders(ex);

        ex.sendResponseHeaders(200, data.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(data);
        }
    }

    static boolean isAllowedStatic(String name) {
        return name.endsWith(".html") ||
                name.endsWith(".js") ||
                name.endsWith(".css") ||
                name.endsWith(".json");
    }

    static String getMimeType(String file) {
        if (file.endsWith(".html")) return "text/html; charset=utf-8";
        if (file.endsWith(".js"))   return "application/javascript; charset=utf-8";
        if (file.endsWith(".json")) return "application/json; charset=utf-8";
        if (file.endsWith(".css"))  return "text/css; charset=utf-8";
        return "text/plain; charset=utf-8";
    }

    /* ========= CONFIG ========= */

    static final File CONFIG_FILE = new File("web/config.json");

    static void sendConfig(HttpExchange ex) throws IOException {
        if (!CONFIG_FILE.exists()) {
            CONFIG_FILE.getParentFile().mkdirs();
            Files.writeString(CONFIG_FILE.toPath(), "{ \"sensors\": [] }");
        }
        sendJson(ex, Files.readString(CONFIG_FILE.toPath()));
    }

    static void saveConfig(HttpExchange ex) throws IOException {

        byte[] raw = ex.getRequestBody().readAllBytes();
        if (raw.length == 0 || raw.length > MAX_CONFIG_SIZE) {
            sendError(ex, 413, "config_too_large");
            return;
        }

        String json = new String(raw, StandardCharsets.UTF_8).trim();
        if (!json.startsWith("{") || !json.endsWith("}")) {
            sendError(ex, 400, "invalid_json");
            return;
        }

        Files.writeString(CONFIG_FILE.toPath(), json);
        sendJson(ex, "{\"status\":\"OK\"}");
    }

    /* ========= RANGE ========= */

    static long parseRange(HttpExchange ex) {
        String q = ex.getRequestURI().getQuery();
        if (q == null) return 0;

        for (String p : q.split("&"))
            if (p.startsWith("rangeMs="))
                return Math.max(0, Long.parseLong(p.substring(8)));

        return 0;
    }
}
