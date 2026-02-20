import { COLOR_CHOICES } from '../constants.js';

// Максимальное количество датчиков, которое можно добавить (ограничение)
export const MAX_SENSORS = 256;
// Задержка перед автосохранением после изменений
export const SAVE_DEBOUNCE_MS = 1000; // 1 секунда

// Множество ID датчиков, которые были недавно удалены
const recentlyDeleted = new Set();
const RECENTLY_DELETED_TIMEOUT = 3000; // 3 секунды

// Функция для пометки датчика как недавно удалённого
export function markSensorDeleted(id) {
  const idStr = String(id);
  recentlyDeleted.add(idStr);
  setTimeout(() => {
    recentlyDeleted.delete(idStr);
  }, RECENTLY_DELETED_TIMEOUT);
}

export function isRecentlyDeleted(id) {
    return recentlyDeleted.has(String(id));
}

// Обновление настроек переменных при изменении конфигурации датчика
export function updateVarSettings(sCfg) {
  // Если у датчика нет поля varSettings, создаём пустой массив
  if (!sCfg.varSettings) sCfg.varSettings = [];

  // Создаём Set существующих имён переменных из настроек
  const existingVars = new Set(sCfg.varSettings.map(vs => vs.var));
  // Находим переменные из списка vars, которых ещё нет в настройках
  const newVars = sCfg.vars.filter(v => !existingVars.has(v));

  // Для каждой новой переменной создаём настройки по умолчанию
  newVars.forEach((v, idx) => {
    // Находим индекс переменной в общем списке (для выбора цвета)
    const varIndex = sCfg.vars.indexOf(v);
    // Выбираем цвет из списка по индексу (циклически)
    const defaultColor = COLOR_CHOICES[varIndex % COLOR_CHOICES.length].value;

    // Добавляем объект настроек в массив varSettings
    sCfg.varSettings.push({
      var: v,                       // Имя переменной
      label: v,                     // Метка для графика (по умолчанию имя)
      color: defaultColor,          // Цвет
      rawColor: '#B0BEC5',          // Цвет без обработки
      unit: '',                     // Единица измерения (пусто)
      lowLimit: null,               // Нижний предел (синяя зона)
      warnLimit: null,              // Предел предупреждения (жёлтая зона)
      alarmLimit: null,             // Предел тревоги (красная зона)
      processing: 'none',           // Режим обработки (по умолчанию без обработки)
      showRaw: true,                // Показывать сырые данные
      showProcessed: false          // Показывать обработанные данные (по умолчанию нет)
    });
  });
}

// Нормализация списка переменных: преобразование в массив строк, обрезка пробелов, удаление пустых
export function normalizeVars(input) {
  // Если входной параметр - массив
  if (Array.isArray(input)) {
    // Преобразуем каждый элемент в строку, обрезаем пробелы, фильтруем пустые
    return input.map(String).map(v => v.trim()).filter(Boolean);
  }

  // Если входной параметр - строка, разбиваем по запятой, обрезаем пробелы, фильтруем пустые
  if (typeof input === 'string') {
    return input.split(',').map(v => v.trim()).filter(Boolean);
  }

  // Для других типов возвращаем пустой массив
  return [];
}

export function isValidVarName(v) {
    return /^[a-zA-Z0-9_]{1,32}$/.test(v);
}