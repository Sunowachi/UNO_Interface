import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

public class Security {

    static final long SESSION_TIMEOUT_MS = 10 * 60 * 1000;
    static final long MAX_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;

    static final int ITERATIONS = 120_000;
    static final int KEY_LENGTH = 256;

    static final int MAX_SESSIONS = 1000;

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

    static final String SENSOR_REGISTER_KEY = "CHANGE_ME_REGISTER_KEY";

    /* ==== SENSOR SECURITY VIA DB ==== */

    static boolean checkSensorToken(String id, String token) {
        if (id == null || token == null) return false;
        Connection c = null;
        try {
            c = Database.borrow();
            try (PreparedStatement ps = c.prepareStatement(
                    "SELECT 1 FROM sensors WHERE sensor_id=? AND token=?")) {
                ps.setString(1, id);
                ps.setString(2, token);
                ResultSet rs = ps.executeQuery();
                if (!rs.next()) return false;
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
                ResultSet rs = ps.executeQuery();
                return rs.next();
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
        Connection c = null;
        try {
            c = Database.borrow();
            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO sensors(sensor_id,token,created_at) VALUES (?,?,?)")) {
                ps.setString(1, sensorId);
                ps.setString(2, token);
                ps.setLong(3, System.currentTimeMillis());
                ps.executeUpdate();
            }
            return token;
        } catch (Exception e) {
            return null;
        } finally {
            Database.release(c);
        }
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
        if (s != null) s.touch();
        return s;
    }

    static Session peekSession(HttpExchange ex) {
        String sid = HttpUtil.getCookie(ex, "SESSION");
        if (sid == null) return null;

        Session s = sessions.get(sid);
        if (s == null) return null;

        String ua = ex.getRequestHeaders().getFirst("User-Agent");
        if (!Objects.equals(s.userAgent, ua) || s.expired()) {
            sessions.remove(sid);
            return null;
        }

        return s;
    }

    static boolean checkCsrf(HttpExchange ex, Session s) throws IOException {
        String token = ex.getRequestHeaders().getFirst("X-CSRF-Token");
        if (!Objects.equals(token, s.csrfToken)) {
            HttpUtil.sendError(ex, 403, "csrf");
            return false;
        }
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

    /* ==== FAILED LOGIN (PostgreSQL) ==== */

    static boolean isBlocked(String user, String ip) {
        Connection c = null;
        try {
            c = Database.borrow();
            try (PreparedStatement ps = c.prepareStatement(
                    "SELECT blocked_until FROM failed_logins WHERE username=? AND ip=?")) {

                ps.setString(1, user);
                ps.setString(2, ip);
                ResultSet rs = ps.executeQuery();
                if (!rs.next()) return false;

                return rs.getLong(1) > System.currentTimeMillis();
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

    /* ==== handlers ==== */

    static void handleLogin(HttpExchange ex) throws IOException {

        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }

        if (sessions.size() > MAX_SESSIONS) {
            HttpUtil.sendError(ex, 503, "too_many_sessions");
            return;
        }

        String ua = ex.getRequestHeaders().getFirst("User-Agent");
        if (ua == null || ua.matches(".*(Android|iPhone|Mobile).*")) {
            HttpUtil.sendError(ex, 403, "forbidden_device");
            return;
        }

        String ip = ex.getRemoteAddress().getAddress().getHostAddress();
        var data = HttpUtil.parseJson(ex);
        var user = data.get("username");
        var pass = data.get("password");
        var dbUser = Database.findUser(user);

        if (isBlocked(user, ip)) {
            HttpUtil.sendError(ex, 403, "blocked");
            return;
        }

        if (dbUser == null || !checkPassword(pass, dbUser.passwordHash)) {
            recordFailedLogin(user, ip);
            Audit.log(user, "LOGIN_FAIL", ip);
            HttpUtil.sendError(ex, 401, "invalid_login");
            return;
        }

        clearFailedLogins(user, ip);

        String oldSid = HttpUtil.getCookie(ex, "SESSION");
        if (oldSid != null) {
            sessions.remove(oldSid);
            HttpUtil.clearCookie(ex, "SESSION");
        }

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

        Audit.log(s.username, "LOGOUT",
                ex.getRemoteAddress().getAddress().getHostAddress());
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
        if (s == null || !checkCsrf(ex, s)) return;

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
        if (s == null || !checkCsrf(ex, s)) return;
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
