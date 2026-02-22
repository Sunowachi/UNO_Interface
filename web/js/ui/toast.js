// ==================== УВЕДОМЛЕНИЯ (TOAST) ====================

let toastTimer = null;

/** Показать всплывающее уведомление */
export function showToast(message) {
    let toast = document.getElementById('toastMessage');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toastMessage';
        toast.className = 'toast';
        document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.classList.add('toast-show');

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.remove('toast-show');
    }, 2500);
}
