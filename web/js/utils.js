console.log('utils.js загружен');

import {
  timeRange,
  ALERT_PRIORITY,
  allSensors,
  sensorTimes,
  setAllSensors,
  currentUser,
  ROLE_PERMISSIONS,
  PERMISSIONS
} from './constants.js';

import { syncNewSensors } from './sensors.js';
import { updateSensorPanel, updateDevicePanel } from './ui.js';
import { drawCurrent } from './charts.js';

/* ================== CONSTANTS ================== */

const MAX_POINTS = 5000;
const DEFAULT_STEP_MS = 1000;

/* ================== PERMISSIONS ================== */

export function hasPermission(permission) {

  if (!permission) return false;

  if (!currentUser || !currentUser.role) return false;

  const perms = ROLE_PERMISSIONS[currentUser.role];

  if (!perms) return false;

  if (perms.has(PERMISSIONS.DEV_ALL)) return true;

  return perms.has(permission);
}

/* ================== SENSOR KEY ================== */

function isValidVarName(v) {
  return typeof v === 'string' && /^[a-zA-Z0-9_]{1,32}$/.test(v);
}

function isValidSensorId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 64;
}

/* ================== BUILD MAP ================== */

export function buildIpVarMap() {
  const map = {};

  for (const key of Object.keys(allSensors || {})) {
    if (typeof key !== 'string') continue;

    const sensorId = parts[0].trim();
    const varName = parts[1].trim();

    const parts = key.split(':', 2);
    if (parts.length !== 2) continue;

    const sensorId = parts[0];
    const varName = parts[1];

    if (!isValidSensorId(sensorId)) continue;
    if (!isValidVarName(varName)) continue;

    if (!map[sensorId]) {
      map[sensorId] = new Set();
    }

    map[sensorId].add(varName);
  }

  return map;
}

/* ================== TIME RANGE ================== */

export function getSelectedTimeRangeMs() {
  const d = Number(timeRange.days) || 0;
  const h = Number(timeRange.hours) || 0;
  const m = Number(timeRange.minutes) || 0;

  const totalMinutes = d * 1440 + h * 60 + m;
  return totalMinutes > 0 ? totalMinutes * 60_000 : 0;

  const safe = Math.max(totalMinutes, 0);
  return safe * 60_000;
}

/* ================== ALERTS ================== */

export function getAlertClass(vs, value) {
  if (!Number.isFinite(value) || !vs) return null;

  const low = Number(vs.lowLimit);
  const warn = Number(vs.warnLimit);
  const alarm = Number(vs.alarmLimit);

  if (Number.isFinite(alarm) && value >= alarm) return 'blink-red';
  if (Number.isFinite(warn) && value >= warn) return 'blink-yellow';
  if (Number.isFinite(low) && value < low) return 'blink-blue';

  return null;
}

export function pickHigherAlertClass(currentClass, newClass) {
  if (!newClass) return currentClass;
  if (!currentClass) return newClass;

  return ALERT_PRIORITY[newClass] > ALERT_PRIORITY[currentClass]
    ? newClass
    : currentClass;
}

/* ================== DATA FETCH ================== */

export async function fetchData() {
  try {
    const rangeMs = getSelectedTimeRangeMs();
    const url = rangeMs > 0
      ? `/data?rangeMs=${encodeURIComponent(rangeMs)}&_=${Date.now()}`
      : `/data?_=${Date.now()}`;

    const res = await fetch(url, { credentials: 'include' });

    if (res.status === 401 || res.status === 403) {
      forceLogout();
      return;
    }

    if (!res.ok) {
      throw new Error('HTTP ' + res.status);
    }

    const text = await res.text();
    if (!text.trim()) return;

    const data = JSON.parse(text);

    if (!data || typeof data !== 'object' || !data.sensors) {
      console.error('Некорректный формат /data:', data);
      return;
    }

    const incoming = data.sensors;

    const newAll = {};
    const now = Date.now();

    for (const [sensorId, vars] of Object.entries(incoming)) {
      if (!vars || typeof vars !== 'object') continue;

      for (const [varName, rows] of Object.entries(vars)) {
        if (!Array.isArray(rows)) continue;

        const key = `${sensorId}:${varName}`;

        const values = [];
        const times = [];

        for (const row of rows) {
          if (!row) continue;

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

        if (values.length > MAX_POINTS) {
          values.splice(0, values.length - MAX_POINTS);
          times.splice(0, times.length - MAX_POINTS);
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

    console.debug(
        '[fetchData] sensors:',
        Object.keys(newAll).length
      );
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