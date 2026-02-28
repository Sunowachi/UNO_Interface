import com.sun.net.httpserver.HttpExchange;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.SimpleDateFormat;
import java.util.Date;

/**
 * Утилитарные методы для работы с HTTP: заголовки, JSON, куки, статические файлы, конфигурация.
 */
public class HttpUtil {

    // ==================== КОНСТАНТЫ ====================
    // Максимальный размер принимаемого JSON
    static final int MAX_JSON_SIZE = Config.getInt("http.maxJsonSize", 4096);
    // Максимальный размер конфигурационного файла
    static final int MAX_CONFIG_SIZE = Config.getInt("http.maxConfigSize", 10 * 1024 * 1024);
    // Директория для архивов конфига
    private static final Path CONFIG_ARCHIVE_DIR = Path.of("config_archive");
    // Принудительный Secure-флаг для cookie
    static final boolean FORCE_SECURE_COOKIE = false;

    // ==================== ОБРАБОТКА HTTP-ЗАГОЛОВКОВ ====================

    /** Установка стандартных заголовков безопасности */
    static void applySecurityHeaders(HttpExchange ex) {
        ex.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        ex.getResponseHeaders().set("X-Frame-Options", "DENY");
        ex.getResponseHeaders().set("Content-Security-Policy",
                "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'");
    }

    /** Отправка JSON-ответа клиенту */
    public static void sendJson(HttpExchange ex, String json) throws IOException {
        if (ex.getResponseHeaders().containsKey("Content-Type")) {
            Audit.warn("-", "ПОПЫТКА_ДВОЙНОГО_ОТВЕТА", "Попытка отправить повторный ответ", ex.getRemoteAddress().toString());
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

    /** Отправка текстовой ошибки клиенту */
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
            // Смешная ошибка
            Audit.error("-", "ОШИБКА_ОТПРАВКИ_ОШИБКИ", e.getMessage(), ex.getRemoteAddress().toString());
        }
    }

    // ==================== СЕРИАЛИЗАЦИЯ JSON ====================

    /** Преобразование объекта в JSON-строку */
    static String toJson(Object o) {
        StringBuilder sb = new StringBuilder();
        writeJson(sb, o);
        return sb.toString();
    }

    /** Рекурсивная запись объекта в JSON */
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

    /** Экранирование специальных символов в JSON-строке */
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

    // ==================== ПАРСИНГ JSON ====================

    /** Парсинг JSON-объекта из тела запроса в Map<String, String> */
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

    // ==================== ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ====================

    /** Получение размера тела запроса из заголовка Content-Length */
    static long getBodySize(HttpExchange ex) {
        String cl = ex.getRequestHeaders().getFirst("Content-Length");
        if (cl == null) return 0;
        try {
            return Long.parseLong(cl);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /** Чтение сырого JSON-тела запроса (возвращает строку или null при ошибке) */
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

    // ==================== РАБОТА С КУКИ ====================

    /** Получение значения куки по имени из запроса */
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

    /** Установка куки в ответ */
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

    /** Очистка куки (установка с истекшим сроком) */
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

    // ==================== ОБРАБОТКА СТАТИЧЕСКИХ ФАЙЛОВ ====================

    /** Обработчик запросов к статическим файлам (GET) */
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

        if ("/favicon.ico".equals(reqPath)) {
            Path rootProject = Path.of(".").toAbsolutePath().normalize();
            Path favPath = rootProject.resolve("favicon.ico");
            if (Files.exists(favPath) && !Files.isHidden(favPath) && Files.size(favPath) <= 1_000_000) {
                byte[] data = Files.readAllBytes(favPath);
                applySecurityHeaders(ex);
                ex.getResponseHeaders().set("Content-Type", "image/x-icon");
                ex.getResponseHeaders().set("Cache-Control", "public, max-age=3600");
                ex.sendResponseHeaders(200, data.length);
                try (OutputStream os = ex.getResponseBody()) {
                    os.write(data);
                }
                return;
            } else {
                ex.getResponseHeaders().set("Content-Type", "image/x-icon");
                ex.sendResponseHeaders(204, -1);
                return;
            }
        }

        boolean isMainPage = "/".equals(reqPath) || "/panel.html".equals(reqPath);

        Path path;
        if (isMainPage) {
            path = root.resolve("panel.html");
        } else {
            path = root.resolve(reqPath.substring(1)).normalize();
        }

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

        if (isMainPage) {
            boolean auth = isAuthenticated(ex);
            if (!auth) {
                String html = new String(data, StandardCharsets.UTF_8);
                html = stripUnauthorizedContent(html);
                data = html.getBytes(StandardCharsets.UTF_8);
            }
        }

        applySecurityHeaders(ex);
        ex.getResponseHeaders().set("Content-Type", getMimeType(name));
        ex.getResponseHeaders().set("Cache-Control",
                name.endsWith(".html") ? "no-store" : "public, max-age=3600");

        ex.sendResponseHeaders(200, data.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(data);
        }
    }

    /** Проверка, авторизован ли пользователь */
    private static boolean isAuthenticated(HttpExchange ex) {
        Security.Session s = Security.getSession(ex);
        return s != null && !s.expired();
    }

    /** Удаление элемента с указанным id из HTML-строки */
    private static String removeElementById(String html, String id) {
        String openTagPattern = "<div\\s+[^>]*id=\"" + id + "\"[^>]*>";
        java.util.regex.Pattern p = java.util.regex.Pattern.compile(openTagPattern, java.util.regex.Pattern.CASE_INSENSITIVE);
        java.util.regex.Matcher m = p.matcher(html);
        if (!m.find()) {
            return html;
        }
        int start = m.start();

        int level = 1;
        int pos = m.end();
        while (pos < html.length() && level > 0) {
            int nextOpen = html.indexOf("<div", pos);
            int nextClose = html.indexOf("</div", pos);
            if (nextClose == -1) break;
            if (nextOpen != -1 && nextOpen < nextClose) {
                level++;
                pos = nextOpen + 4;
            } else {
                level--;
                pos = nextClose + 5;
            }
        }
        int end = pos;
        return html.substring(0, start) + html.substring(end);
    }

    /** Удаление из HTML всех элементов с ограниченным доступом */
    private static String stripUnauthorizedContent(String html) {
        html = removeElementById(html, "appRoot");
        html = removeElementById(html, "editModalBackdrop");
        html = removeElementById(html, "cancelConfirmBackdrop");
        html = removeElementById(html, "devicePanel");
        return html;
    }

    /** Проверка, что имя файла имеет разрешённое расширение */
    static boolean isAllowedStatic(String name) {
        return name.endsWith(".html") || name.endsWith(".js") || name.endsWith(".css") ||
                name.endsWith(".json") || name.endsWith(".svg") || name.endsWith(".png") ||
                name.endsWith(".woff2");
    }

    /** Определение MIME-типа по расширению файла */
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

    // ==================== РАБОТА С КОНФИГУРАЦИЕЙ ====================

    static final File CONFIG_FILE = new File("web/config.json");

    /** Отправка конфигурации клиенту (GET /config/load) */
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

    /** Сохранение конфигурации (POST /config/save) */
    static void saveConfig(HttpExchange ex) throws IOException {
        String json = readRawJson(ex, MAX_CONFIG_SIZE);
        String ip = ex.getRemoteAddress().getAddress().getHostAddress();

        if (json == null) {
            sendError(ex, 400, "invalid_json");
            Security.Session s = Security.getSession(ex);
            String user = (s != null) ? s.username : "-";
            Audit.warn(user, "ОШИБКА_СОХРАНЕНИЯ_КОНФИГА", "Получен некорректный JSON", ip);
            return;
        }

        try {
            archiveOldConfig();
        } catch (Exception e) {
            Audit.error("system", "ОШИБКА_АРХИВАЦИИ_КОНФИГА", e.getMessage(), ip);
        }

        Path tmp = Files.createTempFile("config", ".json");
        Files.writeString(tmp, json, StandardCharsets.UTF_8);
        Files.move(tmp, CONFIG_FILE.toPath(),
                StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        sendJson(ex, "{\"status\":\"OK\"}");

        Security.Session s = Security.getSession(ex);
        if (s != null) {
            Audit.info(s.username, "СОХРАНЕНИЕ_КОНФИГА", "Конфигурация успешно сохранена", ip);
        }
    }

    /** Создание директории для архивов, если её нет */
    private static void ensureArchiveDir() throws IOException {
        if (!Files.exists(CONFIG_ARCHIVE_DIR)) {
            Files.createDirectories(CONFIG_ARCHIVE_DIR);
        }
    }

    /** Вычисление SHA-256 хэша файла в формате Base64 */
    private static String computeFileHash(Path path) throws IOException {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] data = Files.readAllBytes(path);
            byte[] hash = md.digest(data);
            return Base64.getEncoder().encodeToString(hash);
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("Алгоритм SHA-256 недоступен", e);
        }
    }

    /** Архивирование текущего конфигурационного файла */
    private static void archiveOldConfig() throws IOException {
        Path configPath = CONFIG_FILE.toPath();
        if (!Files.exists(configPath)) return;

        ensureArchiveDir();
        String hash = computeFileHash(configPath);
        String timestamp = new SimpleDateFormat("yyyyMMdd_HHmmss").format(new Date());
        String archiveName = "config_" + timestamp + "_" + hash + ".json";
        Path archivePath = CONFIG_ARCHIVE_DIR.resolve(archiveName);

        Files.copy(configPath, archivePath, StandardCopyOption.COPY_ATTRIBUTES, StandardCopyOption.REPLACE_EXISTING);
    }

    // ==================== ОБРАБОТКА ПАРАМЕТРОВ ЗАПРОСА ====================

    /** Извлечение параметра rangeMs из строки запроса */
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