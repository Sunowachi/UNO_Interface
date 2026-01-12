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

export function hasPermission(permission) {
  if (!currentUser || !currentUser.role) {
    return false;
  }

  const role = currentUser.role;
  const perms = ROLE_PERMISSIONS[role];

  if (!perms) return false;
  if (perms.has(PERMISSIONS.DEV_ALL)) return true;

  return perms.has(permission);
}

export function buildIpVarMap() {
  const map = {};

  for (const [key, src] of Object.entries(allSensors || {})) {
    if (!src || !src.sensorId || !src.var) continue;

    const sensorId = String(src.sensorId);
    const varName = String(src.var);

    if (!map[sensorId]) {
      map[sensorId] = new Set();
    }
    map[sensorId].add(varName);
  }
  return map;
}

export function getSelectedTimeRangeMs() {
  const d = Number(timeRange.days) || 0;
  const h = Number(timeRange.hours) || 0;
  const m = Number(timeRange.minutes) || 0;
  const totalMinutes = d * 24 * 60 + h * 60 + m;
  if (totalMinutes <= 0) return 0;
  return totalMinutes * 60 * 1000;
}

export function getAlertClass(vs, value) {
  if (value == null || !Number.isFinite(value)) return null;
  if (!vs) vs = {};

  const low = (vs.lowLimit !== undefined && vs.lowLimit !== null && vs.lowLimit !== '')
    ? Number(vs.lowLimit) : null;
  const warn = (vs.warnLimit !== undefined && vs.warnLimit !== null && vs.warnLimit !== '')
    ? Number(vs.warnLimit) : null;
  const alarm = (vs.alarmLimit !== undefined && vs.alarmLimit !== null && vs.alarmLimit !== '')
    ? Number(vs.alarmLimit) : null;

  if (low !== null && Number.isFinite(low) && value < low) return 'blink-blue';
  if (alarm !== null && Number.isFinite(alarm) && value >= alarm) return 'blink-red';
  if (warn !== null && Number.isFinite(warn) && value >= warn) return 'blink-yellow';

  return null;
}

export function pickHigherAlertClass(currentClass, newClass) {
  if (!newClass) return currentClass;
  if (!currentClass) return newClass;
  return (ALERT_PRIORITY[newClass] > ALERT_PRIORITY[currentClass]) ? newClass : currentClass;
}

// ---- Обновление панели датчиков ----
export async function fetchData() {
  try {
    const rangeMs = getSelectedTimeRangeMs();

    const url = (rangeMs > 0)
      ? `/data?rangeMs=${encodeURIComponent(rangeMs)}&_=${Date.now()}`
      : `/data?_=${Date.now()}`;

    const res = await fetch(url, {
      credentials: 'include'
    });

    if (res.status === 401 || res.status === 403) {
      forceLogout();
      return;
    }

    if (!res.ok) {
      throw new Error('Ошибка при запросе /data: ' + res.status);
    }

    const text = await res.text();
    console.log('Ответ сервера /data:', text.substring(0, 200) + '...');
    if (!text.trim()) return;

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error('Ошибка парсинга JSON /data:', e);
      return;
    }

    const incoming = data.sensors || data;

    // Сборка новых объектов, но не перезапись всего, если приходят корректные times
    const newAll = {};
    const newTimes = {};

    for (const key of Object.keys(incoming)) {
      const src = incoming[key];
      if (!src || !Array.isArray(src.values)) continue;

      const vals = src.values.map(Number);

      // если сервер прислал times синхронно - используем их
      if (Array.isArray(src.times) && src.times.length === vals.length) {
        const times = src.times.map(t =>
          (typeof t === 'number') ? (t < 1e12 ? t * 1000 : t) : Date.parse(t)
        );
        newAll[key] = { values: vals };
        newTimes[key] = times;
      } else {
        // fallback: если сервер не прислал times, пытаемся аккуратно merge:
        // берем существующие times (если есть), и дополняем новыми с шагом 1s
        const existingVals = (allSensors[key] && Array.isArray(allSensors[key].values))
          ? allSensors[key].values.slice()
          : [];

        const existingTimes = Array.isArray(sensorTimes[key]) ? sensorTimes[key].slice() : [];

        if (vals.length >= existingVals.length) {
          // если сервер прислал окно той же длины — заменяем значения и сохраняем/генерируем times
          const delta = vals.length - existingVals.length;
          let times = existingTimes.slice();

          const STEP_MS = 1000;
          if (times.length === 0) {
            const start = Date.now() - STEP_MS * (vals.length - 1);
            times = [];
            for (let i = 0; i < vals.length; i++) times.push(start + i * STEP_MS);
          } else {
            // если есть предыдущие времена — продолжим от последнего
            let last = times[times.length - 1] || (Date.now() - STEP_MS);
            for (let i = times.length; i < vals.length; i++) {
              last = last + STEP_MS;
              times.push(last);
            }
          }

          newAll[key] = { values: vals };
          newTimes[key] = times;
        } else {
          // иначе просто use what came
          const STEP_MS = 1000;
          const start = Date.now() - STEP_MS * (vals.length - 1);
          const times = [];
          for (let i = 0; i < vals.length; i++) times.push(start + i * STEP_MS);

          newAll[key] = { values: vals };
          newTimes[key] = times;
        }
      }
    }

    // Применяем новые данные (обновляем ссылку чтобы UI увидел изменение)
    setAllSensors({ ...allSensors, ...newAll });

    // Перезаписываем sensorTimes для ключей, которые пришли
    for (const k of Object.keys(newTimes)) {
      sensorTimes[k] = newTimes[k];
    }

    await syncNewSensors();
    updateSensorPanel();
    drawCurrent();
    updateDevicePanel();

  } catch (e) {
    console.error('Ошибка в fetchData:', e);
  }
}

// Формат времени ЧЧ:ММ:СС
export function formatTimeHHMMSS(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}