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

// ==================== НАСТРОЙКА ОБРАБОТЧИКОВ КНОПОК ====================

/** Настройка всех обработчиков событий для кнопок и элементов интерфейса */
export function setupButtonHandlers() {
    // Кнопка входа
    const loginBtn = document.getElementById('loginBtn');
    if (loginBtn) loginBtn.addEventListener('click', login);

    // Кнопка добавления датчика
    const addBtn = document.getElementById('addSensorBtn');
    // Кнопка сохранения
    const saveBtn = document.getElementById('saveSensorBtn');
    // Кнопка отмены редактирования
    const cancelBtn = document.getElementById('cancelSensorBtn');
    // Кнопка удаления датчика
    const deleteBtn = document.getElementById('deleteSensorBtn');
    // Кнопка подтверждения отмены
    const cancelOkBtn = document.getElementById('cancelConfirmOkBtn');
    // Кнопка возврата из окна подтверждения
    const cancelBackBtn = document.getElementById('cancelConfirmBackBtn');
    // Поле ввода переменных
    const sensorVarsInput = document.getElementById('sensorVars');
    // Кнопка выхода
    const logoutBtn = document.getElementById('logoutBtn');

    if (logoutBtn) {
        logoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            await forceLogout();
        });
    }

    // При изменении списка переменных перестраиваем UI настроек
    if (sensorVarsInput) {
        sensorVarsInput.addEventListener('input', () => {
            if (editingId == null) return;
            let sCfg = config.sensors.find(s => String(s.id) === String(editingId));
            if (!sCfg) return;
            buildVarSettingsUI(sCfg);
        });
    }

    // Событие обновления конфигурации (для переоткрытия модального окна)
    window.addEventListener('config-changed', (e) => {
        if (e.detail.editingId) {
            openEditModal(e.detail.editingId);
        }
    });

    if (addBtn) addBtn.addEventListener('click', onAddSensorClick);
    if (saveBtn) saveBtn.addEventListener('click', onSaveSensorClick);
    if (cancelBtn) cancelBtn.addEventListener('click', onCancelSensorClick);
    if (deleteBtn) deleteBtn.addEventListener('click', onDeleteSensorClick);
    if (cancelOkBtn) cancelOkBtn.addEventListener('click', onCancelConfirmOk);
    if (cancelBackBtn) cancelBackBtn.addEventListener('click', onCancelConfirmBack);
}
