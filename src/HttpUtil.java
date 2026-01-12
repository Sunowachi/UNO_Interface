import com.sun.net.httpserver.HttpExchange;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public class HttpUtil {

    /* ========= JSON ========= */

    static void sendJson(HttpExchange ex, String json) throws IOException {
        byte[] b = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set(
                "Content-Type", "application/json; charset=utf-8");

        ex.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        ex.getResponseHeaders().set("X-Frame-Options", "DENY");
        ex.getResponseHeaders().set("Content-Security-Policy", "default-src 'self'");

        ex.sendResponseHeaders(200, b.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(b);
        }
    }

    static void sendError(HttpExchange ex, int code, String msg) throws IOException {
        byte[] b = ("{\"error\":\"" + msg + "\"}")
                .getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set(
                "Content-Type", "application/json; charset=utf-8");

        ex.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        ex.getResponseHeaders().set("X-Frame-Options", "DENY");
        ex.getResponseHeaders().set("Content-Security-Policy", "default-src 'self'");

        ex.sendResponseHeaders(code, b.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(b);
        }
    }

    /* ========= JSON parse ========= */

    static Map<String, String> parseJson(HttpExchange ex) throws IOException {

        String json = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);

        if (json.length() > 2048) return Map.of();

        if (json.contains("\n") || json.contains("\r") || json.contains("\t"))
            return Map.of();

        Map<String, String> map = new HashMap<>();

        json = json.trim();
        if (!json.startsWith("{") || !json.endsWith("}")) return map;

        json = json.substring(1, json.length() - 1);

        for (String pair : json.split(",")) {
            String[] kv = pair.split(":", 2);
            if (kv.length != 2) continue;

            String key = kv[0].trim().replaceAll("^\"|\"$", "");
            String val = kv[1].trim().replaceAll("^\"|\"$", "");
            map.put(key, val);

            if (map.size() > 10) return Map.of();
        }
        return map;
    }

    /* ========= Cookies ========= */

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

        boolean https =
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

    /* ========= Static ========= */

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
        if (name.endsWith(".java") || name.endsWith(".db") ||
                name.endsWith(".log") || name.endsWith(".sqlite")) {
            ex.sendResponseHeaders(403, -1);
            return;
        }

        byte[] data = Files.readAllBytes(path);

        ex.getResponseHeaders().set("Content-Type", getMimeType(name));
        ex.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        ex.getResponseHeaders().set("X-Frame-Options", "DENY");
        ex.getResponseHeaders().set(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; object-src 'none'"
        );

        ex.sendResponseHeaders(200, data.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(data);
        }
    }


    static String getMimeType(String file) {
        if (file.endsWith(".html")) return "text/html; charset=utf-8";
        if (file.endsWith(".js"))   return "application/javascript; charset=utf-8";
        if (file.endsWith(".json")) return "application/json; charset=utf-8";
        if (file.endsWith(".css"))  return "text/css; charset=utf-8";
        return "application/octet-stream";
    }

    /* ========= Config ========= */

    static final File CONFIG_FILE = new File("web/config.json");

    static void sendConfig(HttpExchange ex) throws IOException {
        if (!CONFIG_FILE.exists()) {
            CONFIG_FILE.getParentFile().mkdirs();
            Files.writeString(CONFIG_FILE.toPath(), "{ \"sensors\": [] }");
        }
        sendJson(ex, Files.readString(CONFIG_FILE.toPath()));
    }

    static void saveConfig(HttpExchange ex) throws IOException {
        Files.writeString(
                CONFIG_FILE.toPath(),
                new String(ex.getRequestBody().readAllBytes(),
                        StandardCharsets.UTF_8)
        );
        sendJson(ex, "{\"status\":\"OK\"}");
    }

    /* ========= Range ========= */

    static long parseRange(HttpExchange ex) {
        String q = ex.getRequestURI().getQuery();
        if (q == null) return 0;
        for (String p : q.split("&"))
            if (p.startsWith("rangeMs="))
                return Long.parseLong(p.substring(8));
        return 0;
    }
}