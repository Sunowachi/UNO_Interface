import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.*;
import java.util.concurrent.*;

public class DataStore {

    static final int CACHE_POINTS = 200;
    static final long SENSOR_TTL_MS = 60_000;

    /* ===== DB ASYNC SETTINGS ===== */

    static final int DB_BATCH_SIZE = 500;
    static final int DB_QUEUE_LIMIT = 50_000;

    static final BlockingQueue<DbPoint> dbQueue =
            new LinkedBlockingQueue<>(DB_QUEUE_LIMIT);

    static final Map<String, SensorCache> cache =
            new ConcurrentHashMap<>();

    /* ====== API ====== */

    static void handleData(HttpExchange ex) throws IOException {
        String method = ex.getRequestMethod();
        String ip = ex.getRemoteAddress().getAddress().getHostAddress();

        if ("POST".equalsIgnoreCase(method)) {
            String sensorId = ex.getRequestHeaders().getFirst("X-Sensor-Id");
            if (sensorId != null) {
                handleSensorPost(ex);
                return;
            }

            Security.Session s = Security.peekSession(ex);
            if (s != null && !Security.checkCsrf(ex, s)) return;

            if (!ip.startsWith("192.168.") && !ip.equals("127.0.0.1")) {
                HttpUtil.sendError(ex, 403, "forbidden");
                return;
            }
            HttpUtil.sendError(ex, 400, "invalid_post_target");
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
        cache.entrySet().removeIf(e -> !e.getValue().isAlive());

        Connection c = null;
        try {
            c = Database.borrow();
            try (PreparedStatement ps = c.prepareStatement(
                    "DELETE FROM history WHERE ts < ?")) {

                ps.setLong(1,
                        System.currentTimeMillis() - 7L * 24 * 60 * 60 * 1000);
                ps.executeUpdate();
            }
        } catch (Exception ignored) {
        } finally {
            Database.release(c);
        }
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

        if (sensorId == null || token == null) {
            HttpUtil.sendError(ex, 401, "missing_sensor_auth");
            return;
        }

        if (!Security.checkSensorToken(sensorId, token)) {
            HttpUtil.sendError(ex, 403, "invalid_sensor");
            return;
        }

        byte[] bodyBytes = ex.getRequestBody().readAllBytes();
        if (bodyBytes.length > 4096) {
            HttpUtil.sendError(ex, 413, "payload_too_large");
            return;
        }

        String body = new String(bodyBytes).trim()
                .replaceAll("[{}\" ]", "");

        int created = 0;

        for (String pair : body.split(",")) {
            if (!pair.contains(":")) continue;
            String[] kv = pair.split(":", 2);

            String var = kv[0];
            if (!var.matches("[a-zA-Z0-9_]+")) continue;

            String key = sensorId + "_" + var;
            if (!cache.containsKey(key) && ++created > 50) {
                HttpUtil.sendError(ex, 429, "too_many_metrics");
                return;
            }

            try {
                double value = Double.parseDouble(kv[1]);
                recordValue(sensorId, var, value);
            } catch (Exception ignored) {}
        }

        HttpUtil.sendJson(ex, "{\"status\":\"OK\"}");
    }

    /* ====== STORAGE ====== */

    private static void recordValue(String sensor, String var, double value) {
        long ts = System.currentTimeMillis();

        cache.computeIfAbsent(sensor + "_" + var,
                k -> new SensorCache()).add(value, ts);

        if (!dbQueue.offer(new DbPoint(sensor, var, ts, value))) {
            System.err.println(
                    "DB queue overflow, dropping data: " +
                            sensor + ":" + var + "=" + value);
        }
    }

    /* ====== DB WRITER ====== */

    static void startDbWriter() {

        Thread t = new Thread(() -> {

            List<DbPoint> batch = new ArrayList<>(DB_BATCH_SIZE);

            while (true) {
                try {
                    DbPoint first = dbQueue.take();
                    batch.add(first);
                    dbQueue.drainTo(batch, DB_BATCH_SIZE - 1);

                    writeBatch(batch);
                    batch.clear();

                } catch (Exception e) {
                    e.printStackTrace();
                    try { Thread.sleep(1000); } catch (InterruptedException ignored) {}
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
            }

            c.commit();

        } catch (Exception e) {
            try { if (c != null) c.rollback(); } catch (Exception ignored) {}
            throw new RuntimeException(e);

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
                    String key = rs.getString(1) + "_" + rs.getString(2);
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
            SensorCache sc = e.getValue();
            if (!sc.isAlive()) continue;

            List<Point> pts = sc.snapshot(fromTs);
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

    /* ====== CACHE ====== */

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
            for (Point p : points) {
                if (p.ts >= fromTs) out.add(p);
            }
            return out;
        }

        synchronized boolean isAlive() {
            return lastSeen != 0 &&
                    System.currentTimeMillis() - lastSeen <= SENSOR_TTL_MS;
        }
    }

    static class Point {
        final long ts;
        final double value;
        Point(long t, double v) { ts = t; value = v; }
    }

    static class DbPoint {
        final String sensor;
        final String var;
        final long ts;
        final double value;

        DbPoint(String s, String v, long t, double val) {
            sensor = s;
            var = v;
            ts = t;
            value = val;
        }
    }
}
