import { allSensors } from '../constants.js';

let prevDeviceKeys = null;

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