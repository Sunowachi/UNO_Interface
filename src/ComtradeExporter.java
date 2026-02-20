import java.io.*;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

public class ComtradeExporter {
    public static byte[] generateZip(String sensorId, String varName,
                                     List<DataStore.Point> points,
                                     long startTime, long endTime,
                                     double sampleRate) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (ZipOutputStream zos = new ZipOutputStream(baos)) {
            String baseName = sanitizeFileName(sensorId + "_" + varName + "_" + startTime + "_" + endTime);

            zos.putNextEntry(new ZipEntry(baseName + ".cfg"));
            writeCfgFile(zos, sensorId, varName, points, startTime, endTime, sampleRate);
            zos.closeEntry();

            zos.putNextEntry(new ZipEntry(baseName + ".dat"));
            writeDatFile(zos, points);
            zos.closeEntry();

            zos.putNextEntry(new ZipEntry(baseName + ".hdr"));
            writeHdrFile(zos, sensorId, varName, startTime, endTime, points.size());
            zos.closeEntry();
        }
        return baos.toByteArray();
    }

    private static void writeCfgFile(OutputStream os, String sensorId, String varName,
                                     List<DataStore.Point> points,
                                     long startTime, long endTime,
                                     double sampleRate) throws IOException {
        Writer writer = new OutputStreamWriter(os, StandardCharsets.US_ASCII);
        int numPoints = points.size();

        // Стандартная первая строка
        writer.write("COMTRADE_Export," + sensorId + ",1999\n");
        // Количество аналоговых и дискретных каналов
        writer.write("1,0\n");
        // Описание аналогового канала (все поля строго через запятую, без пробелов)
        writer.write("A1," + varName + ",,,V,1.0,0.0,0.0,0.0,0.0,1.0,0.0,A\n");
        // Частота дискретизации с точкой в качестве разделителя
        writer.write(String.format(Locale.US, "%f\n", sampleRate));
        writer.write(numPoints + "\n");
        // Временные метки в микросекундах (целые)
        writer.write((startTime * 1000) + "," + (endTime * 1000) + "\n");
        writer.write("BINARY\n");
        writer.write("1\n");
        writer.flush();
    }

    private static void writeDatFile(OutputStream os, List<DataStore.Point> points) throws IOException {
        ByteBuffer buffer = ByteBuffer.allocate(4 * points.size());
        buffer.order(ByteOrder.LITTLE_ENDIAN);  // меняем порядок байт
        for (DataStore.Point p : points) {
            buffer.putFloat((float) p.value);
        }
        os.write(buffer.array());
        os.flush();
    }

    private static void writeHdrFile(OutputStream os, String sensorId, String varName,
                                     long startTime, long endTime, int pointsCount) throws IOException {
        Writer writer = new OutputStreamWriter(os, StandardCharsets.US_ASCII);
        writer.write("COMTRADE export from DataServer\n");
        writer.write("Sensor ID: " + sensorId + "\n");
        writer.write("Variable: " + varName + "\n");
        writer.write("Start: " + startTime + " ms\n");
        writer.write("End: " + endTime + " ms\n");
        writer.write("Points: " + pointsCount + "\n");
        writer.flush();
    }

    public static String sanitizeFileName(String name) {
        return name.replaceAll("[^a-zA-Z0-9_\\-]", "_");
    }
}