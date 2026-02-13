/* ========== КОНСТАНТЫ НАСТРОЕК ========== */

// Массив доступных цветов для графиков (используется в выпадающем списке)
// Каждый элемент содержит отображаемое имя и HEX-код цвета
export let COLOR_CHOICES = [
  { name: 'Красный',   value: '#ff0000' },
  { name: 'Синий',     value: '#0000ff' },
  { name: 'Оранжевый', value: '#ffa500' },
  { name: 'Зелёный',   value: '#008000' }
];

// Категории единиц измерения для выпадающего списка в настройках переменных
// Ключ - название категории, значение - массив объектов с именем и значением единицы
export let UNIT_CATEGORIES = {
  "Температура": [
    { name: "°C", value: "°C" },
    { name: "°F", value: "°F" },
    { name: "K", value: "K" }
  ],
  "Влажность": [
    { name: "%", value: "%" },
    { name: "g/m³", value: "g/m³" }
  ],
  "Давление": [
    { name: "Па", value: "Pa" },
    { name: "бар", value: "bar" },
    { name: "мм рт. ст.", value: "mmHg" }
  ],
  "Длина": [
    { name: "м", value: "m" },
    { name: "см", value: "cm" },
    { name: "мм", value: "mm" },
    { name: "км", value: "km" }
  ],
  "Масса": [
    { name: "кг", value: "kg" },
    { name: "г", value: "g" },
    { name: "т", value: "t" }
  ],
  "Скорость": [
    { name: "м/с", value: "m/s" },
    { name: "км/ч", value: "km/h" },
    { name: "миль/ч", value: "mph" }
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