import java.io.File;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.sql.*;
import java.util.*;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

public class Database {
    // Константы цветов для консоли (ANSI-коды)
    public static final String WHITE  = "\u001B[0m";   // Сброс цвета
    public static final String RED    = "\u001B[31m";  // Красный текст
    public static final String GREEN  = "\u001B[32m";  // Зелёный текст
    public static final String YELLOW = "\u001B[33m";  // Жёлтый текст

    // Настройки подключения к БД: берутся из переменных окружения или используются значения по умолчанию
    private static final String DB_URL = System.getenv().getOrDefault(
            "DB_URL", "jdbc:postgresql://localhost:5432/sensors"  // URL для подключения к PostgreSQL
    );
    private static final String DB_USER = System.getenv().getOrDefault("DB_USER", "postgres"); // Имя пользователя
    private static final String DB_PASS = System.getenv().getOrDefault("DB_PASS", "1");         // Пароль

    // Настройки пула соединений
    private static final int POOL_SIZE = 10;                      // Количество соединений в пуле
    private static final int BORROW_TIMEOUT_MS = 3000;            // Таймаут ожидания соединения (мс)
    private static ArrayBlockingQueue<Connection> pool;           // Очередь для пула соединений (потокобезопасная)

    // Внутренний класс, представляющий пользователя (из БД)
    static class User {
        final String passwordHash;   // Хэш пароля
        final String role;           // Роль пользователя
        User(String p, String r) {
            passwordHash = p;
            role = r;
        }
    }

    /* ========== ИНИЦИАЛИЗАЦИЯ ========== */

    // Инициализация базы данных и пула соединений (вызывается при старте)
    static void init() {
        try {
            // Загрузка драйвера PostgreSQL (регистрация в DriverManager)
            Class.forName("org.postgresql.Driver");
            // Создание пула как блокирующей очереди с фиксированной ёмкостью
            pool = new ArrayBlockingQueue<>(POOL_SIZE);

            // Заполнение пула соединениями
            for (int i = 0; i < POOL_SIZE; i++) {
                pool.add(createConnection());   // Создаём соединение и добавляем в очередь
            }

            // Получаем соединение для инициализации таблиц
            Connection c = borrow();
            try (Statement st = c.createStatement()) {
                initTables(st);                  // Создаём таблицы, если их нет
            } finally {
                release(c);                       // Возвращаем соединение обратно в пул
            }

            // Вывод сообщения об успешной инициализации (зелёным цветом)
            System.out.println(GREEN + "✔ PostgreSQL connected (pool=" + POOL_SIZE + ")" + WHITE);
        } catch (Exception e) {
            // При ошибке выбрасываем исключение с описанием
            throw new RuntimeException("Database init failed", e);
        }
    }

    // Создание нового соединения с БД (вызывается при наполнении пула и при необходимости пересоздания)
    private static Connection createConnection() throws SQLException {
        // Устанавливаем соединение через DriverManager
        Connection c = DriverManager.getConnection(DB_URL, DB_USER, DB_PASS);
        // Устанавливаем autoCommit в true (каждый SQL-запрос сразу фиксируется)
        c.setAutoCommit(true);
        // Устанавливаем таймаут сети для соединения (3 секунды)
        c.setNetworkTimeout(null, 3000);
        return c;
    }

    /* ========== УПРАВЛЕНИЕ СОЕДИНЕНИЯМИ ========== */

    // Получение соединения из пула (блокируется до таймаута, если нет свободных)
    static Connection borrow() {
        try {
            // Пытаемся извлечь соединение из очереди; если нет свободных, ждём до BORROW_TIMEOUT_MS
            Connection c = pool.poll(BORROW_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            if (c == null) throw new SQLException("DB pool exhausted"); // Если очередь пуста после таймаута

            // Проверяем, не закрыто ли соединение и валидно ли оно (тест-запрос)
            if (c.isClosed() || !c.isValid(2)) {
                quietlyClose(c);               // Закрываем нерабочее соединение тихо
                return createConnection();      // Создаём новое вместо него
            }
            return c;
        } catch (Exception e) {
            // Любое исключение оборачиваем в RuntimeException
            throw new RuntimeException("DB unavailable", e);
        }
    }

    // Возврат соединения в пул (или закрытие при ошибке)
    static void release(Connection c) {
        if (c == null) return;                     // Если соединение null, ничего не делаем
        try {
            // Если соединение закрыто, невалидно или не удалось вернуть в очередь (пул полон), закрываем его
            if (c.isClosed() || !c.isValid(1) || !pool.offer(c)) {
                quietlyClose(c);
            }
        } catch (Exception e) {
            // При ошибке проверки всё равно пытаемся закрыть
            quietlyClose(c);
        }
    }

    // Закрытие соединения без выброса исключений (тихое закрытие)
    private static void quietlyClose(Connection c) {
        try { c.close(); } catch (Exception ignored) {}   // Игнорируем возможные ошибки
    }

    /* ========== УПРАВЛЕНИЕ ТАБЛИЦАМИ ========== */

    // Создание таблиц и индексов
    private static void initTables(Statement st) throws SQLException {
        // Таблица пользователей
        st.execute("""
            CREATE TABLE IF NOT EXISTS users(
                username TEXT PRIMARY KEY CHECK (length(username) <= 64),
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('developer','admin','observer','worker'))
            )
        """);

        // Таблица датчиков
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

        // Таблица истории показаний
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

        // Таблица неудачных попыток входа
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

        // Таблица тревог
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

        // Индексы
        st.execute("CREATE INDEX IF NOT EXISTS idx_history_ts ON history(ts)");
        st.execute("CREATE INDEX IF NOT EXISTS idx_history_sensor_var ON history(sensor_id, var_name)");
        st.execute("CREATE INDEX IF NOT EXISTS idx_failed_logins ON failed_logins(username, ip)");
        st.execute("CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts)");
        st.execute("CREATE INDEX IF NOT EXISTS idx_alerts_sensor ON alerts(sensor_id)");
    }

    /* ========== ОПЕРАЦИИ С ПОЛЬЗОВАТЕЛЯМИ ========== */

    // Поиск пользователя по имени в БД
    static User findUser(String username) {
        // Проверка длины имени (не больше 64 символов)
        if (username == null || username.length() > 64) return null;

        Connection c = borrow();   // Берём соединение из пула
        try (PreparedStatement ps = c.prepareStatement(
                "SELECT password_hash, role FROM users WHERE username=?")) {
            ps.setString(1, username);   // Устанавливаем параметр запроса
            ResultSet rs = ps.executeQuery(); // Выполняем запрос
            // Если запись найдена, создаём объект User с хэшем пароля и ролью, иначе null
            return rs.next() ? new User(rs.getString(1), rs.getString(2)) : null;
        } catch (SQLException e) {
            throw new RuntimeException("DB error", e);   // Ошибка БД оборачивается
        } finally {
            release(c);   // Возвращаем соединение в пул
        }
    }

    // Создание учётной записи разработчика по умолчанию (если её нет)
    static void ensureDefaultDeveloper() {
        // Если пользователь "developer" уже существует, ничего не делаем
        if (findUser("developer") != null) return;

        // Генерируем случайный пароль
        String password = UUID.randomUUID().toString();
        // Хэшируем пароль с помощью Security.hashPassword
        String hash = Security.hashPassword(password);

        Connection c = borrow();
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO users(username,password_hash,role) VALUES (?,?,?)")) {
            ps.setString(1, "developer");
            ps.setString(2, hash);
            ps.setString(3, "developer");
            ps.executeUpdate();   // Выполняем вставку
        } catch (Exception e) {
            throw new RuntimeException("Не удалось создать аккаунт разработчика: ", e);
        } finally {
            release(c);
        }

        // Выводим в консоль предупреждение
        System.out.println(YELLOW + """
            ===========================================================
            ⚠️ ВНИМАНИЕ! Создан аккаунт разработчика!
            🔑 Username: developer
            🔑 Password: """ + RED + password + YELLOW + """
            ⚠️ СОХРАНИТЕ ПАРОЛЬ — он больше не будет показан!
            ===========================================================
            """ + WHITE);

        Audit.info("system", "DEFAULT_DEVELOPER_CREATED", "Password: " + password, "localhost");
    }

    // Запись тревоги в БД
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
            Audit.error("system", "ALERT_RECORD_FAIL", e.getMessage(), "-");
        } finally {
            release(c);
        }
    }

    // Вычисление хэша конфигурационного файла
    private static String getConfigHash() {
        try {
            File f = new File("web/config.json");
            if (!f.exists()) return "";
            byte[] data = Files.readAllBytes(f.toPath());
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(data);
            return Base64.getEncoder().encodeToString(hash);
        } catch (Exception e) {
            Audit.error("system", "CONFIG_HASH_FAIL", e.getMessage(), "-");
            return "";
        }
    }

    // Получение списка всех датчиков (с расшифрованными токенами)
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

    // Регистрация датчика администратором (без ключа)
    public static String registerSensorByAdmin(String sensorId, String ip) {
        if (sensorId == null || sensorId.length() > 64 || ip == null || ip.isEmpty()) return null;
        Connection c = null;
        try {
            c = borrow();
            // Проверка уникальности
            try (PreparedStatement ps = c.prepareStatement("SELECT 1 FROM sensors WHERE sensor_id=?")) {
                ps.setString(1, sensorId);
                if (ps.executeQuery().next()) return null; // уже есть
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
            Audit.info(sensorId, "SENSOR_REGISTER_BY_ADMIN", "Sensor registered by admin", ip);
            return token;
        } catch (SQLException e) {
            Audit.warn(sensorId, "SENSOR_REGISTER_ADMIN_FAIL", e.getMessage(), ip);
            return null;
        } finally {
            release(c);
        }
    }

    // Мягкое удаление / восстановление датчика (переключение флага deleted)
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
            Audit.warn(sensorId, "SENSOR_TOGGLE_DELETE_FAIL", e.getMessage(), "-");
            return false;
        } finally {
            release(c);
        }
    }

    // Полное удаление датчика из БД
    public static boolean permanentDeleteSensor(String sensorId) {
        Connection c = null;
        try {
            c = borrow();
            try (PreparedStatement ps = c.prepareStatement("DELETE FROM sensors WHERE sensor_id=?")) {
                ps.setString(1, sensorId);
                return ps.executeUpdate() > 0;
            }
        } catch (SQLException e) {
            Audit.warn(sensorId, "SENSOR_PERMANENT_DELETE_FAIL", e.getMessage(), "-");
            return false;
        } finally {
            release(c);
        }
    }

    // ================= ОПЕРАЦИИ С ПОЛЬЗОВАТЕЛЯМИ =================

    /**
     * Возвращает список всех пользователей (логин и роль).
     */
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

    /**
     * Создаёт нового пользователя с указанным логином и ролью.
     * Генерирует случайный пароль, хэширует его и сохраняет в БД.
     * @return сгенерированный открытый пароль или null при ошибке (например, пользователь уже существует).
     */
    public static String createUser(String username, String role) {
        if (username == null || username.length() > 64 || !username.matches("[a-zA-Z0-9_]+")) return null;
        if (role == null || !List.of("developer", "admin", "observer", "worker").contains(role)) return null;

        Connection c = null;
        try {
            c = borrow();
            // Проверка уникальности
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

            Audit.info("admin", "USER_CREATED", "User " + username + " created with role " + role, "system");
            return password;
        } catch (SQLException e) {
            if ("23505".equals(e.getSQLState())) return null; // unique violation
            Audit.warn("admin", "USER_CREATE_FAIL", e.getMessage(), "system");
            return null;
        } finally {
            release(c);
        }
    }

    /**
     * Удаляет пользователя из БД.
     */
    public static boolean deleteUser(String username) {
        Connection c = null;
        try {
            c = borrow();
            try (PreparedStatement ps = c.prepareStatement("DELETE FROM users WHERE username=?")) {
                ps.setString(1, username);
                int rows = ps.executeUpdate();
                if (rows > 0) {
                    Audit.info("admin", "USER_DELETED", "User " + username + " deleted", "system");
                    return true;
                }
                return false;
            }
        } catch (SQLException e) {
            Audit.warn("admin", "USER_DELETE_FAIL", e.getMessage(), "system");
            return false;
        } finally {
            release(c);
        }
    }
}