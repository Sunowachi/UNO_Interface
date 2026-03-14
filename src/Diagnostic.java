import java.io.File;
import java.lang.management.ManagementFactory;
import java.lang.management.OperatingSystemMXBean;
import java.sql.Connection;
import java.util.*;

public class Diagnostic {

    private static final long DIAG_ONLINE_TIMEOUT_MS = 10_000; // 10 секунд

    public static Map<String, Object> getHealth() {
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("timestamp", System.currentTimeMillis());

        // База данных
        Map<String, Object> db = new LinkedHashMap<>();
        long dbStart = System.nanoTime();
        Connection c = null; // объявляем переменную соединения
        try {
            c = Database.borrow(); // берём соединение
            try (var st = c.createStatement()) {
                var rs = st.executeQuery("SELECT 1");
                if (rs.next()) {
                    db.put("status", "OK");
                }
            }
            db.put("responseTimeMs", (System.nanoTime() - dbStart) / 1_000_000);
        } catch (Exception e) {
            db.put("status", "ERROR");
            db.put("error", e.getMessage());
        } finally {
            Database.release(c);
        }
        db.putAll(Database.getPoolStats());
        report.put("database", db);

        // DataStore
        Map<String, Object> ds = new LinkedHashMap<>();
        ds.put("queueSize", DataStore.getQueueSize());
        ds.put("queueLimit", DataStore.DB_QUEUE_LIMIT);
        ds.put("droppedPoints", DataStore.getDroppedPoints());
        ds.put("activeMetrics", DataStore.getActiveMetricsCount());
        ds.put("activeSensors", DataStore.getActiveSensorsCount());
        report.put("dataStore", ds);

        // Диск
        Map<String, Object> disk = new LinkedHashMap<>();
        disk.put("auditFileSize", Audit.getAuditFileSize());
        disk.put("freeDiskSpace", new File(".").getFreeSpace());
        disk.put("totalDiskSpace", new File(".").getTotalSpace());
        report.put("disk", disk);

        // Системная нагрузка
        OperatingSystemMXBean osBean = ManagementFactory.getOperatingSystemMXBean();
        Map<String, Object> system = new LinkedHashMap<>();
        system.put("availableProcessors", osBean.getAvailableProcessors());
        system.put("systemLoadAverage", osBean.getSystemLoadAverage());
        report.put("system", system);

        // Датчики
        List<Map<String, Object>> sensorsStatus = new ArrayList<>();
        long now = System.currentTimeMillis();
        for (var e : DataStore.getLastSensorTimes().entrySet()) {
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("id", e.getKey());
            s.put("lastSeen", e.getValue());
            long age = now - e.getValue();

            if (age <= DIAG_ONLINE_TIMEOUT_MS) {
                s.put("status", "ONLINE");
            } else if (age <= DataStore.SENSOR_TTL_MS) {
                s.put("status", "STALE");
            } else {
                s.put("status", "DEAD");
            }
            sensorsStatus.add(s);
        }
        report.put("sensors", sensorsStatus);

        // Общий статус
        boolean allOk = "OK".equals(db.get("status"))
                && DataStore.getQueueSize() < DataStore.DB_QUEUE_LIMIT * 0.9;
        report.put("status", allOk ? "OK" : "WARNING");

        return report;
    }
}