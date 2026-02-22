import { config, currentSensor, setServerStart, setAllSensors, setCurrentSensor, currentUser } from './constants.js';
import { updateSensorPanel, updateDevicePanel, setupButtonHandlers, setupTimeRangeControls, updateTimer, forceLogout } from './ui/index.js';
import { drawCurrent } from './charts.js';
import { fetchData } from './utils/dataUtils.js';
import { syncConfigInitial, loadConfig, syncNewSensors, startConfigPolling, stopConfigPolling } from './sensors/index.js';
import { lockSession } from './session.js';

/* ========== СОСТОЯНИЕ ПРИЛОЖЕНИЯ ========== */
let fetchInterval = null;               // Интервал обновления данных
let timerInterval = null;                // Интервал обновления таймера
let uiInitialized = false;               // Флаг инициализации UI
let initRunning = false;                 // Флаг выполнения init()
let appState = 'idle';                   // Текущее состояние: idle, initializing, ready

/* ========== ФУНКЦИИ ОБНОВЛЕНИЯ ДАННЫХ ========== */

/** Асинхронное обновление данных и интерфейса */
async function fetchAndRefresh() {
    if (!currentUser) {
        console.log('[fetchAndRefresh] пользователь не авторизован, пропускаем');
        return;
    }
    try {
        await fetchData();
        await syncNewSensors();
        updateSensorPanel();
        drawCurrent();
        updateDevicePanel();
    } catch (e) {
        console.error('[fetchAndRefresh] ошибка:', e);
    }
}

/* ========== ИНИЦИАЛИЗАЦИЯ ПРИЛОЖЕНИЯ ========== */

/** Главная функция инициализации после входа */
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

        const res = await fetch('/init', { credentials: 'include' });

        if (res.status === 401 || res.status === 403) {
            clearIntervals();
            uiInitialized = false;
            initRunning = false;
            lockSession();
            return;
        }

        if (!res.ok) throw new Error('Ошибка при запросе /init: ' + res.status);

        const text = await res.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
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
        startConfigPolling();

    } catch (e) {
        console.error('Ошибка в init:', e);
        appState = 'idle';
        throw e;
    } finally {
        initRunning = false;
    }
}

/* ========== ОЧИСТКА РЕСУРСОВ ========== */

/** Остановка всех интервалов и сброс состояния */
export function clearIntervals() {
    appState = 'idle';
    if (fetchInterval) {
        clearInterval(fetchInterval);
        fetchInterval = null;
    }
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    stopConfigPolling();
}
