// ==================== УПРАВЛЕНИЕ ГЛОБАЛЬНОЙ ПАНЕЛЬЮ ТРЕВОГИ ====================

const ALERT_BAR_HEIGHT = 60; // Высота красной панели в пикселях

/** Обновление состояния глобальной тревоги на основе списка датчиков в красной зоне */
export function updateRedAlert(redAlertSensors) {
    const body = document.body;
    const redAlertBar = document.getElementById('redAlertBar');
    const alertMessageSpan = redAlertBar ? redAlertBar.querySelector('.alert-message') : null;
    const sensorPanel = document.getElementById('sensorPanel');

    if (redAlertSensors.length > 0) {
        // Есть активная тревога – показываем панель и сдвигаем контент
        body.classList.add('red-alert');
        body.style.paddingTop = ALERT_BAR_HEIGHT + 'px';
        if (sensorPanel) sensorPanel.classList.add('alert-shown');

        if (redAlertBar && alertMessageSpan) {
            alertMessageSpan.textContent = '⚠️ Тревога: ' + redAlertSensors.join(', ');
            redAlertBar.classList.add('show');
            redAlertBar.hidden = false;
        }
    } else {
        // Тревоги нет – скрываем панель
        body.classList.remove('red-alert');
        body.style.paddingTop = '';
        if (sensorPanel) sensorPanel.classList.remove('alert-shown');

        if (redAlertBar) {
            redAlertBar.classList.remove('show');
            // Даём время на завершение анимации, затем скрываем элемент
            setTimeout(() => {
                if (!redAlertBar.classList.contains('show')) {
                    redAlertBar.hidden = true;
                }
            }, 300);
        }
    }
}
