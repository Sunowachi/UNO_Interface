import { ALERT_PRIORITY } from '../constants.js';

// ==================== ОПРЕДЕЛЕНИЕ КЛАССА ПРЕДУПРЕЖДЕНИЯ ====================

/** Определение класса предупреждения (blink-*) на основе настроек и текущего значения */
export function getAlertClass(vs, value) {
    if (!Number.isFinite(value) || !vs) return null;

    const low = vs.lowLimit;
    const warn = vs.warnLimit;
    const alarm = vs.alarmLimit;

    const hasLow = low !== null && low !== undefined && low !== '';
    const hasWarn = warn !== null && warn !== undefined && warn !== '';
    const hasAlarm = alarm !== null && alarm !== undefined && alarm !== '';

    const lowNum = hasLow ? Number(low) : null;
    const warnNum = hasWarn ? Number(warn) : null;
    const alarmNum = hasAlarm ? Number(alarm) : null;

    if (hasAlarm && Number.isFinite(alarmNum) && value >= alarmNum) return 'blink-red';
    if (hasWarn && Number.isFinite(warnNum) && value >= warnNum) return 'blink-yellow';
    if (hasLow && Number.isFinite(lowNum) && value < lowNum) return 'blink-blue';

    return null;
}

/** Выбор более приоритетного класса предупреждения из двух */
export function pickHigherAlertClass(currentClass, newClass) {
    if (!newClass) return currentClass;
    if (!currentClass) return newClass;
    return ALERT_PRIORITY[newClass] > ALERT_PRIORITY[currentClass] ? newClass : currentClass;
}
