import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

public class Web {

    private static final int PORT = 8181;
    public static final long SERVER_START = System.currentTimeMillis();

    public static void main(String[] args) throws IOException {

        Database.init();
        Security.ensureDefaultDeveloper();
        DataStore.warmupCacheFromDb();

        HttpServer server =
                HttpServer.create(new InetSocketAddress(PORT), 0);

        server.createContext("/data", Web::handleData);
        server.createContext("/init", Web::handleInit);

        server.createContext("/sensor/register", Web::handleSensorRegister);

        server.createContext("/config/load", Web::handleConfigLoad);
        server.createContext("/config/save", Web::handleConfigSave);
        server.createContext("/auth/login", Web::handleLogin);
        server.createContext("/auth/logout", Web::handleLogout);
        server.createContext("/auth/me", Web::handleAuthMe);
        server.createContext("/auth/ping", Web::handleAuthPing);
        server.createContext("/", Web::handleStatic);

        server.setExecutor(Executors.newCachedThreadPool());
        server.start();

        System.out.println("✅ Server started: http://localhost:" + PORT);

        Executors.newSingleThreadScheduledExecutor()
                .scheduleAtFixedRate(
                        DataStore::cleanupCache,
                        1, 1, TimeUnit.MINUTES
                );
    }

    /* === handlers === */

    static void handleInit(HttpExchange ex) throws IOException {

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

    static void handleData(HttpExchange ex) throws IOException {
        DataStore.handleData(ex);
    }

    /* ==== SENSOR REGISTRATION ==== */

    static void handleSensorRegister(HttpExchange ex) throws IOException {

        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }

        var json = HttpUtil.parseJson(ex);

        String sensorId = json.get("sensorId");
        String key = json.get("key");

        if (sensorId == null || key == null) {
            HttpUtil.sendError(ex, 400, "bad_request");
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

        String token = Security.registerSensor(sensorId);
        if (token == null) {
            HttpUtil.sendError(ex, 500, "register_failed");
            return;
        }

        HttpUtil.sendJson(ex,
                "{\"token\":\"" + token + "\"}"
        );
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