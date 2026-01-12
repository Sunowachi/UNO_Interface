import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpExchange;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.sql.*;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.*;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import java.security.SecureRandom;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class Web_old {

    // Server
    private static final int PORT = 8080;
    private static final File CONFIG_FILE = new File("web/config.json");
    private static final long SERVER_START = System.currentTimeMillis();

    // Cache
    private static final Map<String, SensorCache> cache = new ConcurrentHashMap<>();
    private static final int CACHE_POINTS = 200;
    private static final long SENSOR_TTL_MS = 60_000; // 1 минута без данных


    // Database connection
    private static Connection db;
    private static final SimpleDateFormat TS_FMT =
            new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");

    // Sessions
    private static final long SESSION_TIMEOUT_MS = 5 * 60 * 1000;
    private static final long MAX_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000; // 8 часов

    static class Session {
        final String username;
        final String role;
        final String ip;
        final long createdAt;
        volatile long lastActive;

        Session(String u, String r, String ip) {
            this.username = u;
            this.role = r;
            this.ip = ip;
            this.createdAt = System.currentTimeMillis();
            touch();
        }

        void touch() {
            lastActive = System.currentTimeMillis();
        }

        boolean expired() {
            long now = System.currentTimeMillis();
            return now - lastActive > SESSION_TIMEOUT_MS ||
                    now - createdAt > MAX_SESSION_LIFETIME_MS;
        }
    }

    static record LoginReq(String username, String password) {}

    private static final Map<String, Session> sessions = new ConcurrentHashMap<>();

    // Security statics

    static final int ITERATIONS = 120_000;
    static final int KEY_LENGTH = 256;

    // Roles and Permissions
    enum Permission {
        VIEW_DATA,
        EDIT_CONFIG,
        DEVELOPER
    }

    private static final Map<String, Set<Permission>> ROLE_PERMS = Map.of(
            "developer", EnumSet.allOf(Permission.class),
            "admin", EnumSet.of(Permission.VIEW_DATA, Permission.EDIT_CONFIG),
            "observer", EnumSet.of(Permission.VIEW_DATA),
            "worker", EnumSet.of(Permission.VIEW_DATA)
    );

    // Logs
    private static final boolean LOG_POST = true;
    private static final boolean LOG_GET  = true;
    private static final boolean LOG_INIT = true;

    private static final SimpleDateFormat LOG_TS =
            new SimpleDateFormat("HH:mm:ss.SSS");

    // Main
    public static void main(String[] args) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 0);

        server.createContext("/data", Web::handleData);
        server.createContext("/init", Web::handleInit);
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

        ScheduledExecutorService cleaner =
                Executors.newSingleThreadScheduledExecutor();

        cleaner.scheduleAtFixedRate(() -> {
            cache.entrySet().removeIf(e -> !e.getValue().isAlive());
        }, 1, 1, TimeUnit.MINUTES);

    }

    // Logs
    private static void log(String tag, String msg) {
        System.out.println("[" + LOG_TS.format(new java.util.Date()) + "] " + tag + " " + msg);
    }

    // Initialisation
    static {
        try {
            Class.forName("org.sqlite.JDBC");
            db = DriverManager.getConnection("jdbc:sqlite:sensors.web.db");
            initDatabase();
            ensureDefaultDeveloper();
            warmupCacheFromDb();
        } catch (Exception e) {
            e.printStackTrace();
            throw new RuntimeException(e);
        }
    }

    // Handlers
    private static void handleInit(HttpExchange ex) throws IOException {
        if (LOG_INIT) log("INIT", "frontend connected");

        sendJson(ex,
                "{\"startTime\":" + SERVER_START +
                        ",\"sensors\":" + buildSensorsJson(0) + "}"
        );
    }

    private static void handleData(HttpExchange ex) throws IOException {
        String method = ex.getRequestMethod();
        String ip = ex.getRemoteAddress().getAddress().getHostAddress();

        if ("POST".equalsIgnoreCase(method)) {
            if (!ip.startsWith("192.168.") && !ip.equals("127.0.0.1")) {
                sendError(ex, 403, "forbidden");
                return;
            }
            handlePostData(ex, ip);
            return;
        }

        if ("GET".equalsIgnoreCase(method)) {
            long rangeMs = parseRange(ex.getRequestURI());
            String json = buildSensorsJson(rangeMs);

            if (LOG_GET) log("GET", "/web.data rangeMs=" + rangeMs);

            sendJson(ex, json);
            return;
        }

        ex.sendResponseHeaders(405, -1);
    }

    private static void handleLogin(HttpExchange ex) throws IOException {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }

        Map<String, String> data = parseJson(
                new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)
        );

        String user = data.get("username");
        String pass = data.get("password");

        try (PreparedStatement ps = db.prepareStatement(
                "SELECT password_hash, role FROM users WHERE username=?"
        )) {
            ps.setString(1, user);
            ResultSet rs = ps.executeQuery();

            if (!rs.next()) {
                sendJson(ex, "{\"error\":\"invalid_login\"}");
                return;
            }

            String stored = rs.getString(1);

            if (!checkPassword(pass, stored)) {
                sendJson(ex, "{\"error\":\"invalid_login\"}");
                return;
            }

            String sessionId = UUID.randomUUID().toString();
            String ip = ex.getRemoteAddress().getAddress().getHostAddress();
            sessions.put(sessionId, new Session(user, rs.getString(2), ip));

            ex.getResponseHeaders().add(
                    "Set-Cookie",
                    "SESSION=" + sessionId + "; Path=/; HttpOnly; SameSite=Lax"
            );


            sendJson(ex,
                    "{\"status\":\"ok\",\"username\":\"" + user + "\",\"role\":\"" + rs.getString(2) + "\"}"
            );

        } catch (Exception e) {
            e.printStackTrace();
            sendJson(ex, "{\"error\":\"server_error\"}");
        }
    }

    private static void handleLogout(HttpExchange ex) throws IOException {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }

        List<String> cookies = ex.getRequestHeaders().get("Cookie");
        if (cookies != null) {
            for (String c : cookies) {
                for (String part : c.split(";")) {
                    if (part.trim().startsWith("SESSION=")) {
                        String id = part.trim().substring(8);
                        sessions.remove(id); // 🔥 УБИВАЕМ СЕССИЮ
                    }
                }
            }
        }

        // удаляем cookie у клиента
        ex.getResponseHeaders().add(
                "Set-Cookie",
                "SESSION=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
        );

        sendJson(ex, "{\"status\":\"logged_out\"}");
    }

    private static void handleAuthMe(HttpExchange ex) throws IOException {
        Session s = getSession(ex);
        if (s == null) {
            byte[] body = "{\"error\":\"unauthorized\"}".getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().set("Content-Type", "application/json");
            ex.sendResponseHeaders(401, body.length);
            ex.getResponseBody().write(body);
            ex.close();
            return;
        }

        sendJson(ex,
                "{\"username\":\"" + s.username + "\",\"role\":\"" + s.role + "\"}"
        );
    }

    private static void handleAuthPing(HttpExchange ex) throws IOException {
        Session s = getSession(ex);
        if (s == null) {
            byte[] body = "{\"error\":\"unauthorized\"}".getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().set("Content-Type", "application/json");
            ex.sendResponseHeaders(401, body.length);
            ex.getResponseBody().write(body);
            ex.close();
            return;
        }

        s.touch();
        sendJson(ex, "{\"status\":\"ok\"}");
    }

    private static void handleConfigLoad(HttpExchange ex) throws IOException {
        if (!require(ex, Permission.VIEW_DATA)) return;

        if (!CONFIG_FILE.exists()) {
            CONFIG_FILE.getParentFile().mkdirs();
            Files.writeString(CONFIG_FILE.toPath(), "{ \"sensors\": [] }");
        }
        sendJson(ex, Files.readString(CONFIG_FILE.toPath()));
    }

    private static void handleConfigSave(HttpExchange ex) throws IOException {
        if (!require(ex, Permission.EDIT_CONFIG)) return;

        Files.writeString(CONFIG_FILE.toPath(),
                new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));

        sendJson(ex, "{\"status\":\"OK\"}");
    }

    private static void handleStatic(HttpExchange ex) throws IOException {
        Path path = Path.of("web", ex.getRequestURI().getPath().replaceFirst("/", ""));
        if (Files.isDirectory(path)) path = path.resolve("panel.html");

        if (!Files.exists(path)) {
            ex.sendResponseHeaders(404, -1);
            return;
        }

        byte[] data = Files.readAllBytes(path);
        ex.getResponseHeaders().add("Content-Type", getMimeType(path.toString()));
        ex.sendResponseHeaders(200, data.length);
        ex.getResponseBody().write(data);
        ex.close();
    }

    private static void handlePostData(HttpExchange ex, String ip) throws IOException {
        String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8).trim();

        if (LOG_POST) log("POST", ip + " -> " + body);

        body = body.replaceAll("[{}\" ]", "");
        for (String pair : body.split(",")) {
            if (!pair.contains(":")) continue;
            String[] kv = pair.split(":", 2);

            try {
                double value = Double.parseDouble(kv[1]);
                recordValue(ip, kv[0], value);
            } catch (Exception e) {
                log("POST", "invalid pair: " + pair);
            }
        }

        sendJson(ex, "{\"status\":\"OK\"}");
    }

    // Security
    private static Session getSession(HttpExchange ex) {
        List<String> cookies = ex.getRequestHeaders().get("Cookie");
        if (cookies == null) return null;

        for (String c : cookies)
            for (String part : c.split(";"))
                if (part.trim().startsWith("SESSION=")) {
                    String id = part.trim().substring(8);
                    Session s = sessions.get(id);
                    String ip = ex.getRemoteAddress().getAddress().getHostAddress();

                    if (s == null || s.expired()) {
                        sessions.remove(id);
                        return null;
                    }

                    if (!s.ip.equals(ip)) {
                        log("SECURITY", "IP changed for user=" + s.username +
                                " old=" + s.ip + " new=" + ip);
                    }

                    s.touch();
                    return s;
                }
        return null;
    }

    private static void sendError(HttpExchange ex, int code, String msg) throws IOException {
        byte[] body = ("{\"error\":\"" + msg + "\"}").getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(code, body.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(body);
        }
    }

    private static boolean require(HttpExchange ex, Permission p) throws IOException {
        Session s = getSession(ex);
        if (s == null) {
            sendError(ex, 401, "unauthorized");
            return false;
        }
        if (!ROLE_PERMS.getOrDefault(s.role, Set.of()).contains(p)) {
            sendError(ex, 403, "forbidden");
            return false;
        }
        return true;
    }

    static String hashPassword(String password) {
        try {
            byte[] salt = new byte[16];
            SecureRandom.getInstanceStrong().nextBytes(salt);

            PBEKeySpec spec = new PBEKeySpec(
                    password.toCharArray(),
                    salt,
                    ITERATIONS,
                    KEY_LENGTH
            );

            SecretKeyFactory skf =
                    SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");

            byte[] hash = skf.generateSecret(spec).getEncoded();

            return Base64.getEncoder().encodeToString(salt) + ":" +
                    Base64.getEncoder().encodeToString(hash);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    static boolean checkPassword(String password, String stored) {
        try {
            String[] parts = stored.split(":");
            byte[] salt = Base64.getDecoder().decode(parts[0]);
            byte[] hash = Base64.getDecoder().decode(parts[1]);

            PBEKeySpec spec = new PBEKeySpec(
                    password.toCharArray(),
                    salt,
                    ITERATIONS,
                    KEY_LENGTH
            );

            SecretKeyFactory skf =
                    SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");

            byte[] test = skf.generateSecret(spec).getEncoded();
            return MessageDigest.isEqual(hash, test);
        } catch (Exception e) {
            return false;
        }
    }

    static LoginReq parseLogin(String json) {
        Pattern p = Pattern.compile(
                "\"username\"\\s*:\\s*\"([^\"]+)\".*\"password\"\\s*:\\s*\"([^\"]+)\""
        );
        Matcher m = p.matcher(json);
        if (!m.find()) throw new IllegalArgumentException();
        return new LoginReq(m.group(1), m.group(2));
    }

    // Database
    private static void initDatabase() throws SQLException {
        try (Statement st = db.createStatement()) {
            st.execute("""
                CREATE TABLE IF NOT EXISTS history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sensor_id TEXT,
                    var_name TEXT,
                    ts INTEGER,
                    ts_text TEXT,
                    value REAL
                )
            """);
            st.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE,
                    password_hash TEXT,
                    role TEXT
                )
            """);
        }
    }

    static void ensureDefaultDeveloper() {
        try (PreparedStatement ps = db.prepareStatement(
                "INSERT OR IGNORE INTO users(username,password_hash,role) VALUES (?,?,?)")) {
            ps.setString(1, "1");
            ps.setString(2, hashPassword("1"));
            ps.setString(3, "developer");
            ps.executeUpdate();
        } catch (Exception ignored) {}
    }

    // Data
    private static void recordValue(String sensor, String var, double value) {
        long ts = System.currentTimeMillis();
        cache.computeIfAbsent(sensor + "_" + var, k -> new SensorCache())
                .add(value, ts);
        saveToDb(sensor, var, ts, value);
    }

    private static void saveToDb(String s, String v, long ts, double val) {
        try (PreparedStatement ps = db.prepareStatement(
                "INSERT INTO history(sensor_id,var_name,ts,ts_text,value) VALUES (?,?,?,?,?)")) {
            ps.setString(1, s);
            ps.setString(2, v);
            ps.setLong(3, ts);
            ps.setString(4, TS_FMT.format(new java.util.Date(ts)));
            ps.setDouble(5, val);
            ps.executeUpdate();
        } catch (Exception ignored) {}
    }

    private static void warmupCacheFromDb() {
        loadFromDb(0).forEach((k, pts) -> {
            SensorCache c = new SensorCache();
            for (Point p : pts) c.add(p.value, p.ts);
            cache.put(k, c);
        });
    }

    private static Map<String, List<Point>> loadFromDb(long fromTs) {
        Map<String, List<Point>> m = new LinkedHashMap<>();
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT sensor_id,var_name,ts,value FROM history WHERE ts>=? ORDER BY ts")) {
            ps.setLong(1, fromTs);
            ResultSet rs = ps.executeQuery();
            while (rs.next())
                m.computeIfAbsent(rs.getString(1) + "_" + rs.getString(2), k -> new ArrayList<>())
                        .add(new Point(rs.getLong(3), rs.getDouble(4)));
        } catch (Exception ignored) {}
        return m;
    }

    private static String buildSensorsJson(long rangeMs) {
        long fromTs = rangeMs > 0
                ? System.currentTimeMillis() - rangeMs
                : 0;

        Map<String, List<Point>> data = new LinkedHashMap<>();

        for (var e : cache.entrySet()) {
            SensorCache sc = e.getValue();
            if (!sc.isAlive()) continue; // МЁРТВЫЙ ДАТЧИК

            List<Point> pts = new ArrayList<>();
            for (Point p : sc.points)
                if (p.ts >= fromTs) pts.add(p);

            if (!pts.isEmpty()) data.put(e.getKey(), pts);
        }
        return pointsToJsonMap(data);
    }

    private static String pointsToJsonMap(Map<String, List<Point>> data) {
        StringBuilder sb = new StringBuilder("{");
        boolean f = true;
        for (var e : data.entrySet()) {
            if (!f) sb.append(",");
            f = false;
            sb.append("\"").append(e.getKey()).append("\":").append(pointsToJson(e.getValue()));
        }
        return sb.append("}").toString();
    }

    private static String pointsToJson(List<Point> pts) {
        StringBuilder v = new StringBuilder("["), t = new StringBuilder("[");
        for (int i = 0; i < pts.size(); i++) {
            if (i > 0) { v.append(","); t.append(","); }
            v.append(pts.get(i).value);
            t.append(pts.get(i).ts);
        }
        return "{\"values\":" + v + "],\"times\":" + t + "]}";
    }

    private static void sendJson(HttpExchange ex, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(200, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    private static long parseRange(URI uri) {
        String q = uri.getQuery();
        if (q == null) return 0;
        for (String p : q.split("&"))
            if (p.startsWith("rangeMs=")) return Long.parseLong(p.substring(8));
        return 0;
    }

    private static String getMimeType(String f) {
        if (f.endsWith(".html")) return "text/html";
        if (f.endsWith(".js")) return "application/javascript";
        if (f.endsWith(".json")) return "application/json";
        return "text/plain";
    }

    private static Map<String, String> parseJson(String json) {
        Map<String, String> map = new HashMap<>();
        json = json.replaceAll("[{}\" ]", "");
        for (String p : json.split(",")) {
            String[] kv = p.split(":", 2);
            if (kv.length == 2) map.put(kv[0], kv[1]);
        }
        return map;
    }

    static class SensorCache {
        final Deque<Point> points = new ArrayDeque<>();
        volatile long lastSeen;

        void add(double v, long t) {
            points.addLast(new Point(t, v));
            lastSeen = t;
            while (points.size() > CACHE_POINTS) points.removeFirst();
        }

        boolean isAlive() {
            return System.currentTimeMillis() - lastSeen <= SENSOR_TTL_MS;
        }
    }

    static class Point {
        final long ts;
        final double value;
        Point(long t, double v) { ts = t; value = v; }
    }
}