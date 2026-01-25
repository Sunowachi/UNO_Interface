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

/* ================== CONSTANTS ================== */

const MAX_POINTS = 5000;
const DEFAULT_STEP_MS = 1000;

/* ================== PERMISSIONS ================== */

export function hasPermission(permission) {
  if (!permission || !currentUser?.role) return false;
  const perms = ROLE_PERMISSIONS[currentUser.role];
  if (!perms) return false;
  if (perms.has(PERMISSIONS.DEV_ALL)) return true;
  return perms.has(permission);
}

/* ================== SENSOR KEY ================== */

function isValidVarName(v) { return typeof v === 'string' && /^[a-zA-Z0-9_]{1,32}$/.test(v); }
function isValidSensorId(id) { return typeof id === 'string' && id.length > 0 && id.length <= 64; }

/* ================== BUILD MAP ================== */

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

/* ================== TIME RANGE ================== */

export function getSelectedTimeRangeMs() {
  const d = Number(timeRange.days) || 0;
  const h = Number(timeRange.hours) || 0;
  const m = Number(timeRange.minutes) || 0;
  const totalMinutes = Math.max(d * 1440 + h * 60 + m, 0);
  return totalMinutes * 60_000;
}

/* ================== ALERTS ================== */

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

/* ================== DATA FETCH ================== */

export async function fetchData() {
  if (!csrfToken) {
    console.warn('[fetchData] CSRF-токен ещё не установлен, пропускаем fetch');
    return;
  }

  try {
    const rangeMs = getSelectedTimeRangeMs();
    const sensorsPayload = {};
    for (const key of Object.keys(allSensors)) {
      const sensorId = key.split(':')[0];
      if (!sensorId || !allSensors[key]?.token) continue;
      sensorsPayload[sensorId] = allSensors[key].token;
    }

    const res = await fetch('/data', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ sensors: sensorsPayload, rangeMs })
    });

    if (res.status === 401 || res.status === 403) { lockSession(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const data = await res.json();
    if (!data?.sensors) { console.error('Некорректный формат /data:', data); return; }

    const newAll = {};
    for (const [sensorId, vars] of Object.entries(data.sensors)) {
      if (!vars || typeof vars !== 'object') continue;
      for (const [varName, rows] of Object.entries(vars)) {
        if (!Array.isArray(rows)) continue;

        const key = `${sensorId}:${varName}`;
        const values = [], times = [];
        for (const row of rows) {
          const v = Number(row.value ?? row.v ?? row);
          if (!Number.isFinite(v)) continue;
          let t = row.ts ?? row.time ?? row.t ?? Date.now();
          if (typeof t === 'string') t = Date.parse(t);
          if (!Number.isFinite(t)) t = Date.now();
          if (t < 1e12) t *= 1000;
          values.push(v);
          times.push(t);
        }

        if (!values.length) continue;
        if (values.length > 5000) {
          values.splice(0, values.length - 5000);
          times.splice(0, times.length - 5000);
        }

        newAll[key] = { values };
        sensorTimes[key] = times;
      }
    }

    setAllSensors(Object.assign({}, allSensors, newAll));
    await syncNewSensors();
    updateSensorPanel();
    drawCurrent();
    updateDevicePanel();

    // краткий лог вместо полного объекта
    console.debug('[fetchData] обновлено сенсоров:', Object.keys(newAll).length);

  } catch (e) {
    console.error('Ошибка fetchData:', e);
  }
}

/* ================== FORMAT ================== */

export function formatTimeHHMMSS(ms, useUTC = false) {
  const d = new Date(ms);
  const h = useUTC ? d.getUTCHours() : d.getHours();
  const m = useUTC ? d.getUTCMinutes() : d.getMinutes();
  const s = useUTC ? d.getUTCSeconds() : d.getSeconds();
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}