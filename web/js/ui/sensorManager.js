import { csrfToken, PERMISSIONS } from '../constants.js';
import { hasPermission } from '../utils/permissions.js';
import { showToast } from './toast.js';
import { lockSession } from '../session.js';

let managerModal = null;
let sensorsData = [];
let refreshInterval = null;
let actionInProgress = false;

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

export function closeSensorManager() {
    if (managerModal) managerModal.classList.remove('show');
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
}

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

// Сравнивает старые и новые данные, обновляет только изменившиеся строки
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

// Обновляет содержимое строки без пересоздания кнопок, если возможно
function updateRowContent(row, newSensor, oldSensor) {
    // Обновить класс удаления
    if (newSensor.deleted) row.classList.add('deleted-sensor');
    else row.classList.remove('deleted-sensor');

    // Токен
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

    // Ячейки с датами, IP, статусом (индексы ячеек: 2-5)
    const cells = row.cells;
    if (cells.length >= 6) {
        // Дата создания (индекс 2)
        cells[2].textContent = newSensor.createdAt ? new Date(newSensor.createdAt).toLocaleString() : '-';
        // Последняя активность (3)
        cells[3].textContent = newSensor.lastSeen ? new Date(newSensor.lastSeen).toLocaleString() : '-';
        // IP (4)
        cells[4].textContent = newSensor.registerIp || '-';
        // Статус (5)
        cells[5].textContent = newSensor.deleted ? 'Удалён' : 'Активен';
    }

    // Ячейка действий (индекс 6) – обновляем кнопки только если изменился статус deleted
    if (cells.length >= 7) {
        const actionsCell = cells[6];
        const wasDeleted = oldSensor ? oldSensor.deleted : !newSensor.deleted;
        if (wasDeleted !== newSensor.deleted) {
            // Полностью пересоздаём кнопки
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

function createRow(s) {
    const row = document.createElement('tr');
    row.dataset.sensorId = s.sensorId;
    if (s.deleted) row.classList.add('deleted-sensor');

    // ID
    const idCell = document.createElement('td');
    idCell.textContent = s.sensorId;
    row.appendChild(idCell);

    // Токен
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

    // Дата создания
    const createdCell = document.createElement('td');
    createdCell.textContent = s.createdAt ? new Date(s.createdAt).toLocaleString() : '-';
    row.appendChild(createdCell);

    // Последняя активность
    const lastSeenCell = document.createElement('td');
    lastSeenCell.textContent = s.lastSeen ? new Date(s.lastSeen).toLocaleString() : '-';
    row.appendChild(lastSeenCell);

    // IP регистрации
    const ipCell = document.createElement('td');
    ipCell.textContent = s.registerIp || '-';
    row.appendChild(ipCell);

    // Статус
    const statusCell = document.createElement('td');
    statusCell.textContent = s.deleted ? 'Удалён' : 'Активен';
    row.appendChild(statusCell);

    // Действия
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

        // Немедленное локальное обновление
        const sensor = sensorsData.find(s => s.sensorId === sensorId);
        if (sensor) {
            sensor.deleted = deleted;
            const row = document.querySelector(`tr[data-sensor-id="${sensorId}"]`);
            if (row) {
                // Обновляем только класс и текст статуса, ячейку действий (пересоздадим кнопки)
                updateRowContent(row, sensor, { ...sensor, deleted: !deleted });
            }
        }
        // Не вызываем loadSensors сразу – полагаемся на периодический опрос
    } catch (e) {
        console.error('Ошибка операции toggleDelete:', e);
        showToast('Ошибка: ' + e.message);
        // При ошибке загружаем свежие данные с сервера
        await loadSensors(false);
    } finally {
        actionInProgress = false;
    }
}

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

        // Удаляем строку из DOM и из массива
        const row = document.querySelector(`tr[data-sensor-id="${sensorId}"]`);
        if (row) row.remove();
        sensorsData = sensorsData.filter(s => s.sensorId !== sensorId);
        // Не вызываем loadSensors
    } catch (e) {
        console.error('Ошибка операции permanentDelete:', e);
        showToast('Ошибка: ' + e.message);
        await loadSensors(false);
    } finally {
        actionInProgress = false;
    }
}

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
        showToast(`✅ Датчик зарегистрирован! Токен: ${data.token}`);
        input.value = '';

        // Добавляем новую строку
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
        // Не вызываем loadSensors
    } catch (e) {
        console.error('Ошибка регистрации:', e);
        showToast('Ошибка: ' + e.message);
        await loadSensors(false);
    } finally {
        actionInProgress = false;
    }
}

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
