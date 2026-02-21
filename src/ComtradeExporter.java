import java.io.*;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

public class ComtradeExporter {

    // ========== COMTRADE 1999 (ZIP-архив с тремя файлами) ==========

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

    private static void writeCfg1999(OutputStream os, String sensorId, String varName,
                                     List<DataStore.Point> points,
                                     long startTime, long endTime) throws IOException {
        Writer writer = new OutputStreamWriter(os, StandardCharsets.US_ASCII);
        int numPoints = points.size();

        // 1. Station name, device ID, revision year
        writer.write("StationName," + sensorId + ",1999\r\n");

        // 2. Total channels, analog channels, digital channels
        writer.write("1,1,0\r\n");   // один аналоговый, ноль дискретных

        // 3. Analog channel description (13 полей согласно IEEE C37.111-1999)
        //    An,ch_id,ph,ccbm,uu,a,b,skew,min,max,primary,secondary,PS
        //    Указываем, что данные уже в первичных величинах (PS = 'A')
        writer.write("1," + varName + ",,,V,1.0,0.0,0.0,0.0,0.0,1.0,0.0,A\r\n");

        // 4. Digital channels (нет) – пропускаем

        // 5. Номинальная частота сети (50 или 60 Гц) – здесь 50
        writer.write("50\r\n");

        // 6. Количество частот дискретизации (1, т.к. переменная частота)
        writer.write("1\r\n");

        // 7. Для каждой частоты: номер последней выборки, частота (0 – переменная)
        writer.write(numPoints + ",0\r\n");

        // 8. Дата и время начала записи (в формате dd/mm/yyyy,hh:mm:ss.ssssss)
        writer.write(formatComtradeDate(startTime) + "\r\n");

        // 9. Дата и время окончания записи
        writer.write(formatComtradeDate(endTime) + "\r\n");

        // 10. Тип файла данных (ASCII)
        writer.write("ASCII\r\n");

        writer.flush();
    }

    private static void writeDat1999(OutputStream os, List<DataStore.Point> points) throws IOException {
        Writer writer = new OutputStreamWriter(os, StandardCharsets.US_ASCII);
        long baseTime = points.get(0).ts * 1000; // микросекунды первой точки
        for (int i = 0; i < points.size(); i++) {
            DataStore.Point p = points.get(i);
            long timeUs = p.ts * 1000 - baseTime; // микросекунды от начала
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
        writer.write("Generated: " + new Date() + "\r\n");
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

        // Вычисляем реальные min и max
        double minVal = points.stream().mapToDouble(p -> p.value).min().orElse(0.0);
        double maxVal = points.stream().mapToDouble(p -> p.value).max().orElse(0.0);
        // Если min и max совпадают, немного расширяем диапазон
        if (minVal == maxVal) {
            minVal -= 0.5;
            maxVal += 0.5;
        }

        // --- Configuration ---
        writer.write("--- Configuration ---\r\n");
        writer.write("StationName," + sensorId + ",2013\r\n");
        writer.write("1,1,0\r\n");
        // Формируем строку аналогового канала с реальными min/max
        writer.write(String.format(Locale.US,
                "1,%s,,,V,1.0,0.0,0.0,%.3f,%.3f,1.0,0.0,A\r\n",
                varName, minVal, maxVal));
        writer.write("50\r\n");
        writer.write("1\r\n");
        writer.write(points.size() + ",0\r\n");
        writer.write(formatComtradeDate(startTime) + "\r\n");
        writer.write(formatComtradeDate(endTime) + "\r\n");
        writer.write("ASCII\r\n");

        // --- Data ---
        writer.write("--- Data ---\r\n");
        for (int i = 0; i < points.size(); i++) {
            DataStore.Point p = points.get(i);
            long timeUs = Math.max(0, Math.min(duration, p.ts * 1000 - baseTime));
            writer.write(String.format(Locale.US, "%d,%d,%.3f\r\n", i + 1, timeUs, p.value));
        }
        writer.write("\r\n");

        // --- Header ---
        writer.write("--- Header ---\r\n");
        writer.write("COMTRADE 2013 Export from DataServer\r\n");
        writer.write("Sensor ID: " + sensorId + "\r\n");
        writer.write("Variable: " + varName + "\r\n");
        writer.write("Start: " + startTime + " ms\r\n");
        writer.write("End: " + endTime + " ms\r\n");
        writer.write("Points: " + points.size() + "\r\n");
        writer.write("Generated: " + new Date() + "\r\n");
        writer.write("\r\n");

        // --- Information ---
        writer.write("--- Information ---\r\n");
        writer.write("DataServer COMTRADE Exporter\r\n");
        writer.write("Format: COMTRADE 2013 Single File (CFF)\r\n");
        writer.write("Data type: ASCII with variable sample rate\r\n");

        writer.flush();
        return baos.toByteArray();
    }

    // ========== ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ==========

    private static String formatComtradeDate(long millis) {
        SimpleDateFormat sdf = new SimpleDateFormat("dd/MM/yyyy,HH:mm:ss.SSSSSS");
        sdf.setTimeZone(TimeZone.getTimeZone("UTC"));
        return sdf.format(new Date(millis));
    }

    private static String generateShortName(String sensorId, String varName) {
        String s = (sensorId.length() > 4 ? sensorId.substring(0, 4) : sensorId);
        String v = (varName.length() > 3 ? varName.substring(0, 3) : varName);
        String full = sensorId + varName;
        int hash = (full.hashCode() & 0xF) % 10;
        String name = s + v + hash;
        return name.replaceAll("[^a-zA-Z0-9]", "X").toUpperCase();
    }

    // Для обратной совместимости
    public static byte[] generateZip(String sensorId, String varName,
                                     List<DataStore.Point> points,
                                     long startTime, long endTime) throws IOException {
        return generateZip1999(sensorId, varName, points, startTime, endTime);
    }

    public static String sanitizeFileName(String name) {
        return name.replaceAll("[^a-zA-Z0-9_\\-]", "_");
    }
}