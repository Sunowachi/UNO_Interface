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
import { syncConfigInitial, loadConfig, syncNewSensors, startConfigPolling } from './sensors.js';

/* ========== СОСТОЯНИЕ ПРИЛОЖЕНИЯ ========== */

// Переменная для хранения идентификатора интервала периодического обновления данных
let fetchInterval = null;
// Переменная для хранения идентификатора интервала обновления таймера
let timerInterval = null;
// Флаг, указывающий, был ли уже инициализирован пользовательский интерфейс (чтобы не настраивать обработчики повторно)
let uiInitialized = false;
// Флаг, предотвращающий повторный запуск функции init во время её выполнения
let initRunning = false;
// Текущее состояние приложения: 'idle', 'initializing', 'ready' (используется для предотвращения повторных инициализаций)
let appState = 'idle';

/* ========== ФУНКЦИИ ОБНОВЛЕНИЯ ДАННЫХ ========== */

// Вспомогательная асинхронная функция для обновления данных и интерфейса
async function fetchAndRefresh() {
  try {
    // Загружаем свежие данные с сервера с учётом временного диапазона
    await fetchData();
    // Синхронизируем новые датчики (добавляем в конфиг, если их там нет)
    await syncNewSensors();
    // Обновляем панель списка датчиков (отображаем актуальные данные)
    updateSensorPanel();
    // Перерисовываем графики для текущего датчика с новыми данными
    drawCurrent();
    // Обновляем панель устройств (список активных датчиков и переменных)
    updateDevicePanel();
  } catch (e) {
    // Логируем ошибку в консоль, но не прерываем выполнение
    console.error('[fetchAndRefresh] ошибка:', e);
  }
}

/* ========== ИНИЦИАЛИЗАЦИЯ ПРИЛОЖЕНИЯ ========== */

// Главная функция инициализации приложения (вызывается после успешного входа или при загрузке страницы)
export async function init() {
  // Проверяем, что приложение не находится в состоянии инициализации или готовности
  if (appState !== 'idle') {
    console.warn('[init] пропущен, текущее состояние:', appState);
    return; // Если не idle, выходим (предотвращаем повторную инициализацию)
  }

  // Устанавливаем состояние "инициализация"
  appState = 'initializing';
  // Если уже выполняется инициализация, выходим (защита от параллельных вызовов)
  if (initRunning) return;
  initRunning = true;

  try {
    // Останавливаем все работающие интервалы (на случай, если они были)
    clearIntervals();
    console.log('init: запрос /init');

    // Выполняем GET-запрос к серверу для получения начальных данных
    const res = await fetch('/init', { credentials: 'include' });

    // Если сервер вернул 401 (неавторизован) или 403 (доступ запрещён)
    if (res.status === 401 || res.status === 403) {
      // Останавливаем интервалы
      clearIntervals();
      // Сбрасываем флаги
      uiInitialized = false;
      initRunning = false;
      // Принудительно выходим из системы (перенаправляем на экран входа)
      forceLogout();
      return;
    }

    // Если ответ не успешен, генерируем ошибку
    if (!res.ok) throw new Error('Ошибка при запросе /init: ' + res.status);

    // Получаем текст ответа
    const text = await res.text();
    let data;
    try {
      // Пытаемся распарсить JSON
      data = JSON.parse(text);
    } catch (e) {
      console.error('Ошибка парсинга JSON /init:', e);
      return;
    }

    // Проверяем наличие и корректность поля startTime (время запуска сервера)
    if (!data?.startTime || typeof data.startTime !== 'number') {
      console.error('Некорректный startTime:', data?.startTime);
      return;
    }
    // Проверяем наличие и корректность поля sensors (данные датчиков)
    if (!data?.sensors || typeof data.sensors !== 'object') {
      console.error('Некорректный sensors:', data?.sensors);
      return;
    }

    // Сохраняем время запуска сервера в константы (для таймера)
    setServerStart(data.startTime);
    // Сохраняем полученные данные датчиков
    setAllSensors(data.sensors);

    // Загружаем конфигурацию датчиков с сервера (из файла)
    const cfgLoaded = await loadConfig();
    // Если конфиг не загружен (например, файл отсутствует), выводим предупреждение
    if (!cfgLoaded) console.warn('Конфиг не загружен с диска, используем серверный конфиг');

    // Синхронизируем начальную конфигурацию (возможно, добавляем датчики из данных в конфиг)
    await syncConfigInitial();

    // Если текущий датчик не выбран, но в конфигурации есть датчики, выбираем первый
    if (!currentSensor && Array.isArray(config.sensors) && config.sensors.length > 0) {
      setCurrentSensor(config.sensors[0].id);
    }

    // Если интерфейс ещё не был инициализирован (обработчики кнопок не настроены)
    if (!uiInitialized) {
      // Настраиваем обработчики кнопок (добавление, сохранение, удаление и т.д.)
      setupButtonHandlers();
      // Настраиваем элементы управления временным диапазоном
      setupTimeRangeControls();
      // Устанавливаем флаг, что UI инициализирован
      uiInitialized = true;
    }

    // Обновляем все элементы интерфейса с новыми данными
    updateSensorPanel();
    drawCurrent();
    updateDevicePanel();
    updateTimer(); // Обновляем таймер сразу, без ожидания интервала

    // Если интервал обновления данных ещё не запущен
    if (!fetchInterval) {
      // Запускаем периодическое обновление каждые 2 секунды
      fetchInterval = setInterval(fetchAndRefresh, 2000);
      // Через 300 мс после запуска выполняем одно быстрое обновление (чтобы сразу показать данные)
      setTimeout(fetchAndRefresh, 300);
    }
    // Если интервал обновления таймера ещё не запущен, запускаем его (каждую секунду)
    if (!timerInterval) timerInterval = setInterval(updateTimer, 1000);

    // Устанавливаем состояние приложения "готово"
    appState = 'ready';
    startConfigPolling();

  } catch (e) {
    // В случае ошибки логируем её и возвращаем состояние в idle
    console.error('Ошибка в init:', e);
    appState = 'idle';
    throw e; // Пробрасываем ошибку дальше (может быть обработана выше)
  } finally {
    // Сбрасываем флаг выполнения инициализации
    initRunning = false;
  }
}

/* ========== ОЧИСТКА РЕСУРСОВ ========== */

// Функция для остановки всех интервалов и сброса состояния приложения
export function clearIntervals() {
  // Устанавливаем состояние idle (приложение неактивно)
  appState = 'idle';
  // Если интервал обновления данных существует, очищаем его
  if (fetchInterval) {
    clearInterval(fetchInterval);
    fetchInterval = null;
  }
  // Если интервал обновления таймера существует, очищаем его
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}