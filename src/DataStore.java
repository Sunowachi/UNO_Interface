import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

public class DataStore {

    static final int CACHE_POINTS = 200;
    static final long SENSOR_TTL_MS = 60_000;

    static final Map<String, SensorCache> cache =
            new ConcurrentHashMap<>();

    /* ====== API ====== */

    static void handleData(HttpExchange ex) throws IOException {
        String method = ex.getRequestMethod();
        String ip = ex.getRemoteAddress().getAddress().getHostAddress();

        if ("POST".equalsIgnoreCase(method)) {

            Security.Session s = Security.peekSession(ex);
            if (s != null) {
                if (!Security.checkCsrf(ex, s)) return;
            }

            if (!ip.startsWith("192.168.") && !ip.equals("127.0.0.1")) {
                HttpUtil.sendError(ex, 403, "forbidden");
                return;
            }

            handlePostData(ex, ip);
            return;
        }

        if ("GET".equalsIgnoreCase(method)) {

            Security.Session s = Security.getSession(ex);

            if (s == null) {
                HttpUtil.sendError(ex, 401, "unauthorized");
                return;
            }

            if (!Security.require(s, ex, Security.Permission.VIEW_DATA)) {
                return;
            }

            long range = HttpUtil.parseRange(ex);
            HttpUtil.sendJson(ex, buildSensorsJson(range));
            return;
        }

        ex.sendResponseHeaders(405, -1);
    }

    static void cleanupCache() {
        cache.entrySet().removeIf(e -> !e.getValue().isAlive());
        try (var ps = Database.db.prepareStatement(
                "DELETE FROM history WHERE ts < ?")) {

            // История старше 7 дней удаляется
            ps.setLong(1, System.currentTimeMillis() - 7L * 24 * 60 * 60 * 1000);
            ps.executeUpdate();
        } catch (Exception ignored) {}
    }

    static void warmupCacheFromDb() {
        loadFromDb(0).forEach((k, pts) -> {
            SensorCache c = new SensorCache();
            for (Point p : pts) c.add(p.value, p.ts);
            cache.put(k, c);
        });
    }

    /* ====== internals ====== */

    private static void handlePostData(HttpExchange ex, String ip) throws IOException {

        int created = 0;

        if (ex.getRequestHeaders().getFirst("Content-Type") == null ||
                !ex.getRequestHeaders().getFirst("Content-Type")
                        .startsWith("application/json")) {

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

        String body = new String(bodyBytes).trim();

        body = body.replaceAll("[{}\" ]", "");
        for (String pair : body.split(",")) {
            if (!pair.contains(":")) continue;
            String[] kv = pair.split(":", 2);

            String var = kv[0];
            if (!var.matches("[a-zA-Z0-9_]+")) continue;

            String key = sensorId + "_" + var;
            if (!cache.containsKey(key)) {
                if (++created > 50) {
                    HttpUtil.sendError(ex, 429, "too_many_metrics");
                    return;
                }
            }

            try {
                double value = Double.parseDouble(kv[1]);
                recordValue(sensorId, var, value);
            } catch (Exception ignored) {}
        }

        HttpUtil.sendJson(ex, "{\"status\":\"OK\"}");
    }

    private static void recordValue(String sensor, String var, double value) {
        long ts = System.currentTimeMillis();
        cache.computeIfAbsent(sensor + "_" + var,
                k -> new SensorCache()).add(value, ts);
        saveToDb(sensor, var, ts, value);
    }

    private static void saveToDb(String s, String v, long ts, double val) {
        try (PreparedStatement ps = Database.db.prepareStatement(
                "INSERT INTO history(sensor_id,var_name,ts,value) VALUES (?,?,?,?)")) {
            ps.setString(1, s);
            ps.setString(2, v);
            ps.setLong(3, ts);
            ps.setDouble(4, val);
            ps.executeUpdate();
        } catch (Exception ignored) {}
    }

    /* ====== DB load ====== */

    private static Map<String, List<Point>> loadFromDb(long fromTs) {
        Map<String, List<Point>> m = new LinkedHashMap<>();
        try (PreparedStatement ps = Database.db.prepareStatement(
                "SELECT sensor_id,var_name,ts,value FROM history WHERE ts>=? ORDER BY ts")) {
            ps.setLong(1, fromTs);
            ResultSet rs = ps.executeQuery();
            while (rs.next())
                m.computeIfAbsent(
                                rs.getString(1) + "_" + rs.getString(2),
                                k -> new ArrayList<>())
                        .add(new Point(rs.getLong(3), rs.getDouble(4)));
        } catch (Exception ignored) {}
        return m;
    }

    /* ====== JSON ====== */

    static String buildSensorsJson(long rangeMs) {
        long fromTs = rangeMs > 0
                ? System.currentTimeMillis() - rangeMs
                : 0;

        Map<String, List<Point>> data = new LinkedHashMap<>();

        for (var e : cache.entrySet()) {
            SensorCache sc = e.getValue();
            if (!sc.isAlive()) continue;

            List<Point> pts = new ArrayList<>();
            for (Point p : sc.points)
                if (p.ts >= fromTs) pts.add(p);

            if (!pts.isEmpty()) data.put(e.getKey(), pts);
        }
        return pointsToJsonMap(data);
    }

    private static String pointsToJsonMap(Map<String, List<Point>> data) {
        StringBuilder sb = new StringBuilder("{");
        boolean f = true;

        for (var e : data.entrySet()) {
            if (!f) sb.append(",");
            f = false;

            String safeKey = e.getKey()
                    .replaceAll("[^a-zA-Z0-9_\\-]", "_");

            sb.append("\"")
                    .append(safeKey)
                    .append("\":")
                    .append(pointsToJson(e.getValue()));
        }

        return sb.append("}").toString();
    }

    private static String pointsToJson(List<Point> pts) {
        StringBuilder v = new StringBuilder("["),
                t = new StringBuilder("[");
        for (int i = 0; i < pts.size(); i++) {
            if (i > 0) { v.append(","); t.append(","); }
            v.append(pts.get(i).value);
            t.append(pts.get(i).ts);
        }
        return "{\"values\":" + v + "],\"times\":" + t + "]}";
    }

    /* ====== cache ====== */

    static class SensorCache {

        volatile long lastSeen;

        final Deque<Point> points = new ArrayDeque<>();

        synchronized void add(double v, long t) {
            points.addLast(new Point(t, v));
            lastSeen = t;
            while (points.size() > CACHE_POINTS)
                points.removeFirst();
        }

        synchronized boolean isAlive() {
            return System.currentTimeMillis() - lastSeen <= SENSOR_TTL_MS;
        }
    }

    static class Point {
        final long ts;
        final double value;
        Point(long t, double v) { ts = t; value = v; }
    }
}