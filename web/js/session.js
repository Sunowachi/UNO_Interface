console.log('sessions.js загружен');

import { openLoginModal, hideApp, showApp, closeLoginModal } from './ui.js';
import {
  setCurrentUser,
  currentUser,
  setCsrfToken,
  csrfToken
} from './constants.js';
import { applyPermissions } from './ui.js';

const IDLE_TIMEOUT = 1 * 60 * 1000; // 1 минута
let idleTimer = null;
let lastActivity = Date.now();
let pingTimer = null;
let listenersInstalled = false;
let sessionLocked = false;

function resetIdleTimer() {
  lastActivity = Date.now();
}

function startIdleWatch() {
  stopIdleWatch();

  idleTimer = setInterval(() => {
    const idleTime = Date.now() - lastActivity;
    if (idleTime >= IDLE_TIMEOUT) {
      lockSession();
    }
  }, 1000);
}

function stopIdleWatch() {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
}

async function lockSession() {
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

      if (res.status === 401 || res.status === 403) {
        lockSession();
      }

    } catch {

    }
  }, 30_000);
}

export function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function setupActivityListeners() {

  if (listenersInstalled) return;
    listenersInstalled = true;

  const events = ['mousemove', 'keydown', 'mousedown', 'scroll', 'touchstart'];

  events.forEach(e =>
    window.addEventListener(e, () => {
      resetIdleTimer();
    })
  );

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      resetIdleTimer();
    }
  });
}

export async function initSession() {

  stopIdleWatch();
  stopPing();

  try {
    const res = await fetch('/auth/me', {
      credentials: 'include'
    });

    if (!res.ok) throw new Error();

    const data = await res.json();

    setCsrfToken(data.csrf);

    setCurrentUser({
      username: data.username,
      role: data.role,
      csrf: data.csrf
    });

    applyPermissions(data.role);
    resetIdleTimer();
    setupActivityListeners();
    startIdleWatch();
    startPing();

    const { init } = await import('./api.js');
    init();

    closeLoginModal();
    showApp();

  } catch {
    setCurrentUser(null);
    hideApp();
    openLoginModal();
  }
}