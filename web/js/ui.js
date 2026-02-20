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
import { saveConfigWithMessage, markSensorDeleted } from './sensors.js';
import { getAlertClass, pickHigherAlertClass, hasPermission, fetchData, sensorExists, getEffectiveVarSettings } from './utils.js';
import { initCustomNumberInputs } from './customNumberInput.js';

// Переменная для хранения ID редактируемого датчика (null - не редактируется)
let editingId = null;
// Переменная для таймера скрытия всплывающего уведомления (чтобы можно было сбросить)
let toastTimer = null;
// Переменная для отслеживания состояния панели устройств
let prevDeviceKeys = null;

/* ========== УПРАВЛЕНИЕ ИНТЕРФЕЙСОМ ========== */

// Показать основное приложение (скрыть экран входа/загрузки)
export function showApp() {
  // Если пользователь не авторизован, ничего не делаем
  if (!currentUser) return;
  const app = document.getElementById('appRoot'); // Находим корневой элемент приложения
  if (app) app.hidden = false;                    // Убираем атрибут hidden, показываем элемент
}

// Скрыть основное приложение
export function hideApp() {
  const app = document.getElementById('appRoot'); // Находим корневой элемент
  if (app) app.hidden = true;                      // Скрываем элемент
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

/* ========== АВТОРИЗАЦИЯ ========== */

// Асинхронная функция обработки входа пользователя
async function login(e) {
  // Если передан объект события, предотвращаем стандартное поведение формы (перезагрузку страницы)
  e?.preventDefault();
  // Сбрасываем текущего пользователя (на время входа)
  setCurrentUser(null);

  // Получаем значения полей логина и пароля из DOM
  const username = document.getElementById("loginUser").value;
  const password = document.getElementById("loginPass").value;

  // Выполняем POST-запрос к серверу для аутентификации
  const res = await fetch('/auth/login', {
    method: 'POST',                          // Метод запроса
    headers: {
      'Content-Type': 'application/json',    // Отправляем данные в формате JSON
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) // Если есть CSRF-токен, добавляем его в заголовки
    },
    body: JSON.stringify({ username, password }), // Тело запроса: логин и пароль в JSON
    credentials: 'include'                    // Включаем куки (для сессии)
  });

  // Получаем ответ сервера в формате JSON
  const data = await res.json();

  // Если статус ответа не OK (код не 2xx)
  if (!res.ok) {
    hideApp();                // Скрываем приложение (на случай, если оно было показано)
    openLoginModal();         // Открываем модальное окно входа

    // Если сервер вернул ошибку "blocked" (блокировка из-за множества попыток)
    if (data.error === 'blocked') {
      showLoginError('Слишком много попыток. Попробуйте позже.');
    } else {
      // Иначе показываем общую ошибку неверного логина/пароля
      showLoginError('Неверный логин или пароль');
    }
    return; // Прерываем выполнение функции
  }

  // Проверяем поле status в ответе (ожидается "ok")
  if (data.status !== "ok") {
    alert("Ошибка входа");
    return;
  }

  // Очищаем сообщение об ошибке в форме входа
  const errorEl = document.getElementById("loginError");
  if (errorEl) errorEl.textContent = '';

  closeLoginModal(); // Закрываем модальное окно входа

  try {
    // Инициализируем сессию (загружаем данные пользователя, права и т.д.)
    await initSession();
    // Инициализируем основное приложение (загружаем конфигурацию, данные датчиков)
    await init();
    // После успешной инициализации перезагружаем страницу для получения полного HTML
    window.location.reload();
  } catch (err) {
    // Если произошла ошибка при инициализации, выводим её в консоль
    console.error('Ошибка инициализации после логина:', err);
    hideApp();                // Скрываем приложение
    openLoginModal();         // Открываем окно входа снова
    showLoginError('Ошибка инициализации приложения'); // Показываем ошибку
  }
}

// Принудительный выход из системы (logout)
export async function forceLogout() {
  try {
    // Отправляем POST-запрос на выход (удаление сессии на сервере)
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
  } catch {} // Игнорируем ошибки сети (если сервер недоступен)

  setCurrentUser(null); // Очищаем текущего пользователя в приложении
  hideApp();            // Скрываем основное приложение
  openLoginModal();     // Открываем окно входа
}

// Функции для открытия/закрытия модального окна авторизации
export function openLoginModal() {
  document.getElementById("loginModal").classList.add("show"); // Добавляем класс "show" для отображения
}

export function closeLoginModal() {
  document.getElementById("loginModal").classList.remove("show"); // Убираем класс "show"
}

// Показать сообщение об ошибке в модальном окне входа
function showLoginError(message) {
  const errorEl = document.getElementById("loginError"); // Находим элемент для ошибки
  if (errorEl) {
    errorEl.textContent = message;       // Устанавливаем текст ошибки
    errorEl.style.color = '#ff0000';      // Красный цвет текста
    errorEl.style.marginTop = '10px';     // Отступ сверху для визуального разделения
  }
}

/* ========== НАСТРОЙКА ОБРАБОТЧИКОВ ========== */

// Настройка всех обработчиков событий для кнопок и элементов интерфейса
export function setupButtonHandlers() {
  // Кнопка входа в систему
  const loginBtn = document.getElementById('loginBtn');
  if (loginBtn) loginBtn.addEventListener('click', login); // При клике вызываем функцию login

  // Кнопка добавления датчика
  const addBtn = document.getElementById('addSensorBtn');
  // Кнопка сохранения изменений датчика
  const saveBtn = document.getElementById('saveSensorBtn');
  // Кнопка отмены редактирования
  const cancelBtn = document.getElementById('cancelSensorBtn');
  // Кнопка удаления датчика
  const deleteBtn = document.getElementById('deleteSensorBtn');
  // Кнопка подтверждения отмены в модальном окне подтверждения
  const cancelOkBtn = document.getElementById('cancelConfirmOkBtn');
  // Кнопка возврата из модального окна подтверждения
  const cancelBackBtn = document.getElementById('cancelConfirmBackBtn');
  // Поле ввода переменных датчика (список переменных через запятую)
  const sensorVarsInput = document.getElementById('sensorVars');

  // Обработчик изменения поля ввода переменных (срабатывает при вводе текста)
  if (sensorVarsInput) {
    sensorVarsInput.addEventListener('input', () => {
      // Если нет редактируемого датчика, ничего не делаем
      if (editingId == null) return;
      // Ищем конфигурацию редактируемого датчика в общем списке
      let sCfg = config.sensors.find(s => String(s.id) === String(editingId));
      if (!sCfg) return; // Если не найден, выходим
      // Перестраиваем интерфейс настроек переменных (UI для каждой переменной)
      buildVarSettingsUI(sCfg);
    });
  }

  // Обновление открытого редактора при изменении конфигурации
  window.addEventListener('config-changed', (e) => {
    if (e.detail.editingId) {
      // Переоткрываем модальное окно, чтобы показать актуальные настройки
      openEditModal(e.detail.editingId);
    }
  });

  // Привязываем обработчики кликов к соответствующим кнопкам
  if (addBtn) addBtn.addEventListener('click', onAddSensorClick);
  if (saveBtn) saveBtn.addEventListener('click', onSaveSensorClick);
  if (cancelBtn) cancelBtn.addEventListener('click', onCancelSensorClick);
  if (deleteBtn) deleteBtn.addEventListener('click', onDeleteSensorClick);
  if (cancelOkBtn) cancelOkBtn.addEventListener('click', onCancelConfirmOk);
  if (cancelBackBtn) cancelBackBtn.addEventListener('click', onCancelConfirmBack);
}

// Настройка элементов управления временным диапазоном (поля дней, часов, минут и кнопка "Применить")
export function setupTimeRangeControls() {
  // Поле ввода количества дней
  const dInput = document.getElementById('timeDays');
  // Поле ввода часов
  const hInput = document.getElementById('timeHours');
  // Поле ввода минут
  const mInput = document.getElementById('timeMinutes');
  // Кнопка применения нового диапазона
  const applyBtn = document.getElementById('applyTimeRangeBtn');

  // Если хотя бы один из элементов не найден, прекращаем выполнение
  if (!dInput || !hInput || !mInput || !applyBtn) return;

  // Устанавливаем значения полей из текущего объекта timeRange
  dInput.value = timeRange.days;
  hInput.value = timeRange.hours;
  mInput.value = timeRange.minutes;

  // Внутренняя функция для применения нового диапазона (асинхронная)
  async function applyRange() {
    // Получаем числа из полей ввода (parseInt с основанием 10)
    const d = parseInt(dInput.value, 10);
    const h = parseInt(hInput.value, 10);
    const m = parseInt(mInput.value, 10);

    // Проверяем, что значения не отрицательные
    if ((d < 0) || (h < 0) || (m < 0)) {
      alert('Значения диапазона времени не могут быть отрицательными');
      return;
    }

    // Обновляем объект timeRange, если значения не числа — подставляем 0
    timeRange.days = isNaN(d) ? 0 : d;
    timeRange.hours = isNaN(h) ? 0 : h;
    timeRange.minutes = isNaN(m) ? 0 : m;

    // Показываем индикатор загрузки графиков
    const loadingIndicator = document.getElementById('chart-loading');
    if (loadingIndicator) loadingIndicator.style.display = 'block';

    try {
      // Загружаем данные за новый диапазон (функция fetchData из utils)
      await fetchData();
    } catch (error) {
      console.error('Ошибка при загрузке данных по новому диапазону:', error);
      alert('Не удалось загрузить данные за выбранный период.');
    } finally {
      // В любом случае скрываем индикатор загрузки
      if (loadingIndicator) loadingIndicator.style.display = 'none';
    }
  }

  // Назначаем обработчик клика на кнопку "Применить"
  applyBtn.addEventListener('click', applyRange);

  // Добавляем обработчик нажатия клавиш для полей ввода: если нажат Enter, вызываем applyRange
  [dInput, hInput, mInput].forEach(inp => {
    inp.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') await applyRange();
    });
  });
}

/* ========== ОБНОВЛЕНИЕ ИНТЕРФЕЙСА ========== */

// Панель датчиков
export function updateSensorPanel(forceRebuild = false) {
  const list = document.getElementById('sensorList'); // Находим контейнер списка (ul)
  if (!list) return; // Если контейнер отсутствует, выходим

  // Фильтруем датчики, исключая помеченные как удалённые (deleted = true)
  const visibleSensors = config.sensors.filter(s => !s.deleted);

  // Если нет ни одного видимого датчика
  if (visibleSensors.length === 0) {
    const li = document.createElement('li');          // Создаём элемент списка
    li.textContent = 'Нет настроенных датчиков';
    li.style.color = '#777';
    list.appendChild(li);                              // Добавляем в список
    setCurrentSensor(null);                             // Сбрасываем выбранный датчик

    const chartsContainer = document.getElementById('chartsContainer'); // Контейнер графиков
    if (chartsContainer) chartsContainer.innerHTML = ''; // Очищаем графики
    return;
  }

  // Полная перестройка (при изменении конфигурации)
  if (forceRebuild) {
    list.innerHTML = ''; // Очищаем список перед перестроением
    let redAlertSensors = [];

    visibleSensors.forEach((sCfg, index) => {
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
          sensorAlertClass = pickHigherAlertClass(sensorAlertClass, varAlert);
        }
      }

      if (sensorAlertClass === 'blink-red') {
        const sensorName = sCfg.name || 'Датчик ' + (index + 1);
        redAlertSensors.push(sensorName);
      }

      const li = document.createElement('li');
      li.dataset.sensorId = sCfg.id;
      li.style.cssText = 'cursor: pointer; padding: 4px 4px; border-bottom: 1px solid #eee; display: flex; align-items: center; gap: 4px;';

      // Проверяем, есть ли ссылочные переменные
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

      // Создаём nameSpan и добавляем его
      const nameSpan = document.createElement('span');
      nameSpan.className = 'sensor-name';
      nameSpan.textContent = sCfg.name || 'Датчик ' + (index + 1);
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
    return;
  }
  // Инкрементальное обновление (только классы тревоги и выделение)
  const existingMap = new Map();
  for (let li of list.children) {
    const id = li.dataset.sensorId;
    if (id) existingMap.set(id, li);
  }

  let redAlertSensors = [];

  visibleSensors.forEach((sCfg, index) => {
    const id = String(sCfg.id);
    let li = existingMap.get(id);

    // Определяем класс тревоги
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
        sensorAlertClass = pickHigherAlertClass(sensorAlertClass, varAlert);
      }
    }

    if (sensorAlertClass === 'blink-red') {
      const sensorName = sCfg.name || 'Датчик ' + (index + 1);
      redAlertSensors.push(sensorName);
    }

    if (li) {
      // Обновляем классы
      li.classList.remove('blink-blue', 'blink-yellow', 'blink-red');
      if (sensorAlertClass) li.classList.add(sensorAlertClass);

      // Обновляем выделение
      if (String(sCfg.id) === String(currentSensor)) {
        li.classList.add('sensor-selected');
      } else {
        li.classList.remove('sensor-selected');
      }

      existingMap.delete(id);
    } else {
      // Новый датчик – создаём элемент
      li = document.createElement('li');
      li.dataset.sensorId = id;
      li.style.cssText = 'cursor: pointer; padding: 4px 4px; border-bottom: 1px solid #eee; display: flex; align-items: center; gap: 4px;';

      // Проверяем, есть ли ссылочные переменные
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

      // Затем создаём nameSpan и добавляем его
      const nameSpan = document.createElement('span');
      nameSpan.className = 'sensor-name';
      nameSpan.textContent = sCfg.name || 'Датчик ' + (index + 1);
      nameSpan.style.flex = '1 1 auto';
      li.appendChild(nameSpan);

      li.addEventListener('click', () => selectSensor(sCfg.id));

      if (String(sCfg.id) === String(currentSensor)) {
        li.classList.add('sensor-selected');
      }

      li.classList.remove('blink-blue', 'blink-yellow', 'blink-red');
      if (sensorAlertClass) li.classList.add(sensorAlertClass);

      list.appendChild(li);
    }
  });

  // Удаляем элементы датчиков, которых больше нет
  for (let li of existingMap.values()) {
    li.remove();
  }
  updateRedAlert(redAlertSensors);
}

// Обновление панели устройств (список активных датчиков с их переменными)
export function updateDevicePanel(forceRebuild = false) {
  const deviceList = document.getElementById('deviceList');
  if (!deviceList) return;

  let prevDeviceKeys = null;

  // Формируем строку из всех ключей allSensors (чтобы отслеживать изменения)
  const currentKeys = Object.keys(allSensors).filter(k => k.includes(':')).sort().join(',');

  // Если не принудительно и ключи не изменились – ничего не делаем
  if (!forceRebuild && prevDeviceKeys === currentKeys) return;

  prevDeviceKeys = currentKeys;
  deviceList.innerHTML = '';

  const groupedBySensor = {};
  for (const key of Object.keys(allSensors)) {
    const idx = key.indexOf(':');
    if (idx === -1) continue;
    const sensorId = key.slice(0, idx);
    const variable = key.slice(idx + 1);
    if (!groupedBySensor[sensorId]) groupedBySensor[sensorId] = [];
    groupedBySensor[sensorId].push(variable);
  }

  if (Object.keys(groupedBySensor).length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Нет активных устройств';
    li.style.color = '#777';
    deviceList.appendChild(li);
    return;
  }

  for (const [sensorId, vars] of Object.entries(groupedBySensor)) {
    const li = document.createElement('li');
    li.style.padding = '4px 0';
    li.textContent = `ID: ${sensorId} | Переменные: ${vars.join(', ')}`;
    deviceList.appendChild(li);
  }
}

// Функция выбора датчика по его ID
export function selectSensor(id) {
  setCurrentSensor(id);          // Устанавливаем текущий датчик
  updateSensorPanel();           // Обновляем панель датчиков (подсветка выбранного)
  drawCurrent();                 // Отрисовываем графики для выбранного датчика
}

/* ========== УПРАВЛЕНИЕ ДАТЧИКАМИ ========== */

// Открытие модального окна редактирования датчика
export function openEditModal(id) {
  // Если нет прав на редактирование, ничего не делаем
  if (!hasPermission(PERMISSIONS.EDIT_CONFIG)) return;
  editingId = id; // Запоминаем ID редактируемого датчика

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

// Функция для управления кнопкой добавления датчика
function updateAddButtonVisibility() {
  const footer = document.getElementById('sensorPanelFooter');
  if (!footer) return;

  const canEdit = hasPermission(PERMISSIONS.EDIT_CONFIG);
  let addBtn = document.getElementById('addSensorBtn');

  if (canEdit) {
    if (!addBtn) {
      // Создаём кнопку, если её нет
      addBtn = document.createElement('button');
      addBtn.id = 'addSensorBtn';
      addBtn.className = 'btn btn-full';
      addBtn.innerHTML = '➕ Добавить датчик';
      addBtn.addEventListener('click', onAddSensorClick);
      footer.appendChild(addBtn);
    }
  } else {
    // Удаляем кнопку, если она есть
    if (addBtn) addBtn.remove();
  }
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
  if (String(editingId) === oldId) editingId = newId;

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
  editingId = null;    // Сбрасываем ID редактирования
}

/* ========== МОДАЛЬНОЕ ОКНО ПОДТВЕРЖДЕНИЯ ОТМЕНЫ ========== */

// Функции для управления окном подтверждения отмены редактирования
export function openCancelConfirm() {
  const backdrop = document.getElementById('cancelConfirmBackdrop');
  if (backdrop) backdrop.style.display = 'flex'; // Показываем фон
}

export function closeCancelConfirm() {
  const backdrop = document.getElementById('cancelConfirmBackdrop');
  if (backdrop) backdrop.style.display = 'none'; // Скрываем фон
}

// Обработчик нажатия на кнопку "Отмена" в форме редактирования (открывает подтверждение)
export function onCancelSensorClick() {
  openCancelConfirm();
}

// Обработчик подтверждения отмены (кнопка "Да" в окне подтверждения)
export function onCancelConfirmOk() {
  closeCancelConfirm(); // Закрываем окно подтверждения
  closeEditModal();      // Закрываем окно редактирования
  editingId = null;      // Сбрасываем ID редактирования
}

// Обработчик возврата из окна подтверждения (кнопка "Назад")
export function onCancelConfirmBack() {
  closeCancelConfirm(); // Просто закрываем окно подтверждения
}

/* ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ========== */

// Управление глобальной тревогой
function updateRedAlert(redAlertSensors) {
  const body = document.body;
  const redAlertBar = document.getElementById('redAlertBar');
  const alertMessageSpan = redAlertBar ? redAlertBar.querySelector('.alert-message') : null;
  const sensorPanel = document.getElementById('sensorPanel');
  const ALERT_BAR_HEIGHT = 60;

  if (redAlertSensors.length > 0) {
    body.classList.add('red-alert');
    body.style.paddingTop = ALERT_BAR_HEIGHT + 'px';
    if (sensorPanel) sensorPanel.classList.add('alert-shown');

    if (redAlertBar && alertMessageSpan) {
      alertMessageSpan.textContent = '⚠️ Тревога: ' + redAlertSensors.join(', ');
      redAlertBar.classList.add('show');
      redAlertBar.hidden = false;
    }
  } else {
    body.classList.remove('red-alert');
    body.style.paddingTop = '';
    if (sensorPanel) sensorPanel.classList.remove('alert-shown');

    if (redAlertBar) {
      redAlertBar.classList.remove('show');
      setTimeout(() => {
        if (!redAlertBar.classList.contains('show')) {
          redAlertBar.hidden = true;
        }
      }, 300);
    }
  }
}

// Обновление таймера работы системы (отображается в интерфейсе)
export function updateTimer() {
  if (!serverStart) return; // Если время запуска неизвестно, ничего не делаем
  const timerEl = document.getElementById('timer');
  if (!timerEl) return;

  // Вычисляем прошедшее время в секундах
  const elapsedSec = Math.floor((Date.now() - serverStart) / 1000);
  // Разбиваем на часы, минуты, секунды
  const h = Math.floor(elapsedSec / 3600);
  const m = Math.floor((elapsedSec % 3600) / 60);
  const s = elapsedSec % 60;
  // Форматируем строку с ведущими нулями и выводим
  timerEl.textContent = `Время работы: ${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// Показать всплывающее уведомление (toast)
export function showToast(message) {
  let toast = document.getElementById('toastMessage'); // Ищем существующий элемент
  if (!toast) {
    // Если элемента нет, создаём его
    toast = document.createElement('div');
    toast.id = 'toastMessage';
    toast.className = 'toast'; // Базовый класс для стилей
    document.body.appendChild(toast);
  }

  toast.textContent = message;               // Устанавливаем текст
  toast.classList.add('toast-show');          // Добавляем класс для отображения (анимация)

  // Если уже есть запущенный таймер скрытия, сбрасываем его
  if (toastTimer) clearTimeout(toastTimer);
  // Устанавливаем новый таймер на скрытие через 2.5 секунды
  toastTimer = setTimeout(() => {
    toast.classList.remove('toast-show');     // Убираем класс, скрываем
  }, 2500);
}