import { config, setConfig, csrfToken, editingId } from '../constants.js';
import { lockSession } from '../session.js';
import { updateSensorPanel, updateDevicePanel } from '../ui/index.js';
import { drawCurrent } from '../charts.js';
import { updateVarSettings, normalizeVars, isValidVarName, isRecentlyDeleted } from './sensorUtils.js';
import { isSaving } from './configSaver.js';

// ==================== ЗАГРУЗКА КОНФИГУРАЦИИ С СЕРВЕРА ====================

let isPolling = false;
let configPollTimer = null;

/** Периодический опрос конфигурации (синхронизация изменений) */
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

        // Нормализация
        parsed.sensors.forEach(s => {
            s.vars = normalizeVars(s.vars).filter(isValidVarName);
            if (typeof s.deleted !== 'boolean') s.deleted = false;
            updateVarSettings(s);
        });

        // Проверка на недавно удалённые датчики
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

/** Запуск периодического опроса */
export function startConfigPolling(intervalMs = 2000) {
    if (configPollTimer) clearInterval(configPollTimer);
    configPollTimer = setInterval(pollConfig, intervalMs);
}

/** Остановка опроса */
export function stopConfigPolling() {
    if (configPollTimer) {
        clearInterval(configPollTimer);
        configPollTimer = null;
    }
}

/** Загрузка конфигурации с сервера (однократно) */
export async function loadConfig() {
    try {
        const res = await fetch('/config/load', {
            credentials: 'include',
            headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {}
        });

        if (res.status === 401 || res.status === 403) {
            lockSession();
            return;
        }

        if (!res.ok) throw new Error('HTTP error: ' + res.status);

        const text = await res.text();
        const parsed = JSON.parse(text);

        if (!parsed || !Array.isArray(parsed.sensors)) {
            setConfig({ sensors: [] });
            return;
        }

        parsed.sensors.forEach(s => {
            s.vars = normalizeVars(s.vars).filter(isValidVarName);
            if (typeof s.deleted !== 'boolean') s.deleted = false;
            updateVarSettings(s);
        });

        setConfig(parsed);
    } catch (e) {
        console.warn('Ошибка загрузки конфига:', e);
        setConfig({ sensors: [] });
    }
}
