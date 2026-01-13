console.log('sensors.js загружен');

import { config, setConfig, csrfToken, PERMISSIONS } from './constants.js';
import { showToast, updateSensorPanel } from './ui.js';
import { buildIpVarMap, hasPermission } from './utils.js';

const MAX_SENSORS = 256;

let saveTimer = null;

function normalizeVars(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === 'string') {
    return input
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);
  }
  return [];
}

function isValidVarName(v) {
  return /^[a-zA-Z0-9_]{1,32}$/.test(v);
}

// === ЗАГРУЗКА КОНФИГА ===
export async function loadConfig() {
  try {
    const res = await fetch('/config/load', {
      credentials: 'include',
      headers: csrfToken ? {
        'X-CSRF-Token': csrfToken
      } : {}
    });

    if (res.status === 401 || res.status === 403) {
      forceLogout();
      return;
    }

    if (!res.ok) {
      throw new Error('Ошибка HTTP: ' + res.status);
    }

    const text = await res.text();
    const parsed = JSON.parse(text);

    if (!parsed || !Array.isArray(parsed.sensors)) {
      setConfig({ sensors: [] });
    } else {
      setConfig(parsed);
    }

  } catch (e) {
    console.warn('Ошибка загрузки конфига:', e);
    setConfig({ sensors: [] });
  }
}

// === СИНХРОНИЗАЦИЯ КОНФИГА С ДАННЫМИ (при загрузке страницы) ===
export async function syncConfigInitial() {

  if (config.sensors.length >= MAX_SENSORS) {
    console.warn('Достигнут лимит датчиков = 256!');
    return;
  }

  const ipMap = buildIpVarMap();
  let updated = false;

  for (const [sensorId, varSet] of Object.entries(ipMap)) {
    const varsFromData = Array.from(varSet)
      .filter(isValidVarName);
    let sCfg = config.sensors.find(s => String(s.id) === String(sensorId));

    if (!sCfg) {
      sCfg = {
        id: sensorId,
        name: sensorId,
        vars: normalizeVars(varsFromData),
        deleted: false
      };
      config.sensors.push(sCfg);
      updated = true;
    } else {
      sCfg.vars = normalizeVars(sCfg.vars);
      if (sCfg.vars.length === 0) {
        updated = true;
      }
    }
  }

  if (updated) {
    if (
      hasPermission(PERMISSIONS.EDIT_CONFIG) &&
      hasPermission(PERMISSIONS.SAVE_CONFIG)
    ) {
      scheduleSave();
    } else {
      showToast('❌ Недостаточно прав для сохранения конфигурации');
    }
  }
}

// === ДОБАВЛЕНИЕ ТОЛЬКО НОВЫХ ДАТЧИКОВ ПО IP (при каждом новом /data) ===
export async function syncNewSensors() {
  const ipMap = buildIpVarMap();
  let updated = false;

  for (const [sensorId, varSet] of Object.entries(ipMap)) {
    let sCfg = config.sensors.find(s => String(s.id) === String(sensorId));
    if (!sCfg) {
      sCfg = {
        id: sensorId,
        name: sensorId,
        vars: Array.from(varSet).join(', '),
        deleted: false
      };
      config.sensors.push(sCfg);
      updated = true;
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

// === СОХРАНЕНИЕ CONFIG.JSON ===
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

    if (!res.ok) {
      throw new Error('Ошибка HTTP: ' + res.status);
    }

  } catch (e) {
    console.error('Ошибка автосохранения:', e);
  }
}

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

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveConfigSilent, 2000);
}