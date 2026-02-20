// Управление глобальной тревогой
export function updateRedAlert(redAlertSensors) {
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