import { initSession } from './session.js';
import { init } from './api.js';
import {
  setupButtonHandlers,
  setupTimeRangeControls,
  hideApp,
  openLoginModal
} from './ui.js';
import { initCustomNumberInputs } from './customNumberInput.js';

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
});