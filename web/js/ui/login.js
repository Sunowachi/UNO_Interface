import { setCurrentUser, csrfToken } from '../constants.js';
import { hideApp } from './app.js';
import { initSession } from '../session.js';
import { init } from '../api.js';

let loginModal = document.getElementById('loginModal');

export function openLoginModal() {
    if (loginModal) loginModal.classList.add('show');
}

export function closeLoginModal() {
    if (loginModal) loginModal.classList.remove('show');
}

// Показать сообщение об ошибке в модальном окне входа
function showLoginError(message) {
  const errorEl = document.getElementById("loginError"); // Находим элемент для ошибки
  if (errorEl) {
    errorEl.textContent = message;       // Устанавливаем текст ошибки
    errorEl.style.color = '#ff0000';      // Красный цвет текста
    errorEl.style.marginTop = '10px';     // Отступ сверху для визуального разделения
  }
}

// Асинхронная функция обработки входа пользователя
export async function login(e) {
  // Если передан объект события, предотвращаем стандартное поведение формы (перезагрузку страницы)
  e?.preventDefault();
  // Сбрасываем текущего пользователя (на время входа)
  setCurrentUser(null);

  // Получаем значения полей логина и пароля из DOM
  const username = document.getElementById("loginUser").value;
  const password = document.getElementById("loginPass").value;

  // Выполняем POST-запрос к серверу для аутентификации
  const res = await fetch('/auth/login', {
    method: 'POST',                          // Метод запроса
    headers: {
      'Content-Type': 'application/json',    // Отправляем данные в формате JSON
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) // Если есть CSRF-токен, добавляем его в заголовки
    },
    body: JSON.stringify({ username, password }), // Тело запроса: логин и пароль в JSON
    credentials: 'include'                    // Включаем куки (для сессии)
  });

  // Получаем ответ сервера в формате JSON
  const data = await res.json();

  // Если статус ответа не OK (код не 2xx)
  if (!res.ok) {
    hideApp();                // Скрываем приложение (на случай, если оно было показано)
    openLoginModal();         // Открываем модальное окно входа

    // Если сервер вернул ошибку "blocked" (блокировка из-за множества попыток)
    if (data.error === 'blocked') {
      showLoginError('Слишком много попыток. Попробуйте позже.');
    } else {
      // Иначе показываем общую ошибку неверного логина/пароля
      showLoginError('Неверный логин или пароль');
    }
    return; // Прерываем выполнение функции
  }

  // Проверяем поле status в ответе (ожидается "ok")
  if (data.status !== "ok") {
    alert("Ошибка входа");
    return;
  }

  // Очищаем сообщение об ошибке в форме входа
  const errorEl = document.getElementById("loginError");
  if (errorEl) errorEl.textContent = '';

  closeLoginModal(); // Закрываем модальное окно входа

  try {
    // Инициализируем сессию (загружаем данные пользователя, права и т.д.)
    await initSession();
    // Инициализируем основное приложение (загружаем конфигурацию, данные датчиков)
    await init();
    // После успешной инициализации перезагружаем страницу для получения полного HTML
    window.location.reload();
  } catch (err) {
    // Если произошла ошибка при инициализации, выводим её в консоль
    console.error('Ошибка инициализации после логина:', err);
    hideApp();                // Скрываем приложение
    openLoginModal();         // Открываем окно входа снова
    showLoginError('Ошибка инициализации приложения'); // Показываем ошибку
  }
}

// Принудительный выход из системы (logout)
export async function forceLogout() {
  try {
    // Отправляем POST-запрос на выход (удаление сессии на сервере)
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
  } catch {} // Игнорируем ошибки сети (если сервер недоступен)

  setCurrentUser(null); // Очищаем текущего пользователя в приложении
  hideApp();            // Скрываем основное приложение
  openLoginModal();     // Открываем окно входа
}
