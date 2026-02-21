import { login, forceLogout } from './login.js';
import { config, editingId } from '../constants.js';
import {
    onAddSensorClick,
    onSaveSensorClick,
    onCancelSensorClick,
    onDeleteSensorClick,
    onCancelConfirmOk,
    onCancelConfirmBack,
    buildVarSettingsUI,
    openEditModal
} from './editModal.js';

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
  // Кнопка выхода
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      await forceLogout();
    });
  }

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