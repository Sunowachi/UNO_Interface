import java.sql.*;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

public class Database {
    // Константы цветов для консоли
    public static final String WHITE  = "\u001B[0m";
    public static final String RED    = "\u001B[31m";
    public static final String GREEN  = "\u001B[32m";
    public static final String YELLOW = "\u001B[33m";

    // Настройки подключения к БД
    private static final String DB_URL = System.getenv().getOrDefault(
            "DB_URL", "jdbc:postgresql://localhost:5432/sensors"
    );
    private static final String DB_USER = System.getenv().getOrDefault("DB_USER", "postgres");
    private static final String DB_PASS = System.getenv().getOrDefault("DB_PASS", "1");

    // Настройки пула соединений
    private static final int POOL_SIZE = 10;
    private static final int BORROW_TIMEOUT_MS = 3000;
    private static ArrayBlockingQueue<Connection> pool;

    // Модель пользователя
    static class User {
        final String passwordHash;
        final String role;
        User(String p, String r) {
            passwordHash = p;
            role = r;
        }
    }

    /* ========== ИНИЦИАЛИЗАЦИЯ ========== */

    // Инициализация базы данных и пула соединений
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

            System.out.println(GREEN + "✔ PostgreSQL connected (pool=" + POOL_SIZE + ")" + WHITE);
        } catch (Exception e) {
            throw new RuntimeException("Database init failed", e);
        }
    }

    // Создание нового соединения с БД
    private static Connection createConnection() throws SQLException {
        Connection c = DriverManager.getConnection(DB_URL, DB_USER, DB_PASS);
        c.setAutoCommit(true);
        c.setNetworkTimeout(null, 3000);
        return c;
    }

    /* ========== УПРАВЛЕНИЕ СОЕДИНЕНИЯМИ ========== */

    // Получение соединения из пула
    static Connection borrow() {
        try {
            Connection c = pool.poll(BORROW_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            if (c == null) throw new SQLException("DB pool exhausted");

            if (c.isClosed() || !c.isValid(2)) {
                quietlyClose(c);
                return createConnection();
            }
            return c;
        } catch (Exception e) {
            throw new RuntimeException("DB unavailable", e);
        }
    }

    // Возврат соединения в пул
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

    private static void quietlyClose(Connection c) {
        try { c.close(); } catch (Exception ignored) {}
    }

    /* ========== УПРАВЛЕНИЕ ТАБЛИЦАМИ ========== */

    // Создание таблиц и индексов
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
                created_at BIGINT NOT NULL,
                last_seen BIGINT NOT NULL,
                register_ip TEXT NOT NULL CHECK (length(register_ip) <= 45)
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

        st.execute("CREATE INDEX IF NOT EXISTS idx_history_ts ON history(ts)");
        st.execute("CREATE INDEX IF NOT EXISTS idx_history_sensor_var ON history(sensor_id, var_name)");
        st.execute("CREATE INDEX IF NOT EXISTS idx_failed_logins ON failed_logins(username, ip)");
    }

    /* ========== ОПЕРАЦИИ С ПОЛЬЗОВАТЕЛЯМИ ========== */

    // Поиск пользователя по имени
    static User findUser(String username) {
        if (username == null || username.length() > 64) return null;

        Connection c = borrow();
        try (PreparedStatement ps = c.prepareStatement(
                "SELECT password_hash, role FROM users WHERE username=?")) {
            ps.setString(1, username);
            ResultSet rs = ps.executeQuery();
            return rs.next() ? new User(rs.getString(1), rs.getString(2)) : null;
        } catch (SQLException e) {
            throw new RuntimeException("DB error", e);
        } finally {
            release(c);
        }
    }

    // Создание учетной записи разработчика по умолчанию
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
            throw new RuntimeException("Failed to create developer account", e);
        } finally {
            release(c);
        }

        System.out.println(YELLOW + """
            ===========================================================
            ⚠️ ВНИМАНИЕ! Создан аккаунт разработчика!
            🔑 Username: developer
            🔑 Password: """ + RED + password + YELLOW + """
            ⚠️ СОХРАНИТЕ ПАРОЛЬ — он больше не будет показан!
            ===========================================================
            """ + WHITE);
    }
}