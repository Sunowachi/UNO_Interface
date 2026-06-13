import { config } from '../constants.js';
import { hasPermission } from '../utils/permissions.js';
import { PERMISSIONS } from '../constants.js';
import { showToast } from '../ui/toast.js';
import { updateSensorPanel, updateDevicePanel } from '../ui/index.js';
import { buildIpVarMap } from '../utils/dataUtils.js';
import { MAX_SENSORS, updateVarSettings, normalizeVars, isValidVarName, isRecentlyDeleted } from './sensorUtils.js';
import { scheduleSave } from './configSaver.js';

// ==================== СИНХРОНИЗАЦИЯ КОНФИГУРАЦИИ С ДАННЫМИ ОТ ДАТЧИКОВ ====================

/** Первоначальная синхронизация конфигурации с обнаруженными датчиками */
export async function syncConfigInitial() {
    const ipMap = buildIpVarMap();
    let updated = false;

    for (const [sensorId, varSet] of Object.entries(ipMap)) {
        if (config.sensors.length >= MAX_SENSORS) {
            console.warn('Достигнут лимит контроллеров');
            break;
        }

        const varsFromData = Array.from(varSet).filter(isValidVarName);
        let sCfg = config.sensors.find(s => String(s.id) === String(sensorId));

        if (!sCfg) {
            sCfg = { id: sensorId, name: sensorId, vars: varsFromData, deleted: false };
            updateVarSettings(sCfg);
            config.sensors.push(sCfg);
            updated = true;
        } else {
            if (sCfg.deleted) continue;

            sCfg.vars = normalizeVars(sCfg.vars);
            const merged = new Set([...sCfg.vars, ...varsFromData]);

            if (merged.size !== sCfg.vars.length) {
                sCfg.vars = Array.from(merged);
                updated = true;
            }
            updateVarSettings(sCfg);
        }
    }

    if (updated) {
        if (hasPermission(PERMISSIONS.EDIT_CONFIG) && hasPermission(PERMISSIONS.SAVE_CONFIG)) {
            scheduleSave();
        } else {
            showToast('❌ Недостаточно прав для сохранения конфигурации');
        }
        updateSensorPanel(true);
    }
}

/** Обнаружение и добавление новых датчиков (вызывается периодически) */
export async function syncNewSensors() {
    const ipMap = buildIpVarMap();
    let updated = false;

    for (const [sensorId, varSet] of Object.entries(ipMap)) {
        if (config.sensors.length >= MAX_SENSORS) {
            console.warn('Достигнут лимит контроллеров');
            break;
        }

        let sCfg = config.sensors.find(s => String(s.id) === String(sensorId));

        if (!sCfg) {
            // Проверяем, не был ли датчик недавно удалён
            if (isRecentlyDeleted(sensorId)) {
                continue;
            }
            sCfg = {
                id: sensorId,
                name: sensorId,
                vars: Array.from(varSet).filter(isValidVarName),
                deleted: false
            };
            updateVarSettings(sCfg);
            config.sensors.push(sCfg);
            updated = true;
        } else if (!sCfg.deleted) {
            const merged = new Set([
                ...normalizeVars(sCfg.vars),
                ...Array.from(varSet).filter(isValidVarName)
            ]);

            if (merged.size !== sCfg.vars.length) {
                sCfg.vars = Array.from(merged);
                updated = true;
            }
            updateVarSettings(sCfg);
        }
    }

    if (updated) {
        if (hasPermission(PERMISSIONS.SAVE_CONFIG)) {
            scheduleSave();
            showToast('✅ Добавлены новые контроллеры');
        } else {
            showToast('⚠️ Найдены новые контроллеры (нет прав на сохранение)');
        }
        updateSensorPanel(true);
        updateDevicePanel(true);
    }
}
