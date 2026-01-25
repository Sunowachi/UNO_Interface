console.log('sessions.js загружен');

import { openLoginModal, hideApp, showApp, closeLoginModal, applyPermissions } from './ui.js';
import {
  setCurrentUser,
  currentUser,
  setCsrfToken,
  csrfToken
} from './constants.js';
import { clearIntervals } from './api.js';

const IDLE_TIMEOUT = 10 * 60 * 1000; // 10 минут
let idleTimer = null;
let lastActivity = Date.now();
let pingTimer = null;
let listenersInstalled = false;
let sessionLocked = false;
let uiInitialized = false;

function resetIdleTimer() {
  lastActivity = Date.now();
}

function startIdleWatch() {
  stopIdleWatch();
  idleTimer = setInterval(() => {
    const idleTime = Date.now() - lastActivity;
    if (idleTime >= IDLE_TIMEOUT) lockSession();
  }, 1000);
}

function stopIdleWatch() {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
}

export async function lockSession() {

  clearIntervals();

  if (sessionLocked) return;
  sessionLocked = true;

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
  hideApp();
  openLoginModal();
}

export function startPing() {
  stopPing();
  pingTimer = setInterval(async () => {
    try {
      const res = await fetch('/auth/ping', {
        method: 'POST',
        credentials: 'include',
        headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {}
      });
      if (res.status === 401 || res.status === 403) lockSession();
    } catch {}
  }, 30_000);
}

export function stopPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

function setupActivityListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;

  const events = ['mousemove', 'keydown', 'mousedown', 'scroll', 'touchstart'];
  events.forEach(e => window.addEventListener(e, resetIdleTimer));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resetIdleTimer();
  });
}

export async function initSession() {
  stopIdleWatch();
  stopPing();

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
          setCurrentUser(null);
          hideApp();
          openLoginModal();
      } else {
          console.error('Ошибка при инициализации сессии:', err);
      }
  }
}