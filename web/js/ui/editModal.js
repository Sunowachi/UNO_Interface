import {
    config,
    currentSensor,
    setCurrentSensor,
    editingId,
    setEditingId,
    COLOR_CHOICES,
    UNIT_CATEGORIES,
    PROCESSING_MODES,
    PERMISSIONS
} from '../constants.js';
import { hasPermission } from '../utils/permissions.js';
import { getEffectiveVarSettings, sensorExists } from '../utils/dataUtils.js';
import { updateSensorPanel } from './sensorPanel.js';
import { updateDevicePanel } from './devicePanel.js';
import { drawCurrent } from '../charts.js';
import { saveConfigWithMessage, markSensorDeleted } from '../sensors/index.js';
import { initCustomNumberInputs } from '../inputArrows.js';

// ==================== МОДАЛЬНОЕ ОКНО РЕДАКТИРОВАНИЯ ДАТЧИКА ====================

/** Открытие модального окна редактирования датчика */
export function openEditModal(id) {
    if (!hasPermission(PERMISSIONS.EDIT_CONFIG)) return;
    setEditingId(id);

    const backdrop = document.getElementById('editModalBackdrop');
    if (!backdrop) return;

    const devicePanel = document.getElementById('devicePanel');
    if (devicePanel) {
        updateDevicePanel();
        devicePanel.classList.add('show');
    }

    let sCfg = config.sensors.find(s => String(s.id) === String(id));
    if (!sCfg) {
        sCfg = { id, name: 'Датчик ' + id, vars: '', deleted: false };
        config.sensors.push(sCfg);
    }

    const sensorIdInput = document.getElementById('sensorId');
    const sensorNameInput = document.getElementById('sensorName');
    const sensorVarsInput = document.getElementById('sensorVars');

    if (sensorIdInput) sensorIdInput.value = sCfg.id != null ? String(sCfg.id) : '';
    if (sensorNameInput) sensorNameInput.value = sCfg.name || '';
    if (sensorVarsInput) {
        if (Array.isArray(sCfg.vars)) {
            sensorVarsInput.value = sCfg.vars.join(',');
        } else {
            sensorVarsInput.value = sCfg.vars || '';
        }
    }

    // Добавляем подсказку под полем переменных
    if (sensorVarsInput && !document.getElementById('sensorVarsHint')) {
        const hint = document.createElement('small');
        hint.id = 'sensorVarsHint';
        hint.style.cssText = 'color: var(--color-text-secondary); display: block; margin-top: 4px;';
        hint.textContent = 'Для импорта данных из другого датчика используйте формат ID_переменная (например, Sensor1_temp)';
        sensorVarsInput.parentNode.insertBefore(hint, sensorVarsInput.nextSibling);
    }

    buildVarSettingsUI(sCfg);
    backdrop.style.display = 'flex';
}

/** Закрытие модального окна редактирования */
export function closeEditModal() {
    const backdrop = document.getElementById('editModalBackdrop');
    if (backdrop) backdrop.style.display = 'none';

    const devicePanel = document.getElementById('devicePanel');
    if (devicePanel) devicePanel.classList.remove('show');

    const hint = document.getElementById('sensorVarsHint');
    if (hint) hint.remove();
}

/** Построение UI для настроек каждой переменной датчика */
export function buildVarSettingsUI(sCfg) {
    const container = document.getElementById('varSettingsContainer');
    const sensorVarsInput = document.getElementById('sensorVars');
    if (!container || !sensorVarsInput) return;

    container.innerHTML = '';

    const vars = sensorVarsInput.value.split(',').map(v => v.trim()).filter(Boolean);
    const existing = Array.isArray(sCfg.varSettings) ? sCfg.varSettings : [];

    const getSourceDisplayName = (varName) => {
        if (!varName.includes('_')) return '';
        const parts = varName.split('_');
        if (parts.length !== 2) return '';
        const sourceId = parts[0];
        const sourceSensor = config.sensors.find(s => String(s.id) === String(sourceId) && !s.deleted);
        return sourceSensor ? (sourceSensor.name || sourceId) : sourceId;
    };

    vars.forEach((varName, idx) => {
        const found = existing.find(v => v.var === varName) || null;

        const isReference = varName.includes('_') && (() => {
            const parts = varName.split('_');
            if (parts.length === 2) {
                const sourceId = parts[0];
                return config.sensors.some(s => String(s.id) === String(sourceId) && !s.deleted);
            }
            return false;
        })();

        const effectiveVs = isReference ? getEffectiveVarSettings(sCfg, varName) : null;

        if (isReference) {
            // Упрощённая строка для ссылочной переменной
            const sourceName = getSourceDisplayName(varName);

            const row = document.createElement('div');
            row.className = 'var-settings-row';
            row.dataset.var = varName;

            const varSpan = document.createElement('span');
            varSpan.textContent = varName;
            varSpan.className = 'var-name-label';
            varSpan.setAttribute('autocomplete', 'off');
            varSpan.title = 'Имя переменной (импортировано)';

            const sourceInfo = document.createElement('span');
            sourceInfo.className = 'var-source-info';
            sourceInfo.textContent = `↳ от ${sourceName}`;
            sourceInfo.title = `Настройки унаследованы от датчика «${sourceName}»`;

            const refIcon = document.createElement('span');
            refIcon.className = 'var-ref-icon';
            refIcon.textContent = '🔗';
            refIcon.title = 'Импортированная переменная (настройки только для просмотра)';

            row.appendChild(varSpan);
            row.appendChild(sourceInfo);
            row.appendChild(refIcon);

            container.appendChild(row);
        } else {
            const row = document.createElement('div');
            row.className = 'var-settings-row';
            row.dataset.var = varName;

            const varSpan = document.createElement('span');
            varSpan.textContent = varName;
            varSpan.className = 'var-name-label';
            varSpan.setAttribute('autocomplete', 'off');
            varSpan.title = 'Имя переменной (из данных датчика)';

            const labelInput = document.createElement('input');
            labelInput.type = 'text';
            labelInput.placeholder = 'Название графика';
            labelInput.className = 'var-label-input input-full';
            labelInput.setAttribute('autocomplete', 'off');
            labelInput.title = 'Отображаемое название на графике';
            if (isReference) {
                labelInput.value = effectiveVs?.label || varName;
                labelInput.disabled = true;
            } else {
                labelInput.value = found?.label || varName;
            }

            const colorSelect = document.createElement('select');
            colorSelect.className = 'var-color-select select-full';
            COLOR_CHOICES.forEach(choice => {
                const opt = document.createElement('option');
                opt.value = choice.value;
                opt.textContent = choice.name;
                colorSelect.appendChild(opt);
            });
            const defaultColor = COLOR_CHOICES[idx % COLOR_CHOICES.length].value;
            if (isReference) {
                colorSelect.value = effectiveVs?.color || defaultColor;
                colorSelect.disabled = true;
            } else {
                colorSelect.value = found?.color || defaultColor;
            }
            colorSelect.title = 'Цвет обработанных данных';

            const rawColorSelect = document.createElement('select');
            rawColorSelect.className = 'var-rawcolor-select select-full';
            rawColorSelect.title = 'Цвет сырых данных';
            COLOR_CHOICES.forEach(choice => {
                const opt = document.createElement('option');
                opt.value = choice.value;
                opt.textContent = choice.name;
                rawColorSelect.appendChild(opt);
            });
            const defaultRawColor = '#B0BEC5';
            if (isReference) {
                rawColorSelect.value = effectiveVs?.rawColor || defaultRawColor;
                rawColorSelect.disabled = true;
            } else {
                rawColorSelect.value = found?.rawColor || defaultRawColor;
            }

            const unitSelect = document.createElement('select');
            unitSelect.className = 'var-unit-select select-full';
            const defaultOption = document.createElement('option');
            defaultOption.value = '';
            defaultOption.textContent = 'Ед. изм.';
            unitSelect.appendChild(defaultOption);
            for (const category in UNIT_CATEGORIES) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = category;
                UNIT_CATEGORIES[category].forEach(unit => {
                    const option = document.createElement('option');
                    option.value = unit.value;
                    option.textContent = unit.name;
                    optgroup.appendChild(option);
                });
                unitSelect.appendChild(optgroup);
            }
            if (isReference) {
                unitSelect.value = effectiveVs?.unit || '';
                unitSelect.disabled = true;
            } else {
                unitSelect.value = found?.unit || '';
            }
            unitSelect.title = 'Единица измерения';

            const lowInput = document.createElement('input');
            lowInput.type = 'number';
            lowInput.step = 'any';
            lowInput.placeholder = 'Синий <';
            lowInput.className = 'var-low-input input-full';
            lowInput.setAttribute('autocomplete', 'off');
            lowInput.style.width = '90px';
            lowInput.title = 'Нижний порог (синяя подсветка)';
            if (isReference) {
                lowInput.value = effectiveVs?.lowLimit ?? '';
                lowInput.disabled = true;
            } else {
                lowInput.value = found?.lowLimit ?? '';
            }

            const warnInput = document.createElement('input');
            warnInput.type = 'number';
            warnInput.step = 'any';
            warnInput.placeholder = 'Жёлтый ≥';
            warnInput.className = 'var-warn-input input-full';
            warnInput.setAttribute('autocomplete', 'off');
            warnInput.style.width = '90px';
            warnInput.title = 'Порог предупреждения';
            if (isReference) {
                warnInput.value = effectiveVs?.warnLimit ?? '';
                warnInput.disabled = true;
            } else {
                warnInput.value = found?.warnLimit ?? '';
            }

            const alarmInput = document.createElement('input');
            alarmInput.type = 'number';
            alarmInput.step = 'any';
            alarmInput.placeholder = 'Красный ≥';
            alarmInput.className = 'var-alarm-input input-full';
            alarmInput.setAttribute('autocomplete', 'off');
            alarmInput.style.width = '90px';
            alarmInput.title = 'Порог тревоги';
            if (isReference) {
                alarmInput.value = effectiveVs?.alarmLimit ?? '';
                alarmInput.disabled = true;
            } else {
                alarmInput.value = found?.alarmLimit ?? '';
            }

            const processingSelect = document.createElement('select');
            processingSelect.className = 'var-processing-select select-full';
            PROCESSING_MODES.forEach(mode => {
                const opt = document.createElement('option');
                opt.value = mode.value;
                opt.textContent = mode.label;
                processingSelect.appendChild(opt);
            });
            if (isReference) {
                processingSelect.value = effectiveVs?.processing || 'none';
                processingSelect.disabled = true;
            } else {
                processingSelect.value = found?.processing || 'none';
            }
            processingSelect.title = 'Режим обработки';

            const showRawCheckbox = document.createElement('input');
            showRawCheckbox.type = 'checkbox';
            showRawCheckbox.className = 'var-show-raw';
            if (isReference) {
                showRawCheckbox.checked = effectiveVs?.showRaw ?? true;
                showRawCheckbox.disabled = true;
            } else {
                showRawCheckbox.checked = found?.showRaw ?? true;
            }
            showRawCheckbox.title = 'Показывать сырые данные';

            const showRawLabel = document.createElement('label');
            showRawLabel.className = 'checkbox-label';
            showRawLabel.appendChild(showRawCheckbox);
            showRawLabel.appendChild(document.createTextNode(' RAW (сырые)'));
            showRawLabel.title = 'Показывать сырые данные';

            const showProcCheckbox = document.createElement('input');
            showProcCheckbox.type = 'checkbox';
            showProcCheckbox.className = 'var-show-processed';
            const defaultShowProcessed = processingSelect.value !== 'none';
            if (isReference) {
                showProcCheckbox.checked = effectiveVs?.showProcessed ?? defaultShowProcessed;
                showProcCheckbox.disabled = true;
            } else {
                showProcCheckbox.checked = found?.showProcessed ?? defaultShowProcessed;
            }
            showProcCheckbox.title = 'Показывать обработанные данные';

            const showProcLabel = document.createElement('label');
            showProcLabel.className = 'checkbox-label';
            showProcLabel.appendChild(showProcCheckbox);
            showProcLabel.appendChild(document.createTextNode(' Обработанные'));
            showProcLabel.title = 'Показывать обработанные данные';

            if (isReference) {
                const refIcon = document.createElement('span');
                refIcon.className = 'var-ref-icon';
                refIcon.textContent = '🔗';
                refIcon.title = 'Настройки унаследованы от исходного датчика';
                row.appendChild(refIcon);
            }

            row.appendChild(varSpan);
            row.appendChild(labelInput);
            row.appendChild(colorSelect);
            row.appendChild(rawColorSelect);
            row.appendChild(unitSelect);
            row.appendChild(lowInput);
            row.appendChild(warnInput);
            row.appendChild(alarmInput);
            row.appendChild(processingSelect);
            row.appendChild(showRawLabel);
            row.appendChild(showProcLabel);

            container.appendChild(row);
            initCustomNumberInputs(container);
        }
    });
}

/** Обработчик нажатия на кнопку добавления нового датчика */
export async function onAddSensorClick() {
    if (!hasPermission(PERMISSIONS.EDIT_CONFIG)) return;
    let maxId = 0;
    config.sensors.forEach(s => {
        const n = Number(s.id);
        if (!isNaN(n) && n > maxId) maxId = n;
    });
    const newId = maxId + 1;

    const newSensor = { id: newId, name: 'Датчик ' + newId, vars: '', deleted: false };
    config.sensors.push(newSensor);
    setCurrentSensor(newId);

    updateSensorPanel(true);
    drawCurrent();
    openEditModal(newId);
    await saveConfigWithMessage();
}

/** Сохранение изменений датчика после редактирования */
export async function onSaveSensorClick() {
    if (!hasPermission(PERMISSIONS.EDIT_CONFIG)) return;
    if (editingId == null) return;

    let sCfg = config.sensors.find(s => String(s.id) === String(editingId));
    if (!sCfg) {
        sCfg = { id: editingId, deleted: false };
        config.sensors.push(sCfg);
    }

    const sensorIdInput = document.getElementById('sensorId');
    let newId = (sensorIdInput?.value.trim() || String(sCfg.id));

    if (!/^[a-zA-Z0-9_-]+$/.test(newId)) {
        alert('ID датчика может содержать только буквы, цифры, "_" и "-"');
        return;
    }

    if (newId === '') newId = String(sCfg.id);

    const oldId = String(sCfg.id);

    const conflict = config.sensors.find(s => String(s.id) === newId && s !== sCfg);
    if (conflict) {
        alert(`❌ Датчик с ID «${newId}» уже существует. Укажите уникальный ID.`);
        return;
    }

    sCfg.id = newId;

    if (String(currentSensor) === oldId) setCurrentSensor(newId);
    if (String(editingId) === oldId) setEditingId(newId);

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

    const varList = rawVars.split(',').map(v => v.trim()).filter(Boolean);
    for (const v of varList) {
        if (v.includes('_')) {
            const parts = v.split('_');
            if (parts.length !== 2) {
                alert(`Некорректный формат ссылки: "${v}". Используйте ID_переменная.`);
                return;
            }
            const refSensorId = parts[0];
            if (!sensorExists(refSensorId)) {
                alert(`Датчик "${refSensorId}" не найден. Создайте его или исправьте ссылку.`);
                return;
            }
        }
    }

    sCfg.vars = varList;

    const container = document.getElementById('varSettingsContainer');
    if (container) {
        const rows = container.querySelectorAll('.var-settings-row');
        const settings = [];

        rows.forEach(row => {
            const varName = row.dataset.var;
            if (!varName) return;

            const isReference = varName.includes('_') && (() => {
                const parts = varName.split('_');
                if (parts.length === 2) {
                    const sourceId = parts[0];
                    return config.sensors.some(s => String(s.id) === String(sourceId) && !s.deleted);
                }
                return false;
            })();

            if (isReference) {
                const labelInput = row.querySelector('.var-label-input');
                const label = labelInput ? labelInput.value.trim() : varName;
                settings.push({ var: varName });
            } else {
                const labelInput = row.querySelector('.var-label-input');
                const colorSelect = row.querySelector('.var-color-select');
                const rawColorSelect = row.querySelector('.var-rawcolor-select');
                const rawColor = rawColorSelect ? rawColorSelect.value : '#B0BEC5';
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
                    rawColor,
                    unit,
                    lowLimit: Number.isFinite(lowLimit) ? lowLimit : null,
                    warnLimit: Number.isFinite(warnLimit) ? warnLimit : null,
                    alarmLimit: Number.isFinite(alarmLimit) ? alarmLimit : null,
                    processing,
                    showRaw,
                    showProcessed
                });
            }
        });
        sCfg.varSettings = settings;
    }

    closeEditModal();
    await saveConfigWithMessage();
    updateSensorPanel(true);
    drawCurrent();
}

/** Обработчик удаления датчика */
export async function onDeleteSensorClick() {
    if (!hasPermission(PERMISSIONS.EDIT_CONFIG)) return;
    if (editingId == null) return;
    const idx = config.sensors.findIndex(s => String(s.id) === String(editingId));
    if (idx === -1) return;
    const name = config.sensors[idx].name || ('Датчик ' + editingId);
    if (!confirm(`Удалить «${name}»?`)) return;

    config.sensors.splice(idx, 1);
    markSensorDeleted(editingId);
    closeEditModal();
    await saveConfigWithMessage();
    updateSensorPanel(true);
    drawCurrent();
    setEditingId(null);
}

/** Обработчик нажатия на кнопку "Отмена" в форме редактирования */
export function onCancelSensorClick() {
    openCancelConfirm();
}

/** Обработчик подтверждения отмены (кнопка "Да" в окне подтверждения) */
export function onCancelConfirmOk() {
    closeCancelConfirm();
    closeEditModal();
    setEditingId(null);
}

/** Обработчик возврата из окна подтверждения */
export function onCancelConfirmBack() {
    closeCancelConfirm();
}

// ==================== УПРАВЛЕНИЕ ОКНОМ ПОДТВЕРЖДЕНИЯ ОТМЕНЫ ====================

/** Открыть окно подтверждения отмены */
export function openCancelConfirm() {
    const backdrop = document.getElementById('cancelConfirmBackdrop');
    if (backdrop) backdrop.style.display = 'flex';
}

/** Закрыть окно подтверждения отмены */
export function closeCancelConfirm() {
    const backdrop = document.getElementById('cancelConfirmBackdrop');
    if (backdrop) backdrop.style.display = 'none';
}
