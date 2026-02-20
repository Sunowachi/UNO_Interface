import { serverStart } from '../constants.js';

// Обновление таймера работы системы (отображается в интерфейсе)
export function updateTimer() {
  if (!serverStart) return; // Если время запуска неизвестно, ничего не делаем
  const timerEl = document.getElementById('timer');
  if (!timerEl) return;

  // Вычисляем прошедшее время в секундах
  const elapsedSec = Math.floor((Date.now() - serverStart) / 1000);
  // Разбиваем на часы, минуты, секунды
  const h = Math.floor(elapsedSec / 3600);
  const m = Math.floor((elapsedSec % 3600) / 60);
  const s = elapsedSec % 60;
  // Форматируем строку с ведущими нулями и выводим
  timerEl.textContent = `Время работы: ${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}