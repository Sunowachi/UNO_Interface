import {
  timeRange,
  ALERT_PRIORITY,
  allSensors,
  sensorTimes,
  setAllSensors,
  currentUser,
  ROLE_PERMISSIONS,
  PERMISSIONS,
  csrfToken,
  config
} from './constants.js';
import { lockSession } from './session.js';
import { syncNewSensors } from './sensors.js';
import { updateSensorPanel, updateDevicePanel } from './ui.js';
import { drawCurrent } from './charts.js';

/* ========== КОНСТАНТЫ ========== */
// Максимальное количество точек на график (ограничение для производительности)
const MAX_POINTS = 5000;
// Шаг времени по умолчанию (1 секунда) - возможно, используется где-то ещё, но в этом файле не применяется
const DEFAULT_STEP_MS = 1000;

/* ========== ПРОВЕРКИ ПРАВ ДОСТУПА И ВАЛИДАЦИИ ========== */

// Проверка наличия разрешения у текущего пользователя
export function hasPermission(permission) {
  // Если permission не передано или у текущего пользователя нет роли, возвращаем false
  if (!permission || !currentUser?.role) return false;
  // Получаем набор прав для роли пользователя
  const perms = ROLE_PERMISSIONS[currentUser.role];
  // Если для роли нет прав, возвращаем false
  if (!perms) return false;
  // Если у пользователя есть полные права разработчика (DEV_ALL), разрешаем всё
  if (perms.has(PERMISSIONS.DEV_ALL)) return true;
  // Иначе проверяем наличие конкретного разрешения
  return perms.has(permission);
}

// Валидация имени переменной (должно быть строкой из букв, цифр и _, длиной 1-32 символа)
function isValidVarName(v) {
  return typeof v === 'string' && /^[a-zA-Z0-9_]{1,32}$/.test(v);
}

// Валидация ID датчика (должно быть строкой длиной 1-64 символа)
function isValidSensorId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 64;
}

/* ========== РАБОТА С ДАННЫМИ ========== */

// Создание карты переменных по ID датчика (используется для группировки)
export function buildIpVarMap() {
  const map = {}; // Результирующий объект: ключ - ID датчика, значение - Set имён переменных
  // Перебираем все ключи в allSensors
  for (const key of Object.keys(allSensors || {})) {
    if (typeof key !== 'string') continue; // Пропускаем нестроковые ключи
    const parts = key.split(':', 2); // Разделяем ключ на две части по первому двоеточию
    if (parts.length !== 2) continue; // Если двоеточия нет, пропускаем
    const sensorId = parts[0].trim();   // ID датчика
    const varName = parts[1].trim();    // Имя переменной
    // Проверяем валидность ID и имени переменной
    if (!isValidSensorId(sensorId) || !isValidVarName(varName)) continue;
    // Если для данного sensorId ещё нет записи, создаём новый Set
    if (!map[sensorId]) map[sensorId] = new Set();
    // Добавляем имя переменной в Set
    map[sensorId].add(varName);
  }
  return map;
}

// Вычисление временного диапазона в миллисекундах на основе объекта timeRange
export function getSelectedTimeRangeMs() {
  // Преобразуем значения в числа, если не число - подставляем 0
  const d = Number(timeRange.days) || 0;
  const h = Number(timeRange.hours) || 0;
  const m = Number(timeRange.minutes) || 0;
  // Вычисляем общее количество минут, но не меньше 0
  const totalMinutes = Math.max(d * 1440 + h * 60 + m, 0);
  // Переводим минуты в миллисекунды и возвращаем
  return totalMinutes * 60_000;
}

// Проверка существования датчика по ID
export function sensorExists(sensorId) {
    return config.sensors.some(s => String(s.id) === String(sensorId) && !s.deleted);
}

// Получить эффективные настройки переменной (с учётом ссылок на другие датчики)
export function getEffectiveVarSettings(sCfg, varName) {
    // Локальные настройки в текущем датчике
    const local = sCfg.varSettings?.find(v => v.var === varName);

    // Проверяем, является ли переменная ссылкой на другой датчик
    if (varName.includes('_')) {
        const parts = varName.split('_');
        if (parts.length === 2) {
            const sourceId = parts[0];
            const sourceVar = parts[1];
            const sourceSensor = config.sensors.find(s => String(s.id) === String(sourceId) && !s.deleted);
            if (sourceSensor) {
                const sourceSettings = sourceSensor.varSettings?.find(v => v.var === sourceVar);
                if (sourceSettings) {
                    // Возвращаем настройки исходного датчика, но с возможностью переопределить label из локальных
                    return {
                        ...sourceSettings,
                        var: varName,
                        label: local?.label || sourceSettings.label || sourceVar,
                    };
                }
            }
        }
    }
    // Если не ссылка или исходный датчик не найден, возвращаем локальные (или пустой объект)
    return local || {};
}

/* ========== ОБРАБОТКА ПРЕДУПРЕЖДЕНИЙ ========== */

// Определение класса предупреждения (blink-* ) на основе настроек переменной и текущего значения
export function getAlertClass(vs, value) {
  if (!Number.isFinite(value) || !vs) return null;

  const low = vs.lowLimit;
  const warn = vs.warnLimit;
  const alarm = vs.alarmLimit;

  // Проверяем, что пределы явно заданы (не null, не undefined, не пустая строка)
  const hasLow = low !== null && low !== undefined && low !== '';
  const hasWarn = warn !== null && warn !== undefined && warn !== '';
  const hasAlarm = alarm !== null && alarm !== undefined && alarm !== '';

  // Преобразуем в числа только если они есть
  const lowNum = hasLow ? Number(low) : null;
  const warnNum = hasWarn ? Number(warn) : null;
  const alarmNum = hasAlarm ? Number(alarm) : null;

  if (hasAlarm && Number.isFinite(alarmNum) && value >= alarmNum) return 'blink-red';
  if (hasWarn && Number.isFinite(warnNum) && value >= warnNum) return 'blink-yellow';
  if (hasLow && Number.isFinite(lowNum) && value < lowNum) return 'blink-blue';

  return null;
}

// Выбор более приоритетного класса предупреждения из двух
export function pickHigherAlertClass(currentClass, newClass) {
  // Если новый класс отсутствует, оставляем текущий
  if (!newClass) return currentClass;
  // Если текущий отсутствует, берём новый
  if (!currentClass) return newClass;
  // Сравниваем приоритеты из ALERT_PRIORITY (числовые значения)
  return ALERT_PRIORITY[newClass] > ALERT_PRIORITY[currentClass] ? newClass : currentClass;
}

/* ========== ЗАГРУЗКА ДАННЫХ ========== */

// Загрузка данных с сервера с учетом выбранного временного диапазона (основная функция получения данных)
export async function fetchData() {
  // Если CSRF-токен ещё не установлен, не выполняем запрос (предотвращаем лишние вызовы)
  if (!csrfToken) {
    console.warn('[fetchData] CSRF-токен ещё не установлен, пропускаем fetch');
    return;
  }

  try {
    // Получаем выбранный диапазон в миллисекундах
    const rangeMs = getSelectedTimeRangeMs();
    // Выполняем GET-запрос к серверу с параметром rangeMs
    const res = await fetch('/init?rangeMs=' + encodeURIComponent(String(rangeMs)), {
      method: 'GET',
      credentials: 'include' // Включаем куки для аутентификации
    });

    // Если статус ответа 401 (неавторизован) или 403 (доступ запрещён)
    if (res.status === 401 || res.status === 403) {
      console.warn('[fetchData] Сессия недействительна, останавливаем опрос');
      lockSession(); // Блокируем сессию (выходим)
      return;
    }

    // Если ответ не успешен, генерируем ошибку
    if (!res.ok) throw new Error('HTTP ' + res.status);

    // Получаем текст ответа (может быть большим)
    const text = await res.text();
    let data;

    try {
      // Пытаемся распарсить текст как JSON
      data = JSON.parse(text);
    } catch (e) {
      console.error('[fetchData] Ошибка парсинга JSON /init:', e);
      return;
    }

    // Проверяем структуру: ожидаем объект с полем sensors, которое является объектом
    if (!data?.sensors || typeof data.sensors !== 'object') {
      console.error('[fetchData] Некорректный формат sensors:', data?.sensors);
      return;
    }

    const newAll = {};      // Новый объект для allSensors
    const newTimes = {};    // Новый объект для временных меток
    const sensors = data.sensors; // Данные от сервера
    let flatDetected = false; // Флаг, указывающий, что сервер вернул плоскую структуру (ключ уже содержит ":")

    // Определяем, используется ли плоская структура (ключи вида "id:var")
    for (const k of Object.keys(sensors)) {
      if (k.includes(':')) {
        flatDetected = true;
        break;
      }
    }

    if (flatDetected) {
      // Если структура плоская, перебираем все ключи напрямую
      for (const [flatKey, payload] of Object.entries(sensors)) {
        if (payload == null) continue; // Пропускаем null/undefined
        if (Array.isArray(payload)) {
          // Если payload - массив, считаем его массивом значений
          newAll[flatKey] = { values: payload.slice() }; // Копируем массив
        } else if (typeof payload === 'object') {
          // Если payload - объект, ожидаем поля values и times
          const vals = Array.isArray(payload.values) ? payload.values.slice() : [];
          const times = Array.isArray(payload.times) ? payload.times.slice() : null;
          newAll[flatKey] = { values: vals };
          if (times) newTimes[flatKey] = times; // Если есть времена, сохраняем
        }
      }
    } else {
      // Иначе структура вложенная: sensors[ sensorId ][ varName ]
      for (const [sensorId, vars] of Object.entries(sensors)) {
        if (!vars || typeof vars !== 'object') continue;
        for (const [varName, rows] of Object.entries(vars)) {
          const key = `${sensorId}:${varName}`; // Формируем ключ
          if (rows == null) continue;
          if (Array.isArray(rows)) {
            newAll[key] = { values: rows.slice() };
          } else if (typeof rows === 'object') {
            const vals = Array.isArray(rows.values) ? rows.values.slice() : [];
            const times = Array.isArray(rows.times) ? rows.times.slice() : null;
            newAll[key] = { values: vals };
            if (times) newTimes[key] = times;
          }
        }
      }
    }

    // Обновляем глобальный объект allSensors
    setAllSensors(newAll);

    // Очищаем старые временные метки в sensorTimes
    const allTimeKeys = Object.keys(sensorTimes);
    for (const key of allTimeKeys) {
      delete sensorTimes[key];
    }
    // Добавляем новые временные метки
    for (const [key, times] of Object.entries(newTimes)) {
      sensorTimes[key] = times.slice();
    }

    // Синхронизируем новые датчики (добавляем в конфиг, если их там нет)
    await syncNewSensors();
    // Обновляем панель датчиков (только классы тревоги)
    updateSensorPanel(false);
    // Перерисовываем графики для текущего датчика
    drawCurrent();
    // Обновляем панель устройств (только если изменился набор ключей)
    updateDevicePanel(false);
  } catch (e) {
    console.error('Ошибка fetchData:', e);
  }
}

/* ========== ФОРМАТИРОВАНИЕ ========== */

// Форматирование времени в формате HH:MM:SS из миллисекунд
export function formatTimeHHMMSS(ms, useUTC = false) {
  const d = new Date(ms); // Создаём объект Date из миллисекунд
  // Если useUTC = true, берём UTC-часы/минуты/секунды, иначе локальные
  const h = useUTC ? d.getUTCHours() : d.getHours();
  const m = useUTC ? d.getUTCMinutes() : d.getMinutes();
  const s = useUTC ? d.getUTCSeconds() : d.getSeconds();
  // Приводим каждое значение к строке, добавляем ведущий ноль до двух символов и объединяем через двоеточие
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}