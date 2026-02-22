import { currentUser, ROLE_PERMISSIONS, PERMISSIONS } from '../constants.js';
import { updateAddButtonVisibility } from '../ui/sensorPanel.js';

// ==================== ПРОВЕРКА ПРАВ ДОСТУПА ====================

/** Проверка наличия разрешения у текущего пользователя */
export function hasPermission(permission) {
    if (!permission || !currentUser?.role) return false;
    const perms = ROLE_PERMISSIONS[currentUser.role];
    if (!perms) return false;
    if (perms.has(PERMISSIONS.DEV_ALL)) return true;
    return perms.has(permission);
}

/** Применение прав доступа к интерфейсу в зависимости от роли пользователя */
export function applyPermissions(role) {
    const perms = ROLE_PERMISSIONS[role] || new Set();
    const isDev = perms.has(PERMISSIONS.DEV_ALL);

    const sensorPanel = document.getElementById('sensorPanel');
    if (sensorPanel) {
        sensorPanel.classList.toggle('hidden', !(isDev || perms.has(PERMISSIONS.VIEW_DATA)));
    }

    updateAddButtonVisibility();
}
