/* ========== КОНСТАНТЫ НАСТРОЕК ========== */

// Доступные цвета для графиков
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

// Категории единиц измерения для выпадающего списка
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

// Доступные режимы обработки данных
export let PROCESSING_MODES = [
    { value: 'none',        label: 'Без обработки (RAW)' },
    { value: 'moving_avg',  label: 'Скользящее среднее' },
    { value: 'median',      label: 'Медианный фильтр' },
    { value: 'diff',        label: 'Производная (Δ)' }
];

// Метки для быстрого отображения режимов
export let PROCESSING_LABELS = {
    'none':       'Без обработки (RAW)',
    'moving_avg': 'Скользящее среднее',
    'median':     'Медианный фильтр',
    'diff':       'Производная (Δ)'
};

// Приоритеты классов предупреждений
export let ALERT_PRIORITY = {
    null: 0,
    'blink-blue': 1,
    'blink-yellow': 2,
    'blink-red': 3
};

// Текущий выбранный временной диапазон
export let timeRange = {
    days: 0,
    hours: 0,
    minutes: 1
};

// Настройки графиков
export const CHART_POINT_PX = 2;               // Ширина одной точки
export const CHART_MIN_CANVAS_PX = 1275;        // Минимальная ширина холста
export const CHART_MAX_CANVAS_PX = 2400;        // Максимальная ширина холста
export const CHART_MAX_CONTENT_PX = 12000;       // Максимальная ширина содержимого

/* ========== СИСТЕМА РОЛЕЙ И ПРАВ ========== */

// Возможные разрешения
export const PERMISSIONS = Object.freeze({
    VIEW_DATA:       'view_data',       // Просмотр данных
    VIEW_CHARTS:     'view_charts',     // Просмотр графиков
    EDIT_CONFIG:     'edit_config',     // Редактирование конфигурации
    SAVE_CONFIG:     'save_config',     // Сохранение конфигурации
    EXPORT_DATA:     'export_data',     // Экспорт данных
    ADMIN_DB:        'admin_db',        // Администрирование БД
    DEV_ALL:         'dev_all',         // Полные права разработчика
    MANAGE_SENSORS:  'manage_sensors',   // Управление датчиками
    MANAGE_USERS:    'manage_users'
});

// Роли пользователей
export const ROLES = Object.freeze({
    DEVELOPER: 'developer',
    ADMIN:     'admin',
    WORKER:    'worker',
    OBSERVER:  'observer'
});

// Соответствие ролей и разрешений
export const ROLE_PERMISSIONS = Object.freeze({
    [ROLES.DEVELOPER]: new Set([PERMISSIONS.DEV_ALL]),
    [ROLES.ADMIN]: new Set([
        PERMISSIONS.VIEW_DATA,
        PERMISSIONS.VIEW_CHARTS,
        PERMISSIONS.EDIT_CONFIG,
        PERMISSIONS.SAVE_CONFIG,
        PERMISSIONS.EXPORT_DATA,
        PERMISSIONS.ADMIN_DB,
        PERMISSIONS.MANAGE_SENSORS,
        PERMISSIONS.MANAGE_USERS
    ]),
    [ROLES.WORKER]: new Set([PERMISSIONS.VIEW_DATA, PERMISSIONS.VIEW_CHARTS]),
    [ROLES.OBSERVER]: new Set([PERMISSIONS.VIEW_DATA])
});

/* ========== СОСТОЯНИЕ ПРИЛОЖЕНИЯ ========== */

export let currentUser = null;          // Текущий аутентифицированный пользователь
export let csrfToken = null;             // CSRF-токен

export let allSensors = {};              // Данные от датчиков (ключ: "id:переменная")
export let sensorTimes = {};              // Временные метки для каждой переменной

export let currentSensor = null;          // ID текущего выбранного датчика
export let editingId = null;              // ID датчика, который сейчас редактируется

export let config = { sensors: [] };      // Конфигурация приложения
export let serverStart = 0;                // Время запуска сервера

export let chartScroll = {};               // Состояния прокрутки графиков
export let chartFollow = {};               // Флаги слежения за графиками

/* ========== ФУНКЦИИ ДЛЯ УПРАВЛЕНИЯ СОСТОЯНИЕМ ========== */

export function setCurrentUser(user) {
    currentUser = user;
}

export function setCsrfToken(token) {
    csrfToken = token;
}

export function setServerStart(value) {
    serverStart = value;
}

export function setAllSensors(value) {
    allSensors = value;
}

export function setConfig(value) {
    config = value;
}

export function setCurrentSensor(value) {
    currentSensor = value;
}

export function setEditingId(value) {
    editingId = value;
}