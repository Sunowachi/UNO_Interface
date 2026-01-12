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
            initTables();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    static void initTables() throws SQLException {
        try (Statement st = db.createStatement()) {
            st.execute("""
                CREATE TABLE IF NOT EXISTS users(
                    username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL
                )""");
            st.execute("""
                CREATE TABLE IF NOT EXISTS history(
                    id INTEGER PRIMARY KEY,
                    sensor_id TEXT NOT NULL,
                    var_name TEXT NOT NULL,
                    ts INTEGER NOT NULL,
                    value REAL NOT NULL
                )""");
        }
    }

    static User findUser(String username) {
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

    // НЕ ЗАБЫТЬ ПРО ВТОРОЙ АККАУНТ! ОН НУЖЕН ТОЛЬКО ПРИ РАЗРАБОТКЕ!
    static void ensureDefaultDeveloper() {

        if (findUser("developer") != null) {
            return;
        }

        try (PreparedStatement ps = db.prepareStatement(
                "INSERT OR IGNORE INTO users(username,password_hash,role) VALUES (?,?,?)")) {
            ps.setString(1, "developer");
            ps.setString(2, Security.hashPassword(
                    UUID.randomUUID().toString()
            ));
            ps.setString(3, "developer");
            ps.executeUpdate();
        } catch (Exception ignored) {}

        // =======================================================================
        // =======================================================================
        // АККАУНТ НИЖЕ УДАЛИТЬ ПОСЛЕ КОНЦА РАЗРАБОТКИ. ЭТО ТЕСТОВЫЙ АККАУНТ!!!
        // =======================================================================
        // =======================================================================

        try (PreparedStatement ps = db.prepareStatement(
                "INSERT OR IGNORE INTO users(username,password_hash,role) VALUES (?,?,?)")) {
            ps.setString(1, "1");
            ps.setString(2, Security.hashPassword("1"));
            ps.setString(3, "developer");
            ps.executeUpdate();
        } catch (Exception ignored) {}

        // =======================================================================
        // =======================================================================
        // =======================================================================
        // =======================================================================
        // =======================================================================
    }
}