import { csrfToken } from '../constants.js';
import { lockSession } from '../session.js';
import { showToast } from './toast.js';

let diagnosticModal = null;
let refreshInterval = null;
let currentTab = 'overview';
let diagData = null;
let currentAuditEntries = [];
let auditContainer = null;

// Состояние сортировки для вкладки "Датчики"
let sensorsSortColumn = 'id'; // столбец по умолчанию
let sensorsSortDirection = 'asc';

export function openDiagnosticModal() {
    diagnosticModal = document.getElementById('diagnosticModalBackdrop');
    if (!diagnosticModal) {
        console.error('Модальное окно диагностики не найдено');
        return;
    }
    diagnosticModal.classList.add('show');
    loadDiagnosticData();
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(loadDiagnosticData, 2000);
    setupTabListeners();
}

export function closeDiagnosticModal() {
    if (diagnosticModal) diagnosticModal.classList.remove('show');
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
    currentAuditEntries = [];
    auditContainer = null;
}

function setupTabListeners() {
    const tabs = diagnosticModal.querySelectorAll('.tab-button');
    tabs.forEach(btn => {
        btn.removeEventListener('click', handleTabClick);
        btn.addEventListener('click', handleTabClick);
    });
}

function handleTabClick(e) {
    const tabs = diagnosticModal.querySelectorAll('.tab-button');
    tabs.forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    currentTab = e.target.dataset.tab;
    renderTabContent();
}

async function loadDiagnosticData() {
    try {
        const res = await fetch('/diagnostic', {
            credentials: 'include',
            headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {}
        });
        if (res.status === 401 || res.status === 403) {
            lockSession();
            return;
        }
        if (!res.ok) throw new Error('Ошибка загрузки диагностики');
        diagData = await res.json();
        updateTimestamp();
        // Если открыта вкладка аудита, обновляем её инкрементально
        if (currentTab === 'audit') {
            await incrementalAuditUpdate();
        } else {
            renderTabContent();
        }
    } catch (e) {
        console.error('Ошибка загрузки диагностики:', e);
        showToast('Не удалось загрузить диагностику');
    }
}

function updateTimestamp() {
    const tsEl = document.getElementById('diagTimestamp');
    if (tsEl && diagData?.timestamp) {
        const date = new Date(diagData.timestamp);
        tsEl.textContent = `Обновлено: ${date.toLocaleTimeString()}`;
    }
}

function renderTabContent() {
    const contentDiv = document.getElementById('diagnosticContent');
    if (!contentDiv || !diagData) return;

    switch (currentTab) {
        case 'overview': renderOverview(contentDiv); break;
        case 'database': renderDatabase(contentDiv); break;
        case 'datastore': renderDataStore(contentDiv); break;
        case 'disk': renderDisk(contentDiv); break;
        case 'system': renderSystem(contentDiv); break;
        case 'sensors': renderSensors(contentDiv); break;
        case 'audit': renderAudit(contentDiv); break;
    }
}

function renderOverview(div) {
    let html = `<p><strong>Статус:</strong> <span class="status-${diagData.status?.toLowerCase()}">${diagData.status}</span></p>`;
    html += `<p><strong>Время сервера:</strong> ${new Date(diagData.timestamp).toLocaleString()}</p>`;
    div.innerHTML = html;
}

function renderDatabase(div) {
    const db = diagData.database || {};
    let html = '<table class="diagnostic-table">';
    html += `<tr><td>Статус</td><td><span class="status-${db.status?.toLowerCase()}">${db.status}</span></td></tr>`;
    html += `<tr><td>Время ответа</td><td>${db.responseTimeMs} мс</td></tr>`;
    html += `<tr><td>Активных соединений</td><td>${db.active}</td></tr>`;
    html += `<tr><td>Всего соединений</td><td>${db.total}</td></tr>`;
    html += `<tr><td>Доступно</td><td>${db.available}</td></tr>`;
    if (db.error) html += `<tr><td>Ошибка</td><td class="error">${db.error}</td></tr>`;
    html += '</table>';
    div.innerHTML = html;
}

function renderDataStore(div) {
    const ds = diagData.dataStore || {};
    const queuePercent = ((ds.queueSize / ds.queueLimit) * 100).toFixed(1);
    let html = '<table class="diagnostic-table">';
    html += `<tr><td>Размер очереди</td><td>${ds.queueSize} / ${ds.queueLimit} (${queuePercent}%)</td></tr>`;
    html += `<tr><td>Отброшено точек</td><td>${ds.droppedPoints}</td></tr>`;
    html += `<tr><td>Активных метрик</td><td>${ds.activeMetrics}</td></tr>`;
    html += `<tr><td>Активных датчиков</td><td>${ds.activeSensors}</td></tr>`;
    html += '</table>';
    div.innerHTML = html;
}

function renderDisk(div) {
    const disk = diagData.disk || {};
    const freeGB = (disk.freeDiskSpace / (1024**3)).toFixed(2);
    const totalGB = (disk.totalDiskSpace / (1024**3)).toFixed(2);
    const auditMB = (disk.auditFileSize / (1024**2)).toFixed(2);
    let html = '<table class="diagnostic-table">';
    html += `<tr><td>Файл аудита</td><td>${auditMB} МБ</td></tr>`;
    html += `<tr><td>Свободно на диске</td><td>${freeGB} ГБ / ${totalGB} ГБ</td></tr>`;
    html += '</table>';
    div.innerHTML = html;
}

function renderSystem(div) {
    const sys = diagData.system || {};
    let html = '<table class="diagnostic-table">';
    html += `<tr><td>Процессоров</td><td>${sys.availableProcessors}</td></tr>`;
    html += `<tr><td>Средняя нагрузка</td><td>${sys.systemLoadAverage?.toFixed(2) ?? 'N/A'}</td></tr>`;
    html += '</table>';
    div.innerHTML = html;
}

// Естественная сортировка строк
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

// Функция сортировки для датчиков
function sortSensors(data, column, direction) {
    return [...data].sort((a, b) => {
        let valA, valB;
        switch(column) {
            case 'id':
                valA = a.id || '';
                valB = b.id || '';
                break;
            case 'lastSeen':
                valA = a.lastSeen || 0;
                valB = b.lastSeen || 0;
                break;
            case 'status':
                valA = a.status || '';
                valB = b.status || '';
                break;
            default:
                return 0;
        }
        let cmp;
        if (typeof valA === 'string' && typeof valB === 'string') {
            cmp = naturalCompare(valA, valB);
        } else {
            if (valA < valB) cmp = -1;
            else if (valA > valB) cmp = 1;
            else cmp = 0;
        }
        return direction === 'asc' ? cmp : -cmp;
    });
}

// Обработчик клика на заголовок таблицы датчиков
function handleSensorsHeaderClick(column) {
    if (sensorsSortColumn === column) {
        sensorsSortDirection = sensorsSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        sensorsSortColumn = column;
        sensorsSortDirection = 'asc';
    }
    renderSensors(document.getElementById('diagnosticContent'));
}

function renderSensors(div) {
    const sensors = diagData.sensors || [];
    if (sensors.length === 0) {
        div.innerHTML = '<p>Нет данных о датчиках</p>';
        return;
    }

    // Сортируем данные
    const sortedSensors = sortSensors(sensors, sensorsSortColumn, sensorsSortDirection);

    // Генерируем HTML таблицы
    let html = '<table class="diagnostic-table">';
    html += '<thead><tr>';
    html += `<th data-column="id" class="sortable ${sensorsSortColumn === 'id' ? 'sort-' + sensorsSortDirection : ''}">ID</th>`;
    html += `<th data-column="lastSeen" class="sortable ${sensorsSortColumn === 'lastSeen' ? 'sort-' + sensorsSortDirection : ''}">Последняя активность</th>`;
    html += `<th data-column="status" class="sortable ${sensorsSortColumn === 'status' ? 'sort-' + sensorsSortDirection : ''}">Статус</th>`;
    html += '</tr></thead><tbody>';

    sortedSensors.forEach(s => {
        const date = s.lastSeen ? new Date(s.lastSeen).toLocaleString() : '-';
        const statusClass = s.status ? s.status.toLowerCase() : 'unknown';
        html += `<tr>
            <td>${s.id || '-'}</td>
            <td>${date}</td>
            <td><span class="status-${statusClass}">${s.status || 'UNKNOWN'}</span></td>
        </tr>`;
    });
    html += '</tbody></table>';

    div.innerHTML = html;

    // Добавляем обработчики на заголовки
    const ths = div.querySelectorAll('th.sortable');
    ths.forEach(th => {
        th.addEventListener('click', () => {
            const column = th.dataset.column;
            handleSensorsHeaderClick(column);
        });
    });
}

// Полная перерисовка аудита (при переключении на вкладку)
async function renderAudit(div) {
    auditContainer = div;
    div.innerHTML = '<p>Загрузка аудита...</p>';
    const entries = await loadAudit();
    currentAuditEntries = entries;
    fullRenderAudit(div, entries);
}

function fullRenderAudit(div, entries) {
    if (entries.length === 0) {
        div.innerHTML = '<p>Нет записей аудита</p>';
        return;
    }
    let html = '<div class="audit-log">';
    entries.forEach(e => {
        let className = '';
        if (e.level === 'ERROR') className = 'error';
        else if (e.level === 'WARNING') className = 'warning';
        html += `<div class="audit-entry ${className}"><span class="timestamp">${e.timestamp}</span> <span class="level">[${e.level}]</span> <span class="user">${e.user}</span> <span class="action">${e.action}</span> <span class="details">${e.details}</span> <span class="ip">${e.ip}</span></div>`;
    });
    html += '</div>';
    div.innerHTML = html;
}

// Инкрементальное обновление аудита (без изменений, как было)
async function incrementalAuditUpdate() {
    if (!auditContainer || !auditContainer.isConnected) return;
    const newEntries = await loadAudit();
    if (newEntries.length === 0) return;

    let firstNewIndex = -1;
    for (let i = 0; i < newEntries.length; i++) {
        const newEntryStr = JSON.stringify(newEntries[i]);
        const matchIndex = currentAuditEntries.findIndex(old => JSON.stringify(old) === newEntryStr);
        if (matchIndex !== -1) {
            firstNewIndex = i;
            break;
        }
    }

    if (firstNewIndex === -1) {
        currentAuditEntries = newEntries;
        fullRenderAudit(auditContainer, newEntries);
        return;
    }

    if (firstNewIndex === 0) return;

    const addedEntries = newEntries.slice(0, firstNewIndex);
    currentAuditEntries.unshift(...addedEntries);

    const fragment = document.createDocumentFragment();
    addedEntries.forEach(e => {
        let className = '';
        if (e.level === 'ERROR') className = 'error';
        else if (e.level === 'WARNING') className = 'warning';
        const div = document.createElement('div');
        div.className = `audit-entry ${className}`;
        div.innerHTML = `<span class="timestamp">${e.timestamp}</span> <span class="level">[${e.level}]</span> <span class="user">${e.user}</span> <span class="action">${e.action}</span> <span class="details">${e.details}</span> <span class="ip">${e.ip}</span>`;
        fragment.appendChild(div);
    });

    const logDiv = auditContainer.querySelector('.audit-log');
    if (logDiv) {
        const scrollTop = logDiv.scrollTop;
        logDiv.insertBefore(fragment, logDiv.firstChild);
        requestAnimationFrame(() => {
            let addedHeight = 0;
            for (let i = 0; i < addedEntries.length; i++) {
                addedHeight += logDiv.children[i].offsetHeight;
            }
            logDiv.scrollTop = scrollTop + addedHeight;
        });
    } else {
        fullRenderAudit(auditContainer, currentAuditEntries);
    }
}

async function loadAudit() {
    try {
        const res = await fetch('/audit/latest?limit=100', {
            credentials: 'include',
            headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {}
        });
        if (res.status === 401 || res.status === 403) {
            lockSession();
            return [];
        }
        if (!res.ok) throw new Error('Ошибка загрузки аудита');
        const lines = await res.json();
        const entries = lines.map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return { level: 'INFO', user: '-', action: 'raw', details: line, ip: '-', timestamp: '' };
            }
        });
        return entries.reverse();
    } catch (e) {
        console.error('Ошибка загрузки аудита:', e);
        return [];
    }
}

export function initDiagnostic() {
    const closeBtn = document.getElementById('closeDiagnosticBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeDiagnosticModal);

    const modal = document.getElementById('diagnosticModalBackdrop');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeDiagnosticModal();
        });
    }
}