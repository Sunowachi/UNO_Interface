import java.sql.*;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;

public class Database {

    public static final String WHITE = "\u001B[0m";
    public static final String RED = "\u001B[31m";
    public static final String GREEN = "\u001B[32m";
    public static final String YELLOW = "\u001B[33m";

    // ===== POSTGRESQL CONFIG =====
    private static final String DB_URL =
            "jdbc:postgresql://localhost:8080/sensors";
    private static final String DB_USER = "postgres";
    private static final String DB_PASS = "1";

    // ===== POOL CONFIG =====
    private static final int POOL_SIZE = 10;
    private static ArrayBlockingQueue<Connection> pool;

    /* ===== USER MODEL ===== */

    static class User {
        final String passwordHash;
        final String role;

        User(String p, String r) {
            passwordHash = p;
            role = r;
        }
    }

    /* ===== INIT ===== */

    static void init() {
        try {
            Class.forName("org.postgresql.Driver");

            pool = new ArrayBlockingQueue<>(POOL_SIZE);

            for (int i = 0; i < POOL_SIZE; i++) {
                Connection c = DriverManager.getConnection(
                        DB_URL, DB_USER, DB_PASS
                );
                c.setAutoCommit(true);
                pool.add(c);
            }

            try (Connection c = borrow();
                 Statement st = c.createStatement()) {

                initTables(st);
                release(c);
            }

            System.out.println(GREEN +
                    "✔ PostgreSQL connected (pool=" + POOL_SIZE + ")"
                    + WHITE);

        } catch (Exception e) {
            throw new RuntimeException("Database init failed", e);
        }
    }

    /* ===== POOL API ===== */

    static Connection borrow() throws InterruptedException {
        return pool.take();
    }

    static void release(Connection c) {
        if (c != null) pool.offer(c);
    }

    /* ===== TABLES ===== */

    private static void initTables(Statement st) throws SQLException {

        st.execute("""
            CREATE TABLE IF NOT EXISTS users(
                username TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL
            )
        """);

        st.execute("""
            CREATE TABLE IF NOT EXISTS history(
                id BIGSERIAL PRIMARY KEY,
                sensor_id TEXT NOT NULL,
                var_name TEXT NOT NULL,
                ts BIGINT NOT NULL,
                value DOUBLE PRECISION NOT NULL
            )
        """);

        st.execute("""
            CREATE INDEX IF NOT EXISTS idx_history_ts
            ON history(ts)
        """);

        st.execute("""
            CREATE INDEX IF NOT EXISTS idx_history_sensor_var
            ON history(sensor_id, var_name)
        """);
    }

    /* ===== USERS ===== */

    static User findUser(String username) {
        if (username == null || username.length() > 64) return null;

        Connection c = null;
        try {
            c = borrow();

            try (PreparedStatement ps = c.prepareStatement(
                    "SELECT password_hash, role FROM users WHERE username=?")) {

                ps.setString(1, username);
                ResultSet rs = ps.executeQuery();
                if (!rs.next()) return null;

                return new User(
                        rs.getString("password_hash"),
                        rs.getString("role")
                );
            }

        } catch (Exception e) {
            return null;
        } finally {
            release(c);
        }
    }

    /* ===== DEFAULT DEVELOPER ===== */

    static void ensureDefaultDeveloper() {

        if (findUser("developer") != null) return;

        String password = UUID.randomUUID().toString();
        String hash = Security.hashPassword(password);

        Connection c = null;
        try {
            c = borrow();

            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO users(username,password_hash,role) VALUES (?,?,?)")) {

                ps.setString(1, "developer");
                ps.setString(2, hash);
                ps.setString(3, "developer");
                ps.executeUpdate();
            }

        } catch (Exception e) {
            throw new RuntimeException("Failed to create developer account", e);
        } finally {
            release(c);
        }

        System.out.println(YELLOW + """
        ===========================================================
        ⚠️ ВНИМАНИЕ! Создан аккаунт разработчика!""" + GREEN + """
        \n
        🔑 Username: developer
        🔑 Password:""" + RED + password + YELLOW + """
        \n
        ⚠️ СОХРАНИТЕ ЭТОТ ПАРОЛЬ, ЕСЛИ ВЫ РАЗРАБОТЧИК!
        ⚠️ ПАРОЛЬ БОЛЬШЕ НИКОГДА НЕ БУДЕТ ПОКАЗАН!""" + RED + """
        \s
        ⚠️ НИ В КОЕМ СЛУЧАЕ НЕ РАЗГЛАШАЙТЕ ПАРОЛЬ ПОСТОРОННИМ!""" + YELLOW + """
        \s
        ===========================================================
        """ + WHITE);
    }
}