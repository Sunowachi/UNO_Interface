import java.io.*;
import java.nio.file.*;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.concurrent.*;
import java.util.zip.GZIPOutputStream;

/**
 * Класс для асинхронного аудита событий с ротацией файлов.
 */
public class Audit {

    // ==================== КОНФИГУРАЦИЯ ====================
    // Имя файла аудита
    private static final String FILE = Config.get("audit.file", "audit.log");
    // Максимальный размер (10 МБ)
    private static final long MAX_SIZE = Config.getLong("audit.maxSize", 10 * 1024 * 1024);
    // Количество хранимых архивов
    private static final int MAX_BACKUPS = Config.getInt("audit.maxBackups", 5);
    // Размер очереди событий
    private static final int QUEUE_CAPACITY = Config.getInt("audit.queueCapacity", 10_000);

    // ==================== ОЧЕРЕДЬ И ПОТОК ====================
    private static final BlockingQueue<AuditEvent> eventQueue = new LinkedBlockingQueue<>(QUEUE_CAPACITY);
    private static volatile boolean running = true;                      // Флаг работы фонового потока

    static {
        startWriterThread();                                              // Запуск потока при загрузке класса
        Runtime.getRuntime().addShutdownHook(new Thread(Audit::shutdown));
    }

    // ==================== ВНУТРЕННИЙ КЛАСС – СОБЫТИЕ АУДИТА ====================
    private static class AuditEvent {
        final String timestamp;
        final String level;        // INFO, WARNING, ERROR
        final String user;
        final String action;
        final String result;       // SUCCESS, FAIL, BLOCKED и т.п.
        final String details;
        final String ip;
        final String sessionId;
        final long pid;
        final String thread;

        AuditEvent(String level, String user, String action, String result, String details, String ip, String sessionId) {
            this.timestamp = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS").format(new Date());
            this.level = level;
            this.user = user != null ? sanitize(user) : "-";
            this.action = sanitize(action);
            this.result = result != null ? sanitize(result) : "-";
            this.details = details != null ? sanitize(details) : "-";
            this.ip = ip != null ? sanitize(ip) : "-";
            this.sessionId = sessionId != null ? sanitize(sessionId) : "-";
            this.pid = ProcessHandle.current().pid();
            this.thread = Thread.currentThread().getName();
        }

        /** Преобразование события в JSON-строку */
        String toJson() {
            return String.format(
                    "{\"timestamp\":\"%s\",\"level\":\"%s\",\"user\":\"%s\",\"action\":\"%s\"," +
                            "\"result\":\"%s\",\"details\":\"%s\",\"ip\":\"%s\",\"sessionId\":\"%s\"," +
                            "\"pid\":%d,\"thread\":\"%s\"}",
                    timestamp, level, user, action, result, details, ip, sessionId, pid, thread
            );
        }
    }

    // ==================== ОСНОВНЫЕ МЕТОДЫ ЛОГИРОВАНИЯ ====================
    // Для обратной совместимости
    public static void log(String user, String action, String ip) {
        log(Level.INFO, user, action, null, null, ip, null);
    }

    public static void info(String user, String action, String details, String ip) {
        log(Level.INFO, user, action, "SUCCESS", details, ip, null);
    }

    public static void warn(String user, String action, String details, String ip) {
        log(Level.WARNING, user, action, "WARNING", details, ip, null);
    }

    public static void warn(String user, String action, String details, String ip, String sessionId) {
        log(Level.WARNING, user, action, "WARNING", details, ip, sessionId);
    }

    public static void error(String user, String action, String details, String ip) {
        log(Level.ERROR, user, action, "ERROR", details, ip, null);
    }

    public static void error(String user, String action, String details, String ip, String sessionId) {
        log(Level.ERROR, user, action, "ERROR", details, ip, sessionId);
    }

    /** Базовый метод – создаёт событие и помещает в очередь */
    public static void log(Level level, String user, String action, String result, String details, String ip, String sessionId) {
        AuditEvent event = new AuditEvent(level.name(), user, action, result, details, ip, sessionId);
        if (!eventQueue.offer(event)) {
            // Очередь переполнена – сбрасываем в stderr
            System.err.println("[ОЧЕРЕДЬ АУДИТА ПЕРЕПОЛНЕНА] " + event.toJson());
        }
    }

    // ==================== УРОВНИ ЛОГИРОВАНИЯ ====================
    public enum Level {
        INFO, WARNING, ERROR
    }

    // ==================== ФОНОВЫЙ ПОТОК ЗАПИСИ ====================
    private static void startWriterThread() {
        Thread writer = new Thread(() -> {
            while (running || !eventQueue.isEmpty()) {
                try {
                    AuditEvent event = eventQueue.poll(1, TimeUnit.SECONDS);
                    if (event == null) continue;
                    writeEvent(event);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                } catch (Exception e) {
                    System.err.println("[ОШИБКА ПОТОКА ЗАПИСИ АУДИТА] " + e.getMessage());
                }
            }
        });
        writer.setDaemon(true);
        writer.setName("audit-writer");
        writer.start();
    }

    private static void writeEvent(AuditEvent event) {
        synchronized (LOCK) {
            try {
                rotateIfNeeded();
                try (FileWriter fw = new FileWriter(FILE, true)) {
                    fw.write(event.toJson() + "\n");
                }
            } catch (Exception e) {
                System.err.println("[ОШИБКА ЗАПИСИ АУДИТА] " + event.toJson());
            }
        }
    }

    private static final Object LOCK = new Object();

    // ==================== РОТАЦИЯ И АРХИВИРОВАНИЕ ====================
    private static void rotateIfNeeded() throws IOException {
        File f = new File(FILE);
        if (!f.exists() || f.length() < MAX_SIZE) return;

        File temp = new File(FILE + ".tmp");
        if (!f.renameTo(temp)) {
            throw new IOException("Не удалось переименовать файл аудита для ротации");
        }

        String timestamp = new SimpleDateFormat("yyyyMMdd_HHmmss").format(new Date());
        File archived = new File(FILE + "." + timestamp + ".gz");
        try (GZIPOutputStream gzos = new GZIPOutputStream(new FileOutputStream(archived));
             FileInputStream fis = new FileInputStream(temp)) {
            byte[] buffer = new byte[8192];
            int len;
            while ((len = fis.read(buffer)) > 0) {
                gzos.write(buffer, 0, len);
            }
        }
        temp.delete();
        cleanOldArchives();
    }

    private static void cleanOldArchives() {
        File dir = new File(".");
        File[] archives = dir.listFiles((d, name) -> name.startsWith(FILE + ".") && name.endsWith(".gz"));
        if (archives == null) return;
        if (archives.length <= MAX_BACKUPS) return;

        Arrays.sort(archives);
        for (int i = 0; i < archives.length - MAX_BACKUPS; i++) {
            archives[i].delete();
        }
    }

    // ==================== ЗАВЕРШЕНИЕ РАБОТЫ ====================
    public static void shutdown() {
        running = false;
        long deadline = System.currentTimeMillis() + 2000;
        while (!eventQueue.isEmpty() && System.currentTimeMillis() < deadline) {
            try { Thread.sleep(100); } catch (InterruptedException ignored) {}
        }
    }

    // ==================== САНИТАЙЗИНГ СТРОК ДЛЯ JSON ====================
    private static String sanitize(String v) {
        if (v == null) return "-";
        return v.replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\"", "\\\"")
                .replace("|", "_")
                .trim();
    }
}