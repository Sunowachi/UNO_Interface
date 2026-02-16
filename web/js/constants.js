/* ========== КОНСТАНТЫ НАСТРОЕК ========== */

// Массив доступных цветов для графиков (используется в выпадающем списке)
// Каждый элемент содержит отображаемое имя и HEX-код цвета
export let COLOR_CHOICES = [
  { name: 'Красный',      value: '#FF5252' },
  { name: 'Синий',        value: '#42A5F5' },
  { name: 'Зелёный',      value: '#66BB6A' },
  { name: 'Оранжевый',    value: '#FFA726' },
  { name: 'Фиолетовый',   value: '#AB47BC' },
  { name: 'Бирюзовый',    value: '#26C6DA' },
  { name: 'Розовый',      value: '#EC407A' },
  { name: 'Жёлтый',       value: '#FFEE58' },
  { name: 'Коричневый',   value: '#8D6E63' },
  { name: 'Серый (raw)',  value: '#B0BEC5' }
];

// Категории единиц измерения для выпадающего списка в настройках переменных
// Ключ - название категории, значение - массив объектов с именем и значением единицы
// Категории единиц измерения для выпадающего списка в настройках переменных
export let UNIT_CATEGORIES = {
  "Вибрация": [
    { name: "g", value: "g" },
    { name: "м/с²", value: "m/s²" },
    { name: "мкм", value: "µm" },
    { name: "мм", value: "mm" },
    { name: "мм/с", value: "mm/s" }
  ],
  "Влажность": [
    { name: "%", value: "%" },
    { name: "абс. влажность", value: "g/kg" },
    { name: "г/м³", value: "g/m³" }
  ],
  "Время": [
    { name: "мкс", value: "us" },
    { name: "мин", value: "min" },
    { name: "мс", value: "ms" },
    { name: "с", value: "s" },
    { name: "ч", value: "h" }
  ],
  "Вязкость": [
    { name: "Па·с", value: "Pa·s" },
    { name: "сП", value: "cP" }
  ],
  "Давление": [
    { name: "атм", value: "atm" },
    { name: "бар", value: "bar" },
    { name: "кПа", value: "kPa" },
    { name: "мбар", value: "mbar" },
    { name: "мм рт. ст.", value: "mmHg" },
    { name: "МПа", value: "MPa" },
    { name: "Па", value: "Pa" },
    { name: "psi", value: "psi" }
  ],
  "Длина": [
    { name: "дюйм", value: "in" },
    { name: "км", value: "km" },
    { name: "м", value: "m" },
    { name: "мм", value: "mm" },
    { name: "см", value: "cm" },
    { name: "фут", value: "ft" }
  ],
  "Звук": [
    { name: "дБ", value: "dB" },
    { name: "дБА", value: "dBA" }
  ],
  "Концентрация": [
    { name: "%", value: "%" },
    { name: "г/л", value: "g/L" },
    { name: "мг/м³", value: "mg/m3" },
    { name: "моль/л", value: "mol/L" },
    { name: "ppb", value: "ppb" },
    { name: "ppm", value: "ppm" }
  ],
  "Масса": [
    { name: "г", value: "g" },
    { name: "кг", value: "kg" },
    { name: "мг", value: "mg" },
    { name: "т", value: "t" },
    { name: "фунт", value: "lb" }
  ],
  "Плотность": [
    { name: "г/см³", value: "g/cm3" },
    { name: "кг/м³", value: "kg/m3" }
  ],
  "Расход": [
    { name: "гал/мин", value: "gpm" },
    { name: "кг/с", value: "kg/s" },
    { name: "л/мин", value: "L/min" },
    { name: "л/с", value: "L/s" },
    { name: "м³/с", value: "m3/s" },
    { name: "м³/ч", value: "m3/h" },
    { name: "т/ч", value: "t/h" }
  ],
  "Радиация": [
    { name: "Бк", value: "Bq" },
    { name: "Зв", value: "Sv" },
    { name: "мЗв", value: "mSv" },
    { name: "мкЗв/ч", value: "uSv/h" }
  ],
  "Свет": [
    { name: "кд", value: "cd" },
    { name: "лк", value: "lx" },
    { name: "лм", value: "lm" }
  ],
  "Сила": [
    { name: "кгс", value: "kgf" },
    { name: "кН", value: "kN" },
    { name: "Н", value: "N" }
  ],
  "Скорость": [
    { name: "км/ч", value: "km/h" },
    { name: "миль/ч", value: "mph" },
    { name: "м/с", value: "m/s" },
    { name: "узел", value: "kn" }
  ],
  "Скорость вращения": [
    { name: "об/мин", value: "rpm" },
    { name: "об/с", value: "rps" }
  ],
  "Температура": [
    { name: "°C", value: "°C" },
    { name: "°F", value: "°F" },
    { name: "K", value: "K" },
    { name: "°R", value: "R" }
  ],
  "Уровень": [
    { name: "%", value: "%" },
    { name: "м", value: "m" },
    { name: "мм", value: "mm" },
    { name: "см", value: "cm" }
  ],
  "Электрические": [
    { name: "А", value: "A" },
    { name: "В", value: "V" },
    { name: "Вт", value: "W" },
    { name: "Гн", value: "H" },
    { name: "Гц", value: "Hz" },
    { name: "кА", value: "kA" },
    { name: "кВ", value: "kV" },
    { name: "кВт", value: "kW" },
    { name: "кГц", value: "kHz" },
    { name: "кОм", value: "kOhm" },
    { name: "мА", value: "mA" },
    { name: "мВ", value: "mV" },
    { name: "МВт", value: "MW" },
    { name: "мГн", value: "mH" },
    { name: "МГц", value: "MHz" },
    { name: "МОм", value: "MOhm" },
    { name: "мкФ", value: "uF" },
    { name: "Ом", value: "Ohm" },
    { name: "пФ", value: "pF" },
    { name: "Ф", value: "F" }
  ],
  "Энергия": [
    { name: "Вт·ч", value: "Wh" },
    { name: "Дж", value: "J" },
    { name: "кал", value: "cal" },
    { name: "кДж", value: "kJ" },
    { name: "кВт·ч", value: "kWh" },
    { name: "ккал", value: "kcal" }
  ],
  "pH": [
    { name: "pH", value: "pH" }
  ]
};

// Доступные режимы обработки данных (для каждой переменной датчика)
// value - внутреннее имя режима, label - отображаемый текст
export let PROCESSING_MODES = [
  { value: 'none',        label: 'Без обработки (RAW)' },
  { value: 'moving_avg',  label: 'Скользящее среднее' },
  { value: 'median',      label: 'Медианный фильтр' },
  { value: 'diff',        label: 'Производная (Δ)' }
];

// Объект для быстрого получения отображаемого названия режима по его value
// Используется в интерфейсе при отображении настроек
export let PROCESSING_LABELS = {
  'none':       'Без обработки (RAW)',
  'moving_avg': 'Скользящее среднее',
  'median':     'Медианный фильтр',
  'diff':       'Производная (Δ)'
};

// Приоритеты классов предупреждений (чем больше число, тем выше приоритет)
// Используется для сравнения, какой класс важнее (например, красный важнее жёлтого)
export let ALERT_PRIORITY = {
  null: 0,                // Нет предупреждения
  'blink-blue': 1,        // Синее мигание (низкий приоритет)
  'blink-yellow': 2,      // Жёлтое мигание (средний)
  'blink-red': 3          // Красное мигание (высокий)
};

// Текущий выбранный временной диапазон для отображения данных
// Значения обновляются через интерфейс (поля дней, часов, минут)
export let timeRange = {
  days: 0,
  hours: 0,
  minutes: 1
};

// Настройки графиков: размер точки в пикселях, минимальная и максимальная ширина canvas и максимальная ширина содержимого
export const CHART_POINT_PX = 2;               // Толщина точки данных на графике
export const CHART_MIN_CANVAS_PX = 1275;        // Минимальная ширина холста графика
export const CHART_MAX_CANVAS_PX = 2400;        // Максимальная ширина холста
export const CHART_MAX_CONTENT_PX = 12000;       // Максимальная ширина содержимого (при скролле)

/* ========== СИСТЕМА РОЛЕЙ И ПРАВ ========== */

// Объект с константами, определяющими возможные разрешения
// Каждое разрешение - строка, используется в проверках hasPermission
export const PERMISSIONS = Object.freeze({
  VIEW_DATA:       'view_data',       // Просмотр данных датчиков
  VIEW_CHARTS:     'view_charts',     // Просмотр графиков
  EDIT_CONFIG:     'edit_config',     // Редактирование конфигурации датчиков
  SAVE_CONFIG:     'save_config',     // Сохранение конфигурации
  EXPORT_DATA:     'export_data',     // Экспорт данных
  ADMIN_DB:        'admin_db',        // Администрирование базы данных
  DEV_ALL:         'dev_all'          // Полные права разработчика (включает всё)
});

// Роли пользователей (строковые идентификаторы)
export const ROLES = Object.freeze({
  DEVELOPER: 'developer',   // Разработчик (полный доступ)
  ADMIN:     'admin',       // Администратор (управление конфигурацией, экспорт)
  WORKER:    'worker',      // Рабочий (просмотр данных и графиков)
  OBSERVER:  'observer'     // Наблюдатель (только просмотр данных)
});

// Сопоставление каждой роли с набором разрешений (Set строк)
// Используется для проверки прав через hasPermission
export const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.DEVELOPER]: new Set([PERMISSIONS.DEV_ALL]), // Разработчик имеет всё через одно разрешение
  [ROLES.ADMIN]: new Set([
    PERMISSIONS.VIEW_DATA,
    PERMISSIONS.VIEW_CHARTS,
    PERMISSIONS.EDIT_CONFIG,
    PERMISSIONS.SAVE_CONFIG,
    PERMISSIONS.EXPORT_DATA,
    PERMISSIONS.ADMIN_DB
  ]),
  [ROLES.WORKER]: new Set([PERMISSIONS.VIEW_DATA, PERMISSIONS.VIEW_CHARTS]),
  [ROLES.OBSERVER]: new Set([PERMISSIONS.VIEW_DATA])
});

/* ========== СОСТОЯНИЕ ПРИЛОЖЕНИЯ ========== */

// Текущий аутентифицированный пользователь (объект с полями username, role, csrf) или null
export let currentUser = null;
// CSRF-токен для защиты запросов (получается от сервера при входе)
export let csrfToken = null;

// Хранилище всех данных от датчиков, полученных с сервера
// Ключ - строка вида "id:переменная", значение - объект с массивом значений
export let allSensors = {};

// Хранилище временных меток для каждой переменной (если сервер их передаёт)
// Ключ - тот же "id:переменная", значение - массив временных меток (в миллисекундах)
export let sensorTimes = {};

// ID текущего выбранного датчика (для отображения графиков и выделения в списке)
export let currentSensor = null;

// ID датчика, который сейчас редактируется в модальном окне (null, если не редактируется)
export let editingId = null;

// Конфигурация приложения: массив датчиков с их настройками (имена, переменные, параметры)
export let config = { sensors: [] };

// Время запуска сервера (метка времени в миллисекундах, используется для таймера uptime)
export let serverStart = 0;

// Состояние прокрутки графиков для каждого датчика (ключ - ID датчика, значение - позиция скролла)
export let chartScroll = {};

// Состояние режима "следить за обновлениями" для каждого датчика (true/false)
export let chartFollow = {};

/* ========== ФУНКЦИИ ДЛЯ УПРАВЛЕНИЯ СОСТОЯНИЕМ ========== */

// Установка текущего пользователя (вызывается при входе/выходе)
export function setCurrentUser(user) {
  currentUser = user;
}

// Установка CSRF-токена (после успешной аутентификации или обновления)
export function setCsrfToken(token) {
  csrfToken = token;
}

// Установка времени запуска сервера (получается из ответа сервера)
export function setServerStart(value) {
  serverStart = value;
}

// Замена всех данных датчиков новыми (при загрузке с сервера)
export function setAllSensors(value) {
  allSensors = value;
}

// Установка конфигурации приложения (загружается с сервера)
export function setConfig(value) {
  config = value;
}

// Установка текущего выбранного датчика (при клике в списке)
export function setCurrentSensor(value) {
  currentSensor = value;
}