import { config, csrfToken } from '../constants.js';
import { lockSession } from '../session.js';
import { showToast } from '../ui/toast.js';
import { pollConfig } from './configLoader.js';
import { SAVE_DEBOUNCE_MS } from './sensorUtils.js';

// ==================== АВТОСОХРАНЕНИЕ КОНФИГУРАЦИИ ====================

let saveCount = 0;
let saveTimer = null;

/** Запланировать автосохранение с задержкой */
export function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveConfigSilent, SAVE_DEBOUNCE_MS);
}

/** Проверка, выполняется ли в данный момент сохранение */
export function isSaving() {
    return saveCount > 0;
}

/** Тихая отправка конфигурации на сервер (без уведомления пользователя) */
export async function saveConfigSilent() {
    saveCount++;
    try {
        const res = await fetch('/config/save', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
            },
            body: JSON.stringify(config, null, 2)
        });

        if (res.status === 401 || res.status === 403) {
            lockSession();
            return;
        }

        if (!res.ok) throw new Error('HTTP error: ' + res.status);
        await pollConfig(true);
    } catch (e) {
        console.error('Ошибка автосохранения:', e);
    } finally {
        saveCount--;
    }
}

/** Сохранение конфигурации с отображением статуса пользователю */
export async function saveConfigWithMessage() {
    saveCount++;
    try {
        const res = await fetch('/config/save', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
            },
            body: JSON.stringify(config, null, 2)
        });

        if (res.status === 401 || res.status === 403) {
            alert('❌ Сессия истекла. Войдите снова.');
            lockSession();
            return;
        }

        const text = await res.text();
        if (text.includes('OK')) {
            showToast('✅ Настройки сохранены');
            await pollConfig(true);
        } else {
            alert('❌ Ошибка сохранения: ' + text);
        }
    } catch (e) {
        alert('❌ Ошибка сохранения: ' + e.message);
    } finally {
        saveCount--;
    }
}
