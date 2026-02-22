import { showToast } from './toast.js';
import { hasPermission } from '../utils/permissions.js';
import { PERMISSIONS, allSensors, config } from '../constants.js';
import { lockSession } from '../session.js';

// ==================== ИНИЦИАЛИЗАЦИЯ МОДАЛЬНОГО ОКНА ЭКСПОРТА ====================

export function initExportModal() {
    const addBtn = document.getElementById('addExportVarRow');
    const cancelBtn = document.getElementById('cancelExportBtn');
    const downloadBtn = document.getElementById('downloadExportBtn');
    const populateBtn = document.getElementById('populateFromDevicesBtn');

    if (addBtn) {
        addBtn.addEventListener('click', addVariableRow);
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', closeExportModal);
    }

    if (downloadBtn) {
        downloadBtn.addEventListener('click', handleDownload);
    }

    if (populateBtn) {
        populateBtn.addEventListener('click', showSelectionDialog);
    }

    const cancelSelectorBtn = document.getElementById('cancelSelectorBtn');
    const addSelectedBtn = document.getElementById('addSelectedBtn');

    if (cancelSelectorBtn) {
        cancelSelectorBtn.addEventListener('click', closeSelectorModal);
    }
    if (addSelectedBtn) {
        addSelectedBtn.addEventListener('click', addSelectedItems);
    }

    setDefaultDates();
}

// ==================== ВЫБОР ДАТЧИКОВ ИЗ СПИСКА ====================

/** Закрыть окно выбора */
function closeSelectorModal() {
    const selectorModal = document.getElementById('exportSelectorBackdrop');
    if (selectorModal) selectorModal.classList.remove('show');
}

/** Открыть окно выбора и заполнить список доступными парами датчик/переменная */
function showSelectionDialog() {
    const selectorModal = document.getElementById('exportSelectorBackdrop');
    const listContainer = document.getElementById('exportSelectorList');
    if (!selectorModal || !listContainer) return;

    // Собираем уникальные пары (sensorId, varName) из allSensors
    const pairs = [];
    for (const key of Object.keys(allSensors)) {
        const idx = key.indexOf(':');
        if (idx !== -1) {
            const sensorId = key.slice(0, idx);
            const varName = key.slice(idx + 1);
            pairs.push({ sensorId, varName });
        }
    }

    if (pairs.length === 0) {
        showToast('Нет активных устройств');
        return;
    }

    // Обогащаем пары отображаемыми именами из конфига
    const enriched = pairs.map(p => {
        const sensorCfg = config.sensors.find(s => String(s.id) === String(p.sensorId) && !s.deleted);
        const displaySensor = sensorCfg?.name || p.sensorId;
        let displayVar = p.varName;
        if (sensorCfg && Array.isArray(sensorCfg.varSettings)) {
            const varSetting = sensorCfg.varSettings.find(vs => vs.var === p.varName);
            if (varSetting && varSetting.label) {
                displayVar = varSetting.label;
            }
        }
        return {
            sensorId: p.sensorId,
            varName: p.varName,
            displaySensor,
            displayVar
        };
    });

    enriched.sort((a, b) => {
        if (a.displaySensor === b.displaySensor) {
            return a.displayVar.localeCompare(b.displayVar);
        }
        return a.displaySensor.localeCompare(b.displaySensor);
    });

    listContainer.innerHTML = '';
    enriched.forEach(item => {
        const div = document.createElement('div');
        div.className = 'selector-item';
        div.innerHTML = `
            <input type="checkbox" class="selector-checkbox" data-sensor="${item.sensorId}" data-var="${item.varName}">
            <label title="sensorId: ${item.sensorId}\nvarName: ${item.varName}">
                <span class="sensor-id">${item.displaySensor}</span>:
                <span class="var-name">${item.displayVar}</span>
            </label>
        `;
        div.addEventListener('click', (e) => {
            if (e.target.tagName !== 'INPUT') {
                const cb = div.querySelector('.selector-checkbox');
                cb.checked = !cb.checked;
            }
        });
        listContainer.appendChild(div);
    });

    selectorModal.classList.add('show');
}

/** Добавить выбранные элементы в основную таблицу */
function addSelectedItems() {
    const checkboxes = document.querySelectorAll('#exportSelectorList .selector-checkbox:checked');
    if (checkboxes.length === 0) {
        showToast('Ничего не выбрано');
        return;
    }

    const container = document.getElementById('exportVariablesContainer');
    if (!container) return;

    const existingPairs = new Set();
    document.querySelectorAll('#exportVariablesContainer .export-var-row').forEach(row => {
        const sensor = row.querySelector('.export-sensor-id').value.trim();
        const varName = row.querySelector('.export-var-name').value.trim();
        if (sensor && varName) {
            existingPairs.add(`${sensor}:${varName}`);
        }
    });

    checkboxes.forEach(cb => {
        const sensor = cb.dataset.sensor;
        const varName = cb.dataset.var;
        const key = `${sensor}:${varName}`;
        if (!existingPairs.has(key)) {
            addVariableRowWithValues(sensor, varName);
            existingPairs.add(key);
        }
    });

    closeSelectorModal();
    showToast(`Добавлено ${checkboxes.length} строк`);
}

// ==================== УПРАВЛЕНИЕ СТРОКАМИ ВВОДА ====================

/** Добавить строку с предзаполненными значениями */
function addVariableRowWithValues(sensorId, varName) {
    const container = document.getElementById('exportVariablesContainer');
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'export-var-row';
    row.innerHTML = `
        <input type="text" placeholder="ID датчика" class="export-sensor-id" value="${sensorId}" autocomplete="off">
        <input type="text" placeholder="Переменная" class="export-var-name" value="${varName}" autocomplete="off">
        <button class="btn btn-small remove-var-row" type="button">✖</button>
    `;
    container.appendChild(row);
    row.querySelector('.remove-var-row').addEventListener('click', () => row.remove());
}

/** Установить даты по умолчанию (текущее время и час назад) */
function setDefaultDates() {
    const fromInput = document.getElementById('exportFrom');
    const toInput = document.getElementById('exportTo');
    if (!fromInput || !toInput) {
        console.warn('[export] date inputs not found');
        return;
    }
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const format = (d) => d.toISOString().slice(0, 16);
    fromInput.value = format(oneHourAgo);
    toInput.value = format(now);
}

/** Добавить пустую строку для нового датчика/переменной */
function addVariableRow() {
    const container = document.getElementById('exportVariablesContainer');
    if (!container) {
        console.error('[export] variables container not found');
        return;
    }
    const row = document.createElement('div');
    row.className = 'export-var-row';
    row.innerHTML = `
        <input type="text" placeholder="ID датчика" class="export-sensor-id" autocomplete="off">
        <input type="text" placeholder="Переменная" class="export-var-name" autocomplete="off">
        <button class="btn btn-small remove-var-row" type="button">✖</button>
    `;
    container.appendChild(row);
    row.querySelector('.remove-var-row').addEventListener('click', () => row.remove());
}

// ==================== ОТКРЫТИЕ/ЗАКРЫТИЕ МОДАЛЬНОГО ОКНА ====================

/** Открыть модальное окно экспорта */
export function openExportModal() {
    if (!hasPermission(PERMISSIONS.VIEW_DATA)) {
        showToast('Недостаточно прав для экспорта');
        return;
    }
    const exportModal = document.getElementById('exportModalBackdrop');
    const container = document.getElementById('exportVariablesContainer');
    if (!exportModal || !container) {
        console.error('[export] modal or container not found');
        return;
    }
    container.innerHTML = '';
    addVariableRow();
    setDefaultDates();
    exportModal.classList.add('show');
}

/** Закрыть модальное окно экспорта */
export function closeExportModal() {
    const exportModal = document.getElementById('exportModalBackdrop');
    if (exportModal) {
        exportModal.classList.remove('show');
    }
}

// ==================== ОБРАБОТКА СКАЧИВАНИЯ ====================

/** Обработчик нажатия кнопки "Скачать" */
async function handleDownload() {
    if (!hasPermission(PERMISSIONS.VIEW_DATA)) {
        showToast('Недостаточно прав');
        return;
    }

    const container = document.getElementById('exportVariablesContainer');
    const fromInput = document.getElementById('exportFrom');
    const toInput = document.getElementById('exportTo');
    const exportTypeSelect = document.getElementById('exportType');

    if (!container || !fromInput || !toInput || !exportTypeSelect) {
        console.error('[export] required DOM elements missing');
        showToast('Ошибка инициализации формы экспорта');
        return;
    }

    const rows = container.querySelectorAll('.export-var-row');
    if (rows.length === 0) {
        showToast('Добавьте хотя бы один датчик');
        return;
    }

    const fromStr = fromInput.value;
    const toStr = toInput.value;
    if (!fromStr || !toStr) {
        showToast('Заполните даты начала и конца');
        return;
    }

    const fromMs = new Date(fromStr).getTime();
    const toMs = new Date(toStr).getTime();
    if (isNaN(fromMs) || isNaN(toMs)) {
        showToast('Некорректный формат даты');
        return;
    }
    if (fromMs >= toMs) {
        showToast('Дата начала должна быть меньше даты окончания');
        return;
    }

    const version = exportTypeSelect.value;

    const requests = [];
    for (const row of rows) {
        const sensorId = row.querySelector('.export-sensor-id').value.trim();
        const varName = row.querySelector('.export-var-name').value.trim();
        if (sensorId && varName) {
            requests.push({ sensorId, varName });
        }
    }

    if (requests.length === 0) {
        showToast('Нет заполненных строк');
        return;
    }

    for (const { sensorId, varName } of requests) {
        const url = `/export/comtrade?sensor=${encodeURIComponent(sensorId)}&var=${encodeURIComponent(varName)}&from=${fromMs}&to=${toMs}&version=${version}`;
        try {
            const response = await fetch(url, { credentials: 'include' });

            if (response.status === 401 || response.status === 403) {
                lockSession();
                showToast('Сессия истекла');
                return;
            }
            if (!response.ok) {
                const text = await response.text();
                showToast(`Ошибка для ${sensorId}:${varName} – ${text}`);
                continue;
            }

            const blob = await response.blob();
            const forcedBlob = new Blob([await blob.arrayBuffer()], { type: 'application/force-download' });
            const downloadUrl = window.URL.createObjectURL(forcedBlob);
            const a = document.createElement('a');
            const extension = version === '2013' ? '.cff' : '.zip';
            a.download = `${sensorId}_${varName}${extension}`;
            a.href = downloadUrl;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 1000);
        } catch (e) {
            console.error('[export] fetch error:', e);
            showToast(`Ошибка при скачивании ${sensorId}:${varName}: ${e.message}`);
        }
    }

    closeExportModal();
    showToast('Экспорт завершён');
}
