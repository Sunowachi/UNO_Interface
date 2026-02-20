import { config, csrfToken } from '../constants.js';
import { lockSession } from '../session.js';
import { showToast } from '../ui/toast.js';
import { pollConfig } from './configLoader.js';
import { SAVE_DEBOUNCE_MS } from './sensorUtils.js';

let saveCount = 0;
// Переменная для хранения идентификатора таймера автосохранения
let saveTimer = null;

// Функция планирования автосохранения: сбрасывает предыдущий таймер и устанавливает новый
export function scheduleSave() {
  // Очищаем предыдущий таймер, если он был
  clearTimeout(saveTimer);
  // Устанавливаем новый таймер, который через SAVE_DEBOUNCE_MS вызовет saveConfigSilent
  saveTimer = setTimeout(saveConfigSilent, SAVE_DEBOUNCE_MS);
}

export function isSaving() {
    return saveCount > 0;
}

// Фоновая отправка конфигурации на сервер (без уведомления пользователя)
export async function saveConfigSilent() {
  saveCount++;
  try {
    // Выполняем POST-запрос к /config/save
    const res = await fetch('/config/save', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
      },
      body: JSON.stringify(config, null, 2) // Отправляем конфигурацию в формате JSON с отступами
    });

    // Если статус 401 или 403, выходим из системы
    if (res.status === 401 || res.status === 403) {
      lockSession()
      return;
    }

    // Если ответ не успешен, генерируем ошибку
    if (!res.ok) throw new Error('HTTP error: ' + res.status);
    await pollConfig(true);  // принудительная синхронизация
  } catch (e) {
    // Логируем ошибку, но не показываем пользователю
    console.error('Ошибка автосохранения:', e);
  } finally {
    saveCount--;
  }
}

// Сохранение конфигурации с отображением статуса пользователю (вызывается при ручном сохранении)
export async function saveConfigWithMessage() {
  saveCount++;
  try {
    // Выполняем POST-запрос к /config/save
    const res = await fetch('/config/save', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
      },
      body: JSON.stringify(config, null, 2)
    });

    // Если статус 401 или 403
    if (res.status === 401 || res.status === 403) {
      alert('❌ Сессия истекла. Войдите снова.');
      lockSession()
      return;
    }

    // Получаем текст ответа
    const text = await res.text();
    // Если ответ содержит "OK", считаем сохранение успешным
    if (text.includes('OK')) {
      showToast('✅ Настройки сохранены');
      await pollConfig(true);  // принудительная синхронизация
    } else {
      // Иначе показываем ошибку
      alert('❌ Ошибка сохранения: ' + text);
    }
  } catch (e) {
    alert('❌ Ошибка сохранения: ' + e.message);
  } finally {
  saveCount--;
  }
}
