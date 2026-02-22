import {
    timeRange,
    allSensors,
    sensorTimes,
    setAllSensors,
    config,
    csrfToken,
    currentUser
} from '../constants.js';
import { lockSession } from '../session.js';
import { syncNewSensors } from '../sensors/configSync.js';
import { updateSensorPanel, updateDevicePanel } from '../ui/index.js';
import { drawCurrent } from '../charts.js';

// ==================== РАБОТА С ДАННЫМИ ДАТЧИКОВ ====================

/** Создание карты переменных по ID датчика */
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

/** Валидация ID датчика */
function isValidSensorId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 64;
}

/** Валидация имени переменной */
function isValidVarName(v) {
    return typeof v === 'string' && /^[a-zA-Z0-9_]{1,32}$/.test(v);
}

/** Вычисление временного диапазона в миллисекундах */
export function getSelectedTimeRangeMs() {
    const d = Number(timeRange.days) || 0;
    const h = Number(timeRange.hours) || 0;
    const m = Number(timeRange.minutes) || 0;
    const totalMinutes = Math.max(d * 1440 + h * 60 + m, 0);
    return totalMinutes * 60_000;
}

/** Проверка существования датчика по ID */
export function sensorExists(sensorId) {
    return config.sensors.some(s => String(s.id) === String(sensorId) && !s.deleted);
}

/** Получение эффективных настроек переменной (с учётом ссылок на другие датчики) */
export function getEffectiveVarSettings(sCfg, varName) {
    const local = sCfg.varSettings?.find(v => v.var === varName);

    if (varName.includes('_')) {
        const parts = varName.split('_');
        if (parts.length === 2) {
            const sourceId = parts[0];
            const sourceVar = parts[1];
            const sourceSensor = config.sensors.find(s => String(s.id) === String(sourceId) && !s.deleted);
            if (sourceSensor) {
                const sourceSettings = sourceSensor.varSettings?.find(v => v.var === sourceVar);
                if (sourceSettings) {
                    return {
                        ...sourceSettings,
                        var: varName,
                        label: local?.label || sourceSettings.label || sourceVar,
                    };
                }
            }
        }
    }
    return local || {};
}

/** Загрузка данных с сервера с учётом выбранного диапазона */
export async function fetchData() {
    if (!csrfToken) {
        console.warn('[fetchData] CSRF-токен ещё не установлен, пропускаем fetch');
        return;
    }

    try {
        const rangeMs = getSelectedTimeRangeMs();
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
        let data;

        try {
            data = JSON.parse(text);
        } catch (e) {
            console.error('[fetchData] Ошибка парсинга JSON /init:', e);
            return;
        }

        if (!data?.sensors || typeof data.sensors !== 'object') {
            console.error('[fetchData] Некорректный формат sensors:', data?.sensors);
            return;
        }

        const newAll = {};
        const newTimes = {};
        const sensors = data.sensors;
        let flatDetected = false;

        for (const k of Object.keys(sensors)) {
            if (k.includes(':')) {
                flatDetected = true;
                break;
            }
        }

        if (flatDetected) {
            for (const [flatKey, payload] of Object.entries(sensors)) {
                if (payload == null) continue;
                if (Array.isArray(payload)) {
                    newAll[flatKey] = { values: payload.slice() };
                } else if (typeof payload === 'object') {
                    const vals = Array.isArray(payload.values) ? payload.values.slice() : [];
                    const times = Array.isArray(payload.times) ? payload.times.slice() : null;
                    newAll[flatKey] = { values: vals };
                    if (times) newTimes[flatKey] = times;
                }
            }
        } else {
            for (const [sensorId, vars] of Object.entries(sensors)) {
                if (!vars || typeof vars !== 'object') continue;
                for (const [varName, rows] of Object.entries(vars)) {
                    const key = `${sensorId}:${varName}`;
                    if (rows == null) continue;
                    if (Array.isArray(rows)) {
                        newAll[key] = { values: rows.slice() };
                    } else if (typeof rows === 'object') {
                        const vals = Array.isArray(rows.values) ? rows.values.slice() : [];
                        const times = Array.isArray(rows.times) ? rows.times.slice() : null;
                        newAll[key] = { values: vals };
                        if (times) newTimes[key] = times;
                    }
                }
            }
        }

        setAllSensors(newAll);

        const allTimeKeys = Object.keys(sensorTimes);
        for (const key of allTimeKeys) {
            delete sensorTimes[key];
        }
        for (const [key, times] of Object.entries(newTimes)) {
            sensorTimes[key] = times.slice();
        }

        await syncNewSensors();
        updateSensorPanel(false);
        drawCurrent();
        updateDevicePanel(false);
    } catch (e) {
        console.error('Ошибка fetchData:', e);
    }
}
