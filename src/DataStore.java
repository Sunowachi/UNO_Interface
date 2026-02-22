import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Хранилище данных в оперативной памяти (кэш) и асинхронная запись в БД.
 */
public class DataStore {

    // ==================== КОНФИГУРАЦИЯ КЭША И ОГРАНИЧЕНИЙ ====================
    static final int CACHE_POINTS = 200;                 // Максимальное количество точек в кэше на одну метрику
    static final long SENSOR_TTL_MS = 60_000;            // Время жизни датчика без активности (считается онлайн)

    static final long SENSOR_MIN_POST_INTERVAL_MS = 200; // Минимальный интервал между POST от одного датчика
    static final int MAX_SENSOR_FIELDS = 100;            // Максимальное количество полей в одном POST
    static final int MAX_NEW_METRICS_PER_POST = 50;      // Максимальное количество новых метрик, создаваемых за один POST
    static final int MAX_ACTIVE_SENSORS = 20_000;        // Максимальное количество одновременно активных датчиков

    // ==================== СОСТОЯНИЕ СИСТЕМЫ ====================
    static final Map<String, Long> lastPostTs = new ConcurrentHashMap<>();   // Время последнего POST для каждого датчика
    static final AtomicLong lastCleanup = new AtomicLong();                   // Время последней очистки rate limit
    static final Map<String, SensorCache> cache = new ConcurrentHashMap<>();  // Кэш данных: ключ "sensorId:varName"
    static final AtomicLong droppedPoints = new AtomicLong();                 // Счётчик отброшенных точек (для мониторинга)

    // ==================== АСИНХРОННАЯ ЗАПИСЬ В БД ====================
    static final int DB_BATCH_SIZE = 500;                 // Размер пакета для записи в БД
    static final int DB_QUEUE_LIMIT = 500_000;            // Максимальный размер очереди на запись
    static final BlockingQueue<DbPoint> dbQueue = new LinkedBlockingQueue<>(DB_QUEUE_LIMIT); // Очередь точек на запись
    static volatile boolean dbRunning = true;              // Флаг работы фонового потока записи

    // ==================== КЭШ ИСТОРИЧЕСКИХ ДАННЫХ (ИЗ БД) ====================
    private static long lastHistoryLoadTime = 0;
    private static long lastRequestedRangeMs = 0;
    private static final Map<String, List<Point>> historicalCache = new ConcurrentHashMap<>();

    // ==================== ВНУТРЕННИЕ КЛАССЫ ====================

    /** Кэш данных для одной метрики датчика */
    static class SensorCache {
        volatile long lastSeen;
        final Deque<Point> points = new ArrayDeque<>();

        synchronized void add(double v, long t) {
            points.addLast(new Point(t, v));
            lastSeen = t;
            while (points.size() > CACHE_POINTS) points.removeFirst();
        }

        synchronized List<Point> snapshot(long fromTs) {
            List<Point> out = new ArrayList<>();
            for (Point p : points) if (p.ts >= fromTs) out.add(p);
            return out;
        }

        Status status(long now) {
            long age = now - lastSeen;
            if (age <= SENSOR_TTL_MS) return Status.ONLINE;
            if (age <= SENSOR_TTL_MS * 3) return Status.STALE;
            return Status.DEAD;
        }

        enum Status { ONLINE, STALE, DEAD }
    }

    /** Точка данных (временная метка + значение) */
    static class Point {
        final long ts;
        final double value;
        Point(long t, double v) { ts = t; value = v; }
    }

    /** Точка данных для записи в БД (содержит идентификаторы) */
    static class DbPoint {
        final String sensor, var;
        final long ts;
        final double value;
        DbPoint(String s, String v, long t, double val) {
            sensor = s; var = v; ts = t; value = val;
        }
    }

    /** Информация о датчике для ответа /sensors */
    static class SensorInfo {
        final String id;
        final SensorCache.Status status;
        final long lastSeen;
        final Set<String> vars;
        SensorInfo(String id, SensorCache.Status status, long lastSeen, Set<String> vars) {
            this.id = id;
            this.status = status;
            this.lastSeen = lastSeen;
            this.vars = vars;
        }
    }

    /** Вспомогательный билдер для SensorInfo */
    private static class SensorInfoBuilder {
        long lastSeen = 0;
        SensorCache.Status status = SensorCache.Status.DEAD;
        Set<String> vars = new TreeSet<>();

        void add(String var, long seen, SensorCache.Status st) {
            vars.add(var);
            if (seen > lastSeen) lastSeen = seen;
            if (st.ordinal() < status.ordinal()) status = st; // выбираем лучший статус
        }

        SensorInfo build(String id) {
            return new SensorInfo(id, status, lastSeen, vars);
        }
    }

    // ==================== УПРАВЛЕНИЕ ЖИЗНЕННЫМ ЦИКЛОМ ====================

    /** Запуск фонового потока для записи данных из очереди в БД */
    static void startDbWriter() {
        Thread t = new Thread(() -> {
            List<DbPoint> batch = new ArrayList<>(DB_BATCH_SIZE);
            while (dbRunning || !dbQueue.isEmpty()) {
                try {
                    DbPoint first = dbQueue.poll(1, TimeUnit.SECONDS);
                    if (first == null) continue;

                    batch.add(first);
                    dbQueue.drainTo(batch, DB_BATCH_SIZE - 1);
                    writeBatch(batch);
                    batch.clear();
                } catch (Exception e) {
                    e.printStackTrace();
                }
            }
        });
        t.setDaemon(true);
        t.setName("db-writer");
        t.start();
    }

    /** Предварительная загрузка кэша из БД (при старте) */
    static void warmupCacheFromDb() {
        loadFromDbGrouped(0).forEach((k, pts) -> {
            SensorCache c = new SensorCache();
            for (Point p : pts) c.add(p.value, p.ts);
            cache.put(k, c);
        });
    }

    // ==================== ОЧИСТКА И ОБСЛУЖИВАНИЕ ====================

    /** Очистка ограничений для сенсоров (удаление устаревших записей) */
    static void cleanupSensorLimits() {
        long now = System.currentTimeMillis();
        long last = lastCleanup.get();
        if (now - last < 5_000) return;
        if (!lastCleanup.compareAndSet(last, now)) return;
        lastPostTs.entrySet().removeIf(e -> now - e.getValue() > SENSOR_TTL_MS * 3);
    }

    /** Очистка устаревших данных из кэша (удаление мёртвых датчиков) */
    static void cleanupCache() {
        long now = System.currentTimeMillis();
        cache.entrySet().removeIf(e -> e.getValue().status(now) == SensorCache.Status.DEAD);
        lastPostTs.entrySet().removeIf(e -> now - e.getValue() > SENSOR_TTL_MS * 3);
    }

    // ==================== ОБРАБОТКА HTTP-ЗАПРОСОВ ====================

    /** Обработка данных, присланных датчиком (POST /data) */
    static void handleSensorPost(byte[] bodyBytes, String sensorId) {
        cleanupSensorLimits();

        if (!isValidSensorId(sensorId)) {
            droppedPoints.incrementAndGet();
            return;
        }

        if (!lastPostTs.containsKey(sensorId) && lastPostTs.size() > MAX_ACTIVE_SENSORS) {
            droppedPoints.incrementAndGet();
            return;
        }

        long now = System.currentTimeMillis();
        Long last = lastPostTs.get(sensorId);
        if (last != null && now - last < SENSOR_MIN_POST_INTERVAL_MS) {
            droppedPoints.incrementAndGet();
            return;
        }

        if (bodyBytes == null || bodyBytes.length == 0 || bodyBytes.length > 4096) {
            droppedPoints.incrementAndGet();
            return;
        }

        Map<String, Double> fields = parseSimpleJson(bodyBytes);
        if (fields == null || fields.size() > MAX_SENSOR_FIELDS) {
            droppedPoints.incrementAndGet();
            return;
        }

        int created = 0;
        for (var e : fields.entrySet()) {
            String var = e.getKey();
            double value = e.getValue();

            if (!isValidVar(var) || !Double.isFinite(value)) continue;

            String key = sensorId + ":" + var;
            if (!cache.containsKey(key) && ++created > MAX_NEW_METRICS_PER_POST) break;

            recordValue(sensorId, var, value);
        }

        lastPostTs.put(sensorId, now);
    }

    // ==================== COMTRADE ====================

    /** Получение точек данных из БД для экспорта */
    public static List<Point> getPointsFromDb(String sensorId, String varName, long fromTs, long toTs) {
        List<Point> result = new ArrayList<>();
        Connection c = null;
        try {
            c = Database.borrow();
            try (PreparedStatement ps = c.prepareStatement(
                    "SELECT ts, value FROM history WHERE sensor_id=? AND var_name=? AND ts BETWEEN ? AND ? ORDER BY ts")) {
                ps.setString(1, sensorId);
                ps.setString(2, varName);
                ps.setLong(3, fromTs);
                ps.setLong(4, toTs);
                ResultSet rs = ps.executeQuery();
                while (rs.next()) {
                    result.add(new Point(rs.getLong(1), rs.getDouble(2)));
                }
            }
        } catch (SQLException e) {
            Audit.error(sensorId, "ОШИБКА_ЗАПРОСА_БД", e.getMessage(), "-");
        } finally {
            Database.release(c);
        }
        return result;
    }

    // ==================== ОПЕРАЦИИ С ДАННЫМИ ====================

    /** Запись значения в кэш и постановка в очередь на запись в БД */
    private static boolean recordValue(String sensor, String var, double value) {
        long ts = System.currentTimeMillis();
        String key = sensor + ":" + var;
        SensorCache c = cache.computeIfAbsent(key, k -> new SensorCache());
        c.add(value, ts);

        boolean added = dbQueue.offer(new DbPoint(sensor, var, ts, value));
        if (!added) {
            droppedPoints.incrementAndGet();
            Audit.error("system", "ПЕРЕПОЛНЕНИЕ_ОЧЕРЕДИ_БД", "Очередь переполнена, точка отброшена для датчика=" + sensor, "-");
        }
        return added;
    }

    /** Формирование JSON со всеми данными сенсоров (для /init) */
    static String buildSensorsJson(long rangeMs) {
        long now = System.currentTimeMillis();
        long fromTs = rangeMs > 0 ? now - rangeMs : 0;

        long MaxDaysMs = 7L * 24 * 60 * 60 * 1000;
        if (rangeMs > MaxDaysMs) {
            fromTs = now - MaxDaysMs;
        }

        Map<String, List<Point>> data = new LinkedHashMap<>();

        if (rangeMs != lastRequestedRangeMs || now - lastHistoryLoadTime > 60_000) {
            Map<String, List<Point>> dbData = loadFromDbGrouped(fromTs);
            historicalCache.putAll(dbData);
            lastHistoryLoadTime = now;
            lastRequestedRangeMs = rangeMs;
        }

        data.putAll(historicalCache);

        for (var e : cache.entrySet()) {
            String key = e.getKey();
            List<Point> cachePoints = e.getValue().snapshot(fromTs);

            if (cachePoints.isEmpty()) continue;

            if (!data.containsKey(key)) {
                data.put(key, new ArrayList<>(cachePoints));
            } else {
                List<Point> existing = data.get(key);
                long maxExistingTime = 0;
                for (Point p : existing) if (p.ts > maxExistingTime) maxExistingTime = p.ts;

                for (Point cachePoint : cachePoints) {
                    if (cachePoint.ts > maxExistingTime) {
                        existing.add(cachePoint);
                    }
                }
                existing.sort((p1, p2) -> Long.compare(p1.ts, p2.ts));
            }
        }

        return pointsToJsonMap(data);
    }

    /** Получение списка всех датчиков с их статусами и переменными (для /sensors) */
    static List<SensorInfo> listSensors() {
        long now = System.currentTimeMillis();
        Map<String, SensorInfoBuilder> tmp = new HashMap<>();

        for (var e : cache.entrySet()) {
            String[] parts = e.getKey().split(":", 2);
            if (parts.length != 2) continue;

            String sensorId = parts[0];
            String var = parts[1];
            SensorCache c = e.getValue();

            tmp.computeIfAbsent(sensorId, k -> new SensorInfoBuilder())
                    .add(var, c.lastSeen, c.status(now));
        }

        List<SensorInfo> out = new ArrayList<>();
        for (var e : tmp.entrySet()) {
            out.add(e.getValue().build(e.getKey()));
        }

        out.sort(Comparator.comparing(a -> a.id));
        return out;
    }

    // ==================== РАБОТА С БАЗОЙ ДАННЫХ ====================

    /** Запись пакета точек в БД (вызывается из потока db-writer) */
    private static void writeBatch(List<DbPoint> batch) {
        if (batch.isEmpty()) return;

        Connection c = null;
        try {
            c = Database.borrow();
            c.setAutoCommit(false);

            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO history(sensor_id,var_name,ts,value) VALUES (?,?,?,?)")) {
                for (DbPoint p : batch) {
                    ps.setString(1, p.sensor);
                    ps.setString(2, p.var);
                    ps.setLong(3, p.ts);
                    ps.setDouble(4, p.value);
                    ps.addBatch();
                }
                ps.executeBatch();
                ps.clearBatch();
            }
            c.commit();
        } catch (Exception e) {
            try { if (c != null) c.rollback(); } catch (Exception ignored) {}
        } finally {
            Database.release(c);
        }
    }

    /** Загрузка данных из БД, сгруппированных по ключу "sensorId:varName" */
    private static Map<String, List<Point>> loadFromDbGrouped(long fromTs) {
        Map<String, List<Point>> m = new LinkedHashMap<>();
        Connection c = null;

        try {
            c = Database.borrow();
            try (PreparedStatement ps = c.prepareStatement(
                    "SELECT sensor_id,var_name,ts,value FROM history WHERE ts>=? ORDER BY ts")) {
                ps.setLong(1, fromTs);
                ResultSet rs = ps.executeQuery();

                while (rs.next()) {
                    String key = rs.getString(1) + ":" + rs.getString(2);
                    m.computeIfAbsent(key, k -> new ArrayList<>())
                            .add(new Point(rs.getLong(3), rs.getDouble(4)));
                }
            }
        } catch (Exception ignored) {
        } finally {
            Database.release(c);
        }
        return m;
    }

    // ==================== ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ====================

    /** Преобразование карты данных в JSON-объект */
    private static String pointsToJsonMap(Map<String, List<Point>> data) {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (var e : data.entrySet()) {
            if (!first) sb.append(",");
            first = false;
            String safeKey = e.getKey().replaceAll("[^a-zA-Z0-9_\\-:]", "_");
            sb.append("\"").append(safeKey).append("\":")
                    .append(pointsToJson(e.getValue()));
        }
        sb.append("}");
        return sb.toString();
    }

    /** Преобразование списка точек в JSON вида {"values":[...],"times":[...]} */
    private static String pointsToJson(List<Point> pts) {
        StringBuilder values = new StringBuilder();
        StringBuilder times = new StringBuilder();
        for (int i = 0; i < pts.size(); i++) {
            if (i > 0) {
                values.append(",");
                times.append(",");
            }
            values.append(pts.get(i).value);
            times.append(pts.get(i).ts);
        }
        return "{\"values\":[" + values + "],\"times\":[" + times + "]}";
    }

    /** Проверка корректности идентификатора датчика */
    private static boolean isValidSensorId(String s) {
        return s != null && s.matches("[a-zA-Z0-9_\\-]{1,64}");
    }

    /** Проверка корректности имени переменной */
    private static boolean isValidVar(String v) {
        return v != null && v.matches("[a-zA-Z0-9_]{1,32}");
    }

    /** Парсинг упрощённого JSON от сенсоров (формат: {"var1":12.34,"var2":56.78}) */
    private static Map<String, Double> parseSimpleJson(byte[] body) {
        try {
            String s = new String(body, StandardCharsets.UTF_8).trim();
            if (!s.startsWith("{") || !s.endsWith("}")) return null;

            s = s.substring(1, s.length() - 1).trim();
            if (s.isEmpty()) return Map.of();

            Map<String, Double> m = new HashMap<>();
            for (String part : s.split(",")) {
                String[] kv = part.split(":", 2);
                if (kv.length != 2) continue;

                String k = kv[0].trim();
                if (!k.matches("\"[a-zA-Z0-9_]{1,32}\"")) return null;
                k = k.substring(1, k.length() - 1);

                String rawVal = kv[1].trim();
                if (rawVal.startsWith("\"")) return null;
                double v = Double.parseDouble(rawVal);

                m.put(k, v);
            }
            return m;
        } catch (Exception e) {
            return null;
        }
    }
}