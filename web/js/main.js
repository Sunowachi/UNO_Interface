import { initSession } from './session.js';
import { init } from './api.js';
import { setupButtonHandlers } from './ui/buttonHandlers.js';
import { setupTimeRangeControls } from './ui/timeRange.js';
import { hideApp } from './ui/app.js';
import { openLoginModal } from './ui/login.js';
import { initCustomNumberInputs } from './inputArrows.js';
import { initExportModal } from './ui/export.js';

// Добавляем обработчик события, которое срабатывает после полной загрузки HTML-документа
document.addEventListener('DOMContentLoaded', async () => {
  // Скрываем основное приложение (пока не авторизованы)
  hideApp();

  // Настраиваем обработчики кнопок (добавление, сохранение, удаление датчиков и т.д.)
  setupButtonHandlers();

  // Настраиваем поля ввода и кнопку для выбора временного диапазона
  setupTimeRangeControls();

  // Пытаемся инициализировать сессию (проверяем, есть ли уже активная сессия)
  await initSession();

  // Если сессия успешно восстановлена, инициализируем основное приложение (загружаем данные, конфиги)
  await init();

  // Обработчик всех числовых полей на страницы (визуал)
  initCustomNumberInputs();

  // Экспорт
  initExportModal();
});