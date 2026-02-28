import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Properties;

/**
 * Загрузчик конфигурации из файла server.properties.
 * Значения по умолчанию используются, если параметр отсутствует в файле.
 */
public class Config {
    private static final Properties props = new Properties();
    private static final String CONFIG_FILE = "server.properties";

    static {
        Path path = Paths.get(CONFIG_FILE);
        if (Files.exists(path)) {
            try (InputStream is = Files.newInputStream(path)) {
                props.load(is);
                System.out.println("✅ Конфигурация загружена из " + CONFIG_FILE);
            } catch (IOException e) {
                System.err.println("⚠️ Ошибка чтения " + CONFIG_FILE + ", используются значения по умолчанию");
            }
        } else {
            System.out.println("⚠️ Файл " + CONFIG_FILE + " не найден, используются значения по умолчанию");
        }
    }

    public static String get(String key, String defaultValue) {
        return props.getProperty(key, defaultValue);
    }

    public static int getInt(String key, int defaultValue) {
        String val = props.getProperty(key);
        if (val == null) return defaultValue;
        try {
            return Integer.parseInt(val.trim());
        } catch (NumberFormatException e) {
            return defaultValue;
        }
    }

    public static long getLong(String key, long defaultValue) {
        String val = props.getProperty(key);
        if (val == null) return defaultValue;
        try {
            return Long.parseLong(val.trim());
        } catch (NumberFormatException e) {
            return defaultValue;
        }
    }

    public static boolean getBoolean(String key, boolean defaultValue) {
        String val = props.getProperty(key);
        if (val == null) return defaultValue;
        return Boolean.parseBoolean(val.trim());
    }
}