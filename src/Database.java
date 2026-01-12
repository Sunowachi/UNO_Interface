import java.sql.*;
import java.util.UUID;

public class Database {

    public static final String WHITE = "\u001B[0m";
    public static final String RED = "\u001B[31m";
    public static final String GREEN = "\u001B[32m";
    public static final String YELLOW = "\u001B[33m";

    // === НАСТРОЙКИ POSTGRESQL ===
    private static final String DB_URL =
            "jdbc:postgresql://localhost:8080/sensors";
    private static final String DB_USER = "postgres";
    private static final String DB_PASS = "1";

    static Connection db;

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

            db = DriverManager.getConnection(
                    DB_URL,
                    DB_USER,
                    DB_PASS
            );

            db.setAutoCommit(true);

            initTables();

            System.out.println(GREEN + "✔ Connected to PostgreSQL" + WHITE);

        } catch (Exception e) {
            throw new RuntimeException("Database init failed", e);
        }
    }

    /* ===== TABLES ===== */

    static void initTables() throws SQLException {
        try (Statement st = db.createStatement()) {

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
    }

    /* ===== USERS ===== */

    static User findUser(String username) {
        if (username == null || username.length() > 64) return null;

        try (PreparedStatement ps = db.prepareStatement(
                "SELECT password_hash, role FROM users WHERE username=?")) {

            ps.setString(1, username);

            ResultSet rs = ps.executeQuery();
            if (!rs.next()) return null;

            return new User(
                    rs.getString("password_hash"),
                    rs.getString("role")
            );

        } catch (Exception e) {
            return null;
        }
    }

    /* ===== DEFAULT DEVELOPER ===== */

    static void ensureDefaultDeveloper() {

        if (findUser("developer") != null) {
            return;
        }

        String password = UUID.randomUUID().toString();
        String hash = Security.hashPassword(password);

        try (PreparedStatement ps = db.prepareStatement(
                "INSERT INTO users(username,password_hash,role) VALUES (?,?,?)")) {

            ps.setString(1, "developer");
            ps.setString(2, hash);
            ps.setString(3, "developer");
            ps.executeUpdate();

        } catch (Exception e) {
            throw new RuntimeException("Failed to create developer account", e);
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
