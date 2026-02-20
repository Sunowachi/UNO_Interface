import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

public class ComtradeExporter {

    // ========== COMTRADE 1999 (ZIP-архив с тремя файлами) ==========

    public static byte[] generateZip1999(String sensorId, String varName,
                                         List<DataStore.Point> points,
                                         long startTime, long endTime) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (ZipOutputStream zos = new ZipOutputStream(baos)) {
            // Короткое имя (макс 8 символов) для совместимости со старыми анализаторами
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

    private static void writeCfg1999(OutputStream os, String sensorId, String varName,
                                     List<DataStore.Point> points,
                                     long startTime, long endTime) throws IOException {
        Writer writer = new OutputStreamWriter(os, StandardCharsets.US_ASCII);
        int numPoints = points.size();

        writer.write("StationName," + sensorId + ",1999\r\n");
        // Вторая строка: количество аналоговых каналов с буквой 'A', затем количество дискретных
        writer.write("1A,0\r\n");
        // Строка аналогового канала: ровно 11 полей
        writer.write("1," + varName + ",,,V,1.0,0.0,0.0,0.0,0.0,A\r\n");
        writer.write("0\r\n"); // переменная частота дискретизации
        writer.write(numPoints + "\r\n");
        writer.write((startTime * 1000) + "," + (endTime * 1000) + "\r\n");
        writer.write("ASCII\r\n");
        writer.write("1\r\n");
        writer.flush();
    }

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

    private static void writeHdr1999(OutputStream os, String sensorId, String varName,
                                     long startTime, long endTime, int pointsCount) throws IOException {
        Writer writer = new OutputStreamWriter(os, StandardCharsets.US_ASCII);
        writer.write("COMTRADE 1999 Export from DataServer\r\n");
        writer.write("Sensor ID: " + sensorId + "\r\n");
        writer.write("Variable: " + varName + "\r\n");
        writer.write("Start: " + startTime + " ms\r\n");
        writer.write("End: " + endTime + " ms\r\n");
        writer.write("Points: " + pointsCount + "\r\n");
        writer.write("Generated: " + new java.util.Date() + "\r\n");
        writer.flush();
    }

    // ========== COMTRADE 2013 (единый файл .cff) ==========

    public static byte[] generateCff2013(String sensorId, String varName,
                                         List<DataStore.Point> points,
                                         long startTime, long endTime) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        Writer writer = new OutputStreamWriter(baos, StandardCharsets.UTF_8);

        long baseTime = points.get(0).ts * 1000;
        long duration = (endTime - startTime) * 1000;

        // --- Configuration ---
        writer.write("--- Configuration ---\n");
        writer.write("StationName," + sensorId + ",2013\n");
        writer.write("1,0\n");
        // 13 полей для аналогового канала в 2013 (включая primary/secondary)
        writer.write("1," + varName + ",,,V,1.0,0.0,0.0,0.0,0.0,1.0,0.0,A\n");
        writer.write("0\n");
        writer.write(points.size() + "\n");
        writer.write((startTime * 1000) + "," + (endTime * 1000) + "\n");
        writer.write("ASCII\n");
        writer.write("1\n");
        writer.write("\n");

        // --- Data ---
        writer.write("--- Data ---\n");
        for (int i = 0; i < points.size(); i++) {
            DataStore.Point p = points.get(i);
            long timeUs = Math.max(0, Math.min(duration, p.ts * 1000 - baseTime));
            writer.write(String.format(Locale.US, "%d,%d,%.3f\n", i + 1, timeUs, p.value));
        }
        writer.write("\n");

        // --- Header ---
        writer.write("--- Header ---\n");
        writer.write("COMTRADE 2013 Export from DataServer\n");
        writer.write("Sensor ID: " + sensorId + "\n");
        writer.write("Variable: " + varName + "\n");
        writer.write("Start: " + startTime + " ms\n");
        writer.write("End: " + endTime + " ms\n");
        writer.write("Points: " + points.size() + "\n");
        writer.write("Generated: " + new java.util.Date() + "\n");
        writer.write("\n");

        // --- Information ---
        writer.write("--- Information ---\n");
        writer.write("DataServer COMTRADE Exporter\n");
        writer.write("Format: COMTRADE 2013 Single File (CFF)\n");
        writer.write("Data type: ASCII with variable sample rate\n");

        writer.flush();
        return baos.toByteArray();
    }

    // ========== ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ==========

    private static String generateShortName(String sensorId, String varName) {
        // Первые буквы: до 4 от sensorId, до 3 от varName + 1 символ хэша
        String s = (sensorId.length() > 4 ? sensorId.substring(0, 4) : sensorId);
        String v = (varName.length() > 3 ? varName.substring(0, 3) : varName);
        String full = sensorId + varName;
        int hash = (full.hashCode() & 0xF) % 10; // 0..9
        String name = s + v + hash;
        return name.replaceAll("[^a-zA-Z0-9]", "X").toUpperCase();
    }

    // Для обратной совместимости (старый метод generateZip вызывает 1999)
    public static byte[] generateZip(String sensorId, String varName,
                                     List<DataStore.Point> points,
                                     long startTime, long endTime) throws IOException {
        return generateZip1999(sensorId, varName, points, startTime, endTime);
    }

    public static String sanitizeFileName(String name) {
        return name.replaceAll("[^a-zA-Z0-9_\\-]", "_");
    }
}