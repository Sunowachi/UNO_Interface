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

// Открытие модального окна редактирования датчика
export function openEditModal(id) {
  // Если нет прав на редактирование, ничего не делаем
  if (!hasPermission(PERMISSIONS.EDIT_CONFIG)) return;
  setEditingId(id); // Запоминаем ID редактируемого датчика

  const backdrop = document.getElementById('editModalBackdrop'); // Фон модального окна
  if (!backdrop) return;

  // Показываем панель устройств
  const devicePanel = document.getElementById('devicePanel');
  if (devicePanel) {
  updateDevicePanel();
  devicePanel.classList.add('show');
  }

  // Ищем конфигурацию датчика с таким ID в общем списке
  let sCfg = config.sensors.find(s => String(s.id) === String(id));
  // Если датчик не найден (возможно, новый), создаём временную конфигурацию
  if (!sCfg) {
    sCfg = { id, name: 'Датчик ' + id, vars: '', deleted: false };
    config.sensors.push(sCfg); // Добавляем в конфигурацию
  }

  // Получаем элементы формы редактирования
  const sensorIdInput = document.getElementById('sensorId');
  const sensorNameInput = document.getElementById('sensorName');
  const sensorVarsInput = document.getElementById('sensorVars');

  // Заполняем поля значениями из конфигурации
  if (sensorIdInput) sensorIdInput.value = sCfg.id != null ? String(sCfg.id) : '';
  if (sensorNameInput) sensorNameInput.value = sCfg.name || '';
  if (sensorVarsInput) {
    // Если vars - массив, объединяем через запятую, иначе используем как есть (строка)
    if (Array.isArray(sCfg.vars)) {
      sensorVarsInput.value = sCfg.vars.join(',');
    } else {
      sensorVarsInput.value = sCfg.vars || '';
    }
  }

  // Добавляем подсказку под полем ввода переменных
  if (sensorVarsInput && !document.getElementById('sensorVarsHint')) {
    const hint = document.createElement('small');
    hint.id = 'sensorVarsHint';
    hint.style.cssText = 'color: var(--color-text-secondary); display: block; margin-top: 4px;';
    hint.textContent = 'Для импорта данных из другого датчика используйте формат ID_переменная (например, Sensor1_temp)';
    sensorVarsInput.parentNode.insertBefore(hint, sensorVarsInput.nextSibling);
  }

  // Строим интерфейс для настройки каждой переменной (поля для цветов, пределов и т.д.)
  buildVarSettingsUI(sCfg);
  // Показываем модальное окно (делаем фон видимым)
  backdrop.style.display = 'flex';
}

// Закрытие модального окна редактирования
export function closeEditModal() {
  const backdrop = document.getElementById('editModalBackdrop');
  if (backdrop) backdrop.style.display = 'none'; // Скрываем фон

  // Скрываем панель устройств
  const devicePanel = document.getElementById('devicePanel');
  if (devicePanel) devicePanel.classList.remove('show');

  // Удаляем подсказку при закрытии окна
  const hint = document.getElementById('sensorVarsHint');
  if (hint) hint.remove();
}

// Создание пользовательского интерфейса для настройки параметров каждой переменной датчика
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

        // Метка с именем переменной
        const varSpan = document.createElement('span');
        varSpan.textContent = varName;
        varSpan.className = 'var-name-label';
        varSpan.setAttribute('autocomplete', 'off');
        varSpan.title = 'Имя переменной (импортировано)';

        // Информация об источнике
        const sourceInfo = document.createElement('span');
        sourceInfo.className = 'var-source-info';
        sourceInfo.textContent = `↳ от ${sourceName}`;
        sourceInfo.title = `Настройки унаследованы от датчика «${sourceName}»`;

        // Значок ссылки
        const refIcon = document.createElement('span');
        refIcon.className = 'var-ref-icon';
        refIcon.textContent = '🔗';
        refIcon.title = 'Импортированная переменная (настройки только для просмотра)';

        // Собираем строку
        row.appendChild(varSpan);
        row.appendChild(sourceInfo);
        row.appendChild(refIcon);

        container.appendChild(row);
        // Не вызываем initCustomNumberInputs, так как нет числовых полей
    } else {

    const row = document.createElement('div');
    row.className = 'var-settings-row';
    row.dataset.var = varName;

    // Метка с именем переменной
    const varSpan = document.createElement('span');
    varSpan.textContent = varName;
    varSpan.className = 'var-name-label';
    varSpan.setAttribute('autocomplete', 'off');
    varSpan.title = 'Имя переменной (из данных датчика)';

    // Поле названия графика
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

    // Цвет обработанных данных
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

    // Цвет сырых данных
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

    // Единицы измерения
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

    // Поля пределов
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

    // Режим обработки
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

    // Чекбоксы
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

    // Значок ссылки
    if (isReference) {
      const refIcon = document.createElement('span');
      refIcon.className = 'var-ref-icon';
      refIcon.textContent = '🔗';
      refIcon.title = 'Настройки унаследованы от исходного датчика';
      row.appendChild(refIcon);
    }

    // Добавляем все элементы в строку
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
  };
  });
}

// Обработчик нажатия на кнопку добавления нового датчика
export async function onAddSensorClick() {
  if (!hasPermission(PERMISSIONS.EDIT_CONFIG)) return;
  let maxId = 0;
  // Находим максимальный числовой ID среди существующих датчиков
  config.sensors.forEach(s => {
    const n = Number(s.id);
    if (!isNaN(n) && n > maxId) maxId = n;
  });
  const newId = maxId + 1; // Новый ID на единицу больше

  // Создаём объект нового датчика
  const newSensor = { id: newId, name: 'Датчик ' + newId, vars: '', deleted: false };
  config.sensors.push(newSensor); // Добавляем в конфигурацию
  setCurrentSensor(newId);        // Делаем его текущим

  updateSensorPanel(true); // Обновляем панель датчиков
  drawCurrent();       // Отрисовываем графики (пока пустые)
  openEditModal(newId); // Открываем окно редактирования для нового датчика
  // Немедленное сохранение
  await saveConfigWithMessage();
}

// Сохранение изменений датчика после редактирования
export async function onSaveSensorClick() {
  if (!hasPermission(PERMISSIONS.EDIT_CONFIG)) return;
  // Если нет редактируемого датчика, выходим
  if (editingId == null) return;

  // Ищем конфигурацию редактируемого датчика
  let sCfg = config.sensors.find(s => String(s.id) === String(editingId));
  // Если не найден, создаём новый объект и добавляем
  if (!sCfg) {
    sCfg = { id: editingId, deleted: false };
    config.sensors.push(sCfg);
  }

  // Получаем поле ввода ID датчика
  const sensorIdInput = document.getElementById('sensorId');
  let newId = (sensorIdInput?.value.trim() || String(sCfg.id)); // Новый ID или старый

  // Проверяем, что ID состоит только из допустимых символов (буквы, цифры, _, -)
  if (!/^[a-zA-Z0-9_-]+$/.test(newId)) {
    alert('ID датчика может содержать только буквы, цифры, "_" и "-"');
    return;
  }

  // Если после проверки newId пустая строка, оставляем старый ID
  if (newId === '') newId = String(sCfg.id);

  const oldId = String(sCfg.id); // Сохраняем старый ID для сравнения

  // Проверяем, не существует ли уже датчик с таким ID (кроме текущего)
  const conflict = config.sensors.find(s => String(s.id) === newId && s !== sCfg);
  if (conflict) {
    alert(`❌ Датчик с ID «${newId}» уже существует. Укажите уникальный ID.`);
    return;
  }

  sCfg.id = newId; // Присваиваем новый ID

  // Если текущий выбранный датчик имел старый ID, обновляем его на новый
  if (String(currentSensor) === oldId) setCurrentSensor(newId);
  // Если редактируемый датчик имел старый ID, обновляем editingId
  if (String(editingId) === oldId) setEditingId(newId);

  // Получаем поле имени датчика
  const sensorNameInput = document.getElementById('sensorName');
  // Получаем поле списка переменных
  const sensorVarsInput = document.getElementById('sensorVars');

  // Устанавливаем имя: если поле не пустое, используем его, иначе "Датчик {newId}"
  sCfg.name = sensorNameInput
    ? (sensorNameInput.value.trim() || ('Датчик ' + newId))
    : ('Датчик ' + newId);

  // Получаем строку переменных и проверяем на допустимые символы
  const rawVars = sensorVarsInput ? sensorVarsInput.value.trim() : '';
  if (!/^[a-zA-Z0-9_,\s-]*$/.test(rawVars)) {
    alert('Недопустимые символы в списке переменных');
    return;
  }

  // Валидация ссылочных переменных
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

  sCfg.vars = rawVars.split(',').map(v => v.trim()).filter(Boolean); // массив

  // Собираем настройки для каждой переменной из UI
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
        settings.push({ var: varName});
      } else {
        // Находим все элементы внутри строки
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

        // Извлекаем значения (если элемент отсутствует, подставляем значения по умолчанию)
        const label = labelInput ? labelInput.value.trim() : varName;
        const color = colorSelect ? (colorSelect.value || '#ff0000') : '#ff0000';
        const unit = unitSelect ? unitSelect.value.trim() : '';

        const lowStr = lowInput ? lowInput.value.trim() : '';
        const warnStr = warnInput ? warnInput.value.trim() : '';
        const alarmStr = alarmInput ? alarmInput.value.trim() : '';

        // Преобразуем в числа, если строка не пустая; иначе null
        const lowLimit = lowStr === '' ? null : Number(lowStr);
        const warnLimit = warnStr === '' ? null : Number(warnStr);
        const alarmLimit = alarmStr === '' ? null : Number(alarmStr);

        const processing = processingSelect ? (processingSelect.value || 'none') : 'none';
        const showRaw = showRawCheckbox ? showRawCheckbox.checked : true;
        const showProcessed = showProcCheckbox
            ? showProcCheckbox.checked
            : (processing !== 'none'); // По умолчанию показывать обработанные, если режим не "none"

        // Формируем объект настроек для переменной
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
    sCfg.varSettings = settings; // Сохраняем в конфигурацию
  }

  closeEditModal(); // Закрываем окно редактирования
  await saveConfigWithMessage(); // Сохраняем конфигурацию на сервер с уведомлением
  updateSensorPanel(true); // Обновляем панель датчиков
  drawCurrent();       // Перерисовываем графики с новыми настройками
}

// Обработчик удаления датчика
export async function onDeleteSensorClick() {
  if (!hasPermission(PERMISSIONS.EDIT_CONFIG)) return;
  // Если нет редактируемого датчика, выходим
  if (editingId == null) return;
  // Находим индекс датчика в массиве
  const idx = config.sensors.findIndex(s => String(s.id) === String(editingId));
  if (idx === -1) return;
  // Получаем имя датчика для сообщения
  const name = config.sensors[idx].name || ('Датчик ' + editingId);
  // Запрашиваем подтверждение у пользователя
  if (!confirm(`Удалить «${name}»?`)) return;

  // Удаляем датчик из массива (splice)
  config.sensors.splice(idx, 1);
  // Помечаем датчик как недавно удалённый, чтобы избежать авто-восстановления
  markSensorDeleted(editingId);
  closeEditModal(); // Закрываем модальное окно
  await saveConfigWithMessage(); // Сохраняем изменения
  updateSensorPanel(true); // Обновляем панель
  drawCurrent();       // Перерисовываем графики (уже без удалённого)
  setEditingId(null);    // Сбрасываем ID редактирования
}

// Обработчик нажатия на кнопку "Отмена" в форме редактирования (открывает подтверждение)
export function onCancelSensorClick() {
  openCancelConfirm();
}

// Обработчик подтверждения отмены (кнопка "Да" в окне подтверждения)
export function onCancelConfirmOk() {
  closeCancelConfirm(); // Закрываем окно подтверждения
  closeEditModal();     // Закрываем окно редактирования
  setEditingId(null);   // Сбрасываем ID редактирования
}

export function onCancelConfirmBack() {
    closeCancelConfirm();
}

// Функции для управления окном подтверждения отмены редактирования
export function openCancelConfirm() {
  const backdrop = document.getElementById('cancelConfirmBackdrop');
  if (backdrop) backdrop.style.display = 'flex'; // Показываем фон
}

export function closeCancelConfirm() {
  const backdrop = document.getElementById('cancelConfirmBackdrop');
  if (backdrop) backdrop.style.display = 'none'; // Скрываем фон
}
