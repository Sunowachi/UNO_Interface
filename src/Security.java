import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

public class Security {

    static final long SESSION_TIMEOUT_MS = 1 * 60 * 1000; // Время сессии 1 минута без активности
    static final long MAX_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000; // Максимум активной сессии

    static final int ITERATIONS = 120_000;
    static final int KEY_LENGTH = 256;

    enum Permission {
        VIEW_DATA,
        EDIT_CONFIG
    }

    static final Map<String, Set<Permission>> ROLE_PERMS = Map.of(
            "developer", EnumSet.allOf(Permission.class),
            "admin", EnumSet.of(Permission.VIEW_DATA, Permission.EDIT_CONFIG),
            "observer", EnumSet.of(Permission.VIEW_DATA),
            "worker", EnumSet.of(Permission.VIEW_DATA)
    );

    /* ==== SENSOR SECURITY ==== */

    // мастер-ключ для первичной регистрации датчиков
    // должен быть зашит в прошивку MCU
    static final String SENSOR_REGISTER_KEY = "CHANGE_ME_REGISTER_KEY";

    // динамическое хранилище токенов датчиков
    static final Map<String, String> SENSOR_TOKENS = new ConcurrentHashMap<>();

    static boolean checkSensorToken(String id, String token) {
        if (id == null || token == null) return false;
        return token.equals(SENSOR_TOKENS.get(id));
    }

    static boolean isSensorRegistered(String id) {
        return SENSOR_TOKENS.containsKey(id);
    }

    static boolean checkSensorRegisterKey(String key) {
        return SENSOR_REGISTER_KEY.equals(key);
    }

    static String registerSensor(String sensorId) {
        if (sensorId == null || SENSOR_TOKENS.containsKey(sensorId)) {
            return null;
        }
        String token = UUID.randomUUID().toString().replace("-", "");
        SENSOR_TOKENS.put(sensorId, token);
        return token;
    }

    /* ==== SESSION ==== */

    static class Session {
        final String username;
        final String role;
        final long createdAt;
        volatile long lastActive;
        volatile String csrfToken;
        volatile long lastPing;
        final String userAgent;

        Session(String u, String r, String ua) {
            username = u;
            role = r;
            userAgent = ua;
            createdAt = System.currentTimeMillis();
            rotateCsrf();
            touch();
        }

        void touch() {
            lastActive = System.currentTimeMillis();
        }

        void rotateCsrf() {
            csrfToken = UUID.randomUUID().toString();
        }

        boolean expired() {
            long now = System.currentTimeMillis();
            return now - lastActive > SESSION_TIMEOUT_MS ||
                    now - createdAt > MAX_SESSION_LIFETIME_MS;
        }
    }

    static final Map<String, Session> sessions = new ConcurrentHashMap<>();

    /* ==== helpers ==== */

    static Session getSession(HttpExchange ex) {
        Session s = peekSession(ex);
        if (s != null) {
            s.touch();
        }
        return s;
    }

    static Session peekSession(HttpExchange ex) {
        String sid = HttpUtil.getCookie(ex, "SESSION");
        if (sid == null) return null;

        Session s = sessions.get(sid);
        if (s == null) return null;

        String ua = ex.getRequestHeaders().getFirst("User-Agent");
        if (!Objects.equals(s.userAgent, ua)) {
            sessions.remove(sid);
            return null;
        }

        if (s.expired()) {
            sessions.remove(sid);
            return null;
        }

        return s;
    }

    static boolean checkCsrf(HttpExchange ex, Session s) throws IOException {
        String token = ex.getRequestHeaders().getFirst("X-CSRF-Token");

        if (token == null || !token.equals(s.csrfToken)) {
            HttpUtil.sendError(ex, 403, "csrf");
            return false;
        }
        return true;
    }

    static boolean require(Session s, HttpExchange ex, Permission p) throws IOException {
        if (!ROLE_PERMS.getOrDefault(s.role, Set.of()).contains(p)) {
            HttpUtil.sendError(ex, 403, "forbidden");
            String ip = ex.getRemoteAddress()
                    .getAddress()
                    .getHostAddress();

            Audit.log(s.username, "ACCESS_DENIED", ip);

            return false;
        }
        return true;
    }

    /* ==== PASSWORDS ==== */

    static String hashPassword(String password) {
        try {
            byte[] salt = new byte[16];
            SecureRandom.getInstanceStrong().nextBytes(salt);

            PBEKeySpec spec = new PBEKeySpec(
                    password.toCharArray(), salt, ITERATIONS, KEY_LENGTH);

            byte[] hash = SecretKeyFactory
                    .getInstance("PBKDF2WithHmacSHA256")
                    .generateSecret(spec)
                    .getEncoded();

            return Base64.getEncoder().encodeToString(salt) + ":" +
                    Base64.getEncoder().encodeToString(hash);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    static boolean checkPassword(String password, String stored) {
        try {
            String[] p = stored.split(":");
            byte[] salt = Base64.getDecoder().decode(p[0]);
            byte[] hash = Base64.getDecoder().decode(p[1]);

            PBEKeySpec spec = new PBEKeySpec(
                    password.toCharArray(), salt, ITERATIONS, KEY_LENGTH);

            byte[] test = SecretKeyFactory
                    .getInstance("PBKDF2WithHmacSHA256")
                    .generateSecret(spec)
                    .getEncoded();

            return MessageDigest.isEqual(hash, test);
        } catch (Exception e) {
            return false;
        }
    }

    static void ensureDefaultDeveloper() {
        Database.ensureDefaultDeveloper();
    }

    /* ==== FAILED LOGIN ==== */

    static class FailedLogin {
        int count;
        long blockedUntil;
        long lastFail;
    }

    static final Map<String, FailedLogin> failed = new ConcurrentHashMap<>();

    static boolean isBlocked(String key) {
        FailedLogin f = failed.get(key);
        if (f == null) return false;

        if (System.currentTimeMillis() - f.lastFail > 15 * 60 * 1000) {
            failed.remove(key);
            return false;
        }

        return f.blockedUntil > System.currentTimeMillis();
    }

    static {
        new Timer(true).scheduleAtFixedRate(new TimerTask() {
            @Override
            public void run() {
                sessions.entrySet().removeIf(e -> e.getValue().expired());
            }
        }, 60_000, 60_000);
    }

    /* ==== handlers ==== */

    static void handleLogin(HttpExchange ex) throws IOException {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }

        String ua = ex.getRequestHeaders().getFirst("User-Agent");

        if (ua == null || ua.matches(".*(Android|iPhone|Mobile).*")) {
            HttpUtil.sendError(ex, 403, "forbidden_device");
            return;
        }

        String ip = ex.getRemoteAddress()
                .getAddress()
                .getHostAddress();

        var data = HttpUtil.parseJson(ex);
        var user = data.get("username");
        var pass = data.get("password");
        var dbUser = Database.findUser(user);

        String key = user + "|" + ip;
        if (isBlocked(key)) {
            ex.sendResponseHeaders(403, 0);
            HttpUtil.sendJson(ex,
                    "{\"error\":\"blocked\",\"message\":\"Too many failed attempts. Try again later.\"}"
            );
            return;
        }

        if (dbUser == null || !checkPassword(pass, dbUser.passwordHash)) {

            FailedLogin f = failed.computeIfAbsent(key, k -> new FailedLogin());
            f.count++;
            f.lastFail = System.currentTimeMillis();

            if (f.count >= 5) {
                f.blockedUntil = System.currentTimeMillis() + 1 * 60 * 1000;   // Блокируем аккаунт на 1 минуту
            }

            Audit.log(user, "LOGIN_FAIL", ip);
            HttpUtil.sendJson(ex, "{\"error\":\"invalid_login\"}");
            return;
        }

        String oldSid = HttpUtil.getCookie(ex, "SESSION");
        if (oldSid != null) {
            sessions.remove(oldSid);
            HttpUtil.clearCookie(ex, "SESSION");
        }

        failed.remove(key);

        String sid = UUID.randomUUID().toString();

        sessions.put(sid, new Session(user, dbUser.role, ua));
        HttpUtil.setCookie(ex, "SESSION", sid);

        HttpUtil.sendJson(ex,
                "{\"status\":\"ok\",\"username\":\"" + user +
                        "\",\"role\":\"" + dbUser.role + "\"}");

        Audit.log(user, "LOGIN_SUCCESS", ip);
    }

    static void handleLogout(HttpExchange ex) throws IOException {

        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }

        Session s = getSession(ex);
        if (s == null || !checkCsrf(ex, s)) return;
        String sid = HttpUtil.getCookie(ex, "SESSION");
        if (sid != null) sessions.remove(sid);
        HttpUtil.clearCookie(ex, "SESSION");
        HttpUtil.sendJson(ex, "{\"status\":\"logged_out\"}");
        Audit.log(
                s != null ? s.username : "unknown",
                "LOGOUT",
                ex.getRemoteAddress().getAddress().getHostAddress()
        );
    }

    static void handleAuthMe(HttpExchange ex) throws IOException {
        Session s = getSession(ex);
        if (s == null) {
            HttpUtil.sendError(ex, 401, "unauthorized");
            return;
        }

        s.rotateCsrf();

        HttpUtil.sendJson(ex,
                "{\"username\":\"" + s.username +
                        "\",\"role\":\"" + s.role +
                        "\",\"csrf\":\"" + s.csrfToken + "\"}");
    }

    static void handleAuthPing(HttpExchange ex) throws IOException {
        Session s = getSession(ex);
        if (s == null) {
            HttpUtil.sendError(ex, 401, "unauthorized");
            return;
        }
        if (!checkCsrf(ex, s)) return;

        long now = System.currentTimeMillis();
        if (now - s.lastPing < 1000) {
            HttpUtil.sendError(ex, 429, "too_many_requests");
            return;
        }
        s.lastPing = now;

        s.touch();
        s.rotateCsrf();
        HttpUtil.sendJson(ex, "{\"status\":\"ok\"}");
    }

    static void handleConfigLoad(HttpExchange ex) throws IOException {

        Session s = getSession(ex);
        if (s == null) {
            HttpUtil.sendError(ex, 401, "unauthorized");
            return;
        }

        if (!checkCsrf(ex, s)) return;

        if (!require(s, ex, Permission.VIEW_DATA)) return;

        HttpUtil.sendConfig(ex);
    }

    static void handleConfigSave(HttpExchange ex) throws IOException {
        Session s = getSession(ex);
        if (s == null || !checkCsrf(ex, s)) return;
        if (!require(s, ex, Permission.EDIT_CONFIG)) return;

        s.rotateCsrf();
        HttpUtil.saveConfig(ex);
    }
}