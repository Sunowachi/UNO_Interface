import { openLoginModal, hideApp, showApp, closeLoginModal, applyPermissions } from './ui.js';
import { setCurrentUser, currentUser, setCsrfToken, csrfToken } from './constants.js';
import { clearIntervals } from './api.js';

// Настройки таймеров
const IDLE_TIMEOUT = 10 * 60 * 1000; // 10 минут
let idleTimer = null;
let lastActivity = Date.now();
let pingTimer = null;
let listenersInstalled = false;
let sessionLocked = false;
let uiInitialized = false;

/* ========== УПРАВЛЕНИЕ ТАЙМЕРАМИ БЕЗДЕЙСТВИЯ ========== */

// Сброс таймера бездействия при активности пользователя
function resetIdleTimer() {
  lastActivity = Date.now();
}

// Запуск мониторинга бездействия
function startIdleWatch() {
  stopIdleWatch();
  idleTimer = setInterval(() => {
    const idleTime = Date.now() - lastActivity;
    if (idleTime >= IDLE_TIMEOUT) lockSession();
  }, 1000);
}

// Остановка мониторинга бездействия
function stopIdleWatch() {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
}

/* ========== УПРАВЛЕНИЕ СЕССИЕЙ ========== */

// Блокировка сессии при бездействии или ошибке аутентификации
export async function lockSession() {
  if (sessionLocked) return;
  sessionLocked = true;

  clearIntervals();
  stopIdleWatch();
  stopPing();

  try {
    await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {}
    });
  } catch {}

  uiInitialized = false;
  listenersInstalled = false;
  setCurrentUser(null);
  setCsrfToken(null);
  hideApp();
  openLoginModal();
}

/* ========== ПРОВЕРКА АКТИВНОСТИ СЕССИИ ========== */

// Периодическая проверка валидности сессии
export function startPing() {
  stopPing();
  pingTimer = setInterval(async () => {
    if (sessionLocked || !csrfToken) return;

    try {
      const res = await fetch('/auth/ping', {
        method: 'POST',
        credentials: 'include',
        headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {}
      });

      if (res.status === 401 || res.status === 403) {
        console.warn('[ping] Сессия недействительна, блокируем');
        lockSession();
      }
    } catch (e) {
      console.debug('[ping] Ошибка сети:', e);
    }
  }, 30_000);
}

// Остановка проверки сессии
export function stopPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

/* ========== ОТСЛЕЖИВАНИЕ АКТИВНОСТИ ПОЛЬЗОВАТЕЛЯ ========== */

// Установка обработчиков событий активности пользователя
function setupActivityListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;

  const events = ['mousemove', 'keydown', 'mousedown', 'scroll', 'touchstart'];
  events.forEach(e => window.addEventListener(e, resetIdleTimer));

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resetIdleTimer();
  });
}

/* ========== ИНИЦИАЛИЗАЦИЯ СЕССИИ ========== */

// Основная функция инициализации сессии
export async function initSession() {
  stopIdleWatch();
  stopPing();
  sessionLocked = false;

  try {
    const res = await fetch('/auth/me', { credentials: 'include' });
    if (!res.ok) throw res;

    const data = await res.json();
    setCsrfToken(data.csrf);
    setCurrentUser({ username: data.username, role: data.role, csrf: data.csrf });

    applyPermissions(data.role);
    setupActivityListeners();
    resetIdleTimer();
    startIdleWatch();
    startPing();

    closeLoginModal();
    showApp();
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      sessionLocked = false;
      setCurrentUser(null);
      setCsrfToken(null);
      hideApp();
      openLoginModal();
    } else {
      console.error('Ошибка при инициализации сессии:', err);
    }
  }
}