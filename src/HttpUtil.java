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
                "default-src 'self'; " +
                        "script-src 'self'; " +
                        "connect-src 'self'; " +
                        "object-src 'none'"
        );
    }

    /* ========= JSON RESPONSE ========= */

    static void sendJson(HttpExchange ex, String json) throws IOException {
        sendJson(ex, 200, json);
    }

    static void sendJson(HttpExchange ex, int code, String json) throws IOException {
        byte[] b = json.getBytes(StandardCharsets.UTF_8);

        ex.getResponseHeaders().set(
                "Content-Type", "application/json; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-store");

        applySecurityHeaders(ex);

        ex.sendResponseHeaders(code, b.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(b);
        }
    }

    static void sendError(HttpExchange ex, int code, String msg) throws IOException {
        byte[] b = msg.getBytes(StandardCharsets.UTF_8);
        String safe = msg.replaceAll("[^a-zA-Z0-9_]", "");
        sendJson(ex, code, "{\"error\":\"" + safe + "\"}");
        ex.sendResponseHeaders(code, b.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(b);
        }
        ex.close();

    }

    /* ========= JSON SERIALIZATION ========= */

    static String toJson(Object o) {
        StringBuilder sb = new StringBuilder();
        writeJson(sb, o);
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    private static void writeJson(StringBuilder sb, Object o) {

        if (o == null) {
            sb.append("null");
            return;
        }

        if (o instanceof String s) {
            sb.append('"').append(escape(s)).append('"');
            return;
        }

        if (o instanceof Number || o instanceof Boolean) {
            sb.append(o.toString());
            return;
        }

        if (o instanceof Enum<?> e) {
            sb.append('"').append(e.name()).append('"');
            return;
        }

        if (o instanceof Map<?, ?> map) {
            sb.append('{');
            boolean first = true;
            for (var e : map.entrySet()) {
                if (!(e.getKey() instanceof String)) continue;
                if (!first) sb.append(',');
                first = false;
                sb.append('"').append(escape((String) e.getKey())).append("\":");
                writeJson(sb, e.getValue());
            }
            sb.append('}');
            return;
        }

        if (o instanceof Iterable<?> it) {
            sb.append('[');
            boolean first = true;
            for (Object v : it) {
                if (!first) sb.append(',');
                first = false;
                writeJson(sb, v);
            }
            sb.append(']');
            return;
        }
        sb.append('"').append(escape(o.toString())).append('"');
    }

    private static String escape(String s) {
        StringBuilder out = new StringBuilder(s.length() + 8);
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"'  -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 32) out.append('?');
                    else out.append(c);
                }
            }
        }
        return out.toString();
    }

    /* ========= STRICT JSON PARSE (AUTH / KEYS ONLY) ========= */

    static Map<String, String> parseJson(HttpExchange ex) throws IOException {
        try {
            String ct = Optional.ofNullable(
                            ex.getRequestHeaders().getFirst("Content-Type"))
                    .orElse("")
                    .toLowerCase();

            if (!ct.contains("application/json")) {
                return Map.of();
            }

            byte[] raw;
            try {
                raw = ex.getRequestBody().readAllBytes();
            } catch (Exception e) {
                return Map.of();
            }
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
        } catch (Exception e) {
            return Map.of();
        }
    }

    /* ========= BODY SIZE ========= */

    static long getBodySize(HttpExchange ex) {

        String cl = ex.getRequestHeaders().getFirst("Content-Length");
        if (cl == null) return 0;

        try {
            return Long.parseLong(cl);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /* ========= RAW JSON (CONFIG / FUTURE API) ========= */

    static String readRawJson(HttpExchange ex, int maxSize) throws IOException {

        String ct = Optional.ofNullable(
                        ex.getRequestHeaders().getFirst("Content-Type"))
                .orElse("")
                .toLowerCase();

        if (!ct.startsWith("application/json")) return null;

        byte[] raw = ex.getRequestBody().readAllBytes();
        if (raw.length == 0 || raw.length > maxSize) return null;

        String json = new String(raw, StandardCharsets.UTF_8).trim();
        if (!json.startsWith("{") || !json.endsWith("}")) return null;

        return json;
    }

    /* ========= COOKIES ========= */

    static String getCookie(HttpExchange ex, String name) {
        var cookies = ex.getRequestHeaders().get("Cookie");
        if (cookies == null) return null;

        for (String c : cookies) {
            for (String p : c.split(";")) {
                p = p.trim();
                if (p.length() > name.length() + 1 &&
                        p.startsWith(name) &&
                        p.charAt(name.length()) == '=') {
                    return p.substring(name.length() + 1);
                }
            }
        }
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
        ex.getResponseHeaders().set(
                "Cache-Control",
                name.endsWith(".html") ? "no-store" : "public, max-age=3600"
        );

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
                name.endsWith(".json") ||
                name.endsWith(".svg") ||
                name.endsWith(".png") ||
                name.endsWith(".woff2");
    }

    static String getMimeType(String file) {
        if (file.endsWith(".html"))  return "text/html; charset=utf-8";
        if (file.endsWith(".js"))    return "application/javascript; charset=utf-8";
        if (file.endsWith(".json"))  return "application/json; charset=utf-8";
        if (file.endsWith(".css"))   return "text/css; charset=utf-8";
        if (file.endsWith(".svg"))   return "image/svg+xml";
        if (file.endsWith(".png"))   return "image/png";
        if (file.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
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

        String json = readRawJson(ex, MAX_CONFIG_SIZE);
        if (json == null) {
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

        for (String p : q.split("&")) {
            if (p.startsWith("rangeMs=")) {
                try {
                    return Math.max(0, Long.parseLong(p.substring(8)));
                } catch (NumberFormatException ignored) {
                    return 0;
                }
            }
        }
        return 0;
    }
}
