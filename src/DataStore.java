import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;

public class DataStore {
    // Настройки кэша
    static final int CACHE_POINTS = 200;                 // Максимальное количество точек данных, хранящихся в кэше для одного датчика/переменной
    static final long SENSOR_TTL_MS = 60_000;            // Время жизни датчика без активности (мс) – считается онлайн

    // Настройки защиты сенсоров
    static final long SENSOR_MIN_POST_INTERVAL_MS = 200; // Минимальный интервал между POST-запросами от одного датчика (200 мс)
    static final int MAX_SENSOR_FIELDS = 100;            // Максимальное количество полей (переменных) в одном POST-запросе
    static final int MAX_NEW_METRICS_PER_POST = 50;      // Максимальное количество новых метрик (ранее не встречавшихся), создаваемых за один POST
    static final int MAX_ACTIVE_SENSORS = 20_000;        // Максимальное количество одновременно активных датчиков

    // Состояние системы
    static final Map<String, Long> lastPostTs = new ConcurrentHashMap<>();   // Время последнего POST-запроса для каждого датчика (sensorId -> timestamp)
    static final AtomicLong lastCleanup = new AtomicLong();                   // Время последней очистки ограничений (используется для rate limiting)
    static final Map<String, SensorCache> cache = new ConcurrentHashMap<>();  // Основной кэш данных: ключ = "sensorId:varName", значение = SensorCache
    static final AtomicLong droppedPoints = new AtomicLong();                 // Счётчик отброшенных точек данных (для мониторинга)

    // Настройки асинхронной записи в БД
    static final int DB_BATCH_SIZE = 500;                 // Размер пакета для записи в БД (количество точек)
    static final int DB_QUEUE_LIMIT = 500_000;            // Максимальный размер очереди на запись в БД (предотвращает переполнение памяти)
    static final BlockingQueue<DbPoint> dbQueue = new LinkedBlockingQueue<>(DB_QUEUE_LIMIT); // Очередь точек, ожидающих записи в БД
    static volatile boolean dbRunning = true;              // Флаг работы фонового потока записи

    // Кэш исторических данных (из БД)
    private static long lastHistoryLoadTime = 0;           // Время последней загрузки исторических данных из БД
    private static long lastRequestedRangeMs = 0;          // Последний запрошенный диапазон времени (rangeMs)
    private static final Map<String, List<Point>> historicalCache = new ConcurrentHashMap<>(); // Кэш исторических данных: ключ = "sensorId:varName", значение = список точек

    /* ========== ВНУТРЕННИЕ КЛАССЫ ========== */

    // Кэш данных сенсора для одной метрики
    static class SensorCache {
        volatile long lastSeen;                           // Время последнего полученного значения (мс)
        final Deque<Point> points = new ArrayDeque<>();   // Двусторонняя очередь последних точек (до CACHE_POINTS)

        // Добавление новой точки в кэш
        synchronized void add(double v, long t) {
            points.addLast(new Point(t, v));               // Добавляем в конец
            lastSeen = t;                                   // Обновляем время последнего обращения
            while (points.size() > CACHE_POINTS) points.removeFirst(); // Удаляем самые старые, если превышен лимит
        }

        // Получение снимка точек, начиная с указанного времени
        synchronized List<Point> snapshot(long fromTs) {
            List<Point> out = new ArrayList<>();
            for (Point p : points) if (p.ts >= fromTs) out.add(p); // Копируем только те, что не старше fromTs
            return out;
        }

        // Определение статуса датчика на основе времени последнего обращения
        Status status(long now) {
            long age = now - lastSeen;                     // Возраст последних данных
            if (age <= SENSOR_TTL_MS) return Status.ONLINE;    // Активен (в пределах TTL)
            if (age <= SENSOR_TTL_MS * 3) return Status.STALE; // Устаревший (до 3*TTL)
            return Status.DEAD;                             // Мёртвый (больше 3*TTL)
        }

        enum Status { ONLINE, STALE, DEAD }                // Возможные статусы датчика
    }

    // Точка данных (временная метка + значение)
    static class Point {
        final long ts;      // Временная метка (мс)
        final double value; // Значение
        Point(long t, double v) { ts = t; value = v; }
    }

    // Точка данных для записи в БД (содержит также идентификатор датчика и имя переменной)
    static class DbPoint {
        final String sensor, var; // Идентификатор датчика и имя переменной
        final long ts;            // Временная метка
        final double value;       // Значение
        DbPoint(String s, String v, long t, double val) {
            sensor = s; var = v; ts = t; value = val;
        }
    }

    // Информация о сенсоре (для ответа /sensors)
    static class SensorInfo {
        final String id;                 // ID датчика
        final SensorCache.Status status;  // Текущий статус
        final long lastSeen;              // Время последнего полученного значения
        final Set<String> vars;           // Множество имён переменных, которые этот датчик отправлял
        SensorInfo(String id, SensorCache.Status status, long lastSeen, Set<String> vars) {
            this.id = id;
            this.status = status;
            this.lastSeen = lastSeen;
            this.vars = vars;
        }
    }

    // Вспомогательный класс-строитель для SensorInfo (используется при агрегации данных из кэша)
    private static class SensorInfoBuilder {
        long lastSeen = 0;                 // Максимальное время последнего обращения среди всех метрик датчика
        SensorCache.Status status = SensorCache.Status.DEAD; // Худший статус среди метрик (DEAD > STALE > ONLINE)
        Set<String> vars = new TreeSet<>(); // Множество имён переменных (автоматически сортируется)

        void add(String var, long seen, SensorCache.Status st) {
            vars.add(var);                                   // Добавляем имя переменной
            if (seen > lastSeen) lastSeen = seen;           // Обновляем максимальное время
            if (st.ordinal() < status.ordinal()) status = st; // Выбираем "худший" статус (чем меньше порядковый номер, тем хуже: ONLINE(0), STALE(1), DEAD(2)? На самом деле ordinal: ONLINE=0, STALE=1, DEAD=2. Условие st.ordinal() < status.ordinal() означает, что если новый статус имеет меньший номер (т.е. лучше), то мы его не меняем? Проверим: status изначально DEAD (2). Если st = ONLINE (0), то 0 < 2 -> true, status станет ONLINE. Если потом встретится STALE (1), то 1 < ONLINE(0)? false, останется ONLINE. Получается, выбирается наилучший статус. Но в методе build он возвращает статус, который был собран. Похоже, что так и задумано: статус датчика определяется по самой "живой" метрике. Комментарий можно оставить как есть.
        }

        SensorInfo build(String id) {
            return new SensorInfo(id, status, lastSeen, vars);
        }
    }

    /* ========== УПРАВЛЕНИЕ ЖИЗНЕННЫМ ЦИКЛОМ ========== */

    // Запуск фонового потока для записи данных из очереди в БД
    static void startDbWriter() {
        Thread t = new Thread(() -> {
            List<DbPoint> batch = new ArrayList<>(DB_BATCH_SIZE); // Контейнер для накопления пакета
            while (dbRunning || !dbQueue.isEmpty()) {             // Работаем, пока не остановлен флаг и очередь не пуста
                try {
                    DbPoint first = dbQueue.poll(1, TimeUnit.SECONDS); // Ждём элемент не более 1 секунды
                    if (first == null) continue;                       // Если очередь пуста, начинаем следующую итерацию

                    batch.add(first);                                   // Добавляем первый элемент
                    dbQueue.drainTo(batch, DB_BATCH_SIZE - 1);         // Переливаем из очереди в batch до заполнения пакета
                    writeBatch(batch);                                  // Записываем пакет в БД
                    batch.clear();                                      // Очищаем для следующего пакета
                } catch (Exception e) {
                    e.printStackTrace();                                // Выводим ошибку в консоль
                }
            }
        });
        t.setDaemon(true);          // Поток демон (не блокирует завершение JVM)
        t.setName("db-writer");     // Устанавливаем имя потока
        t.start();                  // Запускаем поток
    }

    // Предварительная загрузка кэша из БД (при старте сервера)
    static void warmupCacheFromDb() {
        // Загружаем все данные из БД, сгруппированные по ключу, начиная с 0 (все данные)
        loadFromDbGrouped(0).forEach((k, pts) -> {
            SensorCache c = new SensorCache();          // Создаём новый кэш для каждой метрики
            for (Point p : pts) c.add(p.value, p.ts);   // Добавляем все точки из БД
            cache.put(k, c);                             // Помещаем в общий кэш
        });
    }

    /* ========== ОЧИСТКА И ОБСЛУЖИВАНИЕ ========== */

    // Очистка ограничений для сенсоров (удаление устаревших записей о времени последнего POST)
    static void cleanupSensorLimits() {
        long now = System.currentTimeMillis();
        long last = lastCleanup.get();                   // Получаем время последней очистки
        if (now - last < 5_000) return;                  // Не чаще раза в 5 секунд
        if (!lastCleanup.compareAndSet(last, now)) return; // Пытаемся атомарно обновить время (только один поток)
        // Удаляем из lastPostTs записи, у которых время последнего POST старше 3*TTL (т.е. датчик давно неактивен)
        lastPostTs.entrySet().removeIf(e -> now - e.getValue() > SENSOR_TTL_MS * 3);
    }

    // Очистка устаревших данных из кэша (удаление мёртвых датчиков)
    static void cleanupCache() {
        long now = System.currentTimeMillis();
        // Удаляем из кэша все записи, у которых статус DEAD
        cache.entrySet().removeIf(e -> e.getValue().status(now) == SensorCache.Status.DEAD);
        // Также чистим lastPostTs от мёртвых датчиков
        lastPostTs.entrySet().removeIf(e -> now - e.getValue() > SENSOR_TTL_MS * 3);
    }

    /* ========== ОБРАБОТКА HTTP-ЗАПРОСОВ ========== */

    // Обработка данных, присланных датчиком (вызывается из Web.handleData)
    static void handleSensorPost(byte[] bodyBytes, String sensorId) {
        cleanupSensorLimits();                           // Очищаем устаревшие записи ограничений

        // Проверка валидности ID датчика
        if (!isValidSensorId(sensorId)) {
            droppedPoints.incrementAndGet();             // Увеличиваем счётчик отброшенных точек
            return;
        }

        // Проверка лимита на количество активных датчиков: если датчик новый, а уже достигнут максимум, отклоняем
        if (!lastPostTs.containsKey(sensorId) && lastPostTs.size() > MAX_ACTIVE_SENSORS) {
            droppedPoints.incrementAndGet();
            return;
        }

        long now = System.currentTimeMillis();
        Long last = lastPostTs.get(sensorId);            // Время последнего POST от этого датчика
        // Проверка минимального интервала между POST-запросами
        if (last != null && now - last < SENSOR_MIN_POST_INTERVAL_MS) {
            droppedPoints.incrementAndGet();
            return;
        }

        // Проверка тела запроса: не null, не пустое, не больше 4 КБ
        if (bodyBytes == null || bodyBytes.length == 0 || bodyBytes.length > 4096) {
            droppedPoints.incrementAndGet();
            return;
        }

        // Парсинг JSON-тела в карту полей (имя переменной -> значение)
        Map<String, Double> fields = parseSimpleJson(bodyBytes);
        // Проверка, что парсинг успешен и количество полей не превышает лимит
        if (fields == null || fields.size() > MAX_SENSOR_FIELDS) {
            droppedPoints.incrementAndGet();
            return;
        }

        int created = 0; // Счётчик новых метрик, созданных в этом POST-е
        for (var e : fields.entrySet()) {
            String var = e.getKey();
            double value = e.getValue();

            // Валидация имени переменной и значения (должно быть конечным числом)
            if (!isValidVar(var) || !Double.isFinite(value)) continue;

            String key = sensorId + ":" + var;          // Ключ для кэша
            // Если метрика новая (отсутствует в кэше) и мы уже создали MAX_NEW_METRICS_PER_POST новых, пропускаем её
            if (!cache.containsKey(key) && ++created > MAX_NEW_METRICS_PER_POST) break;

            // Записываем значение
            recordValue(sensorId, var, value);
        }

        // Обновляем время последнего POST для датчика
        lastPostTs.put(sensorId, now);
    }

    /* ========== ОПЕРАЦИИ С ДАННЫМИ ========== */

    // Запись значения в кэш и постановка в очередь на запись в БД
    private static boolean recordValue(String sensor, String var, double value) {
        long ts = System.currentTimeMillis();            // Текущее время
        String key = sensor + ":" + var;
        // Получаем или создаём новый SensorCache для этой метрики
        SensorCache c = cache.computeIfAbsent(key, k -> new SensorCache());
        c.add(value, ts);                                // Добавляем точку в кэш

        // Пытаемся добавить точку в очередь на запись в БД
        boolean added = dbQueue.offer(new DbPoint(sensor, var, ts, value));
        if (!added) {
            // Если очередь переполнена, увеличиваем счётчик отброшенных и логируем
            droppedPoints.incrementAndGet();
            Audit.log("system", "DB_QUEUE_OVERFLOW", "sensor=" + sensor);
        }
        return added;
    }

    // Формирование JSON со всеми данными сенсоров (для /init)
    static String buildSensorsJson(long rangeMs) {
        long now = System.currentTimeMillis();
        long fromTs = rangeMs > 0 ? now - rangeMs : 0;   // Начальная временная метка для запроса

        // Ограничение максимального запрашиваемого диапазона 7 днями
        long MaxDaysMs = 7L * 24 * 60 * 60 * 1000;
        if (rangeMs > MaxDaysMs) {
            fromTs = now - MaxDaysMs;
        }

        // Результирующая карта данных (ключ -> список точек)
        Map<String, List<Point>> data = new LinkedHashMap<>();

        // Загрузка исторических данных из БД, если изменился диапазон или прошло больше минуты
        if (rangeMs != lastRequestedRangeMs || now - lastHistoryLoadTime > 60_000) {
            Map<String, List<Point>> dbData = loadFromDbGrouped(fromTs); // Загружаем из БД
            historicalCache.putAll(dbData);                              // Обновляем исторический кэш
            lastHistoryLoadTime = now;
            lastRequestedRangeMs = rangeMs;
        }

        // Добавляем все исторические данные из кэша в результирующую карту
        data.putAll(historicalCache);

        // Добавляем данные из оперативного кэша (более свежие, чем в БД)
        for (var e : cache.entrySet()) {
            String key = e.getKey();
            List<Point> cachePoints = e.getValue().snapshot(fromTs); // Берём точки из кэша, начиная с fromTs

            if (cachePoints.isEmpty()) continue; // Если нет точек за нужный период, пропускаем

            if (!data.containsKey(key)) {
                // Если для этого ключа ещё нет данных, просто кладём точки из кэша
                data.put(key, new ArrayList<>(cachePoints));
            } else {
                // Иначе нужно объединить с историческими данными, избегая дублирования
                List<Point> existing = data.get(key);
                // Находим максимальное время среди уже имеющихся точек (из БД)
                long maxExistingTime = 0;
                for (Point p : existing) if (p.ts > maxExistingTime) maxExistingTime = p.ts;

                // Добавляем только те точки из кэша, которые новее максимального времени из БД
                for (Point cachePoint : cachePoints) {
                    if (cachePoint.ts > maxExistingTime) {
                        existing.add(cachePoint);
                    }
                }
                // Сортируем объединённый список по времени
                existing.sort((p1, p2) -> Long.compare(p1.ts, p2.ts));
            }
        }

        // Преобразуем карту в JSON-строку и возвращаем
        return pointsToJsonMap(data);
    }

    // Получение списка всех датчиков с их статусами и переменными (для /sensors)
    static List<SensorInfo> listSensors() {
        long now = System.currentTimeMillis();
        // Временная карта для сборки информации по каждому датчику
        Map<String, SensorInfoBuilder> tmp = new HashMap<>();

        // Проходим по всем записям в кэше (каждая запись = одна метрика)
        for (var e : cache.entrySet()) {
            String[] parts = e.getKey().split(":", 2); // Разделяем ключ на sensorId и varName
            if (parts.length != 2) continue;           // Если формат неправильный, пропускаем

            String sensorId = parts[0];
            String var = parts[1];
            SensorCache c = e.getValue();

            // Получаем или создаём билдер для этого датчика и добавляем информацию об этой метрике
            tmp.computeIfAbsent(sensorId, k -> new SensorInfoBuilder())
                    .add(var, c.lastSeen, c.status(now));
        }

        // Преобразуем билдеры в финальные объекты SensorInfo
        List<SensorInfo> out = new ArrayList<>();
        for (var e : tmp.entrySet()) {
            out.add(e.getValue().build(e.getKey()));
        }

        // Сортируем по ID датчика
        out.sort(Comparator.comparing(a -> a.id));
        return out;
    }

    /* ========== РАБОТА С БАЗОЙ ДАННЫХ ========== */

    // Запись пакета точек в БД (вызывается из потока db-writer)
    private static void writeBatch(List<DbPoint> batch) {
        if (batch.isEmpty()) return;                     // Нечего записывать

        Connection c = null;
        try {
            c = Database.borrow();                        // Берём соединение из пула
            c.setAutoCommit(false);                       // Отключаем авто-коммит для пакетной вставки

            // Подготавливаем запрос на вставку
            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO history(sensor_id,var_name,ts,value) VALUES (?,?,?,?)")) {
                for (DbPoint p : batch) {
                    ps.setString(1, p.sensor);            // sensor_id
                    ps.setString(2, p.var);                // var_name
                    ps.setLong(3, p.ts);                   // ts
                    ps.setDouble(4, p.value);              // value
                    ps.addBatch();                          // Добавляем в пакет
                }
                ps.executeBatch();                         // Выполняем пакет
                ps.clearBatch();                            // Очищаем пакет (хороший тон)
            }
            c.commit();                                     // Фиксируем транзакцию
        } catch (Exception e) {
            // При ошибке пытаемся откатить транзакцию
            try { if (c != null) c.rollback(); } catch (Exception ignored) {}
        } finally {
            Database.release(c);                            // Возвращаем соединение в пул
        }
    }

    // Загрузка данных из БД, сгруппированных по ключу "sensorId:varName", начиная с fromTs
    private static Map<String, List<Point>> loadFromDbGrouped(long fromTs) {
        Map<String, List<Point>> m = new LinkedHashMap<>(); // Сохраняем порядок вставки
        Connection c = null;

        try {
            c = Database.borrow();                           // Берём соединение
            try (PreparedStatement ps = c.prepareStatement(
                    "SELECT sensor_id,var_name,ts,value FROM history WHERE ts>=? ORDER BY ts")) {
                ps.setLong(1, fromTs);                       // Устанавливаем параметр
                ResultSet rs = ps.executeQuery();            // Выполняем запрос

                while (rs.next()) {
                    String key = rs.getString(1) + ":" + rs.getString(2); // Составляем ключ
                    // Добавляем точку в список для этого ключа
                    m.computeIfAbsent(key, k -> new ArrayList<>())
                            .add(new Point(rs.getLong(3), rs.getDouble(4)));
                }
            }
        } catch (Exception ignored) {
            // При ошибке загрузки просто игнорируем (вернётся пустая карта)
        } finally {
            Database.release(c);                              // Возвращаем соединение
        }
        return m;
    }

    /* ========== ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ========== */

    // Преобразование карты данных (ключ -> список точек) в JSON-объект вида: { "key1": {"values":[...],"times":[...]}, ... }
    private static String pointsToJsonMap(Map<String, List<Point>> data) {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (var e : data.entrySet()) {
            if (!first) sb.append(",");
            first = false;
            // Очищаем ключ от недопустимых символов (оставляем только буквы, цифры, _, -, :)
            String safeKey = e.getKey().replaceAll("[^a-zA-Z0-9_\\-:]", "_");
            sb.append("\"").append(safeKey).append("\":")
                    .append(pointsToJson(e.getValue()));    // Преобразуем список точек в JSON
        }
        sb.append("}");
        return sb.toString();
    }

    // Преобразование списка точек в JSON вида: {"values":[v1,v2,...],"times":[t1,t2,...]}
    private static String pointsToJson(List<Point> pts) {
        StringBuilder values = new StringBuilder();
        StringBuilder times = new StringBuilder();
        for (int i = 0; i < pts.size(); i++) {
            if (i > 0) {
                values.append(",");
                times.append(",");
            }
            values.append(pts.get(i).value);
            times.append(pts.get(i).ts);
        }
        return "{\"values\":[" + values + "],\"times\":[" + times + "]}";
    }

    // Проверка корректности идентификатора датчика (буквы, цифры, _, -, длина от 1 до 64)
    private static boolean isValidSensorId(String s) {
        return s != null && s.matches("[a-zA-Z0-9_\\-]{1,64}");
    }

    // Проверка корректности имени переменной (буквы, цифры, _, длина от 1 до 32)
    private static boolean isValidVar(String v) {
        return v != null && v.matches("[a-zA-Z0-9_]{1,32}");
    }

    // Парсинг упрощенного JSON от сенсоров (формат: {"var1":12.34,"var2":56.78})
    private static Map<String, Double> parseSimpleJson(byte[] body) {
        try {
            String s = new String(body, StandardCharsets.UTF_8).trim(); // Преобразуем в строку UTF-8 и обрезаем пробелы
            if (!s.startsWith("{") || !s.endsWith("}")) return null;    // Должен быть объект

            s = s.substring(1, s.length() - 1).trim();                  // Убираем внешние скобки
            if (s.isEmpty()) return Map.of();                            // Пустой объект

            Map<String, Double> m = new HashMap<>();
            for (String part : s.split(",")) {                           // Разделяем по запятым
                String[] kv = part.split(":", 2);                         // Делим на ключ и значение
                if (kv.length != 2) continue;                            // Если не два элемента, пропускаем

                String k = kv[0].trim();                                 // Ключ (может быть в кавычках)
                // Проверяем формат ключа: должен быть в двойных кавычках и содержать только допустимые символы
                if (!k.matches("\"[a-zA-Z0-9_]{1,32}\"")) return null;
                k = k.substring(1, k.length() - 1);                      // Убираем кавычки

                String rawVal = kv[1].trim();                            // Значение
                if (rawVal.startsWith("\"")) return null;                // Значение не должно быть строкой
                double v = Double.parseDouble(rawVal);                    // Парсим число

                m.put(k, v);                                             // Добавляем в карту
            }
            return m;
        } catch (Exception e) {
            return null;                                                 // Любая ошибка -> возвращаем null
        }
    }
}