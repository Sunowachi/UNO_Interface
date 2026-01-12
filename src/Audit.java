import java.io.FileWriter;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;

public class Audit {

    private static final Object LOCK = new Object();
    private static final String FILE = "audit.log";

    private static final SimpleDateFormat TS =
            new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");

    public static void log(String user, String action, String ip) {
        String line = TS.format(new Date()) +
                " | user=" + user +
                " | action=" + action +
                " | ip=" + ip + "\n";

        synchronized (LOCK) {
            try (FileWriter fw = new FileWriter(FILE, true)) {
                fw.write(line);
                fw.flush();
            } catch (IOException ignored) {}
        }
    }
}