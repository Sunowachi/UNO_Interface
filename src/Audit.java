import java.io.File;
import java.io.FileWriter;
import java.text.SimpleDateFormat;
import java.util.Date;

public class Audit {
    // Объект для синхронизации доступа к файлу аудита из нескольких потоков
    private static final Object LOCK = new Object();
    // Имя файла, в который будут записываться события аудита
    private static final String FILE = "audit.log";
    // Максимальный размер файла аудита в байтах (10 МБ)
    private static final long MAX_SIZE = 10 * 1024 * 1024;
    // Формат временной метки для каждой записи: год-месяц-день часы:минуты:секунды
    private static final SimpleDateFormat TS = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");

    // ================= ОСНОВНЫЕ МЕТОДЫ =================

    // Запись события аудита
    public static void log(String user, String action, String ip) {
        // Очистка входных строк от потенциально опасных символов
        String safeUser = sanitize(user);
        String safeAction = sanitize(action);
        String safeIp = sanitize(ip);

        // Формирование строки лога: временная метка, PID, имя потока, пользователь, действие, IP
        String line = TS.format(new Date()) +
                " | pid=" + ProcessHandle.current().pid() +
                " | thread=" + Thread.currentThread().getName() +
                " | user=" + safeUser +
                " | action=" + safeAction +
                " | ip=" + safeIp + "\n";

        // Синхронизация блока для предотвращения одновременной записи из разных потоков
        synchronized (LOCK) {
            try {
                // Проверка необходимости ротации файла (если превышен размер)
                rotateIfNeeded();
                // Открытие файла в режиме добавления (true) и запись строки
                try (FileWriter fw = new FileWriter(FILE, true)) {
                    fw.write(line);
                }
            } catch (Exception e) {
                // В случае ошибки записи в файл выводим сообщение в stderr
                System.err.println("[AUDIT FAIL] " + line.trim());
            }
        }
    }

    // ================= ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ =================

    // Ротация лога при превышении размера
    private static void rotateIfNeeded() {
        // Создание объекта File для файла аудита
        File f = new File(FILE);
        // Если файл не существует — ротация не требуется
        if (!f.exists()) return;
        // Если размер файла меньше максимального — ротация не требуется
        if (f.length() < MAX_SIZE) return;

        // Создание имени для ротированного файла: исходное имя + метка времени
        File rotated = new File(FILE + "." +
                new SimpleDateFormat("yyyyMMdd_HHmmss").format(new Date()));
        // Попытка переименовать текущий файл в ротированный
        if (!f.renameTo(rotated)) {
            // Если переименование не удалось, выбрасываем исключение
            throw new RuntimeException("audit log rotation failed");
        }
    }

    // Очистка строковых значений от специальных символов
    private static String sanitize(String v) {
        // Если входная строка равна null, заменяем её дефисом
        if (v == null) return "-";
        // Заменяем символы перевода строки, возврата каретки и вертикальной черты на подчёркивание,
        // чтобы не нарушить формат лога с разделителями "|"
        return v.replace("\n", "_")
                .replace("\r", "_")
                .replace("|", "_")
                .trim(); // Удаляем лишние пробелы в начале и конце
    }
}