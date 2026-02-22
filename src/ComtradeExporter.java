import java.io.*;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Класс для генерации файлов в формате COMTRADE (1999 и 2013).
 */
public class ComtradeExporter {

    // ==================== COMTRADE 1999 (ZIP-архив из трёх файлов) ====================

    /**
     * Генерирует ZIP-архив, содержащий .cfg, .dat и .hdr для версии 1999.
     */
    public static byte[] generateZip1999(String sensorId, String varName,
                                         List<DataStore.Point> points,
                                         long startTime, long endTime) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (ZipOutputStream zos = new ZipOutputStream(baos)) {
            String baseName = generateShortName(sensorId, varName);

            zos.putNextEntry(new ZipEntry(baseName + ".cfg"));
            writeCfg1999(zos, sensorId, varName, points, startTime, endTime);
            zos.closeEntry();

            zos.putNextEntry(new ZipEntry(baseName + ".dat"));
            writeDat1999(zos, points);
            zos.closeEntry();

            zos.putNextEntry(new ZipEntry(baseName + ".hdr"));
            writeHdr1999(zos, sensorId, varName, startTime, endTime, points.size());
            zos.closeEntry();
        }
        return baos.toByteArray();
    }

    /** Запись конфигурационного файла (CFG) для версии 1999 */
    private static void writeCfg1999(OutputStream os, String sensorId, String varName,
                                     List<DataStore.Point> points,
                                     long startTime, long endTime) throws IOException {
        Writer writer = new OutputStreamWriter(os, StandardCharsets.US_ASCII);
        int numPoints = points.size();

        writer.write("StationName," + sensorId + ",1999\r\n");
        writer.write("1,1,0\r\n");   // 1 аналоговый канал, 0 дискретных
        // Описание аналогового канала: An,ch_id,ph,ccbm,uu,a,b,skew,min,max,primary,secondary,PS
        writer.write("1," + varName + ",,,V,1.0,0.0,0.0,0.0,0.0,1.0,0.0,A\r\n");
        writer.write("50\r\n");      // Номинальная частота сети
        writer.write("1\r\n");       // Количество частот дискретизации
        writer.write(numPoints + ",0\r\n");  // Последняя выборка, частота (0 – переменная)
        writer.write(formatComtradeDate(startTime) + "\r\n");
        writer.write(formatComtradeDate(endTime) + "\r\n");
        writer.write("ASCII\r\n");
        writer.flush();
    }

    /** Запись файла данных (DAT) для версии 1999 */
    private static void writeDat1999(OutputStream os, List<DataStore.Point> points) throws IOException {
        Writer writer = new OutputStreamWriter(os, StandardCharsets.US_ASCII);
        long baseTime = points.get(0).ts * 1000; // микросекунды первой точки
        for (int i = 0; i < points.size(); i++) {
            DataStore.Point p = points.get(i);
            long timeUs = p.ts * 1000 - baseTime;
            writer.write(String.format(Locale.US, "%d,%d,%.3f\r\n", i + 1, timeUs, p.value));
        }
        writer.flush();
    }

    /** Запись заголовочного файла (HDR) для версии 1999 */
    private static void writeHdr1999(OutputStream os, String sensorId, String varName,
                                     long startTime, long endTime, int pointsCount) throws IOException {
        Writer writer = new OutputStreamWriter(os, StandardCharsets.US_ASCII);
        writer.write("COMTRADE 1999 Export from DataServer\r\n");
        writer.write("Sensor ID: " + sensorId + "\r\n");
        writer.write("Variable: " + varName + "\r\n");
        writer.write("Start: " + startTime + " ms\r\n");
        writer.write("End: " + endTime + " ms\r\n");
        writer.write("Points: " + pointsCount + "\r\n");
        writer.write("Generated: " + new Date() + "\r\n");
        writer.flush();
    }

    // ==================== COMTRADE 2013 (единый файл .cff) ====================

    /**
     * Генерирует единый файл CFF для версии 2013.
     */
    public static byte[] generateCff2013(String sensorId, String varName,
                                         List<DataStore.Point> points,
                                         long startTime, long endTime) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        Writer writer = new OutputStreamWriter(baos, StandardCharsets.UTF_8);

        long baseTime = points.get(0).ts * 1000;
        long duration = (endTime - startTime) * 1000;

        double minVal = points.stream().mapToDouble(p -> p.value).min().orElse(0.0);
        double maxVal = points.stream().mapToDouble(p -> p.value).max().orElse(0.0);
        if (minVal == maxVal) {
            minVal -= 0.5;
            maxVal += 0.5;
        }

        // --- Секция конфигурации ---
        writer.write("--- Configuration ---\r\n");
        writer.write("StationName," + sensorId + ",2013\r\n");
        writer.write("1,1,0\r\n");
        writer.write(String.format(Locale.US,
                "1,%s,,,V,1.0,0.0,0.0,%.3f,%.3f,1.0,0.0,A\r\n",
                varName, minVal, maxVal));
        writer.write("50\r\n");
        writer.write("1\r\n");
        writer.write(points.size() + ",0\r\n");
        writer.write(formatComtradeDate(startTime) + "\r\n");
        writer.write(formatComtradeDate(endTime) + "\r\n");
        writer.write("ASCII\r\n");

        // --- Секция данных ---
        writer.write("--- Data ---\r\n");
        for (int i = 0; i < points.size(); i++) {
            DataStore.Point p = points.get(i);
            long timeUs = Math.max(0, Math.min(duration, p.ts * 1000 - baseTime));
            writer.write(String.format(Locale.US, "%d,%d,%.3f\r\n", i + 1, timeUs, p.value));
        }
        writer.write("\r\n");

        // --- Секция заголовка ---
        writer.write("--- Header ---\r\n");
        writer.write("COMTRADE 2013 Export from DataServer\r\n");
        writer.write("Sensor ID: " + sensorId + "\r\n");
        writer.write("Variable: " + varName + "\r\n");
        writer.write("Start: " + startTime + " ms\r\n");
        writer.write("End: " + endTime + " ms\r\n");
        writer.write("Points: " + points.size() + "\r\n");
        writer.write("Generated: " + new Date() + "\r\n");
        writer.write("\r\n");

        // --- Секция информации ---
        writer.write("--- Information ---\r\n");
        writer.write("DataServer COMTRADE Exporter\r\n");
        writer.write("Format: COMTRADE 2013 Single File (CFF)\r\n");
        writer.write("Data type: ASCII with variable sample rate\r\n");

        writer.flush();
        return baos.toByteArray();
    }

    // ==================== ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ====================

    /** Форматирование даты в формат COMTRADE: dd/MM/yyyy,HH:mm:ss.SSSSSS (UTC) */
    private static String formatComtradeDate(long millis) {
        SimpleDateFormat sdf = new SimpleDateFormat("dd/MM/yyyy,HH:mm:ss.SSSSSS");
        sdf.setTimeZone(TimeZone.getTimeZone("UTC"));
        return sdf.format(new Date(millis));
    }

    /** Генерация короткого имени файла (до 8 символов) на основе ID датчика и переменной */
    private static String generateShortName(String sensorId, String varName) {
        String s = (sensorId.length() > 4 ? sensorId.substring(0, 4) : sensorId);
        String v = (varName.length() > 3 ? varName.substring(0, 3) : varName);
        String full = sensorId + varName;
        int hash = (full.hashCode() & 0xF) % 10;
        String name = s + v + hash;
        return name.replaceAll("[^a-zA-Z0-9]", "X").toUpperCase();
    }
}