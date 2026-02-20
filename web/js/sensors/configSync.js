import { config } from '../constants.js';
import { hasPermission } from '../utils/permissions.js';
import { PERMISSIONS } from '../constants.js';
import { showToast } from '../ui/toast.js';
import { updateSensorPanel, updateDevicePanel } from '../ui/index.js';
import { buildIpVarMap } from '../utils/dataUtils.js';
import { MAX_SENSORS, updateVarSettings, normalizeVars, isValidVarName, isRecentlyDeleted } from './sensorUtils.js';
import { scheduleSave } from './configSaver.js';

// Первоначальная синхронизация конфигурации с обнаруженными датчиками (вызывается при инициализации)
export async function syncConfigInitial() {
  // Получаем карту переменных по ID датчика из allSensors
  const ipMap = buildIpVarMap();
  let updated = false; // Флаг, были ли изменения в конфигурации

  // Перебираем все обнаруженные датчики
  for (const [sensorId, varSet] of Object.entries(ipMap)) {
    // Если достигнут лимит датчиков, прекращаем добавление
    if (config.sensors.length >= MAX_SENSORS) {
      console.warn('Достигнут лимит датчиков');
      break;
    }

    // Получаем массив переменных из Set, фильтруем валидные
    const varsFromData = Array.from(varSet).filter(isValidVarName);
    // Ищем существующий датчик в конфигурации
    let sCfg = config.sensors.find(s => String(s.id) === String(sensorId));

    // Если датчик не найден
    if (!sCfg) {
      // Создаём новый объект датчика
      sCfg = { id: sensorId, name: sensorId, vars: varsFromData, deleted: false };
      // Обновляем настройки переменных
      updateVarSettings(sCfg);
      // Добавляем в конфигурацию
      config.sensors.push(sCfg);
      updated = true; // Отмечаем, что были изменения
    } else {
      // Если датчик существует, но помечен как удалённый, пропускаем
      if (sCfg.deleted) continue;

      // Нормализуем существующие переменные
      sCfg.vars = normalizeVars(sCfg.vars);
      // Объединяем существующие переменные с новыми (используем Set для уникальности)
      const merged = new Set([...sCfg.vars, ...varsFromData]);

      // Если размер объединённого множества отличается от текущего списка, значит добавились новые
      if (merged.size !== sCfg.vars.length) {
        sCfg.vars = Array.from(merged); // Обновляем список переменных
        updated = true;
      }
      // Обновляем настройки переменных (добавляем отсутствующие)
      updateVarSettings(sCfg);
    }
  }

  // Если были изменения
  if (updated) {
    // Проверяем права на редактирование и сохранение
    if (hasPermission(PERMISSIONS.EDIT_CONFIG) && hasPermission(PERMISSIONS.SAVE_CONFIG)) {
      scheduleSave(); // Планируем автосохранение
    } else {
      // Если прав недостаточно, показываем уведомление
      showToast('❌ Недостаточно прав для сохранения конфигурации');
    }
    updateSensorPanel(true);
  }
}

// Обнаружение и добавление новых датчиков (вызывается периодически при обновлении данных)
export async function syncNewSensors() {
  // Получаем карту переменных по ID датчика из allSensors
  const ipMap = buildIpVarMap();
  let updated = false;

  // Перебираем все обнаруженные датчики
  for (const [sensorId, varSet] of Object.entries(ipMap)) {
    // Проверяем лимит датчиков
    if (config.sensors.length >= MAX_SENSORS) {
      console.warn('Достигнут лимит датчиков');
      break;
    }

    // Ищем существующий датчик в конфигурации
    let sCfg = config.sensors.find(s => String(s.id) === String(sensorId));

    // Если датчик не найден
    if (!sCfg) {
      if (recentlyDeleted.has(sensorId)) {
        continue;
      }
      // Создаём новый
      sCfg = {
        id: sensorId,
        name: sensorId,
        vars: Array.from(varSet).filter(isValidVarName),
        deleted: false
      };

      updateVarSettings(sCfg);
      config.sensors.push(sCfg);
      updated = true;
    } else if (!sCfg.deleted) { // Если датчик существует и не удалён
      // Объединяем существующие переменные с новыми (нормализованные)
      const merged = new Set([
        ...normalizeVars(sCfg.vars),
        ...Array.from(varSet).filter(isValidVarName)
      ]);

      // Если размер изменился, обновляем
      if (merged.size !== sCfg.vars.length) {
        sCfg.vars = Array.from(merged);
        updated = true;
      }
      // Обновляем настройки переменных
      updateVarSettings(sCfg);
    }
  }

  // Если были изменения
  if (updated) {
    if (hasPermission(PERMISSIONS.SAVE_CONFIG)) {
      scheduleSave();
      showToast('✅ Добавлены новые датчики');
    } else {
      showToast('⚠️ Найдены новые датчики (нет прав на сохранение)');
    }
    updateSensorPanel(true);
    updateDevicePanel(true);   // добавляем обновление панели устройств
  }
}
