console.log('api.js загружен');

import {
  allSensors,
  config,
  sensorTimes,
  currentSensor,
  setServerStart,
  setAllSensors,
  setCurrentSensor,
  currentUser
} from './constants.js';

import {
  showToast,
  updateSensorPanel,
  updateDevicePanel,
  setupButtonHandlers,
  setupTimeRangeControls,
  updateTimer,
  showApp,
  applyPermissions,
  forceLogout
} from './ui.js';

import { drawCurrent } from './charts.js';
import { fetchData } from './utils.js';

import {
  syncConfigInitial,
  syncNewSensors,
  loadConfig
} from './sensors.js';

let fetchInterval = null;
let timerInterval = null;
let uiInitialized = false;

export async function init() {
  try {
    console.log('init: запрос /init');

    const res = await fetch('/init', {
      credentials: 'include'
    });

    if (fetchInterval) {
      clearInterval(fetchInterval);
      fetchInterval = null;
    }
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }

    if (res.status === 401 || res.status === 403) {
      forceLogout();
      return;
    }

    if (!res.ok) {
      throw new Error('Ошибка при запросе /init: ' + res.status);
    }

    const text = await res.text();
    console.log('Ответ сервера /init:', text);

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

    // 1) СНАЧАЛА грузим конфиг с диска
    await loadConfig();

    const cfgLoaded = await loadConfig();
    if (!cfgLoaded) {
      console.warn('Конфиг не загружен с диска, используем серверный конфиг');
    }

    // 2) Один раз синхронизируем конфиг с тем, что пришло от сервера
    await syncConfigInitial();

    // 3) Если ещё не выбран датчик – выбрать первый
    if (!currentSensor && Array.isArray(config.sensors) && config.sensors.length > 0) {
      setCurrentSensor(config.sensors[0].id);
    }

    // 4) Обработчики кнопок
    if (!uiInitialized) {
      setupButtonHandlers();
      setupTimeRangeControls();
      uiInitialized = true;
    }

    // 5) Рисуем интерфейс
    updateSensorPanel();
    drawCurrent();
    updateDevicePanel();
    updateTimer();

    // 6) Запускаем периодический опрос сервера
    clearIntervals();
    await fetchData();
    fetchInterval = setInterval(fetchData, 2000);
    timerInterval = setInterval(updateTimer, 1000);

  } catch (e) {
    console.error('Ошибка в init:', e);

    if (fetchInterval) {
      clearInterval(fetchInterval);
      fetchInterval = null;
    }

    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }
}

function clearIntervals() {
  if (fetchInterval) { clearInterval(fetchInterval); fetchInterval = null; }
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}