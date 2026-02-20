import { config, setConfig, csrfToken, PERMISSIONS, COLOR_CHOICES, editingId } from './constants.js';
import { forceLogout, showToast, updateSensorPanel, updateDevicePanel } from './ui.js';
import { buildIpVarMap, hasPermission } from './utils.js';
import { drawCurrent } from './charts.js';
import { lockSession } from './session.js';

/* ========== КОНСТАНТЫ ========== */
// Максимальное количество датчиков, которое можно добавить (ограничение)
const MAX_SENSORS = 256;
// Задержка перед автосохранением после изменений
const SAVE_DEBOUNCE_MS = 1000; // 1 секунда

let isPolling = false;          // флаг, чтобы избежать параллельных вызовов pollConfig
let saveCount = 0;
function isSaving() {
  return saveCount > 0;
}
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

/* ========== СИСТЕМА АВТОСОХРАНЕНИЯ ========== */
// Переменная для хранения идентификатора таймера автосохранения
let saveTimer = null;
// Переменная для хранения таймера опроса
let configPollTimer = null;

// Функция планирования автосохранения: сбрасывает предыдущий таймер и устанавливает новый
function scheduleSave() {
  // Очищаем предыдущий таймер, если он был
  clearTimeout(saveTimer);
  // Устанавливаем новый таймер, который через SAVE_DEBOUNCE_MS вызовет saveConfigSilent
  saveTimer = setTimeout(saveConfigSilent, SAVE_DEBOUNCE_MS);
}

/* ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ========== */

// Обновление настроек переменных при изменении конфигурации датчика
function updateVarSettings(sCfg) {
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
function normalizeVars(input) {
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

// Валидация имени переменной: только буквы, цифры, подчёркивание, длина 1-32 символа
function isValidVarName(v) {
  return /^[a-zA-Z0-9_]{1,32}$/.test(v);
}

/* ========== ЗАГРУЗКА КОНФИГУРАЦИИ ========== */

// Функция опроса конфигурации
export async function pollConfig(force = false) {
  if (!force && isPolling) return;
  if (!force && isSaving()) {
    return;
  }
  isPolling = true;
  try {
    const res = await fetch('/config/load', {
      credentials: 'include',
      headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {}
    });

    if (res.status === 401 || res.status === 403) {
      console.warn('[pollConfig] сессия недействительна!');
      lockSession()
      return;
    }
    if (!res.ok) throw new Error('HTTP error: ' + res.status);

    const text = await res.text();
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.sensors)) return;

    // Нормализуем
    parsed.sensors.forEach(s => {
      s.vars = normalizeVars(s.vars).filter(isValidVarName);
      if (typeof s.deleted !== 'boolean') s.deleted = false;
      updateVarSettings(s);
    });

    // Проверяем, нет ли в новой конфигурации датчиков, которые были недавно удалены
    const hasRecentlyDeleted = parsed.sensors.some(s => recentlyDeleted.has(String(s.id)));
    if (hasRecentlyDeleted) {
      return;
    }

    const sortSensors = (arr) => [...arr].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const sortKeys = (obj) => {
      if (obj === null || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(sortKeys);
      return Object.keys(obj).sort().reduce((acc, key) => {
        acc[key] = sortKeys(obj[key]);
        return acc;
      }, {});
    };

    const normalizedCurrent = sortKeys({ sensors: sortSensors(config.sensors) });
    const normalizedParsed = sortKeys({ sensors: sortSensors(parsed.sensors) });
    const currentJson = JSON.stringify(normalizedCurrent);
    const newJson = JSON.stringify(normalizedParsed);

    if (currentJson !== newJson) {
      setConfig(parsed);
      updateSensorPanel(true);
      drawCurrent();

      // Если открыто модальное окно редактирования, уведомляем об изменениях
      if (editingId !== null) {
        window.dispatchEvent(new CustomEvent('config-changed', { detail: { editingId } }));
      }
    }
  } catch (e) {
    console.warn('[pollConfig] ошибка:', e);
  } finally {
    isPolling = false;
  }
}

// Запуск периодического опроса
export function startConfigPolling(intervalMs = 2000) {
  if (configPollTimer) clearInterval(configPollTimer);
  configPollTimer = setInterval(pollConfig, intervalMs);
}

// Остановка опроса
export function stopConfigPolling() {
  if (configPollTimer) {
    clearInterval(configPollTimer);
    configPollTimer = null;
  }
}

// Загрузка конфигурации с сервера (из файла)
export async function loadConfig() {
  try {
    // Выполняем GET-запрос к /config/load
    const res = await fetch('/config/load', {
      credentials: 'include', // Передаём куки
      headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {} // CSRF-токен, если есть
    });

    // Если статус 401 или 403 (неавторизован или доступ запрещён)
    if (res.status === 401 || res.status === 403) {
      lockSession()
      return;
    }

    // Если ответ не успешен, генерируем ошибку
    if (!res.ok) throw new Error('HTTP error: ' + res.status);

    // Получаем текст ответа
    const text = await res.text();
    // Парсим JSON
    const parsed = JSON.parse(text);

    // Если в ответе нет поля sensors или это не массив, устанавливаем пустую конфигурацию
    if (!parsed || !Array.isArray(parsed.sensors)) {
      setConfig({ sensors: [] });
      return;
    }

    // Обрабатываем каждый датчик
    parsed.sensors.forEach(s => {
      // Нормализуем список переменных и фильтруем только валидные имена
      s.vars = normalizeVars(s.vars).filter(isValidVarName);
      // Если поле deleted отсутствует, устанавливаем false
      if (typeof s.deleted !== 'boolean') s.deleted = false;
      // Обновляем настройки переменных (добавляем отсутствующие)
      updateVarSettings(s);
    });

    // Сохраняем обработанную конфигурацию в глобальное состояние
    setConfig(parsed);
  } catch (e) {
    // В случае ошибки выводим предупреждение и устанавливаем пустую конфигурацию
    console.warn('Ошибка загрузки конфига:', e);
    setConfig({ sensors: [] });
  }
}

/* ========== СИНХРОНИЗАЦИЯ ДАТЧИКОВ ========== */

// Первоначальная синхронизация конфигурации с обнаруженными датчиками (вызывается при инициализации)
export async function syncConfigInitial() {
  // Получаем карту переменных по ID датчика из allSensors
  const ipMap = buildIpVarMap();
  let updated = false; // Флаг, были ли изменения в конфигурации

  // Перебираем все обнаруженные датчики
  for (const [sensorId, varSet] of Object.entries(ipMap)) {
    // Если достигнут лимит датчиков, прекращаем добавление
    if (config.sensors.length >= MAX_SENSORS) {
      console.warn('Достигнут лимит датчиков');
      break;
    }

    // Получаем массив переменных из Set, фильтруем валидные
    const varsFromData = Array.from(varSet).filter(isValidVarName);
    // Ищем существующий датчик в конфигурации
    let sCfg = config.sensors.find(s => String(s.id) === String(sensorId));

    // Если датчик не найден
    if (!sCfg) {
      // Создаём новый объект датчика
      sCfg = { id: sensorId, name: sensorId, vars: varsFromData, deleted: false };
      // Обновляем настройки переменных
      updateVarSettings(sCfg);
      // Добавляем в конфигурацию
      config.sensors.push(sCfg);
      updated = true; // Отмечаем, что были изменения
    } else {
      // Если датчик существует, но помечен как удалённый, пропускаем
      if (sCfg.deleted) continue;

      // Нормализуем существующие переменные
      sCfg.vars = normalizeVars(sCfg.vars);
      // Объединяем существующие переменные с новыми (используем Set для уникальности)
      const merged = new Set([...sCfg.vars, ...varsFromData]);

      // Если размер объединённого множества отличается от текущего списка, значит добавились новые
      if (merged.size !== sCfg.vars.length) {
        sCfg.vars = Array.from(merged); // Обновляем список переменных
        updated = true;
      }
      // Обновляем настройки переменных (добавляем отсутствующие)
      updateVarSettings(sCfg);
    }
  }

  // Если были изменения
  if (updated) {
    // Проверяем права на редактирование и сохранение
    if (hasPermission(PERMISSIONS.EDIT_CONFIG) && hasPermission(PERMISSIONS.SAVE_CONFIG)) {
      scheduleSave(); // Планируем автосохранение
    } else {
      // Если прав недостаточно, показываем уведомление
      showToast('❌ Недостаточно прав для сохранения конфигурации');
    }
    updateSensorPanel(true);
  }
}

// Обнаружение и добавление новых датчиков (вызывается периодически при обновлении данных)
export async function syncNewSensors() {
  // Получаем карту переменных по ID датчика из allSensors
  const ipMap = buildIpVarMap();
  let updated = false;

  // Перебираем все обнаруженные датчики
  for (const [sensorId, varSet] of Object.entries(ipMap)) {
    // Проверяем лимит датчиков
    if (config.sensors.length >= MAX_SENSORS) {
      console.warn('Достигнут лимит датчиков');
      break;
    }

    // Ищем существующий датчик в конфигурации
    let sCfg = config.sensors.find(s => String(s.id) === String(sensorId));

    // Если датчик не найден
    if (!sCfg) {
      if (recentlyDeleted.has(sensorId)) {
        continue;
      }
      // Создаём новый
      sCfg = {
        id: sensorId,
        name: sensorId,
        vars: Array.from(varSet).filter(isValidVarName),
        deleted: false
      };

      updateVarSettings(sCfg);
      config.sensors.push(sCfg);
      updated = true;
    } else if (!sCfg.deleted) { // Если датчик существует и не удалён
      // Объединяем существующие переменные с новыми (нормализованные)
      const merged = new Set([
        ...normalizeVars(sCfg.vars),
        ...Array.from(varSet).filter(isValidVarName)
      ]);

      // Если размер изменился, обновляем
      if (merged.size !== sCfg.vars.length) {
        sCfg.vars = Array.from(merged);
        updated = true;
      }
      // Обновляем настройки переменных
      updateVarSettings(sCfg);
    }
  }

  // Если были изменения
  if (updated) {
    if (hasPermission(PERMISSIONS.SAVE_CONFIG)) {
      scheduleSave();
      showToast('✅ Добавлены новые датчики');
    } else {
      showToast('⚠️ Найдены новые датчики (нет прав на сохранение)');
    }
    updateSensorPanel(true);
    updateDevicePanel(true);   // добавляем обновление панели устройств
  }
}

/* ========== СОХРАНЕНИЕ КОНФИГУРАЦИИ ========== */

// Фоновая отправка конфигурации на сервер (без уведомления пользователя)
export async function saveConfigSilent() {
  saveCount++;
  try {
    // Выполняем POST-запрос к /config/save
    const res = await fetch('/config/save', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
      },
      body: JSON.stringify(config, null, 2) // Отправляем конфигурацию в формате JSON с отступами
    });

    // Если статус 401 или 403, выходим из системы
    if (res.status === 401 || res.status === 403) {
      lockSession()
      return;
    }

    // Если ответ не успешен, генерируем ошибку
    if (!res.ok) throw new Error('HTTP error: ' + res.status);
    await pollConfig(true);  // принудительная синхронизация
  } catch (e) {
    // Логируем ошибку, но не показываем пользователю
    console.error('Ошибка автосохранения:', e);
  } finally {
    saveCount--;
  }
}

// Сохранение конфигурации с отображением статуса пользователю (вызывается при ручном сохранении)
export async function saveConfigWithMessage() {
  saveCount++;
  try {
    // Выполняем POST-запрос к /config/save
    const res = await fetch('/config/save', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
      },
      body: JSON.stringify(config, null, 2)
    });

    // Если статус 401 или 403
    if (res.status === 401 || res.status === 403) {
      alert('❌ Сессия истекла. Войдите снова.');
      lockSession()
      return;
    }

    // Получаем текст ответа
    const text = await res.text();
    // Если ответ содержит "OK", считаем сохранение успешным
    if (text.includes('OK')) {
      showToast('✅ Настройки сохранены');
      await pollConfig(true);  // принудительная синхронизация
    } else {
      // Иначе показываем ошибку
      alert('❌ Ошибка сохранения: ' + text);
    }
  } catch (e) {
    alert('❌ Ошибка сохранения: ' + e.message);
  } finally {
  saveCount--;
  }
}