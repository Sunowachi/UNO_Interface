import com.sun.net.httpserver.HttpExchange;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public class HttpUtil {

    // ================= КОНСТАНТЫ =================

    // Максимальный размер JSON, принимаемого от клиента (4 КБ)
    static final int MAX_JSON_SIZE = 4096;
    // Максимальный размер конфигурационного файла (16 КБ)
    static final int MAX_CONFIG_SIZE = 16 * 1024;
    // Флаг принудительного использования Secure-флага для cookie (если true, то всегда Secure)
    static final boolean FORCE_SECURE_COOKIE = false;

    // ================= ОБРАБОТКА HTTP-ЗАГОЛОВКОВ =================

    // Установка заголовков безопасности для ответа
    static void applySecurityHeaders(HttpExchange ex) {
        // Запрет определения типа контента по содержимому (защита от MIME-атак)
        ex.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        // Запрет на встраивание в iframe (защита от clickjacking)
        ex.getResponseHeaders().set("X-Frame-Options", "DENY");
        // Политика безопасности контента: разрешены ресурсы только с того же источника
        ex.getResponseHeaders().set("Content-Security-Policy",
                "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'");
    }

    // Отправка JSON-ответа клиенту
    public static void sendJson(HttpExchange ex, String json) throws IOException {
        // Проверка, не был ли уже отправлен ответ (заголовок Content-Type уже установлен)
        if (ex.getResponseHeaders().containsKey("Content-Type")) {
            // Логируем попытку двойного ответа
            Audit.log("-", "DOUBLE_RESPONSE_ATTEMPT", ex.getRemoteAddress().toString());
            return;
        }

        // Преобразование строки JSON в байты в кодировке UTF-8
        byte[] data = json.getBytes(StandardCharsets.UTF_8);
        // Добавление заголовков безопасности
        applySecurityHeaders(ex);
        // Установка заголовка Content-Type с указанием кодировки
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=UTF-8");
        // Отправка кода ответа 200 OK и длины тела
        ex.sendResponseHeaders(200, data.length);

        // Запись данных в тело ответа и закрытие потока
        try (OutputStream os = ex.getResponseBody()) {
            os.write(data);
        }
    }

    // Отправка ошибки клиенту (текстовое сообщение)
    public static void sendError(HttpExchange ex, int code, String message) {
        try {
            // Проверка, не был ли уже отправлен ответ
            if (ex.getResponseHeaders().containsKey("Content-Type")) return;

            // Преобразование сообщения в байты UTF-8
            byte[] data = message.getBytes(StandardCharsets.UTF_8);
            // Добавление заголовков безопасности
            applySecurityHeaders(ex);
            // Установка Content-Type как обычный текст
            ex.getResponseHeaders().set("Content-Type", "text/plain; charset=UTF-8");
            // Отправка указанного кода ошибки и длины тела
            ex.sendResponseHeaders(code, data.length);

            // Запись данных
            try (OutputStream os = ex.getResponseBody()) {
                os.write(data);
            }
        } catch (IOException e) {
            // В случае ошибки отправки – запись в аудит
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

    // Рекурсивная запись объекта в StringBuilder в формате JSON
    @SuppressWarnings("unchecked")
    private static void writeJson(StringBuilder sb, Object o) {
        if (o == null) {
            sb.append("null");
            return;
        }

        if (o instanceof String s) {
            // Строки заключаются в кавычки с экранированием
            sb.append('"').append(escape(s)).append('"');
            return;
        }

        if (o instanceof Number || o instanceof Boolean) {
            // Числа и булевы значения пишутся как есть
            sb.append(o.toString());
            return;
        }

        if (o instanceof Enum<?> e) {
            // Перечисления пишутся как строки (имя константы)
            sb.append('"').append(e.name()).append('"');
            return;
        }

        if (o instanceof Map<?, ?> map) {
            // Объект JSON: { ключ: значение, ... }
            sb.append('{');
            boolean first = true;
            for (var e : map.entrySet()) {
                // Ключ должен быть строкой, иначе пропускаем
                if (!(e.getKey() instanceof String)) continue;
                if (!first) sb.append(',');
                first = false;
                // Ключ в кавычках с экранированием
                sb.append('"').append(escape((String) e.getKey())).append("\":");
                // Рекурсивно записываем значение
                writeJson(sb, e.getValue());
            }
            sb.append('}');
            return;
        }

        if (o instanceof Iterable<?> it) {
            // Массив JSON: [ значение, ... ]
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

        // Для остальных типов вызываем toString() и экранируем как строку
        sb.append('"').append(escape(o.toString())).append('"');
    }

    // Экранирование специальных символов в JSON-строке
    private static String escape(String s) {
        StringBuilder out = new StringBuilder(s.length() + 8);
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"' -> out.append("\\\""); // экранирование двойной кавычки
                case '\\' -> out.append("\\\\"); // экранирование обратного слеша
                case '\n' -> out.append("\\n");   // перевод строки
                case '\r' -> out.append("\\r");   // возврат каретки
                case '\t' -> out.append("\\t");   // табуляция
                default -> {
                    // Управляющие символы (код < 32) заменяются вопросительным знаком
                    if (c < 32) out.append('?');
                    else out.append(c);
                }
            }
        }
        return out.toString();
    }

    // ================= ПАРСИНГ JSON =================

    // Парсинг JSON-объекта из тела запроса в Map<String, String>
    static Map<String, String> parseJson(HttpExchange ex) throws IOException {
        try {
            // Получение Content-Type (если отсутствует, то пустая строка) и приведение к нижнему регистру
            String ct = Optional.ofNullable(ex.getRequestHeaders().getFirst("Content-Type"))
                    .orElse("").toLowerCase();
            // Если это не JSON, возвращаем пустую карту
            if (!ct.contains("application/json")) return Map.of();

            // Чтение всего тела запроса в массив байт
            byte[] raw = ex.getRequestBody().readAllBytes();
            // Если тело пустое или превышает максимальный размер – возвращаем пустую карту
            if (raw.length == 0 || raw.length > MAX_JSON_SIZE) return Map.of();

            // Преобразование байт в строку UTF-8 и удаление пробелов по краям
            String json = new String(raw, StandardCharsets.UTF_8).trim();
            // Проверка, что это объект в фигурных скобках
            if (!json.startsWith("{") || !json.endsWith("}")) return Map.of();

            // Создание карты для результатов
            Map<String, String> map = new HashMap<>();
            // Удаление внешних скобок и пробелов
            json = json.substring(1, json.length() - 1).trim();
            // Если строка пустая, возвращаем пустую карту
            if (json.isEmpty()) return map;

            // Разделение строки на пары ключ:значение по запятым
            for (String pair : json.split(",")) {
                // Разделение пары на ключ и значение (максимум 2 части)
                String[] kv = pair.split(":", 2);
                if (kv.length != 2) return Map.of(); // неверный формат

                String key = kv[0].trim();
                String val = kv[1].trim();
                // Проверка, что ключ заключён в двойные кавычки и содержит только буквы, цифры, подчёркивание
                if (!key.matches("\"[a-zA-Z0-9_]+\"")) return Map.of();
                // Проверка, что значение заключено в двойные кавычки (строковое)
                if (!val.matches("\"[^\"]*\"")) return Map.of();
                // Проверка длины ключа и значения
                if (key.length() > 64 || val.length() > 512) return Map.of();

                // Добавление в карту, удаляя внешние кавычки
                map.put(key.substring(1, key.length() - 1), val.substring(1, val.length() - 1));
                // Ограничение на количество полей в объекте (не более 10)
                if (map.size() > 10) return Map.of();
            }
            return map;
        } catch (Exception e) {
            // В случае любой ошибки возвращаем пустую карту
            return Map.of();
        }
    }

    // ================= ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ =================

    // Получение размера тела запроса из заголовка Content-Length
    static long getBodySize(HttpExchange ex) {
        String cl = ex.getRequestHeaders().getFirst("Content-Length");
        if (cl == null) return 0;

        try {
            return Long.parseLong(cl);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    // Чтение сырого JSON-тела запроса (возвращает строку или null при ошибке)
    static String readRawJson(HttpExchange ex, int maxSize) throws IOException {
        // Проверка Content-Type
        String ct = Optional.ofNullable(ex.getRequestHeaders().getFirst("Content-Type"))
                .orElse("").toLowerCase();
        if (!ct.startsWith("application/json")) return null;

        // Чтение тела
        byte[] raw = ex.getRequestBody().readAllBytes();
        if (raw.length == 0 || raw.length > maxSize) return null;

        // Преобразование в строку
        String json = new String(raw, StandardCharsets.UTF_8).trim();
        // Проверка, что это объект
        if (!json.startsWith("{") || !json.endsWith("}")) return null;
        return json;
    }

    // ================= РАБОТА С КУКАМИ =================

    // Получение значения куки по имени из запроса
    static String getCookie(HttpExchange ex, String name) {
        // Получение списка заголовков Cookie
        var cookies = ex.getRequestHeaders().get("Cookie");
        if (cookies == null) return null;

        // Проход по всем строкам Cookie
        for (String c : cookies) {
            // Разделение по точке с запятой (отдельные куки)
            for (String p : c.split(";")) {
                p = p.trim();
                int eq = p.indexOf('=');
                if (eq == -1) continue; // нет знака равенства – пропускаем
                String key = p.substring(0, eq);
                String val = p.substring(eq + 1);
                if (name.equals(key)) return val;
            }
        }
        return null;
    }

    // Установка куки в ответ
    static void setCookie(HttpExchange ex, String k, String v) {
        // Определение, нужно ли использовать Secure-флаг
        boolean https = FORCE_SECURE_COOKIE ||
                "https".equalsIgnoreCase(ex.getRequestHeaders().getFirst("X-Forwarded-Proto"));

        // Атрибут Domain (если задан через переменную окружения)
        String domainAttr = "";
        String cookieDomain = System.getenv("COOKIE_DOMAIN");
        if (cookieDomain != null && !cookieDomain.isBlank()) {
            domainAttr = "; Domain=" + cookieDomain.trim();
        }

        // Атрибут SameSite (из переменной окружения или по умолчанию Strict)
        String sameSite = System.getenv("COOKIE_SAMESITE");
        if (sameSite == null || sameSite.isBlank()) sameSite = "Strict";
        // Если SameSite=None, но нет HTTPS – принудительно меняем на Strict (браузеры требуют Secure для None)
        if ("None".equalsIgnoreCase(sameSite) && !https) sameSite = "Strict";

        // Формирование строки куки
        String cookie = k + "=" + v +
                "; Path=/" + domainAttr +
                "; HttpOnly; SameSite=" + sameSite +
                (https ? "; Secure" : "");

        // Добавление заголовка Set-Cookie
        ex.getResponseHeaders().add("Set-Cookie", cookie);
    }

    // Очистка куки (установка с истекшим сроком действия)
    static void clearCookie(HttpExchange ex, String k) {
        // Аналогично setCookie, но с Max-Age=0 и пустым значением
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

        // Max-Age=0 указывает браузеру удалить куку
        String cookie = k + "=; Path=/; Max-Age=0" +
                domainAttr + "; HttpOnly; SameSite=" + sameSite +
                (https ? "; Secure" : "");

        ex.getResponseHeaders().add("Set-Cookie", cookie);
    }

    // ================= ОБРАБОТКА СТАТИЧЕСКИХ ФАЙЛОВ =================

    // Обработчик запросов к статическим файлам (GET)
    static void handleStatic(HttpExchange ex) throws IOException {
        // Разрешён только GET
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1); // 405 Method Not Allowed
            return;
        }

        // Корневая директория для статики (папка "web" в текущем рабочем каталоге)
        Path root = Path.of("web").toAbsolutePath().normalize();
        // Путь из URL (начинается с /)
        String reqPath = ex.getRequestURI().getPath();

        // Защита от path traversal (обход каталогов через ..)
        if (reqPath.contains("..")) {
            ex.sendResponseHeaders(403, -1); // 403 Forbidden
            return;
        }

        // Полный путь к запрошенному файлу, убираем первый символ '/'
        Path path = root.resolve(reqPath.substring(1)).normalize();
        // Проверка, что путь не выходит за пределы корневой папки
        if (!path.startsWith(root)) {
            ex.sendResponseHeaders(403, -1);
            return;
        }

        // Если путь указывает на директорию, добавляем panel.html (как индексный файл)
        if (Files.isDirectory(path)) {
            path = path.resolve("panel.html");
        }

        // Если файл не существует или скрытый – 404 Not Found
        if (!Files.exists(path) || Files.isHidden(path)) {
            ex.sendResponseHeaders(404, -1);
            return;
        }

        // Имя файла
        String name = path.getFileName().toString();
        // Проверка, что тип файла разрешён для отдачи
        if (!isAllowedStatic(name)) {
            ex.sendResponseHeaders(403, -1);
            return;
        }

        // Проверка размера файла (не более 1 МБ)
        long size = Files.size(path);
        if (size > 1_000_000) {
            ex.sendResponseHeaders(413, -1); // 413 Payload Too Large
            return;
        }

        // Чтение всего файла в память
        byte[] data = Files.readAllBytes(path);
        // Добавление заголовков безопасности
        applySecurityHeaders(ex);
        // Установка MIME-типа
        ex.getResponseHeaders().set("Content-Type", getMimeType(name));
        // Кэширование: HTML не кэшируется, остальное – 1 час
        ex.getResponseHeaders().set("Cache-Control",
                name.endsWith(".html") ? "no-store" : "public, max-age=3600");

        // Отправка ответа
        ex.sendResponseHeaders(200, data.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(data);
        }
    }

    // Проверка, что имя файла имеет разрешённое расширение
    static boolean isAllowedStatic(String name) {
        return name.endsWith(".html") || name.endsWith(".js") || name.endsWith(".css") ||
                name.endsWith(".json") || name.endsWith(".svg") || name.endsWith(".png") ||
                name.endsWith(".woff2");
    }

    // Определение MIME-типа по расширению файла
    static String getMimeType(String file) {
        if (file.endsWith(".html")) return "text/html; charset=utf-8";
        if (file.endsWith(".js")) return "application/javascript; charset=utf-8";
        if (file.endsWith(".json")) return "application/json; charset=utf-8";
        if (file.endsWith(".css")) return "text/css; charset=utf-8";
        if (file.endsWith(".svg")) return "image/svg+xml";
        if (file.endsWith(".png")) return "image/png";
        if (file.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream"; // по умолчанию бинарный поток
    }

    // ================= РАБОТА С КОНФИГУРАЦИЕЙ =================

    // Файл конфигурации (расположен в web/config.json)
    static final File CONFIG_FILE = new File("web/config.json");

    // Отправка конфигурации клиенту (GET /config/load)
    static void sendConfig(HttpExchange ex) throws IOException {
        // Если файл конфигурации не существует, создаём его с пустым массивом датчиков
        if (!CONFIG_FILE.exists()) {
            CONFIG_FILE.getParentFile().mkdirs(); // создаём родительские директории
            Files.writeString(CONFIG_FILE.toPath(), "{ \"sensors\": [] }", StandardCharsets.UTF_8);
        }

        String content;
        try {
            // Чтение содержимого файла
            content = Files.readString(CONFIG_FILE.toPath(), StandardCharsets.UTF_8).trim();
        } catch (IOException e) {
            // При ошибке чтения перезаписываем файл и отдаём пустой JSON
            Files.writeString(CONFIG_FILE.toPath(), "{ \"sensors\": [] }", StandardCharsets.UTF_8);
            sendJson(ex, "{ \"sensors\": [] }");
            return;
        }

        // Если файл пустой, перезаписываем и отдаём пустой JSON
        if (content.isEmpty()) {
            Files.writeString(CONFIG_FILE.toPath(), "{ \"sensors\": [] }", StandardCharsets.UTF_8);
            sendJson(ex, "{ \"sensors\": [] }");
            return;
        }

        // Простейшая проверка, что конфиг содержит объект с ключом "sensors" и массивом
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

        // Если проверка не пройдена, восстанавливаем файл и отдаём пустой JSON
        if (!ok) {
            Files.writeString(CONFIG_FILE.toPath(), "{ \"sensors\": [] }", StandardCharsets.UTF_8);
            sendJson(ex, "{ \"sensors\": [] }");
            return;
        }

        // Отправка содержимого файла как JSON
        sendJson(ex, content);
    }

    // Сохранение конфигурации (POST /config/save)
    static void saveConfig(HttpExchange ex) throws IOException {
        // Чтение сырого JSON из тела запроса (с ограничением MAX_CONFIG_SIZE)
        String json = readRawJson(ex, MAX_CONFIG_SIZE);
        if (json == null) {
            sendError(ex, 400, "invalid_json");
            return;
        }

        // Создание временного файла
        Path tmp = Files.createTempFile("config", ".json");
        // Запись JSON во временный файл
        Files.writeString(tmp, json, StandardCharsets.UTF_8);

        // Атомарное перемещение временного файла на место основного (замена существующего)
        Files.move(tmp, CONFIG_FILE.toPath(),
                StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        // Отправка подтверждения
        sendJson(ex, "{\"status\":\"OK\"}");
    }

    // ================= ОБРАБОТКА ПАРАМЕТРОВ ЗАПРОСА =================

    // Извлечение параметра rangeMs из строки запроса (например, ?rangeMs=60000)
    static long parseRange(HttpExchange ex) {
        String q = ex.getRequestURI().getQuery();
        if (q == null) return 0;

        // Разделяем параметры по &
        for (String p : q.split("&")) {
            if (p.startsWith("rangeMs=")) {
                try {
                    // Парсим число, не допуская отрицательных значений
                    return Math.max(0, Long.parseLong(p.substring(8)));
                } catch (NumberFormatException ignored) {
                    return 0;
                }
            }
        }
        return 0;
    }
}