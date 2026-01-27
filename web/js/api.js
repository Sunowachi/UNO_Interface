console.log('api.js загружен');

import {
  config,
  currentSensor,
  setServerStart,
  setAllSensors,
  setCurrentSensor
} from './constants.js';

import {
  updateSensorPanel,
  updateDevicePanel,
  setupButtonHandlers,
  setupTimeRangeControls,
  updateTimer,
  forceLogout
} from './ui.js';

import { drawCurrent } from './charts.js';
import { fetchData } from './utils.js';

import { syncConfigInitial, loadConfig, syncNewSensors } from './sensors.js';

let fetchInterval = null;
let timerInterval = null;
let uiInitialized = false;
let initRunning = false;
let appState = 'idle';

async function fetchAndRefresh() {
  try {
    const changed = await fetchData();
    await syncNewSensors();
    updateSensorPanel();
    drawCurrent();
    updateDevicePanel();
  } catch (e) {
    console.error('[fetchAndRefresh] ошибка:', e);
  }
}

export async function init() {

  if (appState !== 'idle') {
    console.warn('[init] пропущен, текущее состояние:', appState);
    return;
  }

  appState = 'initializing';
  if (initRunning) return;
  initRunning = true;

  try {
    clearIntervals();

    console.log('init: запрос /init');
    const res = await fetch('/init', { credentials: 'include' });

    if (res.status === 401 || res.status === 403) {
      clearIntervals();
      uiInitialized = false;
      initRunning = false;
      forceLogout();
      return;
    }

    if (!res.ok) throw new Error('Ошибка при запросе /init: ' + res.status);

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) {
      console.error('Ошибка парсинга JSON /init:', e);
      return;
    }

    if (!data?.startTime || typeof data.startTime !== 'number') {
      console.error('Некорректный startTime:', data?.startTime);
      return;
    }
    if (!data?.sensors || typeof data.sensors !== 'object') {
      console.error('Некорректный sensors:', data?.sensors);
      return;
    }

    setServerStart(data.startTime);
    setAllSensors(data.sensors);

    const cfgLoaded = await loadConfig();
    if (!cfgLoaded) console.warn('Конфиг не загружен с диска, используем серверный конфиг');

    await syncConfigInitial();

    if (!currentSensor && Array.isArray(config.sensors) && config.sensors.length > 0) {
      setCurrentSensor(config.sensors[0].id);
    }

    if (!uiInitialized) {
      setupButtonHandlers();
      setupTimeRangeControls();
      uiInitialized = true;
    }

    updateSensorPanel();
    drawCurrent();
    updateDevicePanel();
    updateTimer();

    if (!fetchInterval) {
      fetchInterval = setInterval(fetchAndRefresh, 2000);
      setTimeout(fetchAndRefresh, 300);
    }
    if (!timerInterval) timerInterval = setInterval(updateTimer, 1000);

    appState = 'ready';

  } catch (e) {
      console.error('Ошибка в init:', e);
      appState = 'idle';
      throw e;
    } finally {
      initRunning = false;
    }
}

export function clearIntervals() {
  appState = 'idle';
  if (fetchInterval) { clearInterval(fetchInterval); fetchInterval = null; }
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}