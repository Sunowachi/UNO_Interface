import java.io.File;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.sql.*;
import java.util.*;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Управление подключением к PostgreSQL, пулом соединений и основными операциями с БД.
 */
public class Database {

    // ==================== ЦВЕТА ДЛЯ КОНСОЛИ (ANSI) ====================
    public static final String WHITE  = "\u001B[0m";
    public static final String RED    = "\u001B[31m";
    public static final String GREEN  = "\u001B[32m";
    public static final String YELLOW = "\u001B[33m";

    // ==================== КОНФИГУРАЦИЯ ПОДКЛЮЧЕНИЯ ====================
    private static final String DB_URL = System.getenv().getOrDefault(
            "DB_URL", "jdbc:postgresql://localhost:5432/sensors"
    );
    private static final String DB_USER = System.getenv().getOrDefault("DB_USER", "postgres");
    private static final String DB_PASS = System.getenv().getOrDefault("DB_PASS", "1");

    // ==================== ПУЛ СОЕДИНЕНИЙ ====================
    private static final int POOL_SIZE = 10;
    private static final int BORROW_TIMEOUT_MS = 3000;
    private static ArrayBlockingQueue<Connection> pool;

    // ==================== ВНУТРЕННИЙ КЛАСС – ПОЛЬЗОВАТЕЛЬ ====================
    static class User {
        final String passwordHash;
        final String role;
        User(String p, String r) {
            passwordHash = p;
            role = r;
        }
    }

    // ==================== ИНИЦИАЛИЗАЦИЯ ====================

    /** Инициализация драйвера, пула соединений и таблиц */
    static void init() {
        try {
            Class.forName("org.postgresql.Driver");
            pool = new ArrayBlockingQueue<>(POOL_SIZE);

            for (int i = 0; i < POOL_SIZE; i++) {
                pool.add(createConnection());
            }

            Connection c = borrow();
            try (Statement st = c.createStatement()) {
                initTables(st);
            } finally {
                release(c);
            }

            System.out.println(GREEN + "✔ PostgreSQL подключён (пул=" + POOL_SIZE + ")" + WHITE);
        } catch (Exception e) {
            throw new RuntimeException("Ошибка инициализации базы данных", e);
        }
    }

    /** Создание нового физического соединения */
    private static Connection createConnection() throws SQLException {
        Connection c = DriverManager.getConnection(DB_URL, DB_USER, DB_PASS);
        c.setAutoCommit(true);
        c.setNetworkTimeout(null, 3000);
        return c;
    }

    // ==================== УПРАВЛЕНИЕ СОЕДИНЕНИЯМИ ====================

    /** Получение соединения из пула (блокируется при отсутствии) */
    static Connection borrow() {
        try {
            Connection c = pool.poll(BORROW_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            if (c == null) throw new SQLException("Пул соединений исчерпан");

            if (c.isClosed() || !c.isValid(2)) {
                quietlyClose(c);
                return createConnection();
            }
            return c;
        } catch (Exception e) {
            throw new RuntimeException("БД недоступна", e);
        }
    }

    /** Возврат соединения в пул или его закрытие */
    static void release(Connection c) {
        if (c == null) return;
        try {
            if (c.isClosed() || !c.isValid(1) || !pool.offer(c)) {
                quietlyClose(c);
            }
        } catch (Exception e) {
            quietlyClose(c);
        }
    }

    /** Тихая принудительная очистка соединения */
    private static void quietlyClose(Connection c) {
        try { c.close(); } catch (Exception ignored) {}
    }

    // ==================== СОЗДАНИЕ ТАБЛИЦ ====================

    private static void initTables(Statement st) throws SQLException {
        st.execute("""
            CREATE TABLE IF NOT EXISTS users(
                username TEXT PRIMARY KEY CHECK (length(username) <= 64),
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('developer','admin','observer','worker'))
            )
        """);

        st.execute("""
            CREATE TABLE IF NOT EXISTS sensors(
                sensor_id TEXT PRIMARY KEY CHECK (length(sensor_id) <= 64),
                token_hash TEXT NOT NULL,
                encrypted_token TEXT,
                created_at BIGINT NOT NULL,
                last_seen BIGINT NOT NULL,
                register_ip TEXT NOT NULL CHECK (length(register_ip) <= 45),
                deleted BOOLEAN DEFAULT FALSE
            )
        """);

        st.execute("""
            CREATE TABLE IF NOT EXISTS history(
                id BIGSERIAL PRIMARY KEY,
                sensor_id TEXT NOT NULL,
                var_name TEXT NOT NULL CHECK (length(var_name) <= 64),
                ts BIGINT NOT NULL,
                value DOUBLE PRECISION NOT NULL CHECK (value = value),
                FOREIGN KEY (sensor_id) REFERENCES sensors(sensor_id) ON DELETE CASCADE
            )
        """);

        st.execute("""
            CREATE TABLE IF NOT EXISTS failed_logins(
                username TEXT NOT NULL CHECK (length(username) <= 64),
                ip TEXT NOT NULL CHECK (length(ip) <= 45),
                count INT NOT NULL,
                last_fail BIGINT NOT NULL,
                blocked_until BIGINT NOT NULL,
                PRIMARY KEY (username, ip)
            )
        """);

        st.execute("""
            CREATE TABLE IF NOT EXISTS alerts(
                id BIGSERIAL PRIMARY KEY,
                ts BIGINT NOT NULL,
                sensor_id TEXT NOT NULL,
                var_name TEXT NOT NULL,
                value DOUBLE PRECISION NOT NULL,
                users TEXT NOT NULL,
                snapshot TEXT NOT NULL,
                config_hash TEXT NOT NULL
            )
        """);

        st.execute("CREATE INDEX IF NOT EXISTS idx_history_ts ON history(ts)");
        st.execute("CREATE INDEX IF NOT EXISTS idx_history_sensor_var ON history(sensor_id, var_name)");
        st.execute("CREATE INDEX IF NOT EXISTS idx_failed_logins ON failed_logins(username, ip)");
        st.execute("CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts)");
        st.execute("CREATE INDEX IF NOT EXISTS idx_alerts_sensor ON alerts(sensor_id)");
    }

    // ==================== ОПЕРАЦИИ С ПОЛЬЗОВАТЕЛЯМИ ====================

    /** Поиск пользователя по имени, возвращает объект User или null */
    static User findUser(String username) {
        if (username == null || username.length() > 64) return null;

        Connection c = borrow();
        try (PreparedStatement ps = c.prepareStatement(
                "SELECT password_hash, role FROM users WHERE username=?")) {
            ps.setString(1, username);
            ResultSet rs = ps.executeQuery();
            return rs.next() ? new User(rs.getString(1), rs.getString(2)) : null;
        } catch (SQLException e) {
            throw new RuntimeException("Ошибка БД", e);
        } finally {
            release(c);
        }
    }

    /** Создание учётной записи разработчика по умолчанию (если её нет) */
    static void ensureDefaultDeveloper() {
        if (findUser("developer") != null) return;

        String password = UUID.randomUUID().toString();
        String hash = Security.hashPassword(password);

        Connection c = borrow();
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO users(username,password_hash,role) VALUES (?,?,?)")) {
            ps.setString(1, "developer");
            ps.setString(2, hash);
            ps.setString(3, "developer");
            ps.executeUpdate();
        } catch (Exception e) {
            throw new RuntimeException("Не удалось создать аккаунт разработчика: ", e);
        } finally {
            release(c);
        }

        System.out.println(YELLOW + """
            ===========================================================
            ⚠️ ВНИМАНИЕ! Создан аккаунт разработчика!
            🔑 Логин: developer
            🔑 Пароль: """ + RED + password + YELLOW + """
            ⚠️ СОХРАНИТЕ ПАРОЛЬ — он больше не будет показан!
            ===========================================================
            """ + WHITE);

        Audit.info("system", "СОЗДАН_РАЗРАБОТЧИК_ПО_УМОЛЧАНИЮ", "Пароль: Ну ты и смешарик)", "localhost");
    }

    // ==================== ТРЕВОГИ ====================

    /** Запись тревоги в таблицу alerts */
    public static void recordAlert(String sensorId, String varName, double value, String users, String snapshot) {
        Connection c = null;
        try {
            c = borrow();
            String configHash = getConfigHash();
            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO alerts(ts, sensor_id, var_name, value, users, snapshot, config_hash) VALUES (?,?,?,?,?,?,?)")) {
                ps.setLong(1, System.currentTimeMillis());
                ps.setString(2, sensorId);
                ps.setString(3, varName);
                ps.setDouble(4, value);
                ps.setString(5, users);
                ps.setString(6, snapshot);
                ps.setString(7, configHash);
                ps.executeUpdate();
            }
        } catch (SQLException e) {
            Audit.error("system", "ОШИБКА_ЗАПИСИ_ТРЕВОГИ", e.getMessage(), "-");
        } finally {
            release(c);
        }
    }

    /** Вычисление SHA-256 хэша файла конфигурации (web/config.json) */
    private static String getConfigHash() {
        try {
            File f = new File("web/config.json");
            if (!f.exists()) return "";
            byte[] data = Files.readAllBytes(f.toPath());
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(data);
            return Base64.getEncoder().encodeToString(hash);
        } catch (Exception e) {
            Audit.error("system", "ОШИБКА_ВЫЧИСЛЕНИЯ_ХЭША_КОНФИГА", e.getMessage(), "-");
            return "";
        }
    }

    // ==================== ОПЕРАЦИИ С ДАТЧИКАМИ ====================

    /** Получение списка всех датчиков (с расшифрованными токенами) */
    public static List<Map<String, Object>> listSensors() {
        List<Map<String, Object>> result = new ArrayList<>();
        Connection c = borrow();
        try (PreparedStatement ps = c.prepareStatement(
                "SELECT sensor_id, encrypted_token, created_at, last_seen, register_ip, deleted FROM sensors ORDER BY sensor_id")) {
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Map<String, Object> row = new HashMap<>();
                row.put("sensorId", rs.getString(1));
                String encrypted = rs.getString(2);
                if (encrypted != null) {
                    try {
                        row.put("token", Security.decryptToken(encrypted));
                    } catch (Exception e) {
                        row.put("token", "[ошибка дешифровки]");
                    }
                } else {
                    row.put("token", null);
                }
                row.put("createdAt", rs.getLong(3));
                row.put("lastSeen", rs.getLong(4));
                row.put("registerIp", rs.getString(5));
                row.put("deleted", rs.getBoolean(6));
                result.add(row);
            }
        } catch (SQLException e) {
            throw new RuntimeException("Ошибка получения списка датчиков", e);
        } finally {
            release(c);
        }
        return result;
    }

    /** Регистрация датчика администратором (без ключа) */
    public static String registerSensorByAdmin(String sensorId, String ip) {
        if (sensorId == null || sensorId.length() > 64 || ip == null || ip.isEmpty()) return null;
        Connection c = null;
        try {
            c = borrow();
            try (PreparedStatement ps = c.prepareStatement("SELECT 1 FROM sensors WHERE sensor_id=?")) {
                ps.setString(1, sensorId);
                if (ps.executeQuery().next()) return null;
            }
            String token = UUID.randomUUID().toString().replace("-", "");
            String hash = Security.hashToken(token);
            String encryptedToken = Security.encryptToken(token);
            long now = System.currentTimeMillis();
            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO sensors (sensor_id, token_hash, encrypted_token, created_at, last_seen, register_ip, deleted) VALUES (?,?,?,?,?,?,false)")) {
                ps.setString(1, sensorId);
                ps.setString(2, hash);
                ps.setString(3, encryptedToken);
                ps.setLong(4, now);
                ps.setLong(5, now);
                ps.setString(6, ip);
                ps.executeUpdate();
            }
            Audit.info(sensorId, "РЕГИСТРАЦИЯ_ДАТЧИКА_АДМИНОМ", "Датчик зарегистрирован администратором", ip);
            return token;
        } catch (SQLException e) {
            Audit.warn(sensorId, "ОШИБКА_РЕГИСТРАЦИИ_ДАТЧИКА_АДМИНОМ", e.getMessage(), ip);
            return null;
        } finally {
            release(c);
        }
    }

    /** Переключение флага мягкого удаления датчика */
    public static boolean toggleDeleteSensor(String sensorId, boolean deleted) {
        Connection c = null;
        try {
            c = borrow();
            try (PreparedStatement ps = c.prepareStatement(
                    "UPDATE sensors SET deleted=? WHERE sensor_id=?")) {
                ps.setBoolean(1, deleted);
                ps.setString(2, sensorId);
                return ps.executeUpdate() > 0;
            }
        } catch (SQLException e) {
            Audit.warn(sensorId, "ОШИБКА_ПЕРЕКЛЮЧЕНИЯ_УДАЛЕНИЯ", e.getMessage(), "-");
            return false;
        } finally {
            release(c);
        }
    }

    /** Полное удаление датчика из БД */
    public static boolean permanentDeleteSensor(String sensorId) {
        Connection c = null;
        try {
            c = borrow();
            try (PreparedStatement ps = c.prepareStatement("DELETE FROM sensors WHERE sensor_id=?")) {
                ps.setString(1, sensorId);
                return ps.executeUpdate() > 0;
            }
        } catch (SQLException e) {
            Audit.warn(sensorId, "ОШИБКА_ПОЛНОГО_УДАЛЕНИЯ", e.getMessage(), "-");
            return false;
        } finally {
            release(c);
        }
    }

    // ==================== ОПЕРАЦИИ С ПОЛЬЗОВАТЕЛЯМИ (УПРАВЛЕНИЕ) ====================

    /** Получение списка всех пользователей (логин и роль) */
    public static List<Map<String, Object>> listUsers() {
        List<Map<String, Object>> result = new ArrayList<>();
        Connection c = borrow();
        try (PreparedStatement ps = c.prepareStatement(
                "SELECT username, role FROM users ORDER BY username")) {
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Map<String, Object> row = new HashMap<>();
                row.put("username", rs.getString(1));
                row.put("role", rs.getString(2));
                result.add(row);
            }
        } catch (SQLException e) {
            throw new RuntimeException("Ошибка получения списка пользователей", e);
        } finally {
            release(c);
        }
        return result;
    }

    /** Создание нового пользователя с указанными логином и ролью. Возвращает сгенерированный пароль или null */
    public static String createUser(String username, String role) {
        if (username == null || username.length() > 64 || !username.matches("[a-zA-Z0-9_]+")) return null;
        if (role == null || !List.of("developer", "admin", "observer", "worker").contains(role)) return null;

        Connection c = null;
        try {
            c = borrow();
            try (PreparedStatement ps = c.prepareStatement("SELECT 1 FROM users WHERE username=?")) {
                ps.setString(1, username);
                if (ps.executeQuery().next()) return null;
            }

            String password = UUID.randomUUID().toString().replace("-", "");
            String hash = Security.hashPassword(password);

            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO users(username, password_hash, role) VALUES (?,?,?)")) {
                ps.setString(1, username);
                ps.setString(2, hash);
                ps.setString(3, role);
                ps.executeUpdate();
            }

            Audit.info("admin", "ПОЛЬЗОВАТЕЛЬ_СОЗДАН", "Пользователь " + username + " создан с ролью " + role, "system");
            return password;
        } catch (SQLException e) {
            if ("23505".equals(e.getSQLState())) return null;
            Audit.warn("admin", "ОШИБКА_СОЗДАНИЯ_ПОЛЬЗОВАТЕЛЯ", e.getMessage(), "system");
            return null;
        } finally {
            release(c);
        }
    }

    /** Удаление пользователя из БД */
    public static boolean deleteUser(String username) {
        Connection c = null;
        try {
            c = borrow();
            try (PreparedStatement ps = c.prepareStatement("DELETE FROM users WHERE username=?")) {
                ps.setString(1, username);
                int rows = ps.executeUpdate();
                if (rows > 0) {
                    Audit.info("admin", "ПОЛЬЗОВАТЕЛЬ_УДАЛЁН", "Пользователь " + username + " удалён", "system");
                    return true;
                }
                return false;
            }
        } catch (SQLException e) {
            Audit.warn("admin", "ОШИБКА_УДАЛЕНИЯ_ПОЛЬЗОВАТЕЛЯ", e.getMessage(), "system");
            return false;
        } finally {
            release(c);
        }
    }
}