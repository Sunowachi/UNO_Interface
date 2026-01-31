console.log('utils.js загружен');

import {
  timeRange,
  ALERT_PRIORITY,
  allSensors,
  sensorTimes,
  setAllSensors,
  currentUser,
  ROLE_PERMISSIONS,
  PERMISSIONS,
  csrfToken
} from './constants.js';

import { lockSession } from './session.js';
import { syncNewSensors } from './sensors.js';
import { updateSensorPanel, updateDevicePanel } from './ui.js';
import { drawCurrent } from './charts.js';

const MAX_POINTS = 5000;
const DEFAULT_STEP_MS = 1000;

export function hasPermission(permission) {
  if (!permission || !currentUser?.role) return false;
  const perms = ROLE_PERMISSIONS[currentUser.role];
  if (!perms) return false;
  if (perms.has(PERMISSIONS.DEV_ALL)) return true;
  return perms.has(permission);
}

function isValidVarName(v) { return typeof v === 'string' && /^[a-zA-Z0-9_]{1,32}$/.test(v); }
function isValidSensorId(id) { return typeof id === 'string' && id.length > 0 && id.length <= 64; }

export function buildIpVarMap() {
  const map = {};
  for (const key of Object.keys(allSensors || {})) {
    if (typeof key !== 'string') continue;
    const parts = key.split(':', 2);
    if (parts.length !== 2) continue;
    const sensorId = parts[0].trim();
    const varName = parts[1].trim();
    if (!isValidSensorId(sensorId) || !isValidVarName(varName)) continue;
    if (!map[sensorId]) map[sensorId] = new Set();
    map[sensorId].add(varName);
  }
  return map;
}

export function getSelectedTimeRangeMs() {
  const d = Number(timeRange.days) || 0;
  const h = Number(timeRange.hours) || 0;
  const m = Number(timeRange.minutes) || 0;
  const totalMinutes = Math.max(d * 1440 + h * 60 + m, 0);
  return totalMinutes * 60_000;
}

export function getAlertClass(vs, value) {
  if (!Number.isFinite(value) || !vs) return null;
  const low = Number(vs.lowLimit), warn = Number(vs.warnLimit), alarm = Number(vs.alarmLimit);
  if (Number.isFinite(alarm) && value >= alarm) return 'blink-red';
  if (Number.isFinite(warn) && value >= warn) return 'blink-yellow';
  if (Number.isFinite(low) && value < low) return 'blink-blue';
  return null;
}

export function pickHigherAlertClass(currentClass, newClass) {
  if (!newClass) return currentClass;
  if (!currentClass) return newClass;
  return ALERT_PRIORITY[newClass] > ALERT_PRIORITY[currentClass] ? newClass : currentClass;
}

export async function fetchData() {
  if (!csrfToken) {
    console.warn('[fetchData] CSRF-токен ещё не установлен, пропускаем fetch');
    return;
  }

  try {
    const rangeMs = getSelectedTimeRangeMs();

    console.log('[fetchData] запрос /init?rangeMs=' + rangeMs);
    const res = await fetch('/init?rangeMs=' + encodeURIComponent(String(rangeMs)), {
      method: 'GET',
      credentials: 'include'
    });

    if (res.status === 401 || res.status === 403) {
      console.warn('[fetchData] Сессия недействительна, останавливаем опрос');
      lockSession();
      return;
    }

    if (!res.ok) throw new Error('HTTP ' + res.status);

    const text = await res.text();
    let data;

    try { data = JSON.parse(text); }
    catch (e) {
      console.error('[fetchData] Ошибка парсинга JSON /init:', e);
      return;
    }

    if (!data?.sensors || typeof data.sensors !== 'object') {
      console.error('[fetchData] Некорректный формат sensors:', data?.sensors);
      return;
    }
    const newAll = {};
    const newTimes = {};
    const sensors = data.sensors;
    let flatDetected = false;
    for (const k of Object.keys(sensors)) {
      if (k.includes(':')) { flatDetected = true; break; }
    }

    if (flatDetected) {
      for (const [flatKey, payload] of Object.entries(sensors)) {
        if (payload == null) continue;
        if (Array.isArray(payload)) {
          newAll[flatKey] = { values: payload.slice() };
        } else if (typeof payload === 'object') {
          const vals = Array.isArray(payload.values) ? payload.values.slice() : [];
          const times = Array.isArray(payload.times) ? payload.times.slice() : null;
          newAll[flatKey] = { values: vals };
          if (times) newTimes[flatKey] = times;
        }
      }
    } else {
      for (const [sensorId, vars] of Object.entries(sensors)) {
        if (!vars || typeof vars !== 'object') continue;
        for (const [varName, rows] of Object.entries(vars)) {
          const key = `${sensorId}:${varName}`;
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
    setAllSensors(newAll);
    const allTimeKeys = Object.keys(sensorTimes);
    for (const key of allTimeKeys) {
        delete sensorTimes[key];
    }
    for (const [key, times] of Object.entries(newTimes)) {
        sensorTimes[key] = times.slice();
    }
    await syncNewSensors();
    updateSensorPanel();
    drawCurrent();
    updateDevicePanel();
  } catch (e) {
    console.error('Ошибка fetchData:', e);
  }
}

export function formatTimeHHMMSS(ms, useUTC = false) {
  const d = new Date(ms);
  const h = useUTC ? d.getUTCHours() : d.getHours();
  const m = useUTC ? d.getUTCMinutes() : d.getMinutes();
  const s = useUTC ? d.getUTCSeconds() : d.getSeconds();
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}