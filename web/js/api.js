console.log('api.js загружен');

import {
  allSensors,
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

import {
  syncConfigInitial,
  loadConfig
} from './sensors.js';

let fetchInterval = null;
let timerInterval = null;
let uiInitialized = false;

export async function init() {
  try {
    // безопасно очищаем интервалы перед новым запуском
    clearIntervals();

    console.log('init: запрос /init');

    const res = await fetch('/init', { credentials: 'include' });

    if (res.status === 401 || res.status === 403) {
      forceLogout();
      return;
    }

    if (!res.ok) throw new Error('Ошибка при запросе /init: ' + res.status);

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error('Ошибка парсинга JSON /init:', e);
      console.error('Невалидный ответ сервера:', text);
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

    // безопасно запускаем сессию и опрос данных
    await initSession();

    // интервалы запускаем только один раз
    fetchInterval = setInterval(fetchData, 2000);
    timerInterval = setInterval(updateTimer, 1000);

  } catch (e) {
    console.error('Ошибка в init:', e);
    clearIntervals();
  }
}

// очистка интервалов
function clearIntervals() {
  if (fetchInterval) { clearInterval(fetchInterval); fetchInterval = null; }
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}
