import { config, setConfig, csrfToken, editingId } from '../constants.js';
import { lockSession } from '../session.js';
import { updateSensorPanel, updateDevicePanel } from '../ui/index.js';
import { drawCurrent } from '../charts.js';
import { updateVarSettings, normalizeVars, isValidVarName, isRecentlyDeleted } from './sensorUtils.js';
import { isSaving } from './configSaver.js';

let isPolling = false;
let configPollTimer = null;

// Функция опроса конфигурации
export async function pollConfig(force = false) {
  if (!force && isPolling) return;
  if (!force && isSaving()) {
    return;
  }
  isPolling = true;
  try {
    const res = await fetch('/config/load', {
      credentials: 'include',
      headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {}
    });

    if (res.status === 401 || res.status === 403) {
      console.warn('[pollConfig] сессия недействительна!');
      lockSession();
      return;
    }
    if (!res.ok) throw new Error('HTTP error: ' + res.status);

    const text = await res.text();
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.sensors)) return;

    // Нормализуем
    parsed.sensors.forEach(s => {
      s.vars = normalizeVars(s.vars).filter(isValidVarName);
      if (typeof s.deleted !== 'boolean') s.deleted = false;
      updateVarSettings(s);
    });

    // Проверяем, нет ли в новой конфигурации датчиков, которые были недавно удалены
    const hasRecentlyDeleted = parsed.sensors.some(s => isRecentlyDeleted(s.id));
    if (hasRecentlyDeleted) {
      return;
    }

    const sortSensors = (arr) => [...arr].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const sortKeys = (obj) => {
      if (obj === null || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(sortKeys);
      return Object.keys(obj).sort().reduce((acc, key) => {
        acc[key] = sortKeys(obj[key]);
        return acc;
      }, {});
    };

    const normalizedCurrent = sortKeys({ sensors: sortSensors(config.sensors) });
    const normalizedParsed = sortKeys({ sensors: sortSensors(parsed.sensors) });
    const currentJson = JSON.stringify(normalizedCurrent);
    const newJson = JSON.stringify(normalizedParsed);

    if (currentJson !== newJson) {
      setConfig(parsed);
      updateSensorPanel(true);
      drawCurrent();

      // Если открыто модальное окно редактирования, уведомляем об изменениях
      if (editingId !== null) {
        window.dispatchEvent(new CustomEvent('config-changed', { detail: { editingId } }));
      }
    }
  } catch (e) {
    console.warn('[pollConfig] ошибка:', e);
  } finally {
    isPolling = false;
  }
}

// Запуск периодического опроса
export function startConfigPolling(intervalMs = 2000) {
  if (configPollTimer) clearInterval(configPollTimer);
  configPollTimer = setInterval(pollConfig, intervalMs);
}

// Остановка опроса
export function stopConfigPolling() {
  if (configPollTimer) {
    clearInterval(configPollTimer);
    configPollTimer = null;
  }
}

// Загрузка конфигурации с сервера (из файла)
export async function loadConfig() {
  try {
    // Выполняем GET-запрос к /config/load
    const res = await fetch('/config/load', {
      credentials: 'include', // Передаём куки
      headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {} // CSRF-токен, если есть
    });

    // Если статус 401 или 403 (неавторизован или доступ запрещён)
    if (res.status === 401 || res.status === 403) {
      lockSession()
      return;
    }

    // Если ответ не успешен, генерируем ошибку
    if (!res.ok) throw new Error('HTTP error: ' + res.status);

    // Получаем текст ответа
    const text = await res.text();
    // Парсим JSON
    const parsed = JSON.parse(text);

    // Если в ответе нет поля sensors или это не массив, устанавливаем пустую конфигурацию
    if (!parsed || !Array.isArray(parsed.sensors)) {
      setConfig({ sensors: [] });
      return;
    }

    // Обрабатываем каждый датчик
    parsed.sensors.forEach(s => {
      // Нормализуем список переменных и фильтруем только валидные имена
      s.vars = normalizeVars(s.vars).filter(isValidVarName);
      // Если поле deleted отсутствует, устанавливаем false
      if (typeof s.deleted !== 'boolean') s.deleted = false;
      // Обновляем настройки переменных (добавляем отсутствующие)
      updateVarSettings(s);
    });

    // Сохраняем обработанную конфигурацию в глобальное состояние
    setConfig(parsed);
  } catch (e) {
    // В случае ошибки выводим предупреждение и устанавливаем пустую конфигурацию
    console.warn('Ошибка загрузки конфига:', e);
    setConfig({ sensors: [] });
  }
}
