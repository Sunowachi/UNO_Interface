import { COLOR_CHOICES } from '../constants.js';

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ РАБОТЫ С ДАТЧИКАМИ ====================

/** Максимальное количество датчиков, которое можно добавить */
export const MAX_SENSORS = 256;

/** Задержка перед автосохранением после изменений (мс) */
export const SAVE_DEBOUNCE_MS = 1000;

/** Множество ID датчиков, которые были недавно удалены (для предотвращения авто-восстановления) */
const recentlyDeleted = new Set();
const RECENTLY_DELETED_TIMEOUT = 3000; // 3 секунды

/** Пометка датчика как недавно удалённого */
export function markSensorDeleted(id) {
    const idStr = String(id);
    recentlyDeleted.add(idStr);
    setTimeout(() => {
        recentlyDeleted.delete(idStr);
    }, RECENTLY_DELETED_TIMEOUT);
}

/** Проверка, был ли датчик недавно удалён */
export function isRecentlyDeleted(id) {
    return recentlyDeleted.has(String(id));
}

/** Обновление настроек переменных при изменении конфигурации датчика */
export function updateVarSettings(sCfg) {
    if (!sCfg.varSettings) sCfg.varSettings = [];

    const existingVars = new Set(sCfg.varSettings.map(vs => vs.var));
    const newVars = sCfg.vars.filter(v => !existingVars.has(v));

    newVars.forEach((v, idx) => {
        const varIndex = sCfg.vars.indexOf(v);
        const defaultColor = COLOR_CHOICES[varIndex % COLOR_CHOICES.length].value;

        sCfg.varSettings.push({
            var: v,
            label: v,
            color: defaultColor,
            rawColor: '#B0BEC5',
            unit: '',
            lowLimit: null,
            warnLimit: null,
            alarmLimit: null,
            processing: 'none',
            showRaw: true,
            showProcessed: false
        });
    });
}

/** Нормализация списка переменных: преобразование в массив строк, обрезка пробелов, удаление пустых */
export function normalizeVars(input) {
    if (Array.isArray(input)) {
        return input.map(String).map(v => v.trim()).filter(Boolean);
    }

    if (typeof input === 'string') {
        return input.split(',').map(v => v.trim()).filter(Boolean);
    }

    return [];
}

/** Проверка корректности имени переменной (только буквы, цифры, _, длина 1-32) */
export function isValidVarName(v) {
    return /^[a-zA-Z0-9_]{1,32}$/.test(v);
}
