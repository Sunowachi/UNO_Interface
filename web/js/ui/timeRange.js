import { timeRange } from '../constants.js';
import { fetchData } from '../utils/dataUtils.js';

// ==================== УПРАВЛЕНИЕ ВРЕМЕННЫМ ДИАПАЗОНОМ ====================

/** Настройка элементов управления временным диапазоном (поля дней, часов, минут и кнопка "Применить") */
export function setupTimeRangeControls() {
    const dInput = document.getElementById('timeDays');
    const hInput = document.getElementById('timeHours');
    const mInput = document.getElementById('timeMinutes');
    const applyBtn = document.getElementById('applyTimeRangeBtn');

    if (!dInput || !hInput || !mInput || !applyBtn) return;

    dInput.value = timeRange.days;
    hInput.value = timeRange.hours;
    mInput.value = timeRange.minutes;

    async function applyRange() {
        const d = parseInt(dInput.value, 10);
        const h = parseInt(hInput.value, 10);
        const m = parseInt(mInput.value, 10);

        if ((d < 0) || (h < 0) || (m < 0)) {
            alert('Значения диапазона времени не могут быть отрицательными');
            return;
        }

        timeRange.days = isNaN(d) ? 0 : d;
        timeRange.hours = isNaN(h) ? 0 : h;
        timeRange.minutes = isNaN(m) ? 0 : m;

        const loadingIndicator = document.getElementById('chart-loading');
        if (loadingIndicator) loadingIndicator.style.display = 'block';

        try {
            await fetchData();
        } catch (error) {
            console.error('Ошибка при загрузке данных по новому диапазону:', error);
            alert('Не удалось загрузить данные за выбранный период.');
        } finally {
            if (loadingIndicator) loadingIndicator.style.display = 'none';
        }
    }

    applyBtn.addEventListener('click', applyRange);

    [dInput, hInput, mInput].forEach(inp => {
        inp.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') await applyRange();
        });
    });
}
