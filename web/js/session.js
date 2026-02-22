import { openLoginModal, hideApp, showApp, closeLoginModal } from './ui/index.js';
import { applyPermissions } from './utils/permissions.js';
import { setCurrentUser, currentUser, setCsrfToken, csrfToken } from './constants.js';
import { clearIntervals } from './api.js';
import { stopConfigPolling } from './sensors/index.js';

// Время бездействия в миллисекундах до блокировки сессии (10 минут)
let IDLE_TIMEOUT = 10 * 60 * 1000; // значение по умолчанию, будет переопределено сервером
// Переменная для хранения идентификатора таймера бездействия
let idleTimer = null;
// Временная метка последней активности пользователя
let lastActivity = Date.now();
// Идентификатор таймера для периодической проверки сессии (ping)
let pingTimer = null;
// Флаг, указывающий, установлены ли уже обработчики событий активности
let listenersInstalled = false;
// Флаг блокировки сессии (предотвращает повторные блокировки)
let sessionLocked = false;
// Флаг, указывающий, был ли уже инициализирован пользовательский интерфейс
let uiInitialized = false;

/* ========== УПРАВЛЕНИЕ ТАЙМЕРАМИ БЕЗДЕЙСТВИЯ ========== */

// Сброс таймера бездействия при активности пользователя
function resetIdleTimer() {
  // Обновляем метку последней активности текущим временем
  lastActivity = Date.now();
}

// Запуск мониторинга бездействия
function startIdleWatch() {
  // Останавливаем предыдущий мониторинг, если он был
  stopIdleWatch();
  // Запускаем интервал, который каждую секунду проверяет время бездействия
  idleTimer = setInterval(() => {
    // Вычисляем, сколько прошло с последней активности
    const idleTime = Date.now() - lastActivity;
    // Если время бездействия превышает лимит, блокируем сессию
    if (idleTime >= IDLE_TIMEOUT) lockSession();
  }, 1000); // Проверка каждую секунду
}

// Остановка мониторинга бездействия
function stopIdleWatch() {
  // Если таймер существует, очищаем его
  if (idleTimer) clearInterval(idleTimer);
  // Сбрасываем переменную таймера
  idleTimer = null;
}

/* ========== УПРАВЛЕНИЕ СЕССИЕЙ ========== */

// Блокировка сессии при бездействии или ошибке аутентификации
export async function lockSession() {
  // Если сессия уже заблокирована, ничего не делаем (предотвращаем повторные вызовы)
  if (sessionLocked) return;
  // Устанавливаем флаг блокировки
  sessionLocked = true;
  // Останавливаем все интервалы обновления данных (графики, списки и т.д.)
  clearIntervals();
  // Останавливаем мониторинг бездействия
  stopIdleWatch();
  // Останавливаем периодическую проверку сессии
  stopPing();
  // Останавливаем опрос конфигурации
  stopConfigPolling();

  try {
    // Отправляем запрос на выход (logout), чтобы завершить сессию на сервере
    await fetch('/auth/logout', {
      method: 'POST',                       // POST-запрос
      credentials: 'include',                // Передаём куки
      headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {} // Если есть CSRF-токен, добавляем в заголовки
    });
  } catch {} // Игнорируем возможные ошибки сети

  // Сбрасываем флаги инициализации
  uiInitialized = false;
  listenersInstalled = false;
  // Очищаем данные текущего пользователя
  setCurrentUser(null);
  // Очищаем CSRF-токен
  setCsrfToken(null);
  hideLogoutButton();
  // Скрываем основное приложение
  hideApp();
  // Открываем модальное окно входа
  openLoginModal();
}

/* ========== КНОПКА ВЫХОДА ИЗ АККАУНТА ========== */

// Показать кнопку выхода
function showLogoutButton() {
    const btn = document.getElementById('logoutBtn');
    if (btn) btn.hidden = false;
}

// Скрыть кнопку выхода
function hideLogoutButton() {
    const btn = document.getElementById('logoutBtn');
    if (btn) btn.hidden = true;
}

/* ========== ПРОВЕРКА АКТИВНОСТИ СЕССИИ ========== */

// Периодическая проверка валидности сессии (ping)
export function startPing() {
  // Останавливаем предыдущий ping, если он был
  stopPing();
  // Запускаем интервал с проверкой каждые 30 секунд
  pingTimer = setInterval(async () => {
    // Если сессия заблокирована или нет CSRF-токена, проверка не нужна
    if (sessionLocked || !csrfToken) return;

    try {
      // Отправляем запрос на сервер для проверки сессии
      const res = await fetch('/auth/ping', {
        method: 'POST',                       // POST-запрос
        credentials: 'include',                // Передаём куки
        headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {} // CSRF-токен
      });

      // Если статус ответа 401 (Unauthorized) или 403 (Forbidden), сессия недействительна
      if (res.status === 401 || res.status === 403) {
        console.warn('[ping] Сессия недействительна, блокируем');
        lockSession(); // Блокируем сессию
      }
    } catch (e) {
      // Ошибки сети игнорируем (например, если сервер временно недоступен)
      console.debug('[ping] Ошибка сети:', e);
    }
  }, 30_000); // 30 секунд (30_000 миллисекунд)
}

// Остановка периодической проверки сессии
export function stopPing() {
  // Если таймер существует, очищаем его
  if (pingTimer) clearInterval(pingTimer);
  // Сбрасываем переменную таймера
  pingTimer = null;
}

/* ========== ОТСЛЕЖИВАНИЕ АКТИВНОСТИ ПОЛЬЗОВАТЕЛЯ ========== */

// Установка обработчиков событий активности пользователя
function setupActivityListeners() {
  // Если обработчики уже установлены, ничего не делаем
  if (listenersInstalled) return;
  // Устанавливаем флаг, что обработчики установлены
  listenersInstalled = true;

  // Список событий, которые считаются активностью пользователя
  const events = ['mousemove', 'keydown', 'mousedown', 'scroll', 'touchstart'];
  // Для каждого события добавляем обработчик, который сбрасывает таймер бездействия
  events.forEach(e => window.addEventListener(e, resetIdleTimer));

  // Отслеживаем изменение видимости страницы (переключение вкладок)
  document.addEventListener('visibilitychange', () => {
    // Если страница стала видимой (пользователь вернулся)
    if (!document.hidden) {
      const idleTime = Date.now() - lastActivity;
      // Если время бездействия превышает лимит – блокируем сессию
      if (idleTime >= IDLE_TIMEOUT) {
        lockSession();
      }
    }
  });
 }

/* ========== ИНИЦИАЛИЗАЦИЯ СЕССИИ ========== */

// Основная функция инициализации сессии (вызывается после успешного входа или при загрузке страницы)
export async function initSession() {
  // Останавливаем все активные таймеры (на случай повторной инициализации)
  stopIdleWatch();
  stopPing();
  // Сбрасываем флаг блокировки
  sessionLocked = false;

  try {
    // Запрашиваем информацию о текущем пользователе
    const res = await fetch('/auth/me', { credentials: 'include' });
    // Если ответ не успешный (код не 2xx), генерируем исключение
    if (!res.ok) throw res;

    // Парсим JSON-ответ
    const data = await res.json();
    // Устанавливаем CSRF-токен из ответа
    setCsrfToken(data.csrf);
    // Устанавливаем данные пользователя (имя, роль, CSRF)
    setCurrentUser({ username: data.username, role: data.role, csrf: data.csrf });
    showLogoutButton();

    if (data.idleTimeout && typeof data.idleTimeout === 'number') {
      IDLE_TIMEOUT = data.idleTimeout;
    }

    // Применяем права доступа к интерфейсу на основе роли пользователя
    applyPermissions(data.role);
    // Устанавливаем обработчики событий активности
    setupActivityListeners();
    // Сбрасываем счётчик последней активности
    resetIdleTimer();
    // Запускаем мониторинг бездействия
    startIdleWatch();
    // Запускаем периодическую проверку сессии
    startPing();
    // Закрываем модальное окно входа (если оно было открыто)
    closeLoginModal();
    // Показываем основное приложение
    showApp();
  } catch (err) {
    // Обработка ошибок при инициализации
    // Если ошибка связана с авторизацией (401 или 403)
    if (err.status === 401 || err.status === 403) {
      clearIntervals();           // останавливаем все интервалы обновления данных
      stopConfigPolling();        // останавливаем опрос конфигурации
      lockSession();
      // Очищаем данные пользователя
      setCurrentUser(null);
      setCsrfToken(null);
      // Скрываем приложение
      hideApp();
      // Открываем окно входа
      openLoginModal();
    } else {
      // Другие ошибки (например, сетевые) выводим в консоль
      console.error('Ошибка при инициализации сессии:', err);
    }
  }
}
