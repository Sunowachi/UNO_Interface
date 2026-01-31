import com.sun.net.httpserver.HttpExchange;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public class HttpUtil {

    // ================= КОНСТАНТЫ =================

    static final int MAX_JSON_SIZE = 4096;
    static final int MAX_CONFIG_SIZE = 16 * 1024;
    static final boolean FORCE_SECURE_COOKIE = false;

    // ================= ОБРАБОТКА HTTP-ЗАГОЛОВКОВ =================

    // Применение заголовков безопасности
    static void applySecurityHeaders(HttpExchange ex) {
        ex.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        ex.getResponseHeaders().set("X-Frame-Options", "DENY");
        ex.getResponseHeaders().set("Content-Security-Policy",
                "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'");
    }

    // Отправка JSON-ответа
    public static void sendJson(HttpExchange ex, String json) throws IOException {
        if (ex.getResponseHeaders().containsKey("Content-Type")) {
            Audit.log("-", "DOUBLE_RESPONSE_ATTEMPT", ex.getRemoteAddress().toString());
            return;
        }

        byte[] data = json.getBytes(StandardCharsets.UTF_8);
        applySecurityHeaders(ex);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=UTF-8");
        ex.sendResponseHeaders(200, data.length);

        try (OutputStream os = ex.getResponseBody()) {
            os.write(data);
        }
    }

    // Отправка ошибки
    public static void sendError(HttpExchange ex, int code, String message) {
        try {
            if (ex.getResponseHeaders().containsKey("Content-Type")) return;

            byte[] data = message.getBytes(StandardCharsets.UTF_8);
            applySecurityHeaders(ex);
            ex.getResponseHeaders().set("Content-Type", "text/plain; charset=UTF-8");
            ex.sendResponseHeaders(code, data.length);

            try (OutputStream os = ex.getResponseBody()) {
                os.write(data);
            }
        } catch (IOException e) {
            Audit.log("-", "SEND_ERROR_FAIL", e.getMessage());
        }
    }

    // ================= СЕРИАЛИЗАЦИЯ JSON =================

    // Преобразование объекта в JSON-строку
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

    // Экранирование строк для JSON
    private static String escape(String s) {
        StringBuilder out = new StringBuilder(s.length() + 8);
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"' -> out.append("\\\"");
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

    // ================= ПАРСИНГ JSON =================

    // Парсинг JSON из тела запроса
    static Map<String, String> parseJson(HttpExchange ex) throws IOException {
        try {
            String ct = Optional.ofNullable(ex.getRequestHeaders().getFirst("Content-Type"))
                    .orElse("").toLowerCase();
            if (!ct.contains("application/json")) return Map.of();

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
                if (key.length() > 64 || val.length() > 512) return Map.of();

                map.put(key.substring(1, key.length() - 1), val.substring(1, val.length() - 1));
                if (map.size() > 10) return Map.of();
            }
            return map;
        } catch (Exception e) {
            return Map.of();
        }
    }

    // ================= ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ =================

    // Получение размера тела запроса
    static long getBodySize(HttpExchange ex) {
        String cl = ex.getRequestHeaders().getFirst("Content-Length");
        if (cl == null) return 0;

        try {
            return Long.parseLong(cl);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    // Чтение сырого JSON из запроса
    static String readRawJson(HttpExchange ex, int maxSize) throws IOException {
        String ct = Optional.ofNullable(ex.getRequestHeaders().getFirst("Content-Type"))
                .orElse("").toLowerCase();
        if (!ct.startsWith("application/json")) return null;

        byte[] raw = ex.getRequestBody().readAllBytes();
        if (raw.length == 0 || raw.length > maxSize) return null;

        String json = new String(raw, StandardCharsets.UTF_8).trim();
        if (!json.startsWith("{") || !json.endsWith("}")) return null;
        return json;
    }

    // ================= РАБОТА С КУКАМИ =================

    // Получение куки по имени
    static String getCookie(HttpExchange ex, String name) {
        var cookies = ex.getRequestHeaders().get("Cookie");
        if (cookies == null) return null;

        for (String c : cookies) {
            for (String p : c.split(";")) {
                p = p.trim();
                int eq = p.indexOf('=');
                if (eq == -1) continue;
                String key = p.substring(0, eq);
                String val = p.substring(eq + 1);
                if (name.equals(key)) return val;
            }
        }
        return null;
    }

    // Установка куки
    static void setCookie(HttpExchange ex, String k, String v) {
        boolean https = FORCE_SECURE_COOKIE ||
                "https".equalsIgnoreCase(ex.getRequestHeaders().getFirst("X-Forwarded-Proto"));

        String domainAttr = "";
        String cookieDomain = System.getenv("COOKIE_DOMAIN");
        if (cookieDomain != null && !cookieDomain.isBlank()) {
            domainAttr = "; Domain=" + cookieDomain.trim();
        }

        String sameSite = System.getenv("COOKIE_SAMESITE");
        if (sameSite == null || sameSite.isBlank()) sameSite = "Strict";
        if ("None".equalsIgnoreCase(sameSite) && !https) sameSite = "Strict";

        String cookie = k + "=" + v +
                "; Path=/" + domainAttr +
                "; HttpOnly; SameSite=" + sameSite +
                (https ? "; Secure" : "");

        ex.getResponseHeaders().add("Set-Cookie", cookie);
    }

    // Очистка куки
    static void clearCookie(HttpExchange ex, String k) {
        boolean https = FORCE_SECURE_COOKIE ||
                "https".equalsIgnoreCase(ex.getRequestHeaders().getFirst("X-Forwarded-Proto"));

        String domainAttr = "";
        String cookieDomain = System.getenv("COOKIE_DOMAIN");
        if (cookieDomain != null && !cookieDomain.isBlank()) {
            domainAttr = "; Domain=" + cookieDomain.trim();
        }

        String sameSite = System.getenv("COOKIE_SAMESITE");
        if (sameSite == null || sameSite.isBlank()) sameSite = "Strict";
        if ("None".equalsIgnoreCase(sameSite) && !https) sameSite = "Strict";

        String cookie = k + "=; Path=/; Max-Age=0" +
                domainAttr + "; HttpOnly; SameSite=" + sameSite +
                (https ? "; Secure" : "");

        ex.getResponseHeaders().add("Set-Cookie", cookie);
    }

    // ================= ОБРАБОТКА СТАТИЧЕСКИХ ФАЙЛОВ =================

    // Обработчик статических файлов
    static void handleStatic(HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }

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
        applySecurityHeaders(ex);
        ex.getResponseHeaders().set("Content-Type", getMimeType(name));
        ex.getResponseHeaders().set("Cache-Control",
                name.endsWith(".html") ? "no-store" : "public, max-age=3600");

        ex.sendResponseHeaders(200, data.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(data);
        }
    }

    // Проверка разрешенных типов статических файлов
    static boolean isAllowedStatic(String name) {
        return name.endsWith(".html") || name.endsWith(".js") || name.endsWith(".css") ||
                name.endsWith(".json") || name.endsWith(".svg") || name.endsWith(".png") ||
                name.endsWith(".woff2");
    }

    // Определение MIME-типа по имени файла
    static String getMimeType(String file) {
        if (file.endsWith(".html")) return "text/html; charset=utf-8";
        if (file.endsWith(".js")) return "application/javascript; charset=utf-8";
        if (file.endsWith(".json")) return "application/json; charset=utf-8";
        if (file.endsWith(".css")) return "text/css; charset=utf-8";
        if (file.endsWith(".svg")) return "image/svg+xml";
        if (file.endsWith(".png")) return "image/png";
        if (file.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    // ================= РАБОТА С КОНФИГУРАЦИЕЙ =================

    static final File CONFIG_FILE = new File("web/config.json");

    // Отправка конфигурации
    static void sendConfig(HttpExchange ex) throws IOException {
        if (!CONFIG_FILE.exists()) {
            CONFIG_FILE.getParentFile().mkdirs();
            Files.writeString(CONFIG_FILE.toPath(), "{ \"sensors\": [] }", StandardCharsets.UTF_8);
        }

        String content;
        try {
            content = Files.readString(CONFIG_FILE.toPath(), StandardCharsets.UTF_8).trim();
        } catch (IOException e) {
            Files.writeString(CONFIG_FILE.toPath(), "{ \"sensors\": [] }", StandardCharsets.UTF_8);
            sendJson(ex, "{ \"sensors\": [] }");
            return;
        }

        if (content.isEmpty()) {
            Files.writeString(CONFIG_FILE.toPath(), "{ \"sensors\": [] }", StandardCharsets.UTF_8);
            sendJson(ex, "{ \"sensors\": [] }");
            return;
        }

        boolean ok = false;
        try {
            if (content.startsWith("{")) {
                int idx = content.indexOf("\"sensors\"");
                if (idx != -1) {
                    int arrStart = content.indexOf('[', idx);
                    if (arrStart != -1) ok = true;
                }
            }
        } catch (Exception ignored) {
            ok = false;
        }

        if (!ok) {
            Files.writeString(CONFIG_FILE.toPath(), "{ \"sensors\": [] }", StandardCharsets.UTF_8);
            sendJson(ex, "{ \"sensors\": [] }");
            return;
        }

        sendJson(ex, content);
    }

    // Сохранение конфигурации
    static void saveConfig(HttpExchange ex) throws IOException {
        String json = readRawJson(ex, MAX_CONFIG_SIZE);
        if (json == null) {
            sendError(ex, 400, "invalid_json");
            return;
        }

        Path tmp = Files.createTempFile("config", ".json");
        Files.writeString(tmp, json, StandardCharsets.UTF_8);

        Files.move(tmp, CONFIG_FILE.toPath(),
                StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        sendJson(ex, "{\"status\":\"OK\"}");
    }

    // ================= ОБРАБОТКА ПАРАМЕТРОВ ЗАПРОСА =================

    // Извлечение параметра rangeMs из строки запроса
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