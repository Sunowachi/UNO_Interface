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

/*
  Robust fetchData:

  The server may return sensor data in two formats:
  1) An array of rows: [{ ts:..., value:... }, ...] or [value, value, ...]
  2) An object with separate arrays: { values: [...], times: [...] }

  We support both and ensure 'values' and 'times' arrays are aligned and in milliseconds.
  If times are missing or lengths mismatch we synthesize reasonable timestamps spaced by DEFAULT_STEP_MS
  so that horizontal axis reflects an approximate timeline. Prefer using provided timestamps.
*/
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
    const data = JSON.parse(text);

    if (!data?.sensors) { console.error('Некорректный формат /init:', data); return; }

    const newAll = {};
    const newTimes = {};

    for (const [sensorId, vars] of Object.entries(data.sensors)) {
      if (!vars || typeof vars !== 'object') continue;

      for (const [varName, rows] of Object.entries(vars)) {
        if (!varName) continue;

        const key = `${sensorId}:${varName}`;

        const values = [];
        const times = [];

        // Case A: server provided an array of row entries
        if (Array.isArray(rows)) {
          for (const row of rows) {
            // row might be a number, or an object { value:..., ts:... } or { v:..., t:... }
            let v = Number(row?.value ?? row?.v ?? row);
            if (!Number.isFinite(v)) continue;

            let t = row?.ts ?? row?.time ?? row?.t ?? null;
            if (t == null) {
              // no timestamp in this row; will handle later (synthesize)
              times.push(null);
            } else {
              if (typeof t === 'string') t = Date.parse(t);
              if (!Number.isFinite(t)) t = Date.now();
              if (t < 1e12) t = t * 1000;
              times.push(t);
            }
            values.push(v);
          }
        }
        // Case B: server provided separated arrays { values: [...], times: [...] }
        else if (rows && typeof rows === 'object' && Array.isArray(rows.values)) {
          const valsArr = rows.values;
          const timesArr = Array.isArray(rows.times) ? rows.times : [];

          for (let i = 0; i < valsArr.length; i++) {
            const rawV = valsArr[i];
            let v = Number(rawV);
            if (!Number.isFinite(v)) continue;

            let t = timesArr[i] ?? null;
            if (t != null) {
              if (typeof t === 'string') t = Date.parse(t);
              if (!Number.isFinite(t)) t = Date.now();
              if (t < 1e12) t = t * 1000;
              times.push(t);
            } else {
              times.push(null);
            }
            values.push(v);
          }
        } else {
          // Unknown format for this variable
          continue;
        }

        if (!values.length) continue;

        // If we have timestamps but some are null, try to fill gaps:
        const haveAnyTimestamps = times.some(t => t != null);

        if (!haveAnyTimestamps) {
          // No timestamps -> synthesize evenly spaced timestamps ending at now
          const now = Date.now();
          for (let i = 0; i < values.length; i++) {
            times[i] = now - (values.length - 1 - i) * DEFAULT_STEP_MS;
          }
        } else {
          // Some timestamps exist. For nulls, interpolate or fill with nearest known timestamp.
          // Also, ensure all timestamps are in ms and monotonic non-decreasing.
          // First, replace nulls with NaN so we can post-process.
          for (let i = 0; i < times.length; i++) {
            if (times[i] == null) times[i] = NaN;
          }

          // Replace leading NaNs with first known timestamp minus steps
          let firstKnownIdx = times.findIndex(t => Number.isFinite(t));
          if (firstKnownIdx === -1) {
            const now = Date.now();
            for (let i = 0; i < values.length; i++) times[i] = now - (values.length - 1 - i) * DEFAULT_STEP_MS;
          } else {
            // fill leading
            for (let i = firstKnownIdx - 1; i >= 0; i--) {
              times[i] = times[i + 1] - DEFAULT_STEP_MS;
            }
            // fill middle gaps by linear interpolation between known timestamps
            let lastKnown = firstKnownIdx;
            for (let i = firstKnownIdx + 1; i < times.length; i++) {
              if (Number.isFinite(times[i])) {
                const gap = i - lastKnown;
                const startT = times[lastKnown];
                const endT = times[i];
                const step = (endT - startT) / gap;
                for (let j = 1; j < gap; j++) {
                  times[lastKnown + j] = Math.round(startT + step * j);
                }
                lastKnown = i;
              }
            }
            // fill trailing NaNs with last known + steps
            for (let i = lastKnown + 1; i < times.length; i++) {
              times[i] = times[i - 1] + DEFAULT_STEP_MS;
            }
          }

          // Ensure timestamps are numbers and in ms (already converted earlier)
          for (let i = 0; i < times.length; i++) {
            if (typeof times[i] !== 'number' || !Number.isFinite(times[i])) {
              times[i] = Date.now();
            }
            if (times[i] < 1e12) times[i] = times[i] * 1000;
          }
        }

        // Trim to MAX_POINTS if necessary (keep most recent points)
        if (values.length > MAX_POINTS) {
          const drop = values.length - MAX_POINTS;
          values.splice(0, drop);
          times.splice(0, drop);
        }

        newAll[key] = { values };
        newTimes[key] = times;
      }
    }

    // Merge into global structures
    // Keep previous data but overwrite/add updated keys
    setAllSensors(Object.assign({}, allSensors, newAll));
    // Update sensorTimes for keys we received
    for (const [k, tArr] of Object.entries(newTimes)) {
      sensorTimes[k] = tArr;
    }

    await syncNewSensors();
    updateSensorPanel();
    drawCurrent();
    updateDevicePanel();

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