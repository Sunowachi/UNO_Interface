import { currentUser, csrfToken, PERMISSIONS } from '../constants.js';
import { hasPermission } from '../utils/permissions.js';
import { showToast } from './toast.js';
import { lockSession } from '../session.js';

// ==================== УПРАВЛЕНИЕ ДАТЧИКАМИ (АДМИНИСТРИРОВАНИЕ) ====================

let managerModal = null;
let sensorsData = [];
let refreshInterval = null;
let actionInProgress = false;
// Временное хранилище паролей для только что созданных пользователей
const tempPasswords = new Map();

/** Открыть модальное окно управления датчиками */
export async function openSensorManager() {
    if (!hasPermission(PERMISSIONS.MANAGE_SENSORS)) {
        showToast('Недостаточно прав');
        return;
    }
    managerModal = document.getElementById('sensorManagerModal');
    if (!managerModal) {
        console.error('Модальное окно управления датчиками не найдено');
        return;
    }
    await loadSensors();
    managerModal.classList.add('show');
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(() => {
        if (managerModal.classList.contains('show')) {
            loadSensors(true); // фоновая синхронизация
        }
    }, 3000);
}

/** Закрыть окно управления датчиками */
export function closeSensorManager() {
    if (managerModal) managerModal.classList.remove('show');
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
}

/** Загрузить список датчиков с сервера */
async function loadSensors(silent = false) {
    try {
        const url = '/admin/sensors?_=' + Date.now();
        const res = await fetch(url, {
            credentials: 'include',
            headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {}
        });
        if (res.status === 401 || res.status === 403) {
            lockSession();
            return;
        }
        if (!res.ok) throw new Error('Ошибка загрузки');
        const newData = await res.json();
        updateTableWithDiff(newData);
    } catch (e) {
        if (!silent) {
            console.error('Ошибка загрузки датчиков:', e);
            showToast('Не удалось загрузить список датчиков');
        }
    }
}

/** Сравнить старые и новые данные, обновить только изменившиеся строки */
function updateTableWithDiff(newData) {
    const oldMap = new Map(sensorsData.map(s => [s.sensorId, s]));
    const newMap = new Map(newData.map(s => [s.sensorId, s]));
    const tbody = document.getElementById('sensorManagerBody');
    if (!tbody) return;

    // Удалить строки, которых нет в новых данных
    for (const [sensorId, oldSensor] of oldMap) {
        if (!newMap.has(sensorId)) {
            const row = document.querySelector(`tr[data-sensor-id="${sensorId}"]`);
            if (row) row.remove();
        }
    }

    // Обновить или добавить строки
    newData.forEach(s => {
        const existingRow = document.querySelector(`tr[data-sensor-id="${s.sensorId}"]`);
        if (existingRow) {
            updateRowContent(existingRow, s, oldMap.get(s.sensorId));
        } else {
            tbody.appendChild(createRow(s));
        }
    });

    sensorsData = newData;
}

/** Обновить содержимое существующей строки */
function updateRowContent(row, newSensor, oldSensor) {
    if (newSensor.deleted) row.classList.add('deleted-sensor');
    else row.classList.remove('deleted-sensor');

    const tokenSpan = row.querySelector('.token-mask');
    if (tokenSpan) {
        if (newSensor.token) {
            tokenSpan.dataset.token = newSensor.token;
            tokenSpan.title = 'Наведите для показа токена';
            if (!tokenSpan.matches(':hover')) {
                tokenSpan.textContent = '••••••••••••••••';
            }
        } else {
            tokenSpan.textContent = '—';
            tokenSpan.dataset.token = '';
            tokenSpan.title = 'Токен не сохранён (старый датчик)';
        }
    }

    const cells = row.cells;
    if (cells.length >= 6) {
        cells[2].textContent = newSensor.createdAt ? new Date(newSensor.createdAt).toLocaleString() : '-';
        cells[3].textContent = newSensor.lastSeen ? new Date(newSensor.lastSeen).toLocaleString() : '-';
        cells[4].textContent = newSensor.registerIp || '-';
        cells[5].textContent = newSensor.deleted ? 'Удалён' : 'Активен';
    }

    if (cells.length >= 7) {
        const actionsCell = cells[6];
        const wasDeleted = oldSensor ? oldSensor.deleted : !newSensor.deleted;
        if (wasDeleted !== newSensor.deleted) {
            actionsCell.innerHTML = '';
            if (newSensor.deleted) {
                const restoreBtn = document.createElement('button');
                restoreBtn.textContent = 'Восстановить';
                restoreBtn.className = 'btn btn-small';
                restoreBtn.addEventListener('click', () => toggleDelete(newSensor.sensorId, false));
                actionsCell.appendChild(restoreBtn);

                const deletePermBtn = document.createElement('button');
                deletePermBtn.textContent = 'Удалить навсегда';
                deletePermBtn.className = 'btn btn-small btn-danger';
                deletePermBtn.addEventListener('click', () => permanentDelete(newSensor.sensorId));
                actionsCell.appendChild(deletePermBtn);
            } else {
                const deleteBtn = document.createElement('button');
                deleteBtn.textContent = 'Удалить';
                deleteBtn.className = 'btn btn-small btn-danger';
                deleteBtn.addEventListener('click', () => toggleDelete(newSensor.sensorId, true));
                actionsCell.appendChild(deleteBtn);
            }
        }
    }
}

/** Создать новую строку таблицы для датчика */
function createRow(s) {
    const row = document.createElement('tr');
    row.dataset.sensorId = s.sensorId;
    if (s.deleted) row.classList.add('deleted-sensor');

    const idCell = document.createElement('td');
    idCell.textContent = s.sensorId;
    row.appendChild(idCell);

    const tokenCell = document.createElement('td');
    tokenCell.className = 'token-cell';
    const tokenSpan = document.createElement('span');
    tokenSpan.className = 'token-mask';
    if (s.token) {
        tokenSpan.textContent = '••••••••••••••••';
        tokenSpan.dataset.token = s.token;
        tokenSpan.title = 'Наведите для показа токена';
    } else {
        tokenSpan.textContent = '—';
        tokenSpan.title = 'Токен не сохранён (старый датчик)';
    }
    tokenSpan.addEventListener('mouseenter', (e) => {
        const token = e.target.dataset.token;
        if (token) e.target.textContent = token;
    });
    tokenSpan.addEventListener('mouseleave', (e) => {
        e.target.textContent = s.token ? '••••••••••••••••' : '—';
    });
    tokenCell.appendChild(tokenSpan);
    row.appendChild(tokenCell);

    const createdCell = document.createElement('td');
    createdCell.textContent = s.createdAt ? new Date(s.createdAt).toLocaleString() : '-';
    row.appendChild(createdCell);

    const lastSeenCell = document.createElement('td');
    lastSeenCell.textContent = s.lastSeen ? new Date(s.lastSeen).toLocaleString() : '-';
    row.appendChild(lastSeenCell);

    const ipCell = document.createElement('td');
    ipCell.textContent = s.registerIp || '-';
    row.appendChild(ipCell);

    const statusCell = document.createElement('td');
    statusCell.textContent = s.deleted ? 'Удалён' : 'Активен';
    row.appendChild(statusCell);

    const actionsCell = document.createElement('td');
    if (s.deleted) {
        const restoreBtn = document.createElement('button');
        restoreBtn.textContent = 'Восстановить';
        restoreBtn.className = 'btn btn-small';
        restoreBtn.addEventListener('click', () => toggleDelete(s.sensorId, false));
        actionsCell.appendChild(restoreBtn);

        const deletePermBtn = document.createElement('button');
        deletePermBtn.textContent = 'Удалить навсегда';
        deletePermBtn.className = 'btn btn-small btn-danger';
        deletePermBtn.addEventListener('click', () => permanentDelete(s.sensorId));
        actionsCell.appendChild(deletePermBtn);
    } else {
        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = 'Удалить';
        deleteBtn.className = 'btn btn-small btn-danger';
        deleteBtn.addEventListener('click', () => toggleDelete(s.sensorId, true));
        actionsCell.appendChild(deleteBtn);
    }
    row.appendChild(actionsCell);
    return row;
}

/** Переключить флаг мягкого удаления датчика */
async function toggleDelete(sensorId, deleted) {
    if (actionInProgress) return;
    actionInProgress = true;
    try {
        const res = await fetch('/admin/sensor/toggle-delete', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({ sensorId, deleted: String(deleted) })
        });
        if (res.status === 401 || res.status === 403) {
            lockSession();
            return;
        }
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Ошибка ${res.status}: ${text}`);
        }
        showToast(deleted ? 'Датчик удалён' : 'Датчик восстановлен');

        const sensor = sensorsData.find(s => s.sensorId === sensorId);
        if (sensor) {
            sensor.deleted = deleted;
            const row = document.querySelector(`tr[data-sensor-id="${sensorId}"]`);
            if (row) {
                updateRowContent(row, sensor, { ...sensor, deleted: !deleted });
            }
        }
    } catch (e) {
        console.error('Ошибка операции toggleDelete:', e);
        showToast('Ошибка: ' + e.message);
        await loadSensors(false);
    } finally {
        actionInProgress = false;
    }
}

/** Полное удаление датчика из БД */
async function permanentDelete(sensorId) {
    if (actionInProgress) return;
    if (!confirm(`Вы уверены, что хотите навсегда удалить датчик ${sensorId}? Это действие необратимо.`)) return;
    actionInProgress = true;
    try {
        const res = await fetch('/admin/sensor/delete-permanent', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({ sensorId })
        });
        if (res.status === 401 || res.status === 403) {
            lockSession();
            return;
        }
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Ошибка ${res.status}: ${text}`);
        }
        showToast('Датчик удалён навсегда');

        const row = document.querySelector(`tr[data-sensor-id="${sensorId}"]`);
        if (row) row.remove();
        sensorsData = sensorsData.filter(s => s.sensorId !== sensorId);
    } catch (e) {
        console.error('Ошибка операции permanentDelete:', e);
        showToast('Ошибка: ' + e.message);
        await loadSensors(false);
    } finally {
        actionInProgress = false;
    }
}

/** Зарегистрировать новый датчик (администратором) */
async function registerNewSensor() {
    const input = document.getElementById('newSensorId');
    const sensorId = input.value.trim();
    if (!sensorId) {
        showToast('Введите ID датчика');
        return;
    }
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(sensorId)) {
        showToast('ID должен содержать только буквы, цифры, _ и -, длиной 3-64 символа');
        return;
    }
    if (actionInProgress) return;
    actionInProgress = true;
    try {
        const res = await fetch('/admin/sensor/register', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({ sensorId })
        });
        if (res.status === 401 || res.status === 403) {
            lockSession();
            return;
        }
        if (res.status === 409) {
            showToast('Датчик с таким ID уже существует');
            return;
        }
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Ошибка ${res.status}: ${text}`);
        }
        const data = await res.json();
        showToast(`✅ Датчик зарегистрирован!`);
        input.value = '';

        const newSensor = {
            sensorId,
            token: data.token,
            createdAt: Date.now(),
            lastSeen: Date.now(),
            registerIp: 'только что',
            deleted: false
        };
        sensorsData.push(newSensor);
        const tbody = document.getElementById('sensorManagerBody');
        if (tbody) tbody.appendChild(createRow(newSensor));
    } catch (e) {
        console.error('Ошибка регистрации:', e);
        showToast('Ошибка: ' + e.message);
        await loadSensors(false);
    } finally {
        actionInProgress = false;
    }
}

/** Инициализация обработчиков окна управления датчиками */
export function initSensorManager() {
    const registerBtn = document.getElementById('registerSensorBtn');
    if (registerBtn) registerBtn.addEventListener('click', registerNewSensor);

    const closeBtn = document.getElementById('closeManagerBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeSensorManager);

    const modal = document.getElementById('sensorManagerModal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeSensorManager();
        });
    }
}

// ==================== УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯМИ ====================

let userModal = null;
let usersData = [];
let userRefreshInterval = null;
let userActionInProgress = false;

/** Открыть модальное окно управления пользователями */
export async function openUserManager() {
    if (!hasPermission(PERMISSIONS.MANAGE_USERS)) {
        showToast('Недостаточно прав');
        return;
    }
    userModal = document.getElementById('userManagerModal');
    if (!userModal) {
        console.error('Модальное окно управления пользователями не найдено');
        return;
    }

    // Обновляем селект ролей в зависимости от роли текущего пользователя
    const roleSelect = document.getElementById('newUserRole');
    if (roleSelect && currentUser) {
        const selectedValue = roleSelect.value;
        roleSelect.innerHTML = '';

        const addOption = (value, text) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = text;
            roleSelect.appendChild(opt);
        };

        if (currentUser.role === 'developer') {
            addOption('observer', 'Наблюдатель');
            addOption('worker', 'Рабочий');
            addOption('admin', 'Администратор');
            addOption('developer', 'Разработчик');
        } else {
            addOption('observer', 'Наблюдатель');
            addOption('worker', 'Рабочий');
            addOption('admin', 'Администратор');
        }

        if ([...roleSelect.options].some(opt => opt.value === selectedValue)) {
            roleSelect.value = selectedValue;
        }
    }

    await loadUsers();
    userModal.classList.add('show');
    if (userRefreshInterval) clearInterval(userRefreshInterval);
    userRefreshInterval = setInterval(() => {
        if (userModal.classList.contains('show')) {
            loadUsers(true);
        }
    }, 3000);
}

/** Закрыть окно управления пользователями */
export function closeUserManager() {
    if (userModal) userModal.classList.remove('show');
    if (userRefreshInterval) {
        clearInterval(userRefreshInterval);
        userRefreshInterval = null;
    }
}

/** Загрузить список пользователей с сервера */
async function loadUsers(silent = false) {
    try {
        const url = '/admin/users?_=' + Date.now();
        const res = await fetch(url, {
            credentials: 'include',
            headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {}
        });
        if (res.status === 401 || res.status === 403) {
            lockSession();
            return;
        }
        if (!res.ok) throw new Error('Ошибка загрузки');
        const newData = await res.json();
        updateUserTable(newData);
    } catch (e) {
        if (!silent) {
            console.error('Ошибка загрузки пользователей:', e);
            showToast('Не удалось загрузить список пользователей');
        }
    }
}

/** Обновить таблицу пользователей */
function updateUserTable(newData) {
    const tbody = document.getElementById('userManagerBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    newData.forEach(u => {
        const password = tempPasswords.get(u.username) || null;
        tbody.appendChild(createUserRow(u, password));
    });
    usersData = newData;
}

/** Создать строку таблицы для пользователя */
function createUserRow(user, password) {
    const row = document.createElement('tr');
    row.dataset.username = user.username;

    const userCell = document.createElement('td');
    userCell.textContent = user.username;
    row.appendChild(userCell);

    const roleCell = document.createElement('td');
    roleCell.textContent = user.role;
    row.appendChild(roleCell);

    const passwordCell = document.createElement('td');
    passwordCell.className = 'token-cell';
    if (password) {
        const passSpan = document.createElement('span');
        passSpan.className = 'token-mask';
        passSpan.textContent = '••••••••••••••••';
        passSpan.dataset.token = password;
        passSpan.title = 'Наведите для показа пароля';
        passSpan.addEventListener('mouseenter', (e) => {
            e.target.textContent = e.target.dataset.token;
        });
        passSpan.addEventListener('mouseleave', (e) => {
            e.target.textContent = '••••••••••••••••';
        });
        passwordCell.appendChild(passSpan);
    } else {
        passwordCell.textContent = '—';
    }
    row.appendChild(passwordCell);

    const actionsCell = document.createElement('td');

    if (currentUser && currentUser.username === user.username) {
        const disabledSpan = document.createElement('span');
        disabledSpan.textContent = '—';
        disabledSpan.title = 'Нельзя удалить свой аккаунт';
        disabledSpan.style.opacity = '0.5';
        actionsCell.appendChild(disabledSpan);
    }
    else if (currentUser && currentUser.role !== 'developer' && user.role === 'developer') {
        const disabledSpan = document.createElement('span');
        disabledSpan.textContent = '—';
        disabledSpan.title = 'Нельзя удалить разработчика';
        disabledSpan.style.opacity = '0.5';
        actionsCell.appendChild(disabledSpan);
    } else {
        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = 'Удалить';
        deleteBtn.className = 'btn btn-small btn-danger';
        deleteBtn.addEventListener('click', () => deleteUser(user.username));
        actionsCell.appendChild(deleteBtn);
    }
    row.appendChild(actionsCell);

    return row;
}

/** Создать нового пользователя */
async function createUser() {
    if (userActionInProgress) return;
    const usernameInput = document.getElementById('newUsername');
    const roleSelect = document.getElementById('newUserRole');
    const username = usernameInput.value.trim();
    const role = roleSelect.value;

    if (!username) {
        showToast('Введите логин');
        return;
    }
    if (!/^[a-zA-Z0-9_]{3,64}$/.test(username)) {
        showToast('Логин должен содержать только буквы, цифры и _, длиной 3-64 символа');
        return;
    }

    userActionInProgress = true;
    try {
        const res = await fetch('/admin/user/create', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({ username, role })
        });
        if (res.status === 401 || res.status === 403) {
            lockSession();
            return;
        }
        if (res.status === 409) {
            showToast('Пользователь с таким логином уже существует');
            return;
        }
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Ошибка ${res.status}: ${text}`);
        }
        const data = await res.json();
        tempPasswords.set(data.username, data.password);
        showToast(`✅ Пользователь ${data.username} создан. Пароль отображается в таблице (сохраните его, он исчезнет после перезагрузки)`);
        usernameInput.value = '';
        await loadUsers();
    } catch (e) {
        console.error('Ошибка создания пользователя:', e);
        showToast('Ошибка: ' + e.message);
    } finally {
        userActionInProgress = false;
    }
}

/** Удалить пользователя */
async function deleteUser(username) {
    if (userActionInProgress) return;
    if (!confirm(`Вы уверены, что хотите удалить пользователя ${username}?`)) return;

    userActionInProgress = true;
    try {
        const res = await fetch('/admin/user/delete', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({ username })
        });
        if (res.status === 401 || res.status === 403) {
            lockSession();
            return;
        }
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Ошибка ${res.status}: ${text}`);
        }
        showToast('Пользователь удалён');
        await loadUsers();
    } catch (e) {
        console.error('Ошибка удаления пользователя:', e);
        showToast('Ошибка: ' + e.message);
    } finally {
        userActionInProgress = false;
    }
}

/** Инициализация обработчиков окна управления пользователями */
export function initUserManager() {
    const controls = document.getElementById('userManagerControls');
    if (controls) {
        if (!document.getElementById('newUsername')) {
            const usernameInput = document.createElement('input');
            usernameInput.type = 'text';
            usernameInput.id = 'newUsername';
            usernameInput.className = 'input-full';
            usernameInput.placeholder = 'Логин';
            usernameInput.setAttribute('autocomplete', 'off');
            controls.insertBefore(usernameInput, controls.firstChild);
        }
    }

    const createBtn = document.getElementById('createUserBtn');
    if (createBtn) createBtn.addEventListener('click', createUser);

    const closeBtn = document.getElementById('closeUserManagerBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeUserManager);

    const modal = document.getElementById('userManagerModal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeUserManager();
        });
    }
}
