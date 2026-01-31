import { config, setConfig, csrfToken, PERMISSIONS, COLOR_CHOICES } from './constants.js';
import { forceLogout, showToast, updateSensorPanel } from './ui.js';
import { buildIpVarMap, hasPermission } from './utils.js';

/* ========== КОНСТАНТЫ ========== */
const MAX_SENSORS = 256;
const SAVE_DEBOUNCE_MS = 2000;

/* ========== СИСТЕМА АВТОСОХРАНЕНИЯ ========== */
let saveTimer = null;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveConfigSilent, SAVE_DEBOUNCE_MS);
}

/* ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ========== */

// Обновление настроек переменных при изменении конфигурации
function updateVarSettings(sCfg) {
  if (!sCfg.varSettings) sCfg.varSettings = [];

  const existingVars = new Set(sCfg.varSettings.map(vs => vs.var));
  const newVars = sCfg.vars.filter(v => !existingVars.has(v));

  newVars.forEach((v, idx) => {
    const varIndex = sCfg.vars.indexOf(v);
    const defaultColor = COLOR_CHOICES[varIndex % COLOR_CHOICES.length].value;

    sCfg.varSettings.push({
      var: v,
      label: v,
      color: defaultColor,
      unit: '',
      lowLimit: null,
      warnLimit: null,
      alarmLimit: null,
      processing: 'none',
      showRaw: true,
      showProcessed: false
    });
  });
}

// Нормализация списка переменных
function normalizeVars(input) {
  if (Array.isArray(input)) {
    return input.map(String).map(v => v.trim()).filter(Boolean);
  }

  if (typeof input === 'string') {
    return input.split(',').map(v => v.trim()).filter(Boolean);
  }

  return [];
}

// Валидация имени переменной
function isValidVarName(v) {
  return /^[a-zA-Z0-9_]{1,32}$/.test(v);
}

/* ========== ЗАГРУЗКА КОНФИГУРАЦИИ ========== */

// Загрузка конфигурации с сервера
export async function loadConfig() {
  try {
    const res = await fetch('/config/load', {
      credentials: 'include',
      headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {}
    });

    if (res.status === 401 || res.status === 403) {
      forceLogout();
      return;
    }

    if (!res.ok) throw new Error('HTTP error: ' + res.status);

    const text = await res.text();
    const parsed = JSON.parse(text);

    if (!parsed || !Array.isArray(parsed.sensors)) {
      setConfig({ sensors: [] });
      return;
    }

    parsed.sensors.forEach(s => {
      s.vars = normalizeVars(s.vars).filter(isValidVarName);
      if (typeof s.deleted !== 'boolean') s.deleted = false;
      updateVarSettings(s);
    });

    setConfig(parsed);
  } catch (e) {
    console.warn('Ошибка загрузки конфига:', e);
    setConfig({ sensors: [] });
  }
}

/* ========== СИНХРОНИЗАЦИЯ ДАТЧИКОВ ========== */

// Первоначальная синхронизация конфигурации с обнаруженными датчиками
export async function syncConfigInitial() {
  const ipMap = buildIpVarMap();
  let updated = false;

  for (const [sensorId, varSet] of Object.entries(ipMap)) {
    if (config.sensors.length >= MAX_SENSORS) {
      console.warn('Достигнут лимит датчиков');
      break;
    }

    const varsFromData = Array.from(varSet).filter(isValidVarName);
    let sCfg = config.sensors.find(s => String(s.id) === String(sensorId));

    if (!sCfg) {
      sCfg = { id: sensorId, name: sensorId, vars: varsFromData, deleted: false };
      updateVarSettings(sCfg);
      config.sensors.push(sCfg);
      updated = true;
    } else {
      if (sCfg.deleted) continue;

      sCfg.vars = normalizeVars(sCfg.vars);
      const merged = new Set([...sCfg.vars, ...varsFromData]);

      if (merged.size !== sCfg.vars.length) {
        sCfg.vars = Array.from(merged);
        updated = true;
      }
      updateVarSettings(sCfg);
    }
  }

  if (updated) {
    if (hasPermission(PERMISSIONS.EDIT_CONFIG) && hasPermission(PERMISSIONS.SAVE_CONFIG)) {
      scheduleSave();
    } else {
      showToast('❌ Недостаточно прав для сохранения конфигурации');
    }
    updateSensorPanel();
  }
}

// Обнаружение и добавление новых датчиков
export async function syncNewSensors() {
  const ipMap = buildIpVarMap();
  let updated = false;

  for (const [sensorId, varSet] of Object.entries(ipMap)) {
    if (config.sensors.length >= MAX_SENSORS) {
      console.warn('Достигнут лимит датчиков');
      break;
    }

    let sCfg = config.sensors.find(s => String(s.id) === String(sensorId));

    if (!sCfg) {
      sCfg = { id: sensorId, name: sensorId, vars: Array.from(varSet).filter(isValidVarName), deleted: false };
      updateVarSettings(sCfg);
      config.sensors.push(sCfg);
      updated = true;
    } else if (!sCfg.deleted) {
      const merged = new Set([
        ...normalizeVars(sCfg.vars),
        ...Array.from(varSet).filter(isValidVarName)
      ]);

      if (merged.size !== sCfg.vars.length) {
        sCfg.vars = Array.from(merged);
        updated = true;
      }
      updateVarSettings(sCfg);
    }
  }

  if (updated) {
    if (hasPermission(PERMISSIONS.SAVE_CONFIG)) {
      scheduleSave();
      showToast('✅ Добавлены новые датчики');
    } else {
      showToast('⚠️ Найдены новые датчики (нет прав на сохранение)');
    }
    updateSensorPanel();
  }
}

/* ========== СОХРАНЕНИЕ КОНФИГУРАЦИИ ========== */

// Фоновая отправка конфигурации на сервер
export async function saveConfigSilent() {
  try {
    const res = await fetch('/config/save', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
      },
      body: JSON.stringify(config, null, 2)
    });

    if (res.status === 401 || res.status === 403) {
      forceLogout();
      return;
    }

    if (!res.ok) throw new Error('HTTP error: ' + res.status);
  } catch (e) {
    console.error('Ошибка автосохранения:', e);
  }
}

// Сохранение конфигурации с отображением статуса пользователю
export async function saveConfigWithMessage() {
  try {
    const res = await fetch('/config/save', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
      },
      body: JSON.stringify(config, null, 2)
    });

    if (res.status === 401 || res.status === 403) {
      alert('❌ Сессия истекла. Войдите снова.');
      forceLogout();
      return;
    }

    const text = await res.text();
    if (text.includes('OK')) {
      showToast('✅ Настройки сохранены');
    } else {
      alert('❌ Ошибка сохранения: ' + text);
    }
  } catch (e) {
    alert('❌ Ошибка сохранения: ' + e.message);
  }
}