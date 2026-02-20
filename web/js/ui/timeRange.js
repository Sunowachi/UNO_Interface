import { timeRange } from '../constants.js';
import { fetchData } from '../utils/dataUtils.js';

// Настройка элементов управления временным диапазоном (поля дней, часов, минут и кнопка "Применить")
export function setupTimeRangeControls() {
  // Поле ввода количества дней
  const dInput = document.getElementById('timeDays');
  // Поле ввода часов
  const hInput = document.getElementById('timeHours');
  // Поле ввода минут
  const mInput = document.getElementById('timeMinutes');
  // Кнопка применения нового диапазона
  const applyBtn = document.getElementById('applyTimeRangeBtn');

  // Если хотя бы один из элементов не найден, прекращаем выполнение
  if (!dInput || !hInput || !mInput || !applyBtn) return;

  // Устанавливаем значения полей из текущего объекта timeRange
  dInput.value = timeRange.days;
  hInput.value = timeRange.hours;
  mInput.value = timeRange.minutes;

  // Внутренняя функция для применения нового диапазона (асинхронная)
  async function applyRange() {
    // Получаем числа из полей ввода (parseInt с основанием 10)
    const d = parseInt(dInput.value, 10);
    const h = parseInt(hInput.value, 10);
    const m = parseInt(mInput.value, 10);

    // Проверяем, что значения не отрицательные
    if ((d < 0) || (h < 0) || (m < 0)) {
      alert('Значения диапазона времени не могут быть отрицательными');
      return;
    }

    // Обновляем объект timeRange, если значения не числа — подставляем 0
    timeRange.days = isNaN(d) ? 0 : d;
    timeRange.hours = isNaN(h) ? 0 : h;
    timeRange.minutes = isNaN(m) ? 0 : m;

    // Показываем индикатор загрузки графиков
    const loadingIndicator = document.getElementById('chart-loading');
    if (loadingIndicator) loadingIndicator.style.display = 'block';

    try {
      // Загружаем данные за новый диапазон (функция fetchData из utils)
      await fetchData();
    } catch (error) {
      console.error('Ошибка при загрузке данных по новому диапазону:', error);
      alert('Не удалось загрузить данные за выбранный период.');
    } finally {
      // В любом случае скрываем индикатор загрузки
      if (loadingIndicator) loadingIndicator.style.display = 'none';
    }
  }

  // Назначаем обработчик клика на кнопку "Применить"
  applyBtn.addEventListener('click', applyRange);

  // Добавляем обработчик нажатия клавиш для полей ввода: если нажат Enter, вызываем applyRange
  [dInput, hInput, mInput].forEach(inp => {
    inp.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') await applyRange();
    });
  });
}