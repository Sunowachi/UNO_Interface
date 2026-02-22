import { initSession, openLoginModal } from './session.js';
import { init } from './api.js';
import { setupButtonHandlers } from './ui/buttonHandlers.js';
import { setupTimeRangeControls } from './ui/timeRange.js';
import { hideApp } from './ui/app.js';
import { initCustomNumberInputs } from './inputArrows.js';
import { initExportModal } from './ui/export.js';
import { initSensorManager, initUserManager } from './ui/sensorManager.js';

// ==================== ТОЧКА ВХОДА ПОСЛЕ ЗАГРУЗКИ DOM ====================
document.addEventListener('DOMContentLoaded', async () => {
    hideApp();                              // Скрываем основное приложение до авторизации
    setupButtonHandlers();                  // Настраиваем обработчики кнопок
    setupTimeRangeControls();               // Настраиваем элементы управления временным диапазоном
    initExportModal();                      // Инициализируем модальное окно экспорта

    try {
        await initSession();                 // Проверяем существующую сессию
        await init();                        // Загружаем данные и инициализируем приложение
        initCustomNumberInputs();             // Применяем кастомные стрелки для числовых полей
        initSensorManager();                  // Инициализируем менеджер датчиков
        initUserManager();                    // Инициализируем менеджер пользователей
    } catch (e) {
        setTimeout(openLoginModal, 100);      // В случае ошибки показываем окно входа
    }
});
