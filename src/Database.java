import java.sql.*;
import java.util.UUID;

public class Database {

    static Connection db;

    static class User {
        final String passwordHash;
        final String role;
        User(String p, String r) {
            passwordHash = p;
            role = r;
        }
    }

    static void init() {
        try {
            Class.forName("org.sqlite.JDBC");
            db = DriverManager.getConnection("jdbc:sqlite:sensors.db");

            try (Statement st = db.createStatement()) {
                st.execute("PRAGMA foreign_keys = ON");
                st.execute("PRAGMA journal_mode = WAL");
                st.execute("PRAGMA busy_timeout = 5000");
            }

            initTables();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    static void initTables() throws SQLException {
        try (Statement st = db.createStatement()) {

            st.execute("""
                CREATE TABLE IF NOT EXISTS users(
                    username TEXT PRIMARY KEY,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL
                )""");

            st.execute("""
                CREATE TABLE IF NOT EXISTS history(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sensor_id TEXT NOT NULL,
                    var_name TEXT NOT NULL,
                    ts INTEGER NOT NULL,
                    value REAL NOT NULL
                )""");

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

    static User findUser(String username) {
        if (username == null || username.length() > 64) return null;

        try (PreparedStatement ps = db.prepareStatement(
                "SELECT password_hash, role FROM users WHERE username=?")) {

            ps.setString(1, username);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) return null;

            return new User(rs.getString(1), rs.getString(2));
        } catch (Exception e) {
            return null;
        }
    }

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

        System.out.println("""
        ==============================================
        ⚠️ ВНИМАНИЕ! Создан аккаунт разработчика!
        
        🔑 Username: developer
        🔑 Password:\s""" + password + """
        
        ⚠️  СОХРАНИТЕ ЭТОТ ПАРОЛЬ, ЕСЛИ ВЫ РАЗРАБОТЧИК!
        ⚠️  ПАРОЛЬ БОЛЬШЕ НИКОГДА НЕ БУДЕТ ПОКАЗАН!
        ==============================================
        """);
    }
}
