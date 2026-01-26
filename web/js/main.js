console.log('main.js загружен');

import { initSession } from './session.js';
import { init } from './api.js';
import {
  setupButtonHandlers,
  setupTimeRangeControls,
  hideApp,
  openLoginModal
} from './ui.js';

document.addEventListener('DOMContentLoaded', async () => {
  hideApp();
  setupButtonHandlers();
  setupTimeRangeControls();

  await initSession();
  await init();
});