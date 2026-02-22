import { serverStart } from '../constants.js';

// ==================== ТАЙМЕР РАБОТЫ СЕРВЕРА ====================

/** Обновление отображения времени работы сервера */
export function updateTimer() {
    if (!serverStart) return;
    const timerEl = document.getElementById('timer');
    if (!timerEl) return;

    const elapsedSec = Math.floor((Date.now() - serverStart) / 1000);
    const h = Math.floor(elapsedSec / 3600);
    const m = Math.floor((elapsedSec % 3600) / 60);
    const s = elapsedSec % 60;
    timerEl.textContent = `Время работы: ${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
