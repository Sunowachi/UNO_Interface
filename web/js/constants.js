/* ========== КОНСТАНТЫ НАСТРОЕК ========== */

// Цвета для графиков
export let COLOR_CHOICES = [
  { name: 'Красный',   value: '#ff0000' },
  { name: 'Синий',     value: '#0000ff' },
  { name: 'Оранжевый', value: '#ffa500' },
  { name: 'Зелёный',   value: '#008000' }
];

// Единицы измерения
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

// Режимы обработки данных
export let PROCESSING_MODES = [
  { value: 'none',        label: 'Без обработки (RAW)' },
  { value: 'moving_avg',  label: 'Скользящее среднее' },
  { value: 'median',      label: 'Медианный фильтр' },
  { value: 'diff',        label: 'Производная (Δ)' }
];

// Метки режимов обработки
export let PROCESSING_LABELS = {
  'none':       'Без обработки (RAW)',
  'moving_avg': 'Скользящее среднее',
  'median':     'Медианный фильтр',
  'diff':       'Производная (Δ)'
};

// Приоритеты предупреждений
export let ALERT_PRIORITY = {
  null: 0,
  'blink-blue': 1,
  'blink-yellow': 2,
  'blink-red': 3
};

// Настройки временного диапазона
export let timeRange = {
  days: 0,
  hours: 0,
  minutes: 1
};

// Настройки графиков
export const CHART_POINT_PX = 2;
export const CHART_MIN_CANVAS_PX = 1275;
export const CHART_MAX_CANVAS_PX = 2400;
export const CHART_MAX_CONTENT_PX = 12000;

/* ========== СИСТЕМА РОЛЕЙ И ПРАВ ========== */

// Разрешения
export const PERMISSIONS = Object.freeze({
  VIEW_DATA:       'view_data',
  VIEW_CHARTS:     'view_charts',
  EDIT_CONFIG:     'edit_config',
  SAVE_CONFIG:     'save_config',
  EXPORT_DATA:     'export_data',
  ADMIN_DB:        'admin_db',
  DEV_ALL:         'dev_all'
});

// Роли пользователей
export const ROLES = Object.freeze({
  DEVELOPER: 'developer',
  ADMIN:     'admin',
  WORKER:    'worker',
  OBSERVER:  'observer'
});

// Сопоставление ролей с разрешениями
export const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.DEVELOPER]: new Set([PERMISSIONS.DEV_ALL]),
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

// Пользователь и аутентификация
export let currentUser = null;
export let csrfToken = null;

// Данные сенсоров
export let allSensors = {};
export let sensorTimes = {};
export let currentSensor = null;
export let editingId = null;

// Конфигурация
export let config = { sensors: [] };

// Время работы сервера
export let serverStart = 0;

// Состояние графиков
export let chartScroll = {};
export let chartFollow = {};

/* ========== ФУНКЦИИ ДЛЯ УПРАВЛЕНИЯ СОСТОЯНИЕМ ========== */

// Установка текущего пользователя
export function setCurrentUser(user) {
  currentUser = user;
}

// Установка CSRF-токена
export function setCsrfToken(token) {
  csrfToken = token;
}

// Установка времени старта сервера
export function setServerStart(value) {
  serverStart = value;
}

// Установка данных всех сенсоров
export function setAllSensors(value) {
  allSensors = value;
}

// Установка конфигурации приложения
export function setConfig(value) {
  config = value;
}

// Установка текущего выбранного сенсора
export function setCurrentSensor(value) {
  currentSensor = value;
}