import {
    config,
    allSensors,
    currentSensor,
    setCurrentSensor,
    PERMISSIONS,
    csrfToken
} from '../constants.js';
import { getAlertClass, pickHigherAlertClass } from '../utils/alert.js';
import { hasPermission } from '../utils/permissions.js';
import { updateRedAlert } from './redAlert.js';
import { openEditModal, onAddSensorClick } from './editModal.js';
import { drawCurrent } from '../charts.js';

// ==================== ЕСТЕСТВЕННАЯ СОРТИРОВКА ====================
function naturalCompare(a, b) {
    const re = /(\d+|\D+)/g;
    const aParts = String(a).match(re) || [];
    const bParts = String(b).match(re) || [];
    const len = Math.min(aParts.length, bParts.length);
    for (let i = 0; i < len; i++) {
        const aPart = aParts[i];
        const bPart = bParts[i];
        const aNum = parseInt(aPart, 10);
        const bNum = parseInt(bPart, 10);
        if (!isNaN(aNum) && !isNaN(bNum)) {
            if (aNum !== bNum) return aNum - bNum;
        } else {
            const cmp = aPart.localeCompare(bPart, undefined, { sensitivity: 'base' });
            if (cmp !== 0) return cmp;
        }
    }
    return aParts.length - bParts.length;
}

// ==================== ПАНЕЛЬ ДАТЧИКОВ (СПИСОК СПРАВА) ====================
/** Хранилище предыдущих классов тревоги для каждой переменной (ключ "sensorId:varName") */
const previousVarAlertState = new Map();

/** Отправка тревоги на сервер */
async function sendAlert(sensorId, varName, value) {
    if (!csrfToken) return;
    // Собираем snapshot всех переменных этого датчика из конфигурации
    const snapshot = {};
    const sensorCfg = config.sensors.find(s => String(s.id) === String(sensorId));
    if (sensorCfg && Array.isArray(sensorCfg.vars)) {
        for (const v of sensorCfg.vars) {
            const values = allSensors[`${sensorId}:${v}`]?.values;
            snapshot[v] = values && values.length > 0 ? values[values.length - 1] : null;
        }
    }
    const snapshotBase64 = btoa(JSON.stringify(snapshot));
    try {
        const response = await fetch('/api/alert', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({
                sensorId,
                varName,
                value,
                snapshotBase64
            }),
            credentials: 'include'
        });
        if (!response.ok) {
            console.error('Ошибка отправки тревоги, статус:', response.status);
        }
    } catch (e) {
        console.error('Ошибка отправки тревоги:', e);
    }
}

/** Выбор датчика по его ID */
export function selectSensor(id) {
    setCurrentSensor(id);
    updateSensorPanel();
    drawCurrent();
}

/** Управление кнопками в нижней части панели (добавление, экспорт, управление) */
export function updateAddButtonVisibility() {
    const footer = document.getElementById('sensorPanelFooter');
    if (!footer) return;

    const canEdit = hasPermission(PERMISSIONS.EDIT_CONFIG);
    const canView = hasPermission(PERMISSIONS.VIEW_DATA);
    const canManage = hasPermission(PERMISSIONS.MANAGE_SENSORS);
    const canManageUsers = hasPermission(PERMISSIONS.MANAGE_USERS);
    const canViewDiagnostic = hasPermission(PERMISSIONS.VIEW_DIAGNOSTIC);

    let addBtn = document.getElementById('addSensorBtn');
    let exportBtn = document.getElementById('exportDataBtn');

    if (canView) {
        if (!exportBtn) {
            exportBtn = document.createElement('button');
            exportBtn.id = 'exportDataBtn';
            exportBtn.className = 'btn btn-full';
            exportBtn.innerHTML = '📤 Экспорт';
            exportBtn.addEventListener('click', () => {
                import('./export.js').then(m => m.openExportModal());
            });
            footer.appendChild(exportBtn);
        }
    } else {
        if (exportBtn) exportBtn.remove();
    }

    if (canEdit) {
        if (!addBtn) {
            addBtn = document.createElement('button');
            addBtn.id = 'addSensorBtn';
            addBtn.className = 'btn btn-full';
            addBtn.innerHTML = '➕ Добавить датчик';
            addBtn.addEventListener('click', onAddSensorClick);
            footer.appendChild(addBtn);
        }
    } else {
        if (addBtn) addBtn.remove();
    }

    if (canManage) {
        let manageBtn = document.getElementById('manageSensorsBtn');
        if (!manageBtn) {
            manageBtn = document.createElement('button');
            manageBtn.id = 'manageSensorsBtn';
            manageBtn.className = 'btn btn-full';
            manageBtn.innerHTML = '⚙️ Регистрация датчиков';
            manageBtn.addEventListener('click', () => {
                import('./sensorManager.js').then(m => m.openSensorManager());
            });
            footer.appendChild(manageBtn);
        }
    } else {
        const oldBtn = document.getElementById('manageSensorsBtn');
        if (oldBtn) oldBtn.remove();
    }

    if (canManageUsers) {
        let manageUsersBtn = document.getElementById('manageUsersBtn');
        if (!manageUsersBtn) {
            manageUsersBtn = document.createElement('button');
            manageUsersBtn.id = 'manageUsersBtn';
            manageUsersBtn.className = 'btn btn-full';
            manageUsersBtn.innerHTML = '👥 Управление пользователями';
            manageUsersBtn.addEventListener('click', () => {
                import('./sensorManager.js').then(m => m.openUserManager());
            });
            footer.appendChild(manageUsersBtn);
        }
    } else {
        const oldBtn = document.getElementById('manageUsersBtn');
        if (oldBtn) oldBtn.remove();
    }

    if (canManage) {
        let diagBtn = document.getElementById('diagBtn');
        if (!diagBtn) {
            diagBtn = document.createElement('button');
            diagBtn.id = 'diagBtn';
            diagBtn.className = 'btn btn-full';
            diagBtn.innerHTML = '📊 Диагностика Систем';
            diagBtn.addEventListener('click', () => {
                import('./diagnostic.js').then(m => m.openDiagnosticModal());
            });
            footer.appendChild(diagBtn);
        }
    } else {
        const oldBtn = document.getElementById('diagBtn');
        if (oldBtn) oldBtn.remove();
    }
}

/** Обновление панели датчиков (список элементов) */
export function updateSensorPanel(forceRebuild = false) {
    const list = document.getElementById('sensorList');
    if (!list) return;

    const visibleSensors = config.sensors.filter(s => !s.deleted);

    if (visibleSensors.length === 0) {
        list.innerHTML = '';
        const li = document.createElement('li');
        li.textContent = 'Нет настроенных датчиков';
        li.style.color = '#777';
        list.appendChild(li);
        setCurrentSensor(null);
        const chartsContainer = document.getElementById('chartsContainer');
        if (chartsContainer) chartsContainer.innerHTML = '';
        return;
    }

    // Полная перестройка списка с сортировкой
    list.innerHTML = '';
    let redAlertSensors = [];

    // Сортировка датчиков по имени (или ID, если имени нет) с естественным порядком
    const sortedSensors = [...visibleSensors].sort((a, b) => {
        const nameA = a.name || a.id;
        const nameB = b.name || b.id;
        return naturalCompare(nameA, nameB);
    });

    sortedSensors.forEach((sCfg) => {
        let sensorAlertClass = null;
        const varSettings = Array.isArray(sCfg.varSettings) ? sCfg.varSettings : [];
        const vars = Array.isArray(sCfg.vars)
            ? sCfg.vars.map(v => String(v).trim()).filter(Boolean)
            : String(sCfg.vars || '').split(',').map(v => v.trim()).filter(Boolean);

        for (const v of vars) {
            const sData = allSensors[v] || allSensors[`${sCfg.id}:${v}`] || allSensors[`${sCfg.id}:${v.toLowerCase()}`];
            if (sData && Array.isArray(sData.values) && sData.values.length > 0) {
                const lastVal = sData.values[sData.values.length - 1];
                const vs = varSettings.find(x => x.var === v) || {};
                const varAlert = getAlertClass(vs, lastVal);
                const key = `${sCfg.id}:${v}`;
                const prevAlert = previousVarAlertState.get(key);
                if (varAlert === 'blink-red' && prevAlert !== 'blink-red') {
                    sendAlert(sCfg.id, v, lastVal);
                }
                previousVarAlertState.set(key, varAlert);
                sensorAlertClass = pickHigherAlertClass(sensorAlertClass, varAlert);
            }
        }

        if (sensorAlertClass === 'blink-red') {
            redAlertSensors.push(sCfg.name || sCfg.id);
        }

        const li = document.createElement('li');
        li.dataset.sensorId = sCfg.id;
        li.style.cssText = 'cursor: pointer; padding: 4px 4px; border-bottom: 1px solid #eee; display: flex; align-items: center; gap: 4px;';

        const hasReference = (Array.isArray(sCfg.vars) && sCfg.vars.some(v => v.includes('_'))) ||
            (typeof sCfg.vars === 'string' && sCfg.vars.includes('_'));

        const canEdit = hasPermission(PERMISSIONS.EDIT_CONFIG);
        if (canEdit) {
            const editBtn = document.createElement('button');
            editBtn.textContent = '✏️';
            editBtn.style.cssText = 'border: none; background: transparent; cursor: pointer;';
            editBtn.title = 'Редактировать датчик';
            editBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                openEditModal(sCfg.id);
            });
            li.appendChild(editBtn);
        }
        if (hasReference) {
            const refIcon = document.createElement('span');
            refIcon.className = 'sensor-ref-icon';
            refIcon.textContent = '🔗';
            refIcon.title = 'Импортирует данные других датчиков';
            li.appendChild(refIcon);
        }

        const nameSpan = document.createElement('span');
        nameSpan.className = 'sensor-name';
        nameSpan.textContent = sCfg.name || sCfg.id;
        nameSpan.style.flex = '1 1 auto';
        li.appendChild(nameSpan);

        li.addEventListener('click', () => selectSensor(sCfg.id));

        if (String(sCfg.id) === String(currentSensor)) {
            li.classList.add('sensor-selected');
        }

        li.classList.remove('blink-blue', 'blink-yellow', 'blink-red');
        if (sensorAlertClass) li.classList.add(sensorAlertClass);

        list.appendChild(li);
    });

    updateRedAlert(redAlertSensors);
}