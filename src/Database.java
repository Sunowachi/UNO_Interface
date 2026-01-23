import java.sql.*;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

public class Database {

    /* ========= CONSOLE COLORS ========= */

    public static final String WHITE  = "\u001B[0m";
    public static final String RED    = "\u001B[31m";
    public static final String GREEN  = "\u001B[32m";
    public static final String YELLOW = "\u001B[33m";

    /* ========= POSTGRES ========= */

    private static final String DB_URL =
            System.getenv().getOrDefault(
                    "DB_URL",
                    "jdbc:postgresql://localhost:5432/sensors"
            );

    // Укажите пользователя, который будет подключаться как сервер к БД. Сервер должен иметь права на редактирование БД
    private static final String DB_USER =
            System.getenv().getOrDefault("DB_USER", "postgres");

    /*
    Чтобы задать пароль для доступа к БД, нужно ввести следующие команды в терминале серверной машины:
    Для bash (Linux):

        export DB_PASS=ПАРОЛЬ ОТ БД
        java -jar server.jar

    Для ini (systemd/сервиса) задать в файле .env значения:

        DB_PASS=ПАРОЛЬ ОТ БД

    Для powershell (Windows). После установки пароля необходимо перезапустить терминал:

        setx DB_PASS "ПАРОЛЬ ОТ БД"
        java -jar server.jar

    Для yaml (Docker):

        environment:
          DB_PASS: ПАРОЛЬ ОТ БД
     */


    private static final String DB_PASS = System.getenv("DB_PASS");

    /* ========= POOL ========= */

    private static final int POOL_SIZE = 10;
    private static final int BORROW_TIMEOUT_MS = 3000;

    private static ArrayBlockingQueue<Connection> pool;

    /* ========= USER MODEL ========= */

    static class User {
        final String passwordHash;
        final String role;

        User(String p, String r) {
            passwordHash = p;
            role = r;
        }
    }

    /* ========= INIT ========= */

    static void init() {

        if (DB_PASS == null || DB_PASS.length() < 4) {
            System.out.println("DB_PASS=" + System.getenv("DB_PASS"));
            throw new IllegalStateException(
                    "DB_PASS must be provided via environment variable"
            );
        }

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

            System.out.println(GREEN +
                    "✔ PostgreSQL connected (pool=" + POOL_SIZE + ")" +
                    WHITE);

        } catch (Exception e) {
            throw new RuntimeException("Database init failed", e);
        }
    }

    private static Connection createConnection() throws SQLException {
        Connection c = DriverManager.getConnection(DB_URL, DB_USER, DB_PASS);
        c.setAutoCommit(true);
        c.setNetworkTimeout(null, 3000);
        return c;
    }

    static Connection borrow() {
        try {
            Connection c = pool.poll(BORROW_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            if (c == null)
                throw new SQLException("DB pool exhausted");

            if (c.isClosed() || !c.isValid(2)) {
                quietlyClose(c);
                return createConnection();
            }
            return c;

        } catch (Exception e) {
            throw new RuntimeException("DB unavailable", e);
        }
    }

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
        try {
            c.close();
        } catch (Exception ignored) {}
    }

    /* ========= TABLES ========= */

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
                FOREIGN KEY (sensor_id)
                    REFERENCES sensors(sensor_id)
                    ON DELETE CASCADE
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

    /* ========= USERS ========= */

    static User findUser(String username) {

        if (username == null || username.length() > 64) return null;

        Connection c = borrow();

        try (PreparedStatement ps = c.prepareStatement(
                "SELECT password_hash, role FROM users WHERE username=?")) {

            ps.setString(1, username);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) return null;

            return new User(
                    rs.getString(1),
                    rs.getString(2)
            );

        } catch (SQLException e) {
            throw new RuntimeException("DB error", e);
        } finally {
            release(c);
        }
    }

    /* ========= DEFAULT DEVELOPER ========= */

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
