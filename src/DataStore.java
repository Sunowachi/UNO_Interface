import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;

public class DataStore {

    static final int CACHE_POINTS = 200;
    static final long SENSOR_TTL_MS = 60_000;

    /* ===== SENSOR PROTECTION ===== */

    static final long SENSOR_MIN_POST_INTERVAL_MS = 200;
    static final int MAX_SENSOR_FIELDS = 100;
    static final int MAX_NEW_METRICS_PER_POST = 50;
    static final int MAX_ACTIVE_SENSORS = 20_000;

    static final Map<String, Long> lastPostTs = new ConcurrentHashMap<>();

    /* ===== DB ASYNC SETTINGS ===== */

    static final int DB_BATCH_SIZE = 500;
    static final int DB_QUEUE_LIMIT = 500_000;

    static final BlockingQueue<DbPoint> dbQueue = new LinkedBlockingQueue<>(DB_QUEUE_LIMIT);

    static volatile boolean dbRunning = true;
    static void shutdown() {
        dbRunning = false;
    }

    static final Map<String, SensorCache> cache = new ConcurrentHashMap<>();
    static final AtomicLong droppedPoints = new AtomicLong();

    /* ====== API ====== */

    static void handleData(HttpExchange ex) throws IOException {
        String method = ex.getRequestMethod();

        if ("POST".equalsIgnoreCase(method)) {
            if (ex.getRequestHeaders().getFirst("X-Sensor-Id") != null) {
                handleSensorPost(ex);
                return;
            }
            HttpUtil.sendError(ex, 403, "forbidden");
            return;
        }

        if ("GET".equalsIgnoreCase(method)) {
            Security.Session s = Security.getSession(ex);
            if (s == null) {
                HttpUtil.sendError(ex, 401, "unauthorized");
                return;
            }
            if (!Security.require(s, ex, Security.Permission.VIEW_DATA)) return;

            long range = HttpUtil.parseRange(ex);
            HttpUtil.sendJson(ex, buildSensorsJson(range));
            return;
        }

        ex.sendResponseHeaders(405, -1);
    }

    static void cleanupCache() {
        long now = System.currentTimeMillis();
        cache.entrySet().removeIf(e -> e.getValue().status(now) == SensorCache.Status.DEAD);
        lastPostTs.entrySet().removeIf(e -> now - e.getValue() > SENSOR_TTL_MS * 3);
    }

    static void cleanupHistoryDb() {
        long now = System.currentTimeMillis();
        Connection c = null;
        try {
            c = Database.borrow();
            try (PreparedStatement ps = c.prepareStatement(
                    "DELETE FROM history WHERE ts < ?")) {
                ps.setLong(1, now - 7L * 24 * 60 * 60 * 1000);
                ps.executeUpdate();
            }
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            Database.release(c);
        }
    }

    static void handleSensors(HttpExchange ex) throws IOException {
        Security.Session s = Security.getSession(ex);
        if (s == null) {
            HttpUtil.sendError(ex, 401, "unauthorized");
            return;
        }
        if (!Security.require(s, ex, Security.Permission.VIEW_DATA)) return;

        List<SensorInfo> list = listSensors();
        StringBuilder sb = new StringBuilder("[");
        boolean first = true;

        for (SensorInfo si : list) {
            if (!first) sb.append(",");
            first = false;
            sb.append("{")
                    .append("\"id\":\"").append(si.id).append("\",")
                    .append("\"status\":\"").append(si.status).append("\",")
                    .append("\"lastSeen\":").append(si.lastSeen).append(",")
                    .append("\"vars\":").append(varsToJson(si.vars))
                    .append("}");
        }
        sb.append("]");
        HttpUtil.sendJson(ex, sb.toString());
    }

    private static String varsToJson(Set<String> vars) {
        StringBuilder sb = new StringBuilder("[");
        boolean first = true;
        for (String v : vars) {
            if (!first) sb.append(",");
            first = false;
            sb.append("\"").append(v).append("\"");
        }
        sb.append("]");
        return sb.toString();
    }

    /* ====== SENSOR POST ====== */

    private static void handleSensorPost(HttpExchange ex) throws IOException {

        String ct = ex.getRequestHeaders().getFirst("Content-Type");
        if (ct == null || !ct.startsWith("application/json")) {
            HttpUtil.sendError(ex, 400, "invalid_content_type");
            return;
        }

        String sensorId = ex.getRequestHeaders().getFirst("X-Sensor-Id");
        String token = ex.getRequestHeaders().getFirst("X-Sensor-Token");

        if (!lastPostTs.containsKey(sensorId)
                && lastPostTs.size() > MAX_ACTIVE_SENSORS) {
            HttpUtil.sendError(ex, 503, "sensor_capacity_exceeded");
            return;
        }

        if (!isValidSensorId(sensorId) || token == null) {
            HttpUtil.sendError(ex, 401, "missing_sensor_auth");
            return;
        }

        if (!Security.checkSensorToken(sensorId, token)) {
            HttpUtil.sendError(ex, 403, "invalid_sensor");
            return;
        }

        long now = System.currentTimeMillis();
        Long last = lastPostTs.get(sensorId);
        if (last != null && now - last < SENSOR_MIN_POST_INTERVAL_MS) {
            HttpUtil.sendError(ex, 429, "sensor_rate_limit");
            return;
        }

        byte[] bodyBytes = ex.getRequestBody().readAllBytes();
        if (bodyBytes.length == 0 || bodyBytes.length > 4096) {
            HttpUtil.sendError(ex, 413, "payload_too_large");
            droppedPoints.incrementAndGet();
            return;
        }

        Map<String, Double> fields = parseSimpleJson(bodyBytes);
        if (fields == null || fields.size() > MAX_SENSOR_FIELDS) {
            HttpUtil.sendError(ex, 400, "invalid_json");
            return;
        }

        int created = 0;

        for (var e : fields.entrySet()) {
            String var = e.getKey();
            double value = e.getValue();

            if (!isValidVar(var) || !Double.isFinite(value)) continue;

            String key = sensorId + ":" + var;
            boolean isNew = !cache.containsKey(key);
            if (isNew && ++created > MAX_NEW_METRICS_PER_POST) {
                HttpUtil.sendError(ex, 429, "too_many_metrics");
                return;
            }
            
            boolean ok = recordValue(sensorId, var, value);
            if (!ok) {
                HttpUtil.sendError(ex, 503, "storage_overload");
                return;
            }
        }
        lastPostTs.put(sensorId, now);
        HttpUtil.sendJson(ex, "{\"status\":\"OK\"}");
    }

    /* ====== STORAGE ====== */

    private static boolean recordValue(String sensor, String var, double value) {
        long ts = System.currentTimeMillis();
        String key = sensor + ":" + var;

        SensorCache c = cache.computeIfAbsent(key, k -> new SensorCache());
        c.add(value, ts);

        // Не блокируем поток при переполнении очереди
        boolean added = dbQueue.offer(new DbPoint(sensor, var, ts, value));
        if (!added) {
            droppedPoints.incrementAndGet();
            return false;
        }
        return true;
    }

    /* ====== DB WRITER ====== */

    static void startMaintenance() {
        Thread t = new Thread(() -> {
            while (true) {
                try {
                    cleanupCache();
                    cleanupHistoryDb();
                    Thread.sleep(60_000);
                } catch (InterruptedException e) {
                    return;
                }
            }
        });
        t.setDaemon(true);
        t.setName("datastore-maintenance");
        t.start();
    }

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

    /* ====== DB LOAD ====== */

    static void warmupCacheFromDb() {
        loadFromDbGrouped(0).forEach((k, pts) -> {
            SensorCache c = new SensorCache();
            for (Point p : pts) c.add(p.value, p.ts);
            cache.put(k, c);
        });
    }

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

    /* ====== JSON ====== */

    static String buildSensorsJson(long rangeMs) {
        long fromTs = rangeMs > 0 ? System.currentTimeMillis() - rangeMs : 0;
        Map<String, List<Point>> data = new LinkedHashMap<>();

        for (var e : cache.entrySet()) {
            List<Point> pts = e.getValue().snapshot(fromTs);
            if (!pts.isEmpty()) data.put(e.getKey(), pts);
        }
        return pointsToJsonMap(data);
    }

    private static String pointsToJsonMap(Map<String, List<Point>> data) {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (var e : data.entrySet()) {
            if (!first) sb.append(",");
            first = false;
            String safeKey = e.getKey().replaceAll("[^a-zA-Z0-9_\\-]", "_");
            sb.append("\"").append(safeKey).append("\":")
                    .append(pointsToJson(e.getValue()));
        }
        sb.append("}");
        return sb.toString();
    }

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

    /* ================= UTILS ================= */

    private static boolean isValidSensorId(String s) {
        return s != null && s.matches("[a-zA-Z0-9_\\-]{1,64}");
    }

    private static boolean isValidVar(String v) {
        return v != null && v.matches("[a-zA-Z0-9_]{1,32}");
    }

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

    /* ====== CACHE ====== */

    static class SensorCache {
        enum Status { ONLINE, STALE, DEAD }

        volatile long lastSeen;
        final Deque<Point> points = new ArrayDeque<>();

        synchronized void add(double v, long t) {
            points.addLast(new Point(t, v));
            lastSeen = t;
            while (points.size() > CACHE_POINTS) points.removeFirst();
        }

        synchronized List<Point> snapshot(long fromTs) {
            List<Point> out = new ArrayList<>();
            for (Point p : points)
                if (p.ts >= fromTs) out.add(p);
            return out;
        }

        Status status(long now) {
            long age = now - lastSeen;
            if (age <= SENSOR_TTL_MS) return Status.ONLINE;
            if (age <= SENSOR_TTL_MS * 3) return Status.STALE;
            return Status.DEAD;
        }
    }

    private static class SensorInfoBuilder {
        long lastSeen = 0;
        SensorCache.Status status = SensorCache.Status.DEAD;
        Set<String> vars = new TreeSet<>();

        void add(String var, long seen, SensorCache.Status st) {
            vars.add(var);
            if (seen > lastSeen) lastSeen = seen;
            if (st.ordinal() < status.ordinal()) status = st;
        }

        SensorInfo build(String id) {
            return new SensorInfo(id, status, lastSeen, vars);
        }
    }

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

    static class SensorInfo {
        final String id;
        final SensorCache.Status status;
        final long lastSeen;
        final Set<String> vars;

        SensorInfo(String id,
                   SensorCache.Status status,
                   long lastSeen,
                   Set<String> vars) {
            this.id = id;
            this.status = status;
            this.lastSeen = lastSeen;
            this.vars = vars;
        }
    }

    static class Point {
        final long ts;
        final double value;
        Point(long t, double v) { ts = t; value = v; }
    }

    static class DbPoint {
        final String sensor, var;
        final long ts;
        final double value;
        DbPoint(String s, String v, long t, double val) {
            sensor = s; var = v; ts = t; value = val;
        }
    }
}