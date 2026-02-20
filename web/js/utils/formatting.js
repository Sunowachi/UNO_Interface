// Форматирование времени в формате HH:MM:SS из миллисекунд
export function formatTimeHHMMSS(ms, useUTC = false) {
  const d = new Date(ms); // Создаём объект Date из миллисекунд
  // Если useUTC = true, берём UTC-часы/минуты/секунды, иначе локальные
  const h = useUTC ? d.getUTCHours() : d.getHours();
  const m = useUTC ? d.getUTCMinutes() : d.getMinutes();
  const s = useUTC ? d.getUTCSeconds() : d.getSeconds();
  // Приводим каждое значение к строке, добавляем ведущий ноль до двух символов и объединяем через двоеточие
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}