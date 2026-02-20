import { currentUser } from '../constants.js';

// Показать основное приложение (скрыть экран входа/загрузки)
export function showApp() {
  // Если пользователь не авторизован, ничего не делаем
  if (!currentUser) return;
  const app = document.getElementById('appRoot'); // Находим корневой элемент приложения
  if (app) app.hidden = false;                    // Убираем атрибут hidden, показываем элемент
}

// Скрыть основное приложение
export function hideApp() {
  const app = document.getElementById('appRoot'); // Находим корневой элемент
  if (app) app.hidden = true;                      // Скрываем элемент
}