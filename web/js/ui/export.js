import { showToast } from './toast.js';
import { hasPermission } from '../utils/permissions.js';
import { PERMISSIONS } from '../constants.js';
import { lockSession } from '../session.js';

let exportModal = document.getElementById('exportModalBackdrop');
let container = document.getElementById('exportVariablesContainer');
let addBtn = document.getElementById('addExportVarRow');
let cancelBtn = document.getElementById('cancelExportBtn');
let downloadBtn = document.getElementById('downloadExportBtn');
let exportTypeSelect = document.getElementById('exportType');
let fromInput = document.getElementById('exportFrom');
let toInput = document.getElementById('exportTo');

export function initExportModal() {
    if (!exportModal) return;

    addBtn?.addEventListener('click', addVariableRow);
    cancelBtn?.addEventListener('click', closeExportModal);
    downloadBtn?.addEventListener('click', handleDownload);

    setDefaultDates();
}

function setDefaultDates() {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const format = (d) => d.toISOString().slice(0, 16);
    if (fromInput) fromInput.value = format(oneHourAgo);
    if (toInput) toInput.value = format(now);
}

function addVariableRow() {
    const row = document.createElement('div');
    row.className = 'export-var-row';
    row.innerHTML = `
        <input type="text" placeholder="ID датчика" class="export-sensor-id">
        <input type="text" placeholder="Переменная" class="export-var-name">
        <button class="btn btn-small remove-var-row" type="button">✖</button>
    `;
    container.appendChild(row);
    row.querySelector('.remove-var-row').addEventListener('click', () => row.remove());
}

export function openExportModal() {
    if (!hasPermission(PERMISSIONS.VIEW_DATA)) {
        showToast('Недостаточно прав для экспорта');
        return;
    }
    // Очистить и создать одну строку
    container.innerHTML = '';
    addVariableRow();
    setDefaultDates();
    exportModal.classList.add('show');
}

export function closeExportModal() {
    exportModal.classList.remove('show');
}

async function handleDownload() {
    if (!hasPermission(PERMISSIONS.VIEW_DATA)) {
        showToast('Недостаточно прав');
        return;
    }

    const rows = container.querySelectorAll('.export-var-row');
    if (rows.length === 0) {
        showToast('Добавьте хотя бы один датчик');
        return;
    }

    // Пока поддерживается только одна строка (расширение позже)
    if (rows.length > 1) {
        showToast('Пока поддерживается экспорт только одного датчика/переменной за раз');
        return;
    }

    const sensorId = rows[0].querySelector('.export-sensor-id').value.trim();
    const varName = rows[0].querySelector('.export-var-name').value.trim();
    if (!sensorId || !varName) {
        showToast('Заполните ID датчика и переменную');
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

    const version = exportTypeSelect.value; // '1999' или '2013'

    // Формируем URL с параметром version
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
            showToast(`Ошибка: ${text}`);
            return;
        }

        const blob = await response.blob();
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        // Устанавливаем расширение в зависимости от версии
        const extension = version === '2013' ? '.cff' : '.zip';
        a.download = `${sensorId}_${varName}${extension}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(downloadUrl);

        closeExportModal();
        showToast('Экспорт завершён');
    } catch (e) {
        showToast('Ошибка при скачивании: ' + e.message);
    }
}
