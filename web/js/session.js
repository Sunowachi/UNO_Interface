import { hideApp, showApp } from './ui/index.js';
import { applyPermissions } from './utils/permissions.js';
import { setCurrentUser, currentUser, setCsrfToken, csrfToken } from './constants.js';
import { clearIntervals } from './api.js';
import { stopConfigPolling } from './sensors/index.js';

// ==================== КОНФИГУРАЦИЯ ====================
let IDLE_TIMEOUT = 10 * 60 * 1000;          // Таймаут бездействия (мс), будет переопределён сервером
let idleTimer = null;                        // Таймер бездействия
let lastActivity = Date.now();                // Время последней активности
let pingTimer = null;                         // Таймер ping-запросов
let listenersInstalled = false;               // Флаг установки обработчиков активности
let sessionLocked = false;                     // Флаг блокировки сессии
let uiInitialized = false;                     // Флаг инициализации UI

/* ========== УПРАВЛЕНИЕ ТАЙМЕРАМИ БЕЗДЕЙСТВИЯ ========== */

/** Сброс таймера бездействия при активности */
function resetIdleTimer() {
    lastActivity = Date.now();
}

/** Запуск мониторинга бездействия */
function startIdleWatch() {
    stopIdleWatch();
    idleTimer = setInterval(() => {
        const idleTime = Date.now() - lastActivity;
        if (idleTime >= IDLE_TIMEOUT) lockSession();
    }, 1000);
}

/** Остановка мониторинга бездействия */
function stopIdleWatch() {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
}

/* ========== УПРАВЛЕНИЕ СЕССИЕЙ ========== */

/** Блокировка сессии при бездействии или ошибке аутентификации */
export async function lockSession() {
    if (sessionLocked) return;
    sessionLocked = true;

    clearIntervals();
    stopIdleWatch();
    stopPing();
    stopConfigPolling();

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
    hideLogoutButton();
    hideApp();

    openLoginModal();
    setTimeout(openLoginModal, 200);
}

// ==================== МОДАЛЬНОЕ ОКНО ВХОДА ====================

/** Открытие окна авторизации */
export function openLoginModal() {
    const modal = document.getElementById('loginModal');
    if (!modal) {
        setTimeout(openLoginModal, 100);
        return;
    }
    modal.style.display = 'flex';
    modal.style.visibility = 'visible';
    modal.style.opacity = '1';
    modal.style.zIndex = '10000';
    modal.classList.add('show');

    document.body.style.overflow = 'auto';

    const errorEl = document.getElementById('loginError');
    if (errorEl) errorEl.textContent = '';
}

/** Закрытие окна авторизации */
export function closeLoginModal() {
    const modal = document.getElementById('loginModal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('show');
    }
}

/* ========== КНОПКА ВЫХОДА ========== */

/** Показать кнопку выхода */
function showLogoutButton() {
    const btn = document.getElementById('logoutBtn');
    if (btn) btn.hidden = false;
}

/** Скрыть кнопку выхода */
function hideLogoutButton() {
    const btn = document.getElementById('logoutBtn');
    if (btn) btn.hidden = true;
}

/* ========== ПРОВЕРКА АКТИВНОСТИ СЕССИИ (PING) ========== */

/** Запуск периодической проверки сессии */
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

/** Остановка периодической проверки сессии */
export function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
}

/* ========== ОТСЛЕЖИВАНИЕ АКТИВНОСТИ ПОЛЬЗОВАТЕЛЯ ========== */

/** Установка обработчиков событий активности */
function setupActivityListeners() {
    if (listenersInstalled) return;
    listenersInstalled = true;

    const events = ['mousemove', 'keydown', 'mousedown', 'scroll', 'touchstart'];
    events.forEach(e => window.addEventListener(e, resetIdleTimer));

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            const idleTime = Date.now() - lastActivity;
            if (idleTime >= IDLE_TIMEOUT) {
                lockSession();
            }
        }
    });
}

/* ========== ИНИЦИАЛИЗАЦИЯ СЕССИИ ========== */

/** Основная функция инициализации сессии (проверка /auth/me) */
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
        showLogoutButton();

        if (data.idleTimeout && typeof data.idleTimeout === 'number') {
            IDLE_TIMEOUT = data.idleTimeout;
        }

        applyPermissions(data.role);
        setupActivityListeners();
        resetIdleTimer();
        startIdleWatch();
        startPing();
        closeLoginModal();
        showApp();
    } catch (err) {
        if (err.status === 401 || err.status === 403) {
            clearIntervals();
            stopConfigPolling();
            lockSession();
            setCurrentUser(null);
            setCsrfToken(null);
            hideApp();
            openLoginModal();
            throw new Error('Сессия недействительна');
        } else {
            console.error('Ошибка при инициализации сессии:', err);
            throw err;
        }
    }
}
