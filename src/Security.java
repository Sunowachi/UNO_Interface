import com.sun.net.httpserver.HttpExchange;

import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Класс безопасности: аутентификация, сессии, хэширование паролей, работа с токенами датчиков.
 */
public class Security {

    // ==================== КОНФИГУРАЦИЯ ====================
    static final long SESSION_TIMEOUT_MS = 10 * 60 * 1000;          // 10 минут неактивности
    static final long MAX_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000; // 8 часов макс. время жизни
    static final int MAX_SESSIONS = 1000;                            // Макс. одновременно активных сессий
    static final int ITERATIONS = 120_000;                           // Итераций PBKDF2
    static final int KEY_LENGTH = 256;                                // Длина ключа (бит)
    static final int MAX_PASSWORD_LENGTH = 256;                       // Макс. длина пароля

    static final String SENSOR_REGISTER_KEY;
    static {
        String key = System.getenv("SENSOR_REGISTER_KEY");
        if (key == null || key.isEmpty()) {
            Path keyFile = Paths.get("reg.key");
            if (Files.exists(keyFile)) {
                try {
                    key = Files.readString(keyFile).trim();
                    if (key.isEmpty()) {
                        throw new IllegalStateException("Файл reg.key пуст");
                    }
                } catch (IOException e) {
                    throw new IllegalStateException("Не удалось прочитать файл с ключом регистрации датчиков: " + keyFile.toAbsolutePath(), e);
                }
            } else {
                throw new IllegalStateException("SENSOR_REGISTER_KEY не задан ни в переменной окружения среды разработки, ни в файле reg.key");
            }
        }
        SENSOR_REGISTER_KEY = key;
    }

    // Ключ шифрования токенов датчиков
    private static final String ENCRYPTION_KEY_ENV = "TOKEN_ENCRYPTION_KEY";
    private static final String ENCRYPTION_KEY_FILE = "encryption.key";
    private static final int KEY_SIZE_BYTES = 32;                     // 256 бит
    private static final byte[] ENCRYPTION_KEY;

    static {
        if (SENSOR_REGISTER_KEY == null || SENSOR_REGISTER_KEY.isEmpty()) {
            throw new IllegalStateException("SENSOR_REGISTER_KEY не установлен!");
        }

        byte[] enckey = null;
        String envKey = System.getenv(ENCRYPTION_KEY_ENV);
        if (envKey != null && !envKey.isEmpty()) {
            try {
                enckey = Base64.getDecoder().decode(envKey);
                if (enckey.length != KEY_SIZE_BYTES) {
                    throw new IllegalArgumentException("Ключ из переменной окружения имеет неверную длину (ожидалось 32 байта)");
                }
            } catch (IllegalArgumentException e) {
                throw new IllegalStateException("Не удалось декодировать TOKEN_ENCRYPTION_KEY как Base64", e);
            }
        } else {
            Path keyFile = Paths.get(ENCRYPTION_KEY_FILE);
            if (Files.exists(keyFile)) {
                try {
                    String fileContent = Files.readString(keyFile).trim();
                    enckey = Base64.getDecoder().decode(fileContent);
                    if (enckey.length != KEY_SIZE_BYTES) {
                        throw new IllegalStateException("Ключ из файла имеет неверную длину");
                    }
                } catch (Exception e) {
                    throw new IllegalStateException("Не удалось прочитать ключ из файла " + ENCRYPTION_KEY_FILE, e);
                }
            } else {
                try {
                    SecureRandom sr = SecureRandom.getInstanceStrong();
                    enckey = new byte[KEY_SIZE_BYTES];
                    sr.nextBytes(enckey);
                    String encoded = Base64.getEncoder().encodeToString(enckey);
                    Files.writeString(keyFile, encoded);
                    System.out.println("🔐 Сгенерирован новый ключ шифрования токенов, сохранён в " + ENCRYPTION_KEY_FILE);
                } catch (Exception e) {
                    throw new IllegalStateException("Не удалось сгенерировать ключ шифрования", e);
                }
            }
        }
        ENCRYPTION_KEY = enckey;
    }

    // Макс. общее количество датчиков
    static final int MAX_SENSORS_TOTAL = Config.getInt("security.maxSensorsTotal", 10_000);
    // Лимит регистраций с одного IP в час
    static final int MAX_SENSOR_REG_PER_IP_PER_HOUR = Config.getInt("security.maxSensorRegPerIpPerHour", 10);

    // ==================== ПРАВА ДОСТУПА ====================
    enum Permission { VIEW_DATA, EDIT_CONFIG, MANAGE_SENSORS, MANAGE_USERS, VIEW_DIAGNOSTIC }

    static final Map<String, Set<Permission>> ROLE_PERMS = Map.of(
            "developer", EnumSet.allOf(Permission.class),
            "admin", EnumSet.of(
                    Permission.VIEW_DATA,
                    Permission.EDIT_CONFIG,
                    Permission.MANAGE_SENSORS,
                    Permission.MANAGE_USERS,
                    Permission.VIEW_DIAGNOSTIC
            ),
            "observer", EnumSet.of(Permission.VIEW_DATA),
            "worker", EnumSet.of(Permission.VIEW_DATA)
    );

    // ==================== ОБРАБОТКА ДАТЧИКОВ ====================

    /** Хэширование токена датчика (SHA-256 + Base64) */
    static String hashToken(String token) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return Base64.getEncoder().encodeToString(md.digest(token.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /** Проверка валидности токена датчика (сравнение хэша, IP, last_seen) */
    static boolean validateSensorToken(String id, String token, InetSocketAddress remote) {
        if (id == null || token == null) return false;

        Connection c = null;
        try {
            c = Database.borrow();
            String storedHash;
            long lastSeen;
            String regIp;

            try (PreparedStatement ps = c.prepareStatement(
                    "SELECT token_hash, last_seen, register_ip FROM sensors WHERE sensor_id=?")) {
                ps.setString(1, id);
                ResultSet rs = ps.executeQuery();
                if (!rs.next()) return false;
                storedHash = rs.getString(1);
                lastSeen = rs.getLong(2);
                regIp = rs.getString(3);
            }

            String incomingHash = hashToken(token);
            if (!MessageDigest.isEqual(
                    Base64.getDecoder().decode(storedHash),
                    Base64.getDecoder().decode(incomingHash))) {
                return false;
            }

            String ip = remote.getAddress().getHostAddress();
            if (!Objects.equals(ip, regIp)) {
                Audit.warn(id, "НЕСООТВЕТСТВИЕ_IP_ДАТЧИКА", "Ожидался IP " + regIp + ", получен " + ip, ip);
                return false;
            }

            long now = System.currentTimeMillis();
            if (now <= lastSeen || now - lastSeen < 100) return false;

            try (PreparedStatement ps = c.prepareStatement(
                    "UPDATE sensors SET last_seen=? WHERE sensor_id=? AND last_seen=?")) {
                ps.setLong(1, now);
                ps.setString(2, id);
                ps.setLong(3, lastSeen);
                ps.executeUpdate();
            }

            return true;
        } catch (Exception e) {
            Audit.warn(id, "ОШИБКА_АУТЕНТИФИКАЦИИ_ДАТЧИКА", "Ошибка проверки токена", remote.toString());
            return false;
        } finally {
            Database.release(c);
        }
    }

    /** Проверка ключа регистрации датчика (сравнение с SENSOR_REGISTER_KEY) */
    static boolean checkSensorRegisterKey(String key) {
        if (key == null) return false;
        return MessageDigest.isEqual(
                SENSOR_REGISTER_KEY.getBytes(StandardCharsets.UTF_8),
                key.trim().getBytes(StandardCharsets.UTF_8)
        );
    }

    /** Регистрация нового датчика (генерация токена, сохранение в БД) */
    static String registerSensor(String sensorId, String ip) {
        if (sensorId == null || sensorId.length() > 64 || ip == null || ip.isEmpty()) return null;

        Connection c = null;
        try {
            c = Database.borrow();

            try (PreparedStatement ps = c.prepareStatement("SELECT COUNT(*) FROM sensors")) {
                ResultSet rs = ps.executeQuery();
                if (rs.next() && rs.getInt(1) >= MAX_SENSORS_TOTAL) return null;
            }

            try (PreparedStatement ps = c.prepareStatement(
                    "SELECT COUNT(*) FROM sensors WHERE created_at > ? AND register_ip = ?")) {
                ps.setLong(1, System.currentTimeMillis() - 3_600_000);
                ps.setString(2, ip);
                ResultSet rs = ps.executeQuery();
                if (rs.next() && rs.getInt(1) >= MAX_SENSOR_REG_PER_IP_PER_HOUR) return null;
            }

            String token = UUID.randomUUID().toString().replace("-", "");
            String hash = hashToken(token);
            String encryptedToken = encryptToken(token);
            long now = System.currentTimeMillis();

            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO sensors (sensor_id, token_hash, created_at, last_seen, register_ip, encrypted_token) VALUES (?,?,?,?,?,?)")) {
                ps.setString(1, sensorId);
                ps.setString(2, hash);
                ps.setLong(3, now);
                ps.setLong(4, now);
                ps.setString(5, ip);
                ps.setString(6, encryptedToken);
                ps.executeUpdate();
            }

            Audit.info(sensorId, "РЕГИСТРАЦИЯ_ДАТЧИКА", "Датчик успешно зарегистрирован", ip);
            return token;
        } catch (SQLException e) {
            if ("23505".equals(e.getSQLState())) return null;
            Audit.warn(sensorId, "ОШИБКА_РЕГИСТРАЦИИ_ДАТЧИКА", "Датчик уже существует", ip);
            return null;
        } finally {
            Database.release(c);
        }
    }

    // ==================== ШИФРОВАНИЕ ТОКЕНОВ (AES-GCM) ====================
    private static final String AES_ALGO = "AES/GCM/NoPadding";
    private static final int GCM_TAG_LENGTH = 128;
    private static final int GCM_IV_LENGTH = 12;

    public static String encryptToken(String token) {
        try {
            byte[] iv = new byte[GCM_IV_LENGTH];
            SecureRandom.getInstanceStrong().nextBytes(iv);
            Cipher cipher = Cipher.getInstance(AES_ALGO);
            SecretKeySpec keySpec = new SecretKeySpec(ENCRYPTION_KEY, "AES");
            GCMParameterSpec gcmSpec = new GCMParameterSpec(GCM_TAG_LENGTH, iv);
            cipher.init(Cipher.ENCRYPT_MODE, keySpec, gcmSpec);
            byte[] cipherText = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
            byte[] combined = new byte[iv.length + cipherText.length];
            System.arraycopy(iv, 0, combined, 0, iv.length);
            System.arraycopy(cipherText, 0, combined, iv.length, cipherText.length);
            return Base64.getEncoder().encodeToString(combined);
        } catch (Exception e) {
            throw new RuntimeException("Ошибка шифрования токена", e);
        }
    }

    public static String decryptToken(String encrypted) {
        try {
            byte[] combined = Base64.getDecoder().decode(encrypted);
            byte[] iv = Arrays.copyOfRange(combined, 0, GCM_IV_LENGTH);
            byte[] cipherText = Arrays.copyOfRange(combined, GCM_IV_LENGTH, combined.length);
            Cipher cipher = Cipher.getInstance(AES_ALGO);
            SecretKeySpec keySpec = new SecretKeySpec(ENCRYPTION_KEY, "AES");
            GCMParameterSpec gcmSpec = new GCMParameterSpec(GCM_TAG_LENGTH, iv);
            cipher.init(Cipher.DECRYPT_MODE, keySpec, gcmSpec);
            byte[] plain = cipher.doFinal(cipherText);
            return new String(plain, StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new RuntimeException("Ошибка дешифрования токена", e);
        }
    }

    // ==================== УПРАВЛЕНИЕ СЕССИЯМИ ====================

    /** Внутренний класс – пользовательская сессия */
    static class Session {
        final String username;
        final String role;
        final long createdAt;
        volatile long lastActive;
        volatile long lastPing;
        final String csrf;

        Session(String u, String r) {
            username = u;
            role = r;
            createdAt = System.currentTimeMillis();
            csrf = UUID.randomUUID().toString();
            touch();
        }

        void touch() {
            lastActive = System.currentTimeMillis();
        }

        boolean expired() {
            long now = System.currentTimeMillis();
            return now - lastActive > SESSION_TIMEOUT_MS || now - createdAt > MAX_SESSION_LIFETIME_MS;
        }
    }

    static final Map<String, Session> sessions = new ConcurrentHashMap<>();

    /** Очистка просроченных сессий */
    static void cleanupSessions() {
        sessions.entrySet().removeIf(e -> e.getValue().expired());
    }

    /** Получение сессии из HTTP-запроса (по куке SESSION) */
    static Session getSession(HttpExchange ex) {
        cleanupSessions();

        String sid = HttpUtil.getCookie(ex, "SESSION");
        if (sid == null) return null;

        Session s = sessions.get(sid);
        if (s == null) {
            String sidPreview = sid.length() > 8 ? sid.substring(0, 8) : sid;
            Audit.info("-", "СЕССИЯ_НЕ_НАЙДЕНА", "ID сессии не найден: " + sidPreview, ex.getRemoteAddress().toString());
            return null;
        }

        if (s.expired()) {
            sessions.remove(sid);
            Audit.info(s.username, "СЕССИЯ_ИСТЕКЛА", "Сессия истекла по таймауту", ex.getRemoteAddress().toString());
            return null;
        }

        s.touch();
        return s;
    }

    /** Проверка CSRF-токена для не-GET запросов */
    static boolean checkCsrf(HttpExchange ex, Session s) throws IOException {
        String method = ex.getRequestMethod();
        if ("GET".equalsIgnoreCase(method)) return true;

        String token = ex.getRequestHeaders().getFirst("X-CSRF-Token");
        if (!Objects.equals(token, s.csrf)) {
            HttpUtil.sendError(ex, 403, "csrf");
            return false;
        }
        return true;
    }

    /** Проверка, имеет ли сессия указанное право доступа */
    static boolean require(Session s, HttpExchange ex, Permission p) throws IOException {
        if (!ROLE_PERMS.getOrDefault(s.role, Set.of()).contains(p)) {
            HttpUtil.sendError(ex, 403, "forbidden");
            Audit.warn(s.username, "ДОСТУП_ЗАПРЕЩЁН", "Недостаточно прав для " + p, ex.getRemoteAddress().getAddress().getHostAddress());
            return false;
        }
        return true;
    }

    /** Определение мобильного устройства по заголовкам */
    private static boolean isMobileRequest(HttpExchange ex) {
        String ua = ex.getRequestHeaders().getFirst("User-Agent");
        if (ua != null) {
            String uaLower = ua.toLowerCase();
            if (uaLower.contains("mobile") || uaLower.contains("android") ||
                    uaLower.contains("iphone") || uaLower.contains("ipad") ||
                    uaLower.contains("ipod") || uaLower.contains("blackberry") ||
                    uaLower.contains("windows phone") || uaLower.contains("opera mini") ||
                    uaLower.contains("iemobile")) {
                return true;
            }
        }

        String mobileHeader = ex.getRequestHeaders().getFirst("X-Client-Mobile");
        if ("true".equalsIgnoreCase(mobileHeader)) {
            return true;
        }

        return false;
    }

    // ==================== УПРАВЛЕНИЕ ПАРОЛЯМИ (PBKDF2) ====================

    /** Хэширование пароля с солью (формат: base64(соль):base64(хэш)) */
    static String hashPassword(String password) {
        if (password == null || password.length() > MAX_PASSWORD_LENGTH)
            throw new IllegalArgumentException("Некорректный пароль");

        try {
            byte[] salt = new byte[16];
            SecureRandom.getInstanceStrong().nextBytes(salt);

            PBEKeySpec spec = new PBEKeySpec(
                    password.toCharArray(),
                    salt,
                    ITERATIONS,
                    KEY_LENGTH
            );

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

    /** Проверка пароля против хранимой строки */
    static boolean checkPassword(String password, String stored) {
        try {
            if (password == null || stored == null) return false;
            if (password.length() > MAX_PASSWORD_LENGTH) return false;

            String[] p = stored.split(":");
            if (p.length != 2) return false;

            byte[] salt = Base64.getDecoder().decode(p[0]);
            byte[] hash = Base64.getDecoder().decode(p[1]);

            PBEKeySpec spec = new PBEKeySpec(
                    password.toCharArray(),
                    salt,
                    ITERATIONS,
                    KEY_LENGTH
            );

            byte[] test = SecretKeyFactory
                    .getInstance("PBKDF2WithHmacSHA256")
                    .generateSecret(spec)
                    .getEncoded();

            return MessageDigest.isEqual(hash, test);
        } catch (Exception e) {
            return false;
        }
    }

    /** Создание учётной записи разработчика по умолчанию (делегирует Database) */
    static void ensureDefaultDeveloper() {
        Database.ensureDefaultDeveloper();
    }

    // ==================== УЧЁТ НЕУДАЧНЫХ ПОПЫТОК ВХОДА ====================

    /** Проверка, заблокирован ли пользователь по IP */
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

    /** Запись неудачной попытки входа (при 5 попытках блокировка на 1 минуту) */
    static void recordFailedLogin(String user, String ip) {
        long now = System.currentTimeMillis();
        Connection c = null;

        try {
            c = Database.borrow();
            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO failed_logins(username,ip,count,last_fail,blocked_until) " +
                            "VALUES (?,?,?,?,0) " +
                            "ON CONFLICT (username,ip) DO UPDATE SET " +
                            "count = CASE WHEN failed_logins.blocked_until < ? THEN 1 ELSE failed_logins.count + 1 END, " +
                            "last_fail = EXCLUDED.last_fail, " +
                            "blocked_until = CASE WHEN failed_logins.count + 1 >= 5 THEN ? ELSE failed_logins.blocked_until END")) {
                ps.setString(1, user);
                ps.setString(2, ip);
                ps.setInt(3, 1);
                ps.setLong(4, now);
                ps.setLong(5, now);
                ps.setLong(6, now + 60_000);
                ps.executeUpdate();
            }
        } catch (Exception e) {
            Audit.log(user, "ОШИБКА_ЗАПИСИ_НЕУДАЧНОЙ_ПОПЫТКИ", ip);
        } finally {
            Database.release(c);
        }
    }

    /** Очистка записей о неудачных попытках после успешного входа */
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
        } catch (Exception e) {
            Audit.log(user, "ОШИБКА_ОЧИСТКИ_НЕУДАЧНЫХ_ПОПЫТОК", ip);
        } finally {
            Database.release(c);
        }
    }

    /** Получение списка имён всех активных (не истёкших) пользователей */
    public static List<String> getActiveUsers() {
        cleanupSessions();
        List<String> users = new ArrayList<>();
        for (Session s : sessions.values()) {
            if (!s.expired()) {
                users.add(s.username);
            }
        }
        return users;
    }

    // ==================== ОБРАБОТЧИКИ HTTP-ЗАПРОСОВ ====================

    /** Обработка входа пользователя (POST /auth/login) */
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

        String ip = ex.getRemoteAddress().getAddress().getHostAddress();

        if (isMobileRequest(ex)) {
            HttpUtil.sendError(ex, 403, "Доступ с мобильных устройств запрещён по политике безопасности");
            Audit.warn("-", "ДОСТУП_С_МОБИЛЬНОГО_ЗАПРЕЩЁН", "Доступ с мобильного устройства заблокирован", ip);
            return;
        }

        var data = HttpUtil.parseJson(ex);
        String user = data.get("username");
        String pass = data.get("password");

        if (user == null || pass == null) {
            HttpUtil.sendError(ex, 400, "bad_request");
            return;
        }

        if (isBlocked(user, ip)) {
            HttpUtil.sendError(ex, 403, "blocked");
            Audit.warn(user, "ВХОД_ЗАБЛОКИРОВАН", "Слишком много неудачных попыток", ip);
            return;
        }

        var dbUser = Database.findUser(user);
        if (dbUser == null || !checkPassword(pass, dbUser.passwordHash)) {
            recordFailedLogin(user, ip);
            Audit.warn(user, "НЕУДАЧНЫЙ_ВХОД", "Неверный пароль", ip);
            HttpUtil.sendError(ex, 401, "invalid_login");
            return;
        }

        clearFailedLogins(user, ip);
        String sid = UUID.randomUUID().toString();
        sessions.put(sid, new Session(user, dbUser.role));
        HttpUtil.setCookie(ex, "SESSION", sid);

        HttpUtil.sendJson(ex, "{\"status\":\"ok\",\"username\":\"" + user +
                "\",\"role\":\"" + dbUser.role + "\"}");
        Audit.info(user, "ВХОД_ВЫПОЛНЕН", ip, sid);
    }

    /** Обработка выхода пользователя (POST /auth/logout) */
    static void handleLogout(HttpExchange ex) throws IOException {
        Session s = getSession(ex);
        if (s == null || !checkCsrf(ex, s)) return;

        String sid = HttpUtil.getCookie(ex, "SESSION");
        if (sid != null) sessions.remove(sid);

        HttpUtil.clearCookie(ex, "SESSION");
        HttpUtil.sendJson(ex, "{\"status\":\"logged_out\"}");
    }

    /** Обработка запроса информации о текущей сессии (GET /auth/me) */
    static void handleAuthMe(HttpExchange ex) throws IOException {
        Session s = getSession(ex);
        if (s == null) {
            HttpUtil.sendError(ex, 401, "unauthorized");
            return;
        }

        HttpUtil.sendJson(ex, "{\"username\":\"" + s.username +
                "\",\"role\":\"" + s.role +
                "\",\"csrf\":\"" + s.csrf +
                "\",\"idleTimeout\":" + SESSION_TIMEOUT_MS + "}");
    }

    /** Обработка ping-запроса для поддержания сессии (POST /auth/ping) */
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

    /** Обработка загрузки конфигурации (GET /config/load) – прокси */
    static void handleConfigLoad(HttpExchange ex) throws IOException {
        Session s = getSession(ex);
        if (s == null || !checkCsrf(ex, s)) return;
        if (!require(s, ex, Permission.VIEW_DATA)) return;
        HttpUtil.sendConfig(ex);
    }

    /** Обработка сохранения конфигурации (POST /config/save) – прокси */
    static void handleConfigSave(HttpExchange ex) throws IOException {
        Session s = getSession(ex);
        if (s == null || !checkCsrf(ex, s)) return;
        if (!require(s, ex, Permission.EDIT_CONFIG)) return;
        HttpUtil.saveConfig(ex);
    }
}