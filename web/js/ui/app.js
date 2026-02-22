import { currentUser } from '../constants.js';

// ==================== УПРАВЛЕНИЕ ОТОБРАЖЕНИЕМ ОСНОВНОГО ПРИЛОЖЕНИЯ ====================

/** Показать основное приложение (после успешной авторизации) */
export function showApp() {
    if (!currentUser) return;
    const app = document.getElementById('appRoot');
    if (app) app.hidden = false;
}

/** Скрыть основное приложение (при выходе или отсутствии сессии) */
export function hideApp() {
    const app = document.getElementById('appRoot');
    if (app) {
        app.hidden = true;
        // Скрываем все модальные окна, чтобы они не перекрывали окно входа
        document.querySelectorAll('.modal-backdrop.show').forEach(modal => {
            modal.classList.remove('show');
        });
    }
}
