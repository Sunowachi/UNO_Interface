import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.*;
import java.util.HashMap;
import java.util.Map;

/**
 * Основной класс HTTP-сервера. Регистрирует обработчики и управляет жизненным циклом.
 */
public class Web {

    // ==================== КОНФИГУРАЦИЯ ====================
    private static final int PORT = 8181;                         // Порт сервера
    private static final int MAX_BODY_SIZE = 64 * 1024;           // Максимальный размер тела запроса (64 КБ)
    private static final ExecutorService sensorExecutor = Executors.newFixedThreadPool(50); // Пул для асинхронной обработки данных датчиков
    public static final long SERVER_START = System.currentTimeMillis(); // Время запуска сервера

    // ==================== ТОЧКА ВХОДА ====================
    public static void main(String[] args) throws IOException {
        Database.init();
        Security.ensureDefaultDeveloper();
        DataStore.warmupCacheFromDb();
        DataStore.startDbWriter();

        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 50);

        // Регистрация обработчиков
        server.createContext("/data", Web::handleData);                 // Приём данных от датчиков
        server.createContext("/init", Web::handleInit);                 // Инициализация клиента
        server.createContext("/sensors", Web::handleSensors);           // Список датчиков
        server.createContext("/sensor/register", Web::handleSensorRegister); // Регистрация датчика
        server.createContext("/config/load", Web::handleConfigLoad);    // Загрузка конфигурации
        server.createContext("/config/save", Web::handleConfigSave);    // Сохранение конфигурации
        server.createContext("/auth/login", Web::handleLogin);          // Вход
        server.createContext("/auth/logout", Web::handleLogout);        // Выход
        server.createContext("/auth/me", Web::handleAuthMe);            // Информация о текущем пользователе
        server.createContext("/auth/ping", Web::handleAuthPing);        // Проверка сессии
        server.createContext("/", Web::handleStatic);                   // Статические файлы
        server.createContext("/export/comtrade", Web::handleExportComtrade); // Экспорт COMTRADE
        server.createContext("/api/alert", Web::handleAlert);           // Сохранение тревоги
        server.createContext("/admin/sensors", Web::handleAdminSensors); // Управление датчиками (админ)
        server.createContext("/admin/sensor/register", Web::handleAdminSensorRegister); // Регистрация датчика админом
        server.createContext("/admin/sensor/toggle-delete", Web::handleAdminSensorToggleDelete); // Мягкое удаление
        server.createContext("/admin/sensor/delete-permanent", Web::handleAdminSensorDeletePermanent); // Полное удаление
        server.createContext("/admin/users", Web::handleAdminUsers);    // Список пользователей
        server.createContext("/admin/user/create", Web::handleAdminUserCreate); // Создание пользователя
        server.createContext("/admin/user/delete", Web::handleAdminUserDelete); // Удаление пользователя

        server.setExecutor(Executors.newFixedThreadPool(100));
        server.start();
        System.out.println("✅ Сервер запущен: http://localhost:" + PORT);

        ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
        scheduler.scheduleAtFixedRate(DataStore::cleanupCache, 1, 1, TimeUnit.MINUTES);

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            System.out.println("⏹ Завершение работы сервера...");
            try {
                scheduler.shutdownNow();
                server.stop(1);
                sensorExecutor.shutdownNow();
            } catch (Exception ignored) {}
            try {
                Thread.sleep(1500);
            } catch (InterruptedException ignored) {}
            System.out.println("✔ Сервер остановлен!");
        }));
    }

    // ==================== ОБРАБОТЧИКИ ЗАПРОСОВ ====================

    /** GET /init – возвращает время старта и данные датчиков */
    static void handleInit(HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }

        Security.Session s = Security.getSession(ex);
        if (s == null) {
            HttpUtil.sendError(ex, 401, "unauthorized");
            return;
        }

        if (!Security.require(s, ex, Security.Permission.VIEW_DATA)) return;

        long rangeMs = HttpUtil.parseRange(ex);
        HttpUtil.sendJson(ex, "{\"startTime\":" + SERVER_START +
                ",\"sensors\":" + DataStore.buildSensorsJson(rangeMs) + "}");
    }

    /** POST /data – приём показаний от датчиков */
    static void handleData(HttpExchange ex) throws IOException {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }

        String ct = ex.getRequestHeaders().getFirst("Content-Type");
        if (ct == null || !ct.startsWith("application/json")) {
            HttpUtil.sendError(ex, 415, "unsupported_media_type");
            return;
        }

        if (HttpUtil.getBodySize(ex) > MAX_BODY_SIZE) {
            HttpUtil.sendError(ex, 413, "payload_too_large");
            return;
        }

        String sensorId = ex.getRequestHeaders().getFirst("X-Sensor-Id");
        String token = ex.getRequestHeaders().getFirst("X-Sensor-Token");

        if (!Security.validateSensorToken(sensorId, token, ex.getRemoteAddress())) {
            HttpUtil.sendError(ex, 401, "invalid_sensor");
            return;
        }

        final byte[] body;
        try {
            body = ex.getRequestBody().readAllBytes();
        } catch (Exception e) {
            HttpUtil.sendError(ex, 400, "bad_payload");
            return;
        }

        HttpUtil.sendJson(ex, "{\"status\":\"ok\"}");
        sensorExecutor.submit(() -> {
            try {
                DataStore.handleSensorPost(body, sensorId);
            } catch (Exception e) {
                Audit.error(sensorId, "ОШИБКА_POST_ДАТЧИКА", e.getMessage(), "-");
            }
        });
    }

    /** GET /sensors – список датчиков с их статусами */
    static void handleSensors(HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }

        Security.Session s = Security.getSession(ex);
        if (s == null) {
            HttpUtil.sendError(ex, 401, "unauthorized");
            return;
        }

        if (!Security.require(s, ex, Security.Permission.VIEW_DATA)) return;
        HttpUtil.sendJson(ex, HttpUtil.toJson(DataStore.listSensors()));
    }

    /** POST /sensor/register – регистрация нового датчика */
    static void handleSensorRegister(HttpExchange ex) throws IOException {
        try {
            if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(405, -1);
                return;
            }

            String ct = ex.getRequestHeaders().getFirst("Content-Type");
            if (ct == null || !ct.startsWith("application/json")) {
                HttpUtil.sendError(ex, 415, "unsupported_media_type");
                return;
            }

            var json = HttpUtil.parseJson(ex);
            String sensorId = json.get("sensorId");
            String key = json.get("key");

            if (sensorId != null) sensorId = sensorId.trim();
            if (key != null) key = key.trim();

            if (sensorId == null || key == null) {
                HttpUtil.sendError(ex, 400, "bad_request");
                return;
            }

            String ip = ex.getRemoteAddress().getAddress().getHostAddress();

            if (!sensorId.matches("[a-zA-Z0-9_-]{3,64}")) {
                HttpUtil.sendError(ex, 400, "invalid_sensor_id");
                Audit.warn(sensorId, "ОШИБКА_ВАЛИДАЦИИ_ДАТЧИКА", "Неверный формат ID датчика", ip);
                return;
            }

            if (!Security.checkSensorRegisterKey(key)) {
                HttpUtil.sendError(ex, 403, "forbidden");
                Audit.warn(sensorId, "ОШИБКА_КЛЮЧА_РЕГИСТРАЦИИ", "Неверный ключ регистрации", ip);
                return;
            }

            String token = Security.registerSensor(sensorId, ip);

            if (token == null) {
                HttpUtil.sendError(ex, 409, "already_registered");
                Audit.warn(sensorId, "ОШИБКА_РЕГИСТРАЦИИ_ДАТЧИКА", "Датчик уже зарегистрирован", ip);
                return;
            }

            Audit.info(sensorId, "РЕГИСТРАЦИЯ_ДАТЧИКА", "Датчик успешно зарегистрирован", ip);
            HttpUtil.sendJson(ex, "{\"token\":\"" + token + "\"}");
        } catch (Exception e) {
            HttpUtil.sendError(ex, 500, "internal_error");
        }
    }

    /** GET /export/comtrade – экспорт данных в формате COMTRADE */
    static void handleExportComtrade(HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }

        Security.Session s = Security.getSession(ex);
        if (s == null) {
            HttpUtil.sendError(ex, 401, "unauthorized");
            return;
        }
        if (!Security.require(s, ex, Security.Permission.VIEW_DATA)) return;

        String query = ex.getRequestURI().getQuery();
        Map<String, String> params = parseQuery(query);
        String sensorId = params.get("sensor");
        String varName = params.get("var");
        String fromStr = params.get("from");
        String toStr = params.get("to");
        String version = params.get("version");

        if (sensorId == null || varName == null || fromStr == null || toStr == null) {
            HttpUtil.sendError(ex, 400, "missing parameters: sensor, var, from, to");
            return;
        }

        long fromTs, toTs;
        try {
            fromTs = Long.parseLong(fromStr);
            toTs = Long.parseLong(toStr);
        } catch (NumberFormatException e) {
            HttpUtil.sendError(ex, 400, "invalid timestamp");
            return;
        }

        if (fromTs > toTs || toTs - fromTs > 7L * 24 * 60 * 60 * 1000) {
            HttpUtil.sendError(ex, 400, "invalid time range (max 7 days)");
            return;
        }

        List<DataStore.Point> points = DataStore.getPointsFromDb(sensorId, varName, fromTs, toTs);
        if (points.isEmpty()) {
            HttpUtil.sendError(ex, 404, "no data found");
            Audit.warn(sensorId, "ОШИБКА_ЭКСПОРТА_COMTRADE", "Нет данных для " + varName, s.username);
            return;
        }
        if (points.size() < 2) {
            HttpUtil.sendError(ex, 400, "need at least two data points for COMTRADE export");
            return;
        }

        byte[] fileData;
        String contentType;
        String extension;

        if ("2013".equals(version)) {
            fileData = ComtradeExporter.generateCff2013(sensorId, varName, points, fromTs, toTs);
            contentType = "application/octet-stream";
            extension = ".cff";
        } else {
            fileData = ComtradeExporter.generateZip1999(sensorId, varName, points, fromTs, toTs);
            contentType = "application/zip";
            extension = ".zip";
        }

        HttpUtil.applySecurityHeaders(ex);
        ex.getResponseHeaders().set("Content-Type", contentType);
        ex.getResponseHeaders().set("Content-Disposition",
                "attachment; filename=\"" + sensorId + "_" + varName + extension + "\"");
        ex.sendResponseHeaders(200, fileData.length);
        Audit.info(sensorId, "ЭКСПОРТ_COMTRADE", "Экспортирован " + varName + " с " + fromTs + " по " + toTs, s.username);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(fileData);
        }
    }

    /** POST /api/alert – сохранение тревоги, отправленной клиентом */
    static void handleAlert(HttpExchange ex) throws IOException {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }

        Security.Session s = Security.getSession(ex);
        if (s == null) {
            HttpUtil.sendError(ex, 401, "unauthorized");
            return;
        }
        if (!Security.checkCsrf(ex, s)) return;

        String ct = ex.getRequestHeaders().getFirst("Content-Type");
        if (ct == null || !ct.startsWith("application/json")) {
            HttpUtil.sendError(ex, 415, "unsupported_media_type");
            return;
        }

        byte[] body = ex.getRequestBody().readAllBytes();
        if (body.length == 0 || body.length > 64 * 1024) {
            HttpUtil.sendError(ex, 400, "bad_request");
            return;
        }

        String json = new String(body, StandardCharsets.UTF_8).trim();
        if (!json.startsWith("{") || !json.endsWith("}")) {
            HttpUtil.sendError(ex, 400, "bad_request");
            return;
        }
        json = json.substring(1, json.length() - 1).trim();
        Map<String, String> fields = new HashMap<>();
        for (String pair : json.split(",")) {
            String[] kv = pair.split(":", 2);
            if (kv.length != 2) continue;
            String key = kv[0].trim();
            String val = kv[1].trim();
            if (key.startsWith("\"") && key.endsWith("\"")) key = key.substring(1, key.length()-1);
            if (val.startsWith("\"") && val.endsWith("\"")) val = val.substring(1, val.length()-1);
            fields.put(key, val);
        }

        String sensorId = fields.get("sensorId");
        String varName = fields.get("varName");
        String valueStr = fields.get("value");
        String snapshotBase64 = fields.get("snapshotBase64");

        if (sensorId == null || varName == null || valueStr == null) {
            HttpUtil.sendError(ex, 400, "missing fields");
            return;
        }

        double value;
        try {
            value = Double.parseDouble(valueStr);
        } catch (NumberFormatException e) {
            HttpUtil.sendError(ex, 400, "invalid value");
            return;
        }

        String snapshot;
        try {
            byte[] decoded = Base64.getDecoder().decode(snapshotBase64);
            snapshot = new String(decoded, StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            HttpUtil.sendError(ex, 400, "invalid base64");
            return;
        }

        List<String> users = Security.getActiveUsers();
        String usersStr = String.join(", ", users);

        Database.recordAlert(sensorId, varName, value, usersStr, snapshot);

        HttpUtil.sendJson(ex, "{\"status\":\"ok\"}");
    }

    // ==================== АДМИНИСТРИРОВАНИЕ ДАТЧИКОВ ====================

    /** GET /admin/sensors – список всех датчиков с токенами (для админки) */
    static void handleAdminSensors(HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }
        Security.Session s = Security.getSession(ex);
        if (s == null || !Security.require(s, ex, Security.Permission.MANAGE_SENSORS)) return;

        ex.getResponseHeaders().set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
        ex.getResponseHeaders().set("Pragma", "no-cache");
        ex.getResponseHeaders().set("Expires", "0");

        List<Map<String, Object>> sensors = Database.listSensors();
        HttpUtil.sendJson(ex, HttpUtil.toJson(sensors));
    }

    /** POST /admin/sensor/register – регистрация датчика администратором */
    static void handleAdminSensorRegister(HttpExchange ex) throws IOException {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }
        Security.Session s = Security.getSession(ex);
        if (s == null || !Security.require(s, ex, Security.Permission.MANAGE_SENSORS)) return;
        if (!Security.checkCsrf(ex, s)) return;

        Map<String, String> data = HttpUtil.parseJson(ex);
        String sensorId = data.get("sensorId");
        if (sensorId == null || !sensorId.matches("[a-zA-Z0-9_-]{3,64}")) {
            HttpUtil.sendError(ex, 400, "invalid_sensor_id");
            return;
        }

        String ip = ex.getRemoteAddress().getAddress().getHostAddress();
        String token = Database.registerSensorByAdmin(sensorId, ip);
        if (token == null) {
            HttpUtil.sendError(ex, 409, "already_exists");
            return;
        }

        Map<String, String> resp = new HashMap<>();
        resp.put("token", token);
        HttpUtil.sendJson(ex, HttpUtil.toJson(resp));
    }

    /** POST /admin/sensor/toggle-delete – мягкое удаление / восстановление датчика */
    static void handleAdminSensorToggleDelete(HttpExchange ex) throws IOException {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }
        Security.Session s = Security.getSession(ex);
        if (s == null || !Security.require(s, ex, Security.Permission.MANAGE_SENSORS)) return;
        if (!Security.checkCsrf(ex, s)) return;

        Map<String, String> data = HttpUtil.parseJson(ex);
        String sensorId = data.get("sensorId");
        String deletedStr = data.get("deleted");
        if (sensorId == null || deletedStr == null) {
            HttpUtil.sendError(ex, 400, "missing_params");
            return;
        }
        boolean deleted = Boolean.parseBoolean(deletedStr);
        boolean ok = Database.toggleDeleteSensor(sensorId, deleted);
        if (!ok) {
            HttpUtil.sendError(ex, 404, "sensor_not_found");
            return;
        }
        HttpUtil.sendJson(ex, "{\"status\":\"ok\"}");
    }

    /** POST /admin/sensor/delete-permanent – полное удаление датчика */
    static void handleAdminSensorDeletePermanent(HttpExchange ex) throws IOException {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }
        Security.Session s = Security.getSession(ex);
        if (s == null || !Security.require(s, ex, Security.Permission.MANAGE_SENSORS)) return;
        if (!Security.checkCsrf(ex, s)) return;

        Map<String, String> data = HttpUtil.parseJson(ex);
        String sensorId = data.get("sensorId");
        if (sensorId == null) {
            HttpUtil.sendError(ex, 400, "missing_sensor_id");
            return;
        }
        boolean ok = Database.permanentDeleteSensor(sensorId);
        if (!ok) {
            HttpUtil.sendError(ex, 404, "sensor_not_found");
            return;
        }
        HttpUtil.sendJson(ex, "{\"status\":\"ok\"}");
    }

    /** Разбор query-строки в Map */
    private static Map<String, String> parseQuery(String query) {
        Map<String, String> map = new HashMap<>();
        if (query == null) return map;
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq > 0) {
                map.put(pair.substring(0, eq), pair.substring(eq + 1));
            }
        }
        return map;
    }

    // ==================== УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯМИ ====================

    /** GET /admin/users – список всех пользователей */
    static void handleAdminUsers(HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }
        Security.Session s = Security.getSession(ex);
        if (s == null || !Security.require(s, ex, Security.Permission.MANAGE_USERS)) return;

        ex.getResponseHeaders().set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
        ex.getResponseHeaders().set("Pragma", "no-cache");
        ex.getResponseHeaders().set("Expires", "0");

        List<Map<String, Object>> users = Database.listUsers();
        HttpUtil.sendJson(ex, HttpUtil.toJson(users));
    }

    /** POST /admin/user/create – создание нового пользователя */
    static void handleAdminUserCreate(HttpExchange ex) throws IOException {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }
        Security.Session s = Security.getSession(ex);
        if (s == null || !Security.require(s, ex, Security.Permission.MANAGE_USERS)) return;
        if (!Security.checkCsrf(ex, s)) return;

        Map<String, String> data = HttpUtil.parseJson(ex);
        String username = data.get("username");
        String role = data.get("role");
        if (username == null || role == null) {
            HttpUtil.sendError(ex, 400, "missing_params");
            return;
        }
        if (!username.matches("[a-zA-Z0-9_]{3,64}")) {
            HttpUtil.sendError(ex, 400, "invalid_username");
            return;
        }
        if (!List.of("developer", "admin", "observer", "worker").contains(role)) {
            HttpUtil.sendError(ex, 400, "invalid_role");
            return;
        }

        if ("developer".equals(role) && !"developer".equals(s.role)) {
            HttpUtil.sendError(ex, 403, "only_developer_can_create_developer");
            return;
        }

        String password = Database.createUser(username, role);
        if (password == null) {
            HttpUtil.sendError(ex, 409, "user_already_exists");
            return;
        }

        Map<String, String> resp = new HashMap<>();
        resp.put("username", username);
        resp.put("password", password);
        HttpUtil.sendJson(ex, HttpUtil.toJson(resp));
    }

    /** POST /admin/user/delete – удаление пользователя */
    static void handleAdminUserDelete(HttpExchange ex) throws IOException {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }
        Security.Session s = Security.getSession(ex);
        if (s == null || !Security.require(s, ex, Security.Permission.MANAGE_USERS)) return;
        if (!Security.checkCsrf(ex, s)) return;

        Map<String, String> data = HttpUtil.parseJson(ex);
        String username = data.get("username");
        if (username == null) {
            HttpUtil.sendError(ex, 400, "missing_username");
            return;
        }

        if (username.equals(s.username)) {
            HttpUtil.sendError(ex, 403, "cannot_delete_self");
            return;
        }

        Database.User userToDelete = Database.findUser(username);
        if (userToDelete != null && "developer".equals(userToDelete.role) && !"developer".equals(s.role)) {
            HttpUtil.sendError(ex, 403, "cannot_delete_developer");
            return;
        }

        boolean ok = Database.deleteUser(username);
        if (!ok) {
            HttpUtil.sendError(ex, 404, "user_not_found");
            return;
        }
        HttpUtil.sendJson(ex, "{\"status\":\"ok\"}");
    }

    // ==================== ПРОКСИ-ОБРАБОТЧИКИ ====================
    // Делегируют выполнение соответствующим методам Security

    static void handleLogin(HttpExchange ex) throws IOException {
        Security.handleLogin(ex);
    }

    static void handleLogout(HttpExchange ex) throws IOException {
        Security.handleLogout(ex);
    }

    static void handleAuthMe(HttpExchange ex) throws IOException {
        Security.handleAuthMe(ex);
    }

    static void handleAuthPing(HttpExchange ex) throws IOException {
        Security.handleAuthPing(ex);
    }

    static void handleConfigLoad(HttpExchange ex) throws IOException {
        Security.handleConfigLoad(ex);
    }

    static void handleConfigSave(HttpExchange ex) throws IOException {
        Security.handleConfigSave(ex);
    }

    static void handleStatic(HttpExchange ex) throws IOException {
        HttpUtil.handleStatic(ex);
    }
}