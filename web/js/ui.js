console.log('ui.js загружен');

import {
  config,
  currentSensor,
  allSensors,
  timeRange,
  COLOR_CHOICES,
  UNIT_CATEGORIES,
  PROCESSING_MODES,
  serverStart,
  setCurrentSensor,
  PERMISSIONS,
  setCurrentUser,
  ROLE_PERMISSIONS,
  currentUser,
  csrfToken
} from './constants.js';

import { initSession } from './session.js';
import { init } from './api.js';
import { drawCurrent, clearChart } from './charts.js';
import { saveConfigWithMessage } from './sensors.js';
import { getAlertClass, pickHigherAlertClass, hasPermission } from './utils.js';

let editingId = null;
let toastTimer = null;

export function showApp() {
  if (!currentUser) return;
  const app = document.getElementById('appRoot');
  if (app) app.hidden = false;
}

export function hideApp() {
    const app = document.getElementById('appRoot');
    if (app) app.hidden = true;
}

async function login(e) {

  e?.preventDefault();
  setCurrentUser(null);

  const username = document.getElementById("loginUser").value;
  const password = document.getElementById("loginPass").value;

  const res = await fetch('/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
      },
      body: JSON.stringify({ username, password }),
      credentials: 'include'
  });

  const data = await res.json();

  if (!res.ok) {
    hideApp();
    openLoginModal();

    if (data.error === 'blocked') {
      showLoginError('Слишком много попыток. Попробуйте позже.');
    } else {
      showLoginError('Неверный логин или пароль');
    }
    return;
  }

  if (data.status !== "ok") {
    alert("Ошибка входа");
    return;
  }

  // Очищаем ошибку при успешном логине
  const errorEl = document.getElementById("loginError");
  if (errorEl) errorEl.textContent = '';

  // После успешного логина инициализируем сессию и приложение
  closeLoginModal();
  try {
    await initSession();
    await init();
  } catch (err) {
    console.error('Ошибка инициализации после логина:', err);
    hideApp();
    openLoginModal();
    showLoginError('Ошибка инициализации приложения');
  }
}

export function openLoginModal() {document.getElementById("loginModal").classList.add("show");}

export function closeLoginModal() {document.getElementById("loginModal").classList.remove("show");}

function showLoginError(message) {
  const errorEl = document.getElementById("loginError");
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.style.color = '#ff0000';
    errorEl.style.marginTop = '10px';
  }
}

export function applyPermissions(role) {
  const perms = ROLE_PERMISSIONS[role] || new Set();
  const isDev = perms.has(PERMISSIONS.DEV_ALL);

  const sensorPanel = document.getElementById('sensorPanel');
  if (sensorPanel) {
    sensorPanel.classList.toggle(
      'hidden',
      !(isDev || perms.has(PERMISSIONS.VIEW_DATA))
    );
  }

  const addBtn = document.getElementById('addSensorBtn');
  if (addBtn) {
    addBtn.classList.toggle(
      'hidden',
      !(isDev || perms.has(PERMISSIONS.EDIT_CONFIG))
    );
  }
}

export async function forceLogout() {
  try {
    await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'include'
    });
  } catch {}
  setCurrentUser(null);
  hideApp();
  openLoginModal();
}

// ===== ПРИВЯЗКА КНОПОК
export function setupButtonHandlers() {
  const loginBtn = document.getElementById('loginBtn');
  if (loginBtn) {
    loginBtn.addEventListener('click', login);
  }

  const addBtn = document.getElementById('addSensorBtn');
  const saveBtn = document.getElementById('saveSensorBtn');
  const cancelBtn = document.getElementById('cancelSensorBtn');
  const deleteBtn = document.getElementById('deleteSensorBtn');
  const cancelOkBtn = document.getElementById('cancelConfirmOkBtn');
  const cancelBackBtn = document.getElementById('cancelConfirmBackBtn');
  const sensorVarsInput = document.getElementById('sensorVars');

  if (sensorVarsInput) {
    sensorVarsInput.addEventListener('input', () => {
      if (editingId == null) return;
      let sCfg = config.sensors.find(s => String(s.id) === String(editingId));
      if (!sCfg) return;
      buildVarSettingsUI(sCfg);
    });
  }

  if (addBtn) addBtn.addEventListener('click', onAddSensorClick);
  if (saveBtn) saveBtn.addEventListener('click', onSaveSensorClick);
  if (cancelBtn) cancelBtn.addEventListener('click', onCancelSensorClick);
  if (deleteBtn) deleteBtn.addEventListener('click', onDeleteSensorClick);
  if (cancelOkBtn) cancelOkBtn.addEventListener('click', onCancelConfirmOk);
  if (cancelBackBtn) cancelBackBtn.addEventListener('click', onCancelConfirmBack);
}

export function setupTimeRangeControls() {
  const dInput = document.getElementById('timeDays');
  const hInput = document.getElementById('timeHours');
  const mInput = document.getElementById('timeMinutes');
  const applyBtn = document.getElementById('applyTimeRangeBtn');

  if (!dInput || !hInput || !mInput || !applyBtn) return;

  // начальные значения
  dInput.value = timeRange.days;
  hInput.value = timeRange.hours;
  mInput.value = timeRange.minutes;

  function applyRange() {
    const d = parseInt(dInput.value, 10);
    const h = parseInt(hInput.value, 10);
    const m = parseInt(mInput.value, 10);

    if ((d < 0) || (h < 0) || (m < 0)) {
      alert('Значения диапазона времени не могут быть отрицательными');
      return;
    }

    timeRange.days = isNaN(d) ? 0 : d;
    timeRange.hours = isNaN(h) ? 0 : h;
    timeRange.minutes = isNaN(m) ? 0 : m;

    // просто перерисовываем графики по тем же данным, но в новом окне
    drawCurrent();
  }

  applyBtn.addEventListener('click', applyRange);

  // Enter на любом из трёх полей тоже применяет
  [dInput, hInput, mInput].forEach(inp => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        applyRange();
      }
    });
  });
}

// Обновление панели
export function updateSensorPanel() {
  const list = document.getElementById('sensorList');
  if (!list) return;

  const visibleSensors = config.sensors.filter(s => !s.deleted);
  list.innerHTML = '';

  if (visibleSensors.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Нет настроенных датчиков';
    li.style.color = '#777';
    list.appendChild(li);
    setCurrentSensor(null);

    // очищаем все графики динамически
    const chartsContainer = document.getElementById('chartsContainer');
    if (chartsContainer) chartsContainer.innerHTML = '';

    return;
  }

  visibleSensors.forEach((sCfg, index) => {
    let lastTempText = 'нет данных';
    let sensorAlertClass = null;

    const varSettings = Array.isArray(sCfg.varSettings) ? sCfg.varSettings : [];

    if (sCfg.vars) {
      const vars = sCfg.vars.split(',').map(v => v.trim()).filter(Boolean);
      for (const v of vars) {
        const sData =
          allSensors[v] ||
          allSensors[`${sCfg.id}:${v}`] ||
          allSensors[`${sCfg.id}:${v.toLowerCase()}`];

        if (sData && Array.isArray(sData.values)) {
          const arr = sData.values;
          if (arr.length > 0) {
            const lastVal = arr[arr.length - 1];

            // заполняем текст только один раз — по первой найденной переменной
            if (lastTempText === 'нет данных' && Number.isFinite(lastVal)) {
              const vs = varSettings.find(x => x.var === v) || {};
              const unit = vs.unit || '';
              lastTempText = lastVal.toFixed(2) + (unit ? ' ' + unit : '');
            }

            // считаем тревогу для этой переменной
            const vs = varSettings.find(x => x.var === v) || {};
            const varAlert = getAlertClass(vs, lastVal);
            sensorAlertClass = pickHigherAlertClass(sensorAlertClass, varAlert);
          }
        }
      }
    }

    const li = document.createElement('li');
    li.style.cursor = 'pointer';
    li.style.padding = '4px 4px';
    li.style.borderBottom = '1px solid #eee';
    li.style.display = 'flex';
    li.style.alignItems = 'center';
    li.style.gap = '4px';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = (sCfg.name || 'Датчик ' + (index + 1)) + ': ' + lastTempText;
    nameSpan.style.flex = '1 1 auto';

    const canEdit = hasPermission(PERMISSIONS.EDIT_CONFIG);

    if (canEdit) {
      const editBtn = document.createElement('button');
      editBtn.textContent = '✏️';
      editBtn.style.border = 'none';
      editBtn.style.background = 'transparent';
      editBtn.style.cursor = 'pointer';
      editBtn.title = 'Редактировать датчик';

      editBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openEditModal(sCfg.id);
      });

      li.appendChild(editBtn);
    }

    li.addEventListener('click', () => selectSensor(sCfg.id));

    if (String(sCfg.id) === String(currentSensor)) {
      li.classList.add('sensor-selected');
    }

    // применяем мигание к элементу датчика
    li.classList.remove('blink-blue', 'blink-yellow', 'blink-red');
    if (sensorAlertClass) {
      li.classList.add(sensorAlertClass);
    }

    li.appendChild(nameSpan);
    list.appendChild(li);
  });
}

export function updateDevicePanel() {
  const deviceList = document.getElementById('deviceList');
  if (!deviceList) return;

  deviceList.innerHTML = ''; // очищаем список

  // Группируем переменные по IP
  const groupedByIP = {};

  for (const key of Object.keys(allSensors)) {

    const idx = key.indexOf('_');
    if (idx === -1) continue;
    const ip = key.slice(0, idx);
    const variable = key.slice(idx + 1);

    if (!groupedByIP[ip]) groupedByIP[ip] = [];
    groupedByIP[ip].push(variable);
  }

  // Отображаем результат
  for (const [ip, vars] of Object.entries(groupedByIP)) {
    const li = document.createElement('li');
    li.style.padding = '4px 0';
    li.textContent = `IP: ${ip} | Переменные: ${vars.join(', ')}`;
    deviceList.appendChild(li);
  }
}

// ===== МОДАЛКА РЕДАКТИРОВАНИЯ =====
export function openEditModal(id) {
  if (!hasPermission(PERMISSIONS.EDIT_CONFIG)) {
    return;
  }
  editingId = id;
  const backdrop = document.getElementById('editModalBackdrop');
  if (!backdrop) return;

  let sCfg = config.sensors.find(s => String(s.id) === String(id));
  if (!sCfg) {
    sCfg = {
      id,
      name: 'Датчик ' + id,
      vars: '',
      deleted: false
    };
    config.sensors.push(sCfg);
  }

  const sensorIdInput = document.getElementById('sensorId');
  const sensorNameInput = document.getElementById('sensorName');
  const sensorVarsInput = document.getElementById('sensorVars');

  if (sensorIdInput) sensorIdInput.value = sCfg.id != null ? String(sCfg.id) : '';
  if (sensorNameInput) sensorNameInput.value = sCfg.name || '';
  if (sensorVarsInput) sensorVarsInput.value = sCfg.vars || '';

  buildVarSettingsUI(sCfg);

  backdrop.style.display = 'flex';
}

export function buildVarSettingsUI(sCfg) {
  const container = document.getElementById('varSettingsContainer');
  const sensorVarsInput = document.getElementById('sensorVars');
  if (!container || !sensorVarsInput) return;

  container.innerHTML = '';

  // текущий список переменных из input
  const vars = sensorVarsInput.value
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);

  const existing = Array.isArray(sCfg.varSettings) ? sCfg.varSettings : [];

  vars.forEach((varName, idx) => {
    const found = existing.find(v => v.var === varName) || null;

    const row = document.createElement('div');
    row.className = 'var-settings-row';
    row.dataset.var = varName;
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '6px';
    row.style.flexWrap = 'wrap';

    const varSpan = document.createElement('span');
    varSpan.textContent = varName;
    varSpan.style.minWidth = '80px';

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.placeholder = 'Название графика';
    labelInput.value = (found && found.label) ? found.label : varName;
    labelInput.className = 'var-label-input';
    labelInput.style.flex = '1 1 auto';

    // выбор цвета
    const colorSelect = document.createElement('select');
    colorSelect.className = 'var-color-select';

    COLOR_CHOICES.forEach(choice => {
      const opt = document.createElement('option');
      opt.value = choice.value;      // #ff0000
      opt.textContent = choice.name; // "Красный"
      colorSelect.appendChild(opt);
    });

    const defaultColor = COLOR_CHOICES[idx % COLOR_CHOICES.length].value;
    const currentColor = (found && found.color) ? found.color : defaultColor;
    colorSelect.value = currentColor;

    // единицы измерения - выпадающий список по категориям
    const unitSelect = document.createElement('select');
    unitSelect.className = 'var-unit-select';

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Ед. изм.';
    unitSelect.appendChild(defaultOption);

    for (const category in UNIT_CATEGORIES) {
      const categoryOptGroup = document.createElement('optgroup');
      categoryOptGroup.label = category;
      UNIT_CATEGORIES[category].forEach(unit => {
        const option = document.createElement('option');
        option.value = unit.value;
        option.textContent = unit.name;
        categoryOptGroup.appendChild(option);
      });
      unitSelect.appendChild(categoryOptGroup);
    }

    const currentUnit = (found && found.unit) ? found.unit : '';
    unitSelect.value = currentUnit;

    // === Пороги ===
    const lowInput = document.createElement('input');
    lowInput.type = 'number';
    lowInput.step = 'any';
    lowInput.placeholder = 'Синий <';
    lowInput.className = 'var-low-input';
    lowInput.style.width = '90px';
    lowInput.value = (found && found.lowLimit != null) ? found.lowLimit : '';

    const warnInput = document.createElement('input');
    warnInput.type = 'number';
    warnInput.step = 'any';
    warnInput.placeholder = 'Жёлтый ≥';
    warnInput.className = 'var-warn-input';
    warnInput.style.width = '90px';
    warnInput.value = (found && found.warnLimit != null) ? found.warnLimit : '';

    const alarmInput = document.createElement('input');
    alarmInput.type = 'number';
    alarmInput.step = 'any';
    alarmInput.placeholder = 'Красный ≥';
    alarmInput.className = 'var-alarm-input';
    alarmInput.style.width = '90px';
    alarmInput.value = (found && found.alarmLimit != null) ? found.alarmLimit : '';

    // === Обработка сигнала ===
    const processingSelect = document.createElement('select');
    processingSelect.className = 'var-processing-select';

    PROCESSING_MODES.forEach(mode => {
      const opt = document.createElement('option');
      opt.value = mode.value;
      opt.textContent = mode.label;
      processingSelect.appendChild(opt);
    });

    const currentProcessing = (found && found.processing) ? found.processing : 'none';
    processingSelect.value = currentProcessing;

    // чекбокс: показывать сырые данные
    const showRawCheckbox = document.createElement('input');
    showRawCheckbox.type = 'checkbox';
    showRawCheckbox.className = 'var-show-raw';
    showRawCheckbox.checked = (found && typeof found.showRaw === 'boolean')
      ? found.showRaw
      : true;

    const showRawLabel = document.createElement('label');
    showRawLabel.style.fontSize = '11px';
    showRawLabel.appendChild(showRawCheckbox);
    showRawLabel.appendChild(document.createTextNode(' RAW (сырые)'));

    // чекбокс: показывать обработанные данные
    const showProcCheckbox = document.createElement('input');
    showProcCheckbox.type = 'checkbox';
    showProcCheckbox.className = 'var-show-processed';
    const defaultShowProcessed = currentProcessing !== 'none';
    showProcCheckbox.checked = (found && typeof found.showProcessed === 'boolean')
      ? found.showProcessed
      : defaultShowProcessed;

    const showProcLabel = document.createElement('label');
    showProcLabel.style.fontSize = '11px';
    showProcLabel.appendChild(showProcCheckbox);
    showProcLabel.appendChild(document.createTextNode(' Обработанные'));

    // Вкликиваем всё в строку
    row.appendChild(varSpan);
    row.appendChild(labelInput);
    row.appendChild(colorSelect);
    row.appendChild(unitSelect);
    row.appendChild(lowInput);
    row.appendChild(warnInput);
    row.appendChild(alarmInput);
    row.appendChild(processingSelect);
    row.appendChild(showRawLabel);
    row.appendChild(showProcLabel);

    container.appendChild(row);
  });
}

export function selectSensor(id) {
  setCurrentSensor(id);
  updateSensorPanel();
  drawCurrent();
}

// ===== КНОПКА "ДОБАВИТЬ ДАТЧИК" =====
export function onAddSensorClick() {
  let maxId = 0;
  config.sensors.forEach(s => {
    const n = Number(s.id);
    if (!isNaN(n) && n > maxId) maxId = n;
  });
  const newId = maxId + 1;

  const newSensor = {
    id: newId,
    name: 'Датчик ' + newId,
    vars: '',
    deleted: false
  };

  config.sensors.push(newSensor);
  setCurrentSensor(newId);

  updateSensorPanel();
  drawCurrent();
  openEditModal(newId);
}

// === УДАЛЕНИЕ ДАТЧИКА ===
export async function onDeleteSensorClick() {
  if (editingId == null) return;
  const idx = config.sensors.findIndex(s => String(s.id) === String(editingId));
  if (idx === -1) return;
  const name = config.sensors[idx].name || ('Датчик ' + editingId);
  if (!confirm(`Удалить «${name}»?`)) return;

  config.sensors.splice(idx, 1);
  closeEditModal();
  await saveConfigWithMessage();
  updateSensorPanel();
  drawCurrent();
  editingId = null;
}

export function closeEditModal() {
  const backdrop = document.getElementById('editModalBackdrop');
  if (backdrop) backdrop.style.display = 'none';
}

// ===== МОДАЛКА ПОДТВЕРЖДЕНИЯ ОТМЕНЫ =====
export function openCancelConfirm() {
  const backdrop = document.getElementById('cancelConfirmBackdrop');
  if (backdrop) backdrop.style.display = 'flex';
}

export function closeCancelConfirm() {
  const backdrop = document.getElementById('cancelConfirmBackdrop');
  if (backdrop) backdrop.style.display = 'none';
}

export function onCancelSensorClick() { openCancelConfirm(); }

export function onCancelConfirmOk() {
  closeCancelConfirm();
  closeEditModal();
  editingId = null;
}

export function onCancelConfirmBack() { closeCancelConfirm(); }

// ===== СОХРАНЕНИЕ ИЗ МОДАЛКИ =====
export async function onSaveSensorClick() {

  if (editingId == null) return;

  // ищем текущую конфигурацию датчика по старому ID
  let sCfg = config.sensors.find(s => String(s.id) === String(editingId));
  if (!sCfg) {
    sCfg = { id: editingId, deleted: false };
    config.sensors.push(sCfg);
  }

  // === ЧТЕНИЕ И ОБНОВЛЕНИЕ ID ДАТЧИКА ===
  const sensorIdInput = document.getElementById('sensorId');
  let newId = (sensorIdInput?.value.trim() || String(sCfg.id));

  if (!/^[a-zA-Z0-9_-]+$/.test(newId)) {
    alert('ID датчика может содержать только буквы, цифры, "_" и "-"');
    return;
  }

  if (newId === '') {
    // если пусто — оставляем прежний
    newId = String(sCfg.id);
  }

  const oldId = String(sCfg.id);

  // проверка уникальности ID
  const conflict = config.sensors.find(
    s => String(s.id) === newId && s !== sCfg
  );
  if (conflict) {
    alert(`❌ Датчик с ID «${newId}» уже существует. Укажите уникальный ID.`);
    return;
  }

  // обновляем ID в конфиге
  sCfg.id = newId;

  // если этот датчик сейчас выбран/редактируется — обновляем ссылки
  if (String(currentSensor) === oldId) {
    setCurrentSensor(newId);
  }
  if (String(editingId) === oldId) {
    editingId = newId;
  }

  // === ОСТАЛЬНЫЕ ПОЛЯ ДАТЧИКА ===
  const sensorNameInput = document.getElementById('sensorName');
  const sensorVarsInput = document.getElementById('sensorVars');

  sCfg.name = sensorNameInput
    ? (sensorNameInput.value.trim() || ('Датчик ' + newId))
    : ('Датчик ' + newId);

  const rawVars = sensorVarsInput ? sensorVarsInput.value.trim() : '';

  if (!/^[a-zA-Z0-9_,\s-]*$/.test(rawVars)) {
    alert('Недопустимые символы в списке переменных');
    return;
  }

  sCfg.vars = rawVars;

  // Считываем настройки переменных из UI
  const container = document.getElementById('varSettingsContainer');
  if (container) {
    const rows = container.querySelectorAll('.var-settings-row');
    const settings = [];
    rows.forEach(row => {
      const varName = row.dataset.var;
      if (!varName) return;
      const labelInput = row.querySelector('.var-label-input');
      const colorSelect = row.querySelector('.var-color-select');
      const unitSelect = row.querySelector('.var-unit-select');
      const lowInput = row.querySelector('.var-low-input');
      const warnInput = row.querySelector('.var-warn-input');
      const alarmInput = row.querySelector('.var-alarm-input');
      const processingSelect = row.querySelector('.var-processing-select');
      const showRawCheckbox = row.querySelector('.var-show-raw');
      const showProcCheckbox = row.querySelector('.var-show-processed');

      const label = labelInput ? labelInput.value.trim() : varName;
      const color = colorSelect ? (colorSelect.value || '#ff0000') : '#ff0000';
      const unit = unitSelect ? unitSelect.value.trim() : '';

      const lowStr = lowInput ? lowInput.value.trim() : '';
      const warnStr = warnInput ? warnInput.value.trim() : '';
      const alarmStr = alarmInput ? alarmInput.value.trim() : '';

      const lowLimit = lowStr === '' ? null : Number(lowStr);
      const warnLimit = warnStr === '' ? null : Number(warnStr);
      const alarmLimit = alarmStr === '' ? null : Number(alarmStr);

      const processing = processingSelect ? (processingSelect.value || 'none') : 'none';
      const showRaw = showRawCheckbox ? showRawCheckbox.checked : true;
      const showProcessed = showProcCheckbox
        ? showProcCheckbox.checked
        : (processing !== 'none');

      settings.push({
        var: varName,
        label: label || varName,
        color,
        unit,
        lowLimit: Number.isFinite(lowLimit) ? lowLimit : null,
        warnLimit: Number.isFinite(warnLimit) ? warnLimit : null,
        alarmLimit: Number.isFinite(alarmLimit) ? alarmLimit : null,
        processing,
        showRaw,
        showProcessed
      });
    });
    sCfg.varSettings = settings;
  }

  closeEditModal();
  await saveConfigWithMessage();
  updateSensorPanel();
  drawCurrent();
}

// ===== ТАЙМЕР И ГРАФИКИ =====
export function updateTimer() {

  if (!serverStart) return;

  const timerEl = document.getElementById('timer');
  if (!timerEl) return;

  const elapsedSec = Math.floor((Date.now() - serverStart) / 1000);
  const h = Math.floor(elapsedSec / 3600);
  const m = Math.floor((elapsedSec % 3600) / 60);
  const s = elapsedSec % 60;
  timerEl.textContent = `Время работы: ${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
}

// === ТОСТ ===
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