import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.util.List;
import java.util.concurrent.*;
import java.util.HashMap;
import java.util.Map;

public class Web {
    // Порт, на котором будет запущен сервер
    private static final int PORT = 8181;
    // Максимальный размер тела запроса в байтах (64 КБ)
    private static final int MAX_BODY_SIZE = 64 * 1024;
    // Пул потоков для асинхронной обработки данных от датчиков (макс. 50 потоков)
    private static final ExecutorService sensorExecutor = Executors.newFixedThreadPool(50);
    // Время запуска сервера в миллисекундах (используется для клиентской синхронизации)
    public static final long SERVER_START = System.currentTimeMillis();

    // ================= МЕТОДЫ ИНИЦИАЛИЗАЦИИ =================

    // Точка входа в приложение
    public static void main(String[] args) throws IOException {
        // Инициализация соединения с базой данных
        Database.init();
        // Создание учётной записи разработчика по умолчанию, если её нет
        Security.ensureDefaultDeveloper();
        // Предварительное заполнение кэша данными из БД для ускорения работы
        DataStore.warmupCacheFromDb();
        // Запуск фонового потока для периодической записи кэша в БД
        DataStore.startDbWriter();

        // Создание HTTP-сервера, слушающего порт PORT, с размером очереди 50
        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 50);

        // Регистрация обработчиков для различных URL-путей
        // Каждый обработчик – ссылка на статический метод класса Web
        server.createContext("/data", Web::handleData);                 // Приём данных от датчиков
        server.createContext("/init", Web::handleInit);                 // Инициализация клиента (список датчиков и время старта)
        server.createContext("/sensors", Web::handleSensors);           // Получение списка всех датчиков
        server.createContext("/sensor/register", Web::handleSensorRegister); // Регистрация нового датчика
        server.createContext("/config/load", Web::handleConfigLoad);    // Загрузка конфигурации (прокси на Security)
        server.createContext("/config/save", Web::handleConfigSave);    // Сохранение конфигурации (прокси на Security)
        server.createContext("/auth/login", Web::handleLogin);          // Аутентификация пользователя
        server.createContext("/auth/logout", Web::handleLogout);        // Завершение сессии пользователя
        server.createContext("/auth/me", Web::handleAuthMe);            // Информация о текущем пользователе
        server.createContext("/auth/ping", Web::handleAuthPing);        // Проверка валидности сессии
        server.createContext("/", Web::handleStatic);                   // Раздача статических файлов (HTML, JS, CSS)
        server.createContext("/export/comtrade", Web::handleExportComtrade); // Экспорт файла COMTRADE

        // Назначение пула потоков для обработки входящих запросов (100 потоков)
        server.setExecutor(Executors.newFixedThreadPool(100));
        // Запуск сервера
        server.start();
        // Вывод в консоль сообщения об успешном запуске
        System.out.println("✅ Сервер запущен: http://localhost:" + PORT);

        // Создание планировщика с одним потоком для периодических задач
        ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
        // Запуск задачи очистки устаревших записей в кэше каждую минуту (начальная задержка 1 мин.)
        scheduler.scheduleAtFixedRate(DataStore::cleanupCache, 1, 1, TimeUnit.MINUTES);

        // Регистрация обработчика завершения работы приложения (вызывается при SIGTERM, Ctrl+C)
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            System.out.println("⏹ Завершение работы сервера...");
            try {
                // Принудительное завершение планировщика
                scheduler.shutdownNow();
                // Остановка HTTP-сервера с таймаутом 1 секунда
                server.stop(1);
                // Принудительное завершение пула обработчиков датчиков
                sensorExecutor.shutdownNow();
            } catch (Exception ignored) {} // Игнорируем исключения при остановке
            try {
                // Пауза 1.5 секунды для завершения фоновых операций
                Thread.sleep(1500);
            } catch (InterruptedException ignored) {}
            System.out.println("✔ Сервер остановлен!");
        }));
    }

    // ================= ОБРАБОТЧИКИ ЗАПРОСОВ =================

    // Обработчик GET /init – возвращает время старта сервера и список датчиков
    static void handleInit(HttpExchange ex) throws IOException {
        // Проверка метода запроса: разрешён только GET
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1); // 405 Method Not Allowed, тело ответа отсутствует
            return;
        }

        // Получение сессии по Cookie (или другому заголовку)
        Security.Session s = Security.getSession(ex);
        // Если сессия не найдена – пользователь не аутентифицирован
        if (s == null) {
            HttpUtil.sendError(ex, 401, "unauthorized"); // 401 Unauthorized
            return;
        }

        // Проверка, имеет ли сессия право VIEW_DATA; если нет – отправляется ошибка 403
        if (!Security.require(s, ex, Security.Permission.VIEW_DATA)) return;

        // Парсинг параметра range из строки запроса (для фильтрации по времени)
        long rangeMs = HttpUtil.parseRange(ex);
        // Формирование JSON-ответа: время старта и JSON-строка со списком датчиков
        HttpUtil.sendJson(ex, "{\"startTime\":" + SERVER_START +
                ",\"sensors\":" + DataStore.buildSensorsJson(rangeMs) + "}");
    }

    // Обработчик POST /data – принимает показания от датчиков
    static void handleData(HttpExchange ex) throws IOException {
        // Разрешён только POST
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }

        // Получение заголовка Content-Type
        String ct = ex.getRequestHeaders().getFirst("Content-Type");
        // Проверка, что Content-Type начинается с application/json
        if (ct == null || !ct.startsWith("application/json")) {
            HttpUtil.sendError(ex, 415, "unsupported_media_type"); // 415 Unsupported Media Type
            return;
        }

        // Проверка размера тела запроса: если превышает лимит – ошибка 413
        if (HttpUtil.getBodySize(ex) > MAX_BODY_SIZE) {
            HttpUtil.sendError(ex, 413, "payload_too_large");
            return;
        }

        // Чтение заголовков аутентификации датчика
        String sensorId = ex.getRequestHeaders().getFirst("X-Sensor-Id");
        String token = ex.getRequestHeaders().getFirst("X-Sensor-Token");

        // Проверка валидности ID датчика и токена, а также IP-адреса
        if (!Security.validateSensorToken(sensorId, token, ex.getRemoteAddress())) {
            HttpUtil.sendError(ex, 401, "invalid_sensor");
            return;
        }

        final byte[] body;
        try {
            // Чтение всего тела запроса в массив байт
            body = ex.getRequestBody().readAllBytes();
        } catch (Exception e) {
            HttpUtil.sendError(ex, 400, "bad_payload"); // 400 Bad Request
            return;
        }

        // Отправка немедленного ответа "ok" клиенту
        HttpUtil.sendJson(ex, "{\"status\":\"ok\"}");
        // Асинхронная обработка данных в отдельном потоке (чтобы не блокировать обработчик)
        sensorExecutor.submit(() -> {
            try {
                // Передача данных в DataStore для обработки и сохранения
                DataStore.handleSensorPost(body, sensorId);
            } catch (Exception e) {
                // В случае ошибки – запись в аудит
                Audit.log(sensorId, "SENSOR_POST_FAIL", "-");
            }
        });
    }

    // Обработчик GET /sensors – возвращает список всех зарегистрированных датчиков
    static void handleSensors(HttpExchange ex) throws IOException {
        // Только GET
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }

        // Проверка аутентификации пользователя
        Security.Session s = Security.getSession(ex);
        if (s == null) {
            HttpUtil.sendError(ex, 401, "unauthorized");
            return;
        }

        // Проверка права VIEW_DATA
        if (!Security.require(s, ex, Security.Permission.VIEW_DATA)) return;
        // Получение списка датчиков из DataStore, преобразование в JSON и отправка
        HttpUtil.sendJson(ex, HttpUtil.toJson(DataStore.listSensors()));
    }

    // Обработчик POST /sensor/register – регистрация нового датчика
    static void handleSensorRegister(HttpExchange ex) throws IOException {
        try {
            // Только POST
            if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(405, -1);
                return;
            }

            // Проверка Content-Type
            String ct = ex.getRequestHeaders().getFirst("Content-Type");
            if (ct == null || !ct.startsWith("application/json")) {
                HttpUtil.sendError(ex, 415, "unsupported_media_type");
                return;
            }

            // Парсинг JSON-тела запроса в Map
            var json = HttpUtil.parseJson(ex);
            // Извлечение полей sensorId и key
            String sensorId = json.get("sensorId");
            String key = json.get("key");

            // Удаление пробелов в начале и конце
            if (sensorId != null) sensorId = sensorId.trim();
            if (key != null) key = key.trim();

            // Проверка наличия обязательных полей
            if (sensorId == null || key == null) {
                HttpUtil.sendError(ex, 400, "bad_request");
                return;
            }

            // Валидация формата ID датчика: буквы, цифры, _, -, длина от 3 до 64
            if (!sensorId.matches("[a-zA-Z0-9_-]{3,64}")) {
                HttpUtil.sendError(ex, 400, "invalid_sensor_id");
                return;
            }

            // Проверка регистрационного ключа (должен совпадать с предустановленным)
            if (!Security.checkSensorRegisterKey(key)) {
                HttpUtil.sendError(ex, 403, "forbidden");
                return;
            }

            // Получение IP-адреса клиента (отправившего запрос)
            String ip = ex.getRemoteAddress().getAddress().getHostAddress();
            // Регистрация датчика: генерация и сохранение токена, привязка IP
            String token = Security.registerSensor(sensorId, ip);

            // Если датчик уже зарегистрирован – вернуть 409 Conflict
            if (token == null) {
                HttpUtil.sendError(ex, 409, "already_registered");
                return;
            }

            // Запись в журнал аудита о регистрации
            Audit.log(sensorId, "SENSOR_REGISTER", ip);
            // Отправка клиенту сгенерированного токена в JSON
            HttpUtil.sendJson(ex, "{\"token\":\"" + token + "\"}");
        } catch (Exception e) {
            // Любое исключение на этапе обработки -> 500 Internal Server Error
            HttpUtil.sendError(ex, 500, "internal_error");
        }
    }

    // Обработчик COMTRADE - экспорт файла в этом формате
    static void handleExportComtrade(HttpExchange ex) throws IOException {
        // Только GET
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }

        // Проверка аутентификации
        Security.Session s = Security.getSession(ex);
        if (s == null) {
            HttpUtil.sendError(ex, 401, "unauthorized");
            return;
        }
        if (!Security.require(s, ex, Security.Permission.VIEW_DATA)) return;

        // Парсинг параметров запроса
        String query = ex.getRequestURI().getQuery();
        Map<String, String> params = parseQuery(query);
        String sensorId = params.get("sensor");
        String varName = params.get("var");
        String fromStr = params.get("from");
        String toStr = params.get("to");

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

        // Проверка, что from <= to и разумный диапазон (например, не больше 7 дней)
        if (fromTs > toTs || toTs - fromTs > 7L * 24 * 60 * 60 * 1000) {
            HttpUtil.sendError(ex, 400, "invalid time range (max 7 days)");
            return;
        }

        // Получение данных
        List<DataStore.Point> points = DataStore.getPointsFromDb(sensorId, varName, fromTs, toTs);
        if (points.isEmpty()) {
            HttpUtil.sendError(ex, 404, "no data found");
            return;
        }

        // Вычисление средней частоты дискретизации (по среднему интервалу)
        double sampleRate = 1.0; // по умолчанию
        if (points.size() > 1) {
            long totalInterval = points.get(points.size() - 1).ts - points.get(0).ts;
            if (totalInterval > 0) {
                double avgIntervalSec = totalInterval / 1000.0 / (points.size() - 1);
                sampleRate = 1.0 / avgIntervalSec;
            }
        }

        // Генерация COMTRADE архива
        byte[] zipData;
        try {
            zipData = ComtradeExporter.generateZip(sensorId, varName, points, fromTs, toTs, sampleRate);
        } catch (IOException e) {
            HttpUtil.sendError(ex, 500, "export failed");
            return;
        }

        // Отправка ZIP-файла
        HttpUtil.applySecurityHeaders(ex);
        ex.getResponseHeaders().set("Content-Type", "application/zip");
        ex.getResponseHeaders().set("Content-Disposition",
                "attachment; filename=\"" + ComtradeExporter.sanitizeFileName(sensorId + "_" + varName + ".zip") + "\"");
        ex.sendResponseHeaders(200, zipData.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(zipData);
        }
    }

    // Вспомогательный метод для разбора query-строки
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

    // ================= ПРОКСИ-ОБРАБОТЧИКИ =================
    // Все следующие методы просто делегируют выполнение соответствующим методам класса Security
    // Это сделано для единообразия регистрации контекстов в main()

    static void handleLogin(HttpExchange ex) throws IOException {
        Security.handleLogin(ex); // Аутентификация пользователя
    }

    static void handleLogout(HttpExchange ex) throws IOException {
        Security.handleLogout(ex); // Завершение сессии
    }

    static void handleAuthMe(HttpExchange ex) throws IOException {
        Security.handleAuthMe(ex); // Информация о текущем пользователе
    }

    static void handleAuthPing(HttpExchange ex) throws IOException {
        Security.handleAuthPing(ex); // Проверка активности сессии
    }

    static void handleConfigLoad(HttpExchange ex) throws IOException {
        Security.handleConfigLoad(ex); // Загрузка конфигурации
    }

    static void handleConfigSave(HttpExchange ex) throws IOException {
        Security.handleConfigSave(ex); // Сохранение конфигурации
    }

    static void handleStatic(HttpExchange ex) throws IOException {
        HttpUtil.handleStatic(ex); // Обслуживание статических файлов
    }
}