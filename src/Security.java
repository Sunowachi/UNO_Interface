import com.sun.net.httpserver.HttpExchange;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

public class Security {

    /* ================= CONFIG ================= */

    static final long SESSION_TIMEOUT_MS = 10 * 60 * 1000;
    static final long MAX_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
    static final int MAX_SESSIONS = 1000;

    static final int ITERATIONS = 120_000;
    static final int KEY_LENGTH = 256;

    static final String SENSOR_REGISTER_KEY = "CHANGE_ME_REGISTER_KEY";

    /* ================= PERMISSIONS ================= */

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

    /* ================= SENSORS ================= */

    static boolean checkSensorToken(String id, String token) {
        if (id == null || token == null) return false;

        Connection c = null;
        try {
            c = Database.borrow();
            try (PreparedStatement ps = c.prepareStatement(
                    "SELECT token FROM sensors WHERE sensor_id=?")) {
                ps.setString(1, id);
                ResultSet rs = ps.executeQuery();
                if (!rs.next()) return false;

                if (!MessageDigest.isEqual(
                        rs.getString(1).getBytes(),
                        token.getBytes()
                )) return false;
            }

            try (PreparedStatement ps = c.prepareStatement(
                    "UPDATE sensors SET last_seen=? WHERE sensor_id=?")) {
                ps.setLong(1, System.currentTimeMillis());
                ps.setString(2, id);
                ps.executeUpdate();
            }

            return true;
        } catch (Exception e) {
            return false;
        } finally {
            Database.release(c);
        }
    }

    static boolean isSensorRegistered(String id) {
        if (id == null) return false;
        Connection c = null;
        try {
            c = Database.borrow();
            try (PreparedStatement ps = c.prepareStatement(
                    "SELECT 1 FROM sensors WHERE sensor_id=?")) {
                ps.setString(1, id);
                return ps.executeQuery().next();
            }
        } catch (Exception e) {
            return false;
        } finally {
            Database.release(c);
        }
    }

    static boolean checkSensorRegisterKey(String key) {
        return SENSOR_REGISTER_KEY.equals(key);
    }

    static String registerSensor(String sensorId) {
        if (sensorId == null) return null;

        String token = UUID.randomUUID().toString().replace("-", "");
        long now = System.currentTimeMillis();

        Connection c = null;
        try {
            c = Database.borrow();
            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO sensors(sensor_id,token,created_at,last_seen) VALUES (?,?,?,?)")) {
                ps.setString(1, sensorId);
                ps.setString(2, token);
                ps.setLong(3, now);
                ps.setLong(4, now);
                ps.executeUpdate();
            }
            return token;
        } catch (Exception e) {
            return null;
        } finally {
            Database.release(c);
        }
    }

    /* ================= SESSION ================= */

    static class Session {
        final String username;
        final String role;
        final long createdAt;
        volatile long lastActive;
        volatile long lastPing;
        volatile String csrf;

        Session(String u, String r) {
            username = u;
            role = r;
            createdAt = System.currentTimeMillis();
            rotateCsrf();
            touch();
        }

        void touch() {
            lastActive = System.currentTimeMillis();
        }

        void rotateCsrf() {
            csrf = UUID.randomUUID().toString();
        }

        boolean expired() {
            long now = System.currentTimeMillis();
            return now - lastActive > SESSION_TIMEOUT_MS ||
                    now - createdAt > MAX_SESSION_LIFETIME_MS;
        }
    }

    static final Map<String, Session> sessions = new ConcurrentHashMap<>();

    static void cleanupSessions() {
        sessions.entrySet().removeIf(e -> e.getValue().expired());
    }

    static Session getSession(HttpExchange ex) {
        cleanupSessions();
        String sid = HttpUtil.getCookie(ex, "SESSION");
        if (sid == null) return null;

        Session s = sessions.get(sid);
        if (s == null || s.expired()) {
            sessions.remove(sid);
            return null;
        }
        s.touch();
        return s;
    }

    static boolean checkCsrf(HttpExchange ex, Session s) throws IOException {
        String token = ex.getRequestHeaders().getFirst("X-CSRF-Token");
        if (!Objects.equals(token, s.csrf)) {
            HttpUtil.sendError(ex, 403, "csrf");
            return false;
        }
        s.rotateCsrf();
        return true;
    }

    static boolean require(Session s, HttpExchange ex, Permission p) throws IOException {
        if (!ROLE_PERMS.getOrDefault(s.role, Set.of()).contains(p)) {
            HttpUtil.sendError(ex, 403, "forbidden");
            Audit.log(s.username, "ACCESS_DENIED",
                    ex.getRemoteAddress().getAddress().getHostAddress());
            return false;
        }
        return true;
    }

    /* ================= PASSWORDS ================= */

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

    /* ================= FAILED LOGIN ================= */

    static boolean isBlocked(String user, String ip) {
        Connection c = null;
        try {
            c = Database.borrow();
            try (PreparedStatement ps = c.prepareStatement(
                    "SELECT blocked_until FROM failed_logins WHERE username=? AND ip=?")) {
                ps.setString(1, user);
                ps.setString(2, ip);
                ResultSet rs = ps.executeQuery();
                return rs.next() && rs.getLong(1) > System.currentTimeMillis();
            }
        } catch (Exception e) {
            return false;
        } finally {
            Database.release(c);
        }
    }

    static void recordFailedLogin(String user, String ip) {
        long now = System.currentTimeMillis();
        Connection c = null;
        try {
            c = Database.borrow();
            try (PreparedStatement ps = c.prepareStatement("""
                INSERT INTO failed_logins(username,ip,count,last_fail,blocked_until)
                VALUES (?,?,?,?,?)
                ON CONFLICT (username,ip)
                DO UPDATE SET
                    count = failed_logins.count + 1,
                    last_fail = EXCLUDED.last_fail,
                    blocked_until = CASE
                        WHEN failed_logins.count + 1 >= 5
                        THEN ?
                        ELSE failed_logins.blocked_until
                    END
            """)) {
                ps.setString(1, user);
                ps.setString(2, ip);
                ps.setInt(3, 1);
                ps.setLong(4, now);
                ps.setLong(5, 0);
                ps.setLong(6, now + 60_000);
                ps.executeUpdate();
            }
        } catch (Exception ignored) {
        } finally {
            Database.release(c);
        }
    }

    static void clearFailedLogins(String user, String ip) {
        Connection c = null;
        try {
            c = Database.borrow();
            try (PreparedStatement ps = c.prepareStatement(
                    "DELETE FROM failed_logins WHERE username=? AND ip=?")) {
                ps.setString(1, user);
                ps.setString(2, ip);
                ps.executeUpdate();
            }
        } catch (Exception ignored) {
        } finally {
            Database.release(c);
        }
    }

    /* ================= HANDLERS ================= */

    static void handleLogin(HttpExchange ex) throws IOException {

        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }

        cleanupSessions();
        if (sessions.size() >= MAX_SESSIONS) {
            HttpUtil.sendError(ex, 503, "too_many_sessions");
            return;
        }

        var data = HttpUtil.parseJson(ex);
        String user = data.get("username");
        String pass = data.get("password");

        if (user == null || pass == null) {
            HttpUtil.sendError(ex, 400, "bad_request");
            return;
        }

        String ip = ex.getRemoteAddress().getAddress().getHostAddress();

        if (isBlocked(user, ip)) {
            HttpUtil.sendError(ex, 403, "blocked");
            return;
        }

        var dbUser = Database.findUser(user);
        if (dbUser == null || !checkPassword(pass, dbUser.passwordHash)) {
            recordFailedLogin(user, ip);
            Audit.log(user, "LOGIN_FAIL", ip);
            HttpUtil.sendError(ex, 401, "invalid_login");
            return;
        }

        clearFailedLogins(user, ip);

        String sid = UUID.randomUUID().toString();
        sessions.put(sid, new Session(user, dbUser.role));
        HttpUtil.setCookie(ex, "SESSION", sid);

        HttpUtil.sendJson(ex,
                "{\"status\":\"ok\",\"username\":\"" + user +
                        "\",\"role\":\"" + dbUser.role + "\"}");

        Audit.log(user, "LOGIN_SUCCESS", ip);
    }

    static void handleLogout(HttpExchange ex) throws IOException {
        Session s = getSession(ex);
        if (s == null || !checkCsrf(ex, s)) return;

        String sid = HttpUtil.getCookie(ex, "SESSION");
        if (sid != null) sessions.remove(sid);

        HttpUtil.clearCookie(ex, "SESSION");
        HttpUtil.sendJson(ex, "{\"status\":\"logged_out\"}");
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
                        "\",\"csrf\":\"" + s.csrf + "\"}");
    }

    static void handleAuthPing(HttpExchange ex) throws IOException {
        Session s = getSession(ex);
        if (s == null || !checkCsrf(ex, s)) return;

        long now = System.currentTimeMillis();
        if (now - s.lastPing < 1000) {
            HttpUtil.sendError(ex, 429, "too_many_requests");
            return;
        }

        s.lastPing = now;
        HttpUtil.sendJson(ex, "{\"status\":\"ok\"}");
    }

    static void handleConfigLoad(HttpExchange ex) throws IOException {
        Session s = getSession(ex);
        if (s == null || !checkCsrf(ex, s)) return;
        if (!require(s, ex, Permission.VIEW_DATA)) return;
        HttpUtil.sendConfig(ex);
    }

    static void handleConfigSave(HttpExchange ex) throws IOException {
        Session s = getSession(ex);
        if (s == null || !checkCsrf(ex, s)) return;
        if (!require(s, ex, Permission.EDIT_CONFIG)) return;
        HttpUtil.saveConfig(ex);
    }
}
