import { setCurrentUser, csrfToken } from '../constants.js';
import { hideApp } from './app.js';
import { initSession, lockSession } from '../session.js';
import { init } from '../api.js';

let loginModal = document.getElementById('loginModal');

// Функция для определения мобильного устройства
function isMobileDevice() {
    const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const isSmallScreen = window.innerWidth < 768;
    const hasHighDpr = window.devicePixelRatio > 1.5;
    return hasTouch && (isSmallScreen || hasHighDpr);
}

// Функция для отправки запроса с заголовком
async function loginWithMobileCheck(credentials) {
    const headers = {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
    };

    if (isMobileDevice()) {
        headers['X-Client-Mobile'] = 'true';
    }

    return fetch('/auth/login', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(credentials),
        credentials: 'include'
    });
}

export function openLoginModal() {
    if (loginModal) loginModal.classList.add('show');
    const errorEl = document.getElementById("loginError");
    if (errorEl) errorEl.textContent = '';
}

export function closeLoginModal() {
    if (loginModal) loginModal.classList.remove('show');
}

function showLoginError(message) {
    const errorEl = document.getElementById('loginError');
    if (errorEl) {
        errorEl.textContent = message;
        errorEl.style.color = '';
        errorEl.style.marginTop = '';
    } else {
        console.error('[login] loginError element not found, message:', message);
    }
}

export async function login(e) {
    e?.preventDefault();
    setCurrentUser(null);
    showLoginError('');

    const username = document.getElementById("loginUser").value.trim();
    const password = document.getElementById("loginPass").value;

    if (!username || !password) {
        showLoginError('Введите логин и пароль');
        return;
    }

    let response;
    try {
        // Используем функцию с проверкой мобильности
        response = await loginWithMobileCheck({ username, password });
    } catch (networkError) {
        console.error('Network error during login:', networkError);
        showLoginError('Сетевая ошибка. Проверьте соединение с сервером.');
        hideApp();
        openLoginModal();
        return;
    }

    // Получаем текст ответа
    let responseText;
    try {
        responseText = await response.text();
    } catch (e) {
        console.error('Failed to read response text:', e);
        showLoginError('Ошибка чтения ответа от сервера');
        hideApp();
        openLoginModal();
        return;
    }

    // Пытаемся распарсить JSON, если это возможно
    let data = {};
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
        try {
            data = JSON.parse(responseText);
        } catch (e) {
            console.warn('Response is not valid JSON despite content-type:', responseText);
        }
    }

    if (!response.ok) {
        hideApp();
        openLoginModal();

        let errorMessage = 'Ошибка сервера';
        if (response.status === 401 || response.status === 403) {
            if (data.error === 'blocked') {
                errorMessage = 'Слишком много попыток. Попробуйте позже.';
            } else {
                errorMessage = 'Неверный логин или пароль';
            }
        } else {
            const details = data.error || data.message || responseText;
            if (details && details !== '') {
                errorMessage = `Ошибка сервера (${response.status}): ${details}`;
            } else {
                errorMessage = `Ошибка сервера (${response.status})`;
            }
        }
        showLoginError(errorMessage);
        return;
    }

    // Успешный вход
    showLoginError('');
    closeLoginModal();

    try {
        await initSession();
        await init();
        window.location.reload();
    } catch (err) {
        console.error('Error during post-login initialization:', err);
        hideApp();
        openLoginModal();
        showLoginError('Ошибка инициализации приложения');
    }
}

export async function forceLogout() {
    try {
        await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {}
    lockSession();
    setCurrentUser(null);
    hideApp();
    openLoginModal();
}
