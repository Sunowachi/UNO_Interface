import { ALERT_PRIORITY } from '../constants.js';

// Определение класса предупреждения (blink-* ) на основе настроек переменной и текущего значения
export function getAlertClass(vs, value) {
  if (!Number.isFinite(value) || !vs) return null;

  const low = vs.lowLimit;
  const warn = vs.warnLimit;
  const alarm = vs.alarmLimit;

  // Проверяем, что пределы явно заданы (не null, не undefined, не пустая строка)
  const hasLow = low !== null && low !== undefined && low !== '';
  const hasWarn = warn !== null && warn !== undefined && warn !== '';
  const hasAlarm = alarm !== null && alarm !== undefined && alarm !== '';

  // Преобразуем в числа только если они есть
  const lowNum = hasLow ? Number(low) : null;
  const warnNum = hasWarn ? Number(warn) : null;
  const alarmNum = hasAlarm ? Number(alarm) : null;

  if (hasAlarm && Number.isFinite(alarmNum) && value >= alarmNum) return 'blink-red';
  if (hasWarn && Number.isFinite(warnNum) && value >= warnNum) return 'blink-yellow';
  if (hasLow && Number.isFinite(lowNum) && value < lowNum) return 'blink-blue';

  return null;
}

// Выбор более приоритетного класса предупреждения из двух
export function pickHigherAlertClass(currentClass, newClass) {
  // Если новый класс отсутствует, оставляем текущий
  if (!newClass) return currentClass;
  // Если текущий отсутствует, берём новый
  if (!currentClass) return newClass;
  // Сравниваем приоритеты из ALERT_PRIORITY (числовые значения)
  return ALERT_PRIORITY[newClass] > ALERT_PRIORITY[currentClass] ? newClass : currentClass;
}
