import java.io.File;
import java.io.FileWriter;
import java.text.SimpleDateFormat;
import java.util.Date;

public class Audit {

    /* ================= CONFIG ================= */

    private static final Object LOCK = new Object();
    private static final String FILE = "audit.log";
    private static final long MAX_SIZE = 10 * 1024 * 1024; // 10 MB

    private static final SimpleDateFormat TS =
            new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");

    /* ================= PUBLIC API ================= */

    public static void log(String user, String action, String ip) {

        String safeUser = sanitize(user);
        String safeAction = sanitize(action);
        String safeIp = sanitize(ip);

        String line =
                TS.format(new Date()) +
                        " | pid=" + ProcessHandle.current().pid() +
                        " | thread=" + Thread.currentThread().getName() +
                        " | user=" + safeUser +
                        " | action=" + safeAction +
                        " | ip=" + safeIp +
                        "\n";

        synchronized (LOCK) {
            try {
                rotateIfNeeded();
                try (FileWriter fw = new FileWriter(FILE, true)) {
                    fw.write(line);
                }
            } catch (Exception e) {
                System.err.println("[AUDIT FAIL] " + line.trim());
            }
        }
    }

    /* ================= INTERNAL ================= */

    private static void rotateIfNeeded() {
        File f = new File(FILE);
        if (!f.exists()) return;

        if (f.length() < MAX_SIZE) return;

        File rotated = new File(FILE + "." +
                new SimpleDateFormat("yyyyMMdd_HHmmss").format(new Date()));

        if (!f.renameTo(rotated)) {
            throw new RuntimeException("audit log rotation failed");
        }
    }

    private static String sanitize(String v) {
        if (v == null) return "-";
        return v
                .replace("\n", "_")
                .replace("\r", "_")
                .replace("|", "_")
                .trim();
    }
}
