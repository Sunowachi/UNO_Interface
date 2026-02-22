import com.sun.net.httpserver.HttpExchange;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

public class Security {
    // ================= КОНФИГУРАЦИЯ =================

    // Время неактивности сессии до истечения (10 минут в миллисекундах)
    static final long SESSION_TIMEOUT_MS = 10 * 60 * 1000;
    // Максимальное время жизни сессии (8 часов)
    static final long MAX_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
    // Максимальное количество одновременно активных сессий
    static final int MAX_SESSIONS = 1000;
    // Количество итераций PBKDF2 для хэширования пароля
    static final int ITERATIONS = 120_000;
    // Длина ключа (выходного хэша) в битах
    static final int KEY_LENGTH = 256;
    // Максимальная длина пароля (ограничение для защиты от DoS)
    static final int MAX_PASSWORD_LENGTH = 256;

    // Ключ для регистрации новых датчиков, берётся из переменной окружения
    static final String SENSOR_REGISTER_KEY = System.getenv("SENSOR_REGISTER_KEY");

    // Статический блок инициализации: проверяет, что ключ регистрации задан
    static {
        // Если переменная окружения не установлена или пуста – выбрасываем исключение
        if (SENSOR_REGISTER_KEY == null || SENSOR_REGISTER_KEY.isEmpty()) {
            throw new IllegalStateException("SENSOR_REGISTER_KEY должен быть установлен через переменную среды");
        }
    }

    // Максимальное общее количество датчиков, которые можно зарегистрировать
    static final int MAX_SENSORS_TOTAL = 10_000;
    // Максимальное количество регистраций с одного IP в час
    static final int MAX_SENSOR_REG_PER_IP_PER_HOUR = 10;

    // Перечисление возможных прав доступа
    enum Permission { VIEW_DATA, EDIT_CONFIG }

    // Карта ролей и соответствующих им прав (неизменяемая)
    static final Map<String, Set<Permission>> ROLE_PERMS = Map.of(
            "developer", EnumSet.allOf(Permission.class),           // разработчик имеет все права
            "admin", EnumSet.of(Permission.VIEW_DATA, Permission.EDIT_CONFIG), // админ: просмотр и редактирование
            "observer", EnumSet.of(Permission.VIEW_DATA),           // наблюдатель: только просмотр
            "worker", EnumSet.of(Permission.VIEW_DATA)              // рабочий: только просмотр
    );

    // ================= ОБРАБОТКА ДАТЧИКОВ =================

    // Хэширование токена датчика с помощью SHA-256 и кодирование в Base64
    static String hashToken(String token) {
        try {
            // Получение экземпляра MessageDigest для алгоритма SHA-256
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            // Вычисление хэша от токена (в байтах UTF-8) и кодирование результата в Base64
            return Base64.getEncoder().encodeToString(md.digest(token.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            // В случае ошибки (например, алгоритм не найден) выбрасываем runtime-исключение
            throw new RuntimeException(e);
        }
    }

    // Проверка валидности токена датчика
    static boolean validateSensorToken(String id, String token, InetSocketAddress remote) {
        // Если ID или токен равны null – сразу невалидно
        if (id == null || token == null) return false;

        Connection c = null;
        try {
            // Заимствование соединения из пула Database
            c = Database.borrow();
            String storedHash;
            long lastSeen;
            String regIp;

            // Запрос к БД: получаем хэш токена, время последнего обращения и IP регистрации
            try (PreparedStatement ps = c.prepareStatement(
                    "SELECT token_hash, last_seen, register_ip FROM sensors WHERE sensor_id=?")) {
                ps.setString(1, id);                // подставляем ID датчика
                ResultSet rs = ps.executeQuery();    // выполняем запрос
                if (!rs.next()) return false;        // если датчик не найден – false
                storedHash = rs.getString(1);        // сохраняем хэш из БД
                lastSeen = rs.getLong(2);             // сохраняем время последнего обращения
                regIp = rs.getString(3);              // сохраняем IP регистрации
            }

            // Вычисляем хэш от предъявленного токена
            String incomingHash = hashToken(token);
            // Сравниваем хэши безопасным способом (без утечки времени)
            if (!MessageDigest.isEqual(
                    Base64.getDecoder().decode(storedHash),   // декодируем хранимый хэш
                    Base64.getDecoder().decode(incomingHash))) { // декодируем вновь вычисленный
                return false;
            }

            // Получаем IP-адрес клиента из запроса
            String ip = remote.getAddress().getHostAddress();
            // Проверяем, совпадает ли IP с тем, что был при регистрации
            if (!Objects.equals(ip, regIp)) {
                // Если не совпадает – пишем в аудит и отклоняем
                Audit.warn(id, "SENSOR_IP_MISMATCH", "IP mismatch: expected " + regIp + ", got " + ip, ip);
                return false;
            }

            long now = System.currentTimeMillis(); // текущее время
            // Проверка, что время не идёт назад (now <= lastSeen) и что прошло не меньше 100 мс с последнего обращения
            if (now <= lastSeen || now - lastSeen < 100) return false;

            // Обновляем last_seen в БД (оптимистичная блокировка через проверку старого значения)
            try (PreparedStatement ps = c.prepareStatement(
                    "UPDATE sensors SET last_seen=? WHERE sensor_id=? AND last_seen=?")) {
                ps.setLong(1, now);          // новое время
                ps.setString(2, id);          // ID датчика
                ps.setLong(3, lastSeen);      // старое время (для проверки)
                ps.executeUpdate();            // выполняем обновление
            }

            return true; // всё успешно
        } catch (Exception e) {
            // В случае исключения – запись в аудит и возврат false
            Audit.warn(id, "SENSOR_AUTH_FAIL", "Token validation failed", remote.toString());
            return false;
        } finally {
            // Возвращаем соединение обратно в пул
            Database.release(c);
        }
    }

    // Проверка ключа регистрации датчика (сравнение с SENSOR_REGISTER_KEY)
    static boolean checkSensorRegisterKey(String key) {
        if (key == null) return false; // если ключ пустой – false
        // Безопасное сравнение массивов байт, чтобы избежать timing-атак
        return MessageDigest.isEqual(
                SENSOR_REGISTER_KEY.getBytes(StandardCharsets.UTF_8), // байты эталонного ключа
                key.trim().getBytes(StandardCharsets.UTF_8)          // байты переданного ключа (с обрезанными пробелами)
        );
    }

    // Регистрация нового датчика
    static String registerSensor(String sensorId, String ip) {
        // Проверка входных данных: ID не null и не длиннее 64, IP не null и не пуст
        if (sensorId == null || sensorId.length() > 64 || ip == null || ip.isEmpty()) return null;

        Connection c = null;
        try {
            c = Database.borrow(); // заимствуем соединение

            // Проверка общего количества датчиков
            try (PreparedStatement ps = c.prepareStatement("SELECT COUNT(*) FROM sensors")) {
                ResultSet rs = ps.executeQuery();
                if (rs.next() && rs.getInt(1) >= MAX_SENSORS_TOTAL) return null; // превышен лимит
            }

            // Проверка количества регистраций с этого IP за последний час
            try (PreparedStatement ps = c.prepareStatement(
                    "SELECT COUNT(*) FROM sensors WHERE created_at > ? AND register_ip = ?")) {
                ps.setLong(1, System.currentTimeMillis() - 3_600_000); // время 1 час назад
                ps.setString(2, ip);                                   // IP клиента
                ResultSet rs = ps.executeQuery();
                if (rs.next() && rs.getInt(1) >= MAX_SENSOR_REG_PER_IP_PER_HOUR) return null; // превышен лимит на IP
            }

            // Генерация нового токена (убираем дефисы из UUID)
            String token = UUID.randomUUID().toString().replace("-", "");
            // Хэширование токена для хранения в БД
            String hash = hashToken(token);
            long now = System.currentTimeMillis(); // текущее время

            // Вставка новой записи о датчике
            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO sensors (sensor_id, token_hash, created_at, last_seen, register_ip) VALUES (?,?,?,?,?)")) {
                ps.setString(1, sensorId);   // ID датчика
                ps.setString(2, hash);        // хэш токена
                ps.setLong(3, now);            // время создания
                ps.setLong(4, now);            // время последнего обращения (равно созданию)
                ps.setString(5, ip);            // IP регистрации
                ps.executeUpdate();              // выполняем вставку
            }

            Audit.info(sensorId, "SENSOR_REGISTER", "Sensor registered successfully", ip);
            return token; // возвращаем незахэшированный токен клиенту
        } catch (SQLException e) {
            // Если нарушено уникальное ограничение (SQLSTATE 23505) – значит датчик уже существует
            if ("23505".equals(e.getSQLState())) return null;
            // В остальных случаях пишем в аудит
            Audit.warn(sensorId, "SENSOR_REGISTER_FAIL", "Sensor already exists", ip);
            return null;
        } finally {
            Database.release(c); // возвращаем соединение
        }
    }

    // ================= УПРАВЛЕНИЕ СЕССИЯМИ =================

    // Внутренний класс, представляющий пользовательскую сессию
    static class Session {
        final String username;   // имя пользователя
        final String role;       // роль пользователя
        final long createdAt;    // время создания сессии (мс)
        volatile long lastActive; // время последней активности (обновляется при каждом обращении)
        volatile long lastPing;   // время последнего ping-запроса (для rate limiting)
        final String csrf;        // CSRF-токен для защиты от межсайтовой подделки запросов

        // Конструктор сессии
        Session(String u, String r) {
            username = u;
            role = r;
            createdAt = System.currentTimeMillis();
            csrf = UUID.randomUUID().toString(); // генерируем уникальный CSRF-токен
            touch(); // устанавливаем lastActive = now
        }

        // Обновление времени последней активности
        void touch() {
            lastActive = System.currentTimeMillis();
        }

        // Проверка, истекла ли сессия (по таймауту неактивности или по максимальному времени жизни)
        boolean expired() {
            long now = System.currentTimeMillis();
            return now - lastActive > SESSION_TIMEOUT_MS || now - createdAt > MAX_SESSION_LIFETIME_MS;
        }
    }

    // Потокобезопасное хранилище активных сессий (ключ – SESSION ID)
    static final Map<String, Session> sessions = new ConcurrentHashMap<>();

    // Очистка просроченных сессий
    static void cleanupSessions() {
        // Удаляем все записи, у которых expired() возвращает true
        sessions.entrySet().removeIf(e -> e.getValue().expired());
    }

    // Получение сессии из HTTP-запроса (по куке SESSION)
    static Session getSession(HttpExchange ex) {
        cleanupSessions(); // предварительно чистим истёкшие сессии

        // Чтение куки SESSION с помощью утилитного метода
        String sid = HttpUtil.getCookie(ex, "SESSION");
        if (sid == null) return null; // если куки нет – сессии нет

        // Получаем сессию по идентификатору
        Session s = sessions.get(sid);
        if (s == null) {
            // Если сессия не найдена, логируем факт (обрезаем sid для безопасности)
            String sidPreview = sid.length() > 8 ? sid.substring(0, 8) : sid;
            Audit.info("-", "SESSION_MISS", "Session ID not found: " + sidPreview, ex.getRemoteAddress().toString());
            return null;
        }

        // Проверяем, не истекла ли сессия (повторно, на случай если просрочилась после cleanup)
        if (s.expired()) {
            sessions.remove(sid); // удаляем истекшую
            Audit.info(s.username, "SESSION_EXPIRED", "Session timed out", ex.getRemoteAddress().toString());
            return null;
        }

        // Обновляем время активности
        s.touch();
        return s;
    }

    // Проверка CSRF-токена для не-GET запросов
    static boolean checkCsrf(HttpExchange ex, Session s) throws IOException {
        String method = ex.getRequestMethod();
        // Для GET-запросов CSRF не требуется (считаются безопасными)
        if ("GET".equalsIgnoreCase(method)) return true;

        // Получаем токен из заголовка X-CSRF-Token
        String token = ex.getRequestHeaders().getFirst("X-CSRF-Token");
        // Сравниваем с токеном, хранящимся в сессии
        if (!Objects.equals(token, s.csrf)) {
            // Если не совпадает – отправляем ошибку 403
            HttpUtil.sendError(ex, 403, "csrf");
            return false;
        }
        return true;
    }

    // Проверка, имеет ли сессия указанное право доступа
    static boolean require(Session s, HttpExchange ex, Permission p) throws IOException {
        // Получаем набор прав для роли пользователя (если роли нет – пустое множество)
        if (!ROLE_PERMS.getOrDefault(s.role, Set.of()).contains(p)) {
            // Если права нет – 403 Forbidden и запись в аудит
            HttpUtil.sendError(ex, 403, "forbidden");
            Audit.warn(s.username, "ACCESS_DENIED", "Insufficient permissions for " + p, ex.getRemoteAddress().getAddress().getHostAddress());
            return false;
        }
        return true;
    }

    private static boolean isMobileRequest(HttpExchange ex) {
        // Проверяем User-Agent
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

        // Проверяем специальный заголовок, устанавливаемый JavaScript
        String mobileHeader = ex.getRequestHeaders().getFirst("X-Client-Mobile");
        if ("true".equalsIgnoreCase(mobileHeader)) {
            return true;
        }

        return false;
    }

    // ================= УПРАВЛЕНИЕ ПАРОЛЯМИ =================

    // Хэширование пароля с использованием PBKDF2 (с солью)
    static String hashPassword(String password) {
        // Проверка длины пароля
        if (password == null || password.length() > MAX_PASSWORD_LENGTH)
            throw new IllegalArgumentException("bad password");

        try {
            // Генерация случайной соли (16 байт)
            byte[] salt = new byte[16];
            SecureRandom.getInstanceStrong().nextBytes(salt);

            // Спецификация ключа на основе пароля: пароль, соль, итерации, длина ключа
            PBEKeySpec spec = new PBEKeySpec(
                    password.toCharArray(),
                    salt,
                    ITERATIONS,
                    KEY_LENGTH
            );

            // Получение экземпляра фабрики для PBKDF2 с SHA-256
            byte[] hash = SecretKeyFactory
                    .getInstance("PBKDF2WithHmacSHA256")
                    .generateSecret(spec)
                    .getEncoded();

            // Возвращаем строку вида "base64(соль):base64(хэш)"
            return Base64.getEncoder().encodeToString(salt) + ":" +
                    Base64.getEncoder().encodeToString(hash);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    // Проверка пароля против хранимой строки (соль:хэш)
    static boolean checkPassword(String password, String stored) {
        try {
            // Проверка на null и максимальную длину
            if (password == null || stored == null) return false;
            if (password.length() > MAX_PASSWORD_LENGTH) return false;

            // Разделяем хранимую строку на соль и хэш
            String[] p = stored.split(":");
            if (p.length != 2) return false; // неверный формат

            // Декодируем соль и хэш из Base64
            byte[] salt = Base64.getDecoder().decode(p[0]);
            byte[] hash = Base64.getDecoder().decode(p[1]);

            // Создаём спецификацию с теми же параметрами
            PBEKeySpec spec = new PBEKeySpec(
                    password.toCharArray(),
                    salt,
                    ITERATIONS,
                    KEY_LENGTH
            );

            // Вычисляем хэш для введённого пароля
            byte[] test = SecretKeyFactory
                    .getInstance("PBKDF2WithHmacSHA256")
                    .generateSecret(spec)
                    .getEncoded();

            // Безопасное сравнение двух хэшей
            return MessageDigest.isEqual(hash, test);
        } catch (Exception e) {
            return false; // любая ошибка -> неверный пароль
        }
    }

    // Метод, вызываемый при старте для создания учётной записи разработчика по умолчанию
    static void ensureDefaultDeveloper() {
        Database.ensureDefaultDeveloper();
    }

    // ================= УЧЕТ НЕУДАЧНЫХ ПОПЫТОК ВХОДА =================

    // Проверка, заблокирован ли пользователь по IP (есть ли запись с blocked_until > now)
    static boolean isBlocked(String user, String ip) {
        Connection c = null;
        try {
            c = Database.borrow();
            try (PreparedStatement ps = c.prepareStatement(
                    "SELECT blocked_until FROM failed_logins WHERE username=? AND ip=?")) {
                ps.setString(1, user);
                ps.setString(2, ip);
                ResultSet rs = ps.executeQuery();
                // Если запись есть и время блокировки больше текущего – true
                return rs.next() && rs.getLong(1) > System.currentTimeMillis();
            }
        } catch (Exception e) {
            return false; // при ошибке считаем, что не заблокирован
        } finally {
            Database.release(c);
        }
    }

    // Запись неудачной попытки входа (увеличиваем счётчик, при 5 попытках блокируем на 1 минуту)
    static void recordFailedLogin(String user, String ip) {
        long now = System.currentTimeMillis();
        Connection c = null;

        try {
            c = Database.borrow();
            // UPSERT: если запись существует, обновляем, иначе вставляем
            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO failed_logins(username,ip,count,last_fail,blocked_until) " +
                            "VALUES (?,?,?,?,0) " +
                            "ON CONFLICT (username,ip) DO UPDATE SET " +
                            "count = CASE WHEN failed_logins.blocked_until < ? THEN 1 ELSE failed_logins.count + 1 END, " +
                            "last_fail = EXCLUDED.last_fail, " +
                            "blocked_until = CASE WHEN failed_logins.count + 1 >= 5 THEN ? ELSE failed_logins.blocked_until END")) {
                ps.setString(1, user);
                ps.setString(2, ip);
                ps.setInt(3, 1);                 // начальное значение count для INSERT
                ps.setLong(4, now);                // last_fail
                ps.setLong(5, now);                // условие: если блокировка истекла, сбросить count на 1
                ps.setLong(6, now + 60_000);       // новое blocked_until (текущее время + 1 минута)
                ps.executeUpdate();
            }
        } catch (Exception e) {
            Audit.log(user, "FAILED_LOGIN_RECORD_FAIL", ip);
        } finally {
            Database.release(c);
        }
    }

    // Очистка записей о неудачных попытках после успешного входа
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
            Audit.log(user, "FAILED_LOGIN_CLEAR_FAIL", ip);
        } finally {
            Database.release(c);
        }
    }

    // Получение списка имён всех активных (не истёкших) пользователей
    public static List<String> getActiveUsers() {
        cleanupSessions(); // предварительно очищаем истёкшие
        List<String> users = new ArrayList<>();
        for (Session s : sessions.values()) {
            if (!s.expired()) {
                users.add(s.username);
            }
        }
        return users;
    }

    // ================= ОБРАБОТЧИКИ HTTP-ЗАПРОСОВ =================

    // Обработка входа пользователя (POST /auth/login)
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

        // Получаем IP сразу
        String ip = ex.getRemoteAddress().getAddress().getHostAddress();

        // Проверка на мобильное устройство (без user'а)
        if (isMobileRequest(ex)) {
            HttpUtil.sendError(ex, 403, "Доступ с мобильных устройств запрещён по политике безопасности");
            Audit.warn("-", "MOBILE_ACCESS_DENIED", "Access from mobile device blocked", ip);
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
            Audit.warn(user, "LOGIN_BLOCKED", "Too many failed attempts", ip);
            return;
        }

        var dbUser = Database.findUser(user);
        if (dbUser == null || !checkPassword(pass, dbUser.passwordHash)) {
            recordFailedLogin(user, ip);
            Audit.warn(user, "LOGIN_FAIL", "Invalid password", ip);
            HttpUtil.sendError(ex, 401, "invalid_login");
            return;
        }

        clearFailedLogins(user, ip);
        String sid = UUID.randomUUID().toString();
        sessions.put(sid, new Session(user, dbUser.role));
        HttpUtil.setCookie(ex, "SESSION", sid);

        HttpUtil.sendJson(ex, "{\"status\":\"ok\",\"username\":\"" + user +
                "\",\"role\":\"" + dbUser.role + "\"}");
        Audit.info(user, "LOGIN_SUCCESS", ip, sid);
    }

    // Обработка выхода пользователя (POST /auth/logout)
    static void handleLogout(HttpExchange ex) throws IOException {
        // Получаем сессию
        Session s = getSession(ex);
        // Если сессии нет или CSRF-токен не прошёл проверку – выходим (getSession уже мог отправить ошибку)
        if (s == null || !checkCsrf(ex, s)) return;

        // Получаем идентификатор сессии из куки
        String sid = HttpUtil.getCookie(ex, "SESSION");
        if (sid != null) sessions.remove(sid); // удаляем сессию из хранилища

        // Очищаем куку SESSION (устанавливаем пустое значение и срок действия в прошлом)
        HttpUtil.clearCookie(ex, "SESSION");
        // Отправляем подтверждение
        HttpUtil.sendJson(ex, "{\"status\":\"logged_out\"}");
    }

    // Обработка запроса информации о текущей сессии (GET /auth/me)
    static void handleAuthMe(HttpExchange ex) throws IOException {
        Session s = getSession(ex);
        if (s == null) {
            HttpUtil.sendError(ex, 401, "unauthorized"); // нет сессии
            return;
        }

        // Отправляем JSON с именем пользователя, ролью и CSRF-токеном
        HttpUtil.sendJson(ex, "{\"username\":\"" + s.username +
                "\",\"role\":\"" + s.role +
                "\",\"csrf\":\"" + s.csrf +
                "\",\"idleTimeout\":" + SESSION_TIMEOUT_MS + "}");
    }

    // Обработка ping-запроса для поддержания сессии (POST /auth/ping)
    static void handleAuthPing(HttpExchange ex) throws IOException {
        Session s = getSession(ex);
        if (s == null || !checkCsrf(ex, s)) return;

        long now = System.currentTimeMillis();
        // Простейший rate limiting: не чаще 1 раза в секунду
        if (now - s.lastPing < 1000) {
            HttpUtil.sendError(ex, 429, "too_many_requests"); // 429 Too Many Requests
            return;
        }

        s.lastPing = now; // обновляем время последнего ping
        HttpUtil.sendJson(ex, "{\"status\":\"ok\"}");
    }

    // Обработка загрузки конфигурации (GET /config/load)
    static void handleConfigLoad(HttpExchange ex) throws IOException {
        Session s = getSession(ex);
        if (s == null || !checkCsrf(ex, s)) return;
        // Проверка права VIEW_DATA
        if (!require(s, ex, Permission.VIEW_DATA)) return;
        // Делегируем HttpUtil для отправки конфигурации
        HttpUtil.sendConfig(ex);
    }

    // Обработка сохранения конфигурации (POST /config/save)
    static void handleConfigSave(HttpExchange ex) throws IOException {
        Session s = getSession(ex);
        if (s == null || !checkCsrf(ex, s)) return;
        // Проверка права EDIT_CONFIG
        if (!require(s, ex, Permission.EDIT_CONFIG)) return;
        // Делегируем HttpUtil для сохранения конфигурации
        HttpUtil.saveConfig(ex);
    }
}