import { currentUser, ROLE_PERMISSIONS, PERMISSIONS } from '../constants.js';
import { updateAddButtonVisibility } from '../ui/sensorPanel.js';

// Проверка наличия разрешения у текущего пользователя
export function hasPermission(permission) {
  // Если permission не передано или у текущего пользователя нет роли, возвращаем false
  if (!permission || !currentUser?.role) return false;
  // Получаем набор прав для роли пользователя
  const perms = ROLE_PERMISSIONS[currentUser.role];
  // Если для роли нет прав, возвращаем false
  if (!perms) return false;
  // Если у пользователя есть полные права разработчика (DEV_ALL), разрешаем всё
  if (perms.has(PERMISSIONS.DEV_ALL)) return true;
  // Иначе проверяем наличие конкретного разрешения
  return perms.has(permission);
}

// Применить права доступа к интерфейсу в зависимости от роли пользователя
export function applyPermissions(role) {
  // Получаем набор прав для данной роли (если роль не найдена - пустой Set)
  const perms = ROLE_PERMISSIONS[role] || new Set();
  // Проверяем, есть ли у пользователя полные права разработчика (DEV_ALL)
  const isDev = perms.has(PERMISSIONS.DEV_ALL);

  // Находим панель списка датчиков (sensorPanel)
  const sensorPanel = document.getElementById('sensorPanel');
  if (sensorPanel) {
    // Скрываем панель, если у пользователя нет прав на просмотр данных (VIEW_DATA) и не разработчик
    sensorPanel.classList.toggle('hidden', !(isDev || perms.has(PERMISSIONS.VIEW_DATA)));
  }

  // Управление кнопкой добавления датчика
  updateAddButtonVisibility();
}