import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public class Web {

    private static final int PORT = 8181;
    private static final int MAX_BODY_SIZE = 64 * 1024; // 64 KB

    public static final long SERVER_START = System.currentTimeMillis();

    public static void main(String[] args) throws IOException {

        /* ===== INIT CORE ===== */

        Database.init();
        Security.ensureDefaultDeveloper();

        DataStore.warmupCacheFromDb();
        DataStore.startDbWriter();

        /* ===== HTTP SERVER ===== */

        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 100);

        server.createContext("/data", Web::handleData);
        server.createContext("/init", Web::handleInit);
        server.createContext("/sensors", Web::handleSensors);
        server.createContext("/sensor/register", Web::handleSensorRegister);

        server.createContext("/config/load", Web::handleConfigLoad);
        server.createContext("/config/save", Web::handleConfigSave);

        server.createContext("/auth/login", Web::handleLogin);
        server.createContext("/auth/logout", Web::handleLogout);
        server.createContext("/auth/me", Web::handleAuthMe);
        server.createContext("/auth/ping", Web::handleAuthPing);

        server.createContext("/", Web::handleStatic);

        // фиксированный пул потоков для стабильной работы с контроллерами
        server.setExecutor(Executors.newFixedThreadPool(100));

        server.start();
        System.out.println("✅ Server started: http://localhost:" + PORT);

        /* ===== CACHE CLEANUP ===== */

        ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
        scheduler.scheduleAtFixedRate(DataStore::cleanupCache, 1, 1, TimeUnit.MINUTES);

        /* ===== SHUTDOWN HOOK ===== */

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            System.out.println("⏹ Shutting down server...");

            try {
                scheduler.shutdownNow();
                server.stop(1);
            } catch (Exception ignored) {}

            try {
                Thread.sleep(1500); // дать дописать batch
            } catch (InterruptedException ignored) {}
            System.out.println("✔ Server stopped");
        }));
    }

    /* ================= HANDLERS ================= */

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

        if (!Security.require(s, ex, Security.Permission.VIEW_DATA)) {
            return;
        }

        HttpUtil.sendJson(ex,
                "{\"startTime\":" + SERVER_START +
                        ",\"sensors\":" + DataStore.buildSensorsJson(0) + "}"
        );
    }

    /* ===== SENSOR DATA ===== */

    static void handleData(HttpExchange ex) throws IOException {
        try {
            if ("POST".equalsIgnoreCase(ex.getRequestMethod())) {

                String ct = ex.getRequestHeaders().getFirst("Content-Type");
                if (ct == null || !ct.startsWith("application/json")) {
                    HttpUtil.sendError(ex, 415, "unsupported_media_type");
                    return;
                }

                String enc = ex.getRequestHeaders().getFirst("Content-Encoding");
                if (enc != null && !enc.equalsIgnoreCase("identity")) {
                    HttpUtil.sendError(ex, 415, "compressed_body_not_supported");
                    return;
                }

                if (HttpUtil.getBodySize(ex) > MAX_BODY_SIZE) {
                    HttpUtil.sendError(ex, 413, "payload_too_large");
                    return;
                }

                // SENSOR AUTH
                if (!Security.checkSensorToken(ex)) {
                    HttpUtil.sendError(ex, 403, "forbidden");
                    return;
                }

                // кладём данные в очередь для асинхронной записи
                DataStore.enqueueData(ex);
                HttpUtil.sendJson(ex, "{\"status\":\"ok\"}");
                return;
            }

            if ("GET".equalsIgnoreCase(ex.getRequestMethod())) {
                Security.Session s = Security.getSession(ex);
                if (s == null) {
                    HttpUtil.sendError(ex, 401, "unauthorized");
                    return;
                }

                if (!Security.require(s, ex, Security.Permission.VIEW_DATA)) {
                    return;
                }

                DataStore.handleData(ex);
                return;
            }
            ex.sendResponseHeaders(405, -1);
        } catch (Exception e) {
            e.printStackTrace();
            try {
                HttpUtil.sendError(ex, 500, "internal_error");
            } catch (Exception ignored) {}
        }
    }

    /* ==== SENSOR REGISTRATION ==== */

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

        HttpUtil.sendJson(ex,
                HttpUtil.toJson(DataStore.listSensors()));
    }

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

            if (!sensorId.matches("[a-zA-Z0-9_-]{3,64}")) {
                HttpUtil.sendError(ex, 400, "invalid_sensor_id");
                return;
            }

            if (!Security.checkSensorRegisterKey(key)) {
                HttpUtil.sendError(ex, 403, "forbidden");
                return;
            }

            if (Security.isSensorRegistered(sensorId)) {
                HttpUtil.sendError(ex, 409, "already_registered");
                return;
            }

            String ip = ex.getRemoteAddress().getAddress().getHostAddress();
            String token = Security.registerSensor(sensorId, ip);
            if (token == null) {
                HttpUtil.sendError(ex, 500, "sensor_register_failed");
                return;
            }

            Audit.log(sensorId, "SENSOR_REGISTER", ip);

            HttpUtil.sendJson(ex, "{\"token\":\"" + token + "\"}");
        } catch (Exception e) {
            e.printStackTrace();
            HttpUtil.sendError(ex, 500, "internal_error_during_register");
        }
    }

    /* ==== AUTH / CONFIG ==== */

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