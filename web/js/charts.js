import {
  allSensors,
  sensorTimes,
  config,
  currentSensor,
  COLOR_CHOICES,
  CHART_POINT_PX,
  CHART_MIN_CANVAS_PX,
  CHART_MAX_CANVAS_PX,
  CHART_MAX_CONTENT_PX
} from './constants.js';
import { applyProcessing } from './dsp.js';
import { getAlertClass, getSelectedTimeRangeMs, formatTimeHHMMSS } from './utils.js';

// Карта для хранения состояния графиков (не используется в текущей версии, но зарезервирована)
const chartState = new Map();

/* ========== ОСНОВНАЯ ФУНКЦИЯ ОТРИСОВКИ ГРАФИКОВ ========== */

// Отрисовка всех графиков для текущего выбранного датчика
export function drawCurrent() {
  const container = document.getElementById('chartsContainer');
  const RAW_COLOR = '#999999';

  if (!currentSensor || !container) {
    if (container) container.innerHTML = "";
    return;
  }

  const sCfg = config.sensors.find(s => String(s.id) === String(currentSensor) && !s.deleted);
  if (!sCfg) {
    container.innerHTML = "";
    return;
  }

  const vars = Array.isArray(sCfg.vars)
    ? sCfg.vars.map(v => String(v).trim()).filter(Boolean)
    : String(sCfg.vars || '').split(',').map(v => v.trim()).filter(Boolean);

  const desiredWrapperIds = new Set();
  const varSettings = Array.isArray(sCfg.varSettings) ? sCfg.varSettings : [];
  const rangeMs = getSelectedTimeRangeMs();
  const now = Date.now();

  for (let idx = 0; idx < vars.length; idx++) {
    const varName = vars[idx];
    const keyColon = `${sCfg.id}:${varName}`;
    const keyLowerColon = `${sCfg.id}:${varName.toLowerCase()}`;
    let dataKey = null;

    if (allSensors[keyColon]) dataKey = keyColon;
    else if (allSensors[keyLowerColon]) dataKey = keyLowerColon;

    if (!dataKey) continue;

    const sData = allSensors[dataKey];
    if (!sData || !Array.isArray(sData.values) || sData.values.length === 0) continue;

    let times = sensorTimes[dataKey] || null;
    const vs = varSettings.find(v => v.var === varName) || {};
    const baseLabel = vs.label || varName;
    const unit = vs.unit || '';
    const defaultColor = COLOR_CHOICES[idx % COLOR_CHOICES.length].value;
    const color = vs.color || defaultColor;

    let rawValues = sData.values.slice();
    const processingMode = vs.processing || 'none';
    let processedValues = (processingMode && processingMode !== 'none')
      ? applyProcessing(rawValues, processingMode)
      : null;

    if (processedValues && processedValues.length !== rawValues.length) {
      processedValues = null;
    }

    const showRaw = (typeof vs.showRaw === 'boolean') ? vs.showRaw : true;
    const showProcessed = (processingMode !== 'none')
      ? ((typeof vs.showProcessed === 'boolean') ? vs.showProcessed : true)
      : false;

    const titleText = unit ? `${baseLabel} (${unit})` : baseLabel;

    if (rangeMs > 0 && Array.isArray(times) && times.length === rawValues.length) {
      const minAllowedTime = now - rangeMs;
      let startIdx = 0;
      for (let i = 0; i < times.length; i++) {
        if (times[i] >= minAllowedTime) { startIdx = i; break; }
      }
      times = times.slice(startIdx);
      rawValues = rawValues.slice(startIdx);
      if (processedValues) processedValues = processedValues.slice(startIdx);
    }

    if (!rawValues.length && (!processedValues || !processedValues.length)) continue;

    const lastVal = rawValues.length ? rawValues[rawValues.length - 1] : NaN;
    const alertClass = getAlertClass(vs, lastVal);
    const canvasId = `chart_${sCfg.id}_${varName}`;
    const wrapperId = `wrapper_${canvasId}`;
    desiredWrapperIds.add(wrapperId);

    let wrapper = document.getElementById(wrapperId);
    let scrollWrapper, dataCanvas, axisCanvas, valueCard;

    if (!wrapper) {
      // ======== СОЗДАНИЕ НОВОЙ ОБЁРТКИ ========
      wrapper = document.createElement('div');
      wrapper.className = 'chart-wrapper';
      wrapper.id = wrapperId;

      valueCard = document.createElement('div');
      valueCard.className = 'card chart-value-card';

      const valueTitle = document.createElement('div');
      valueTitle.className = 'chart-value-title';
      valueTitle.textContent = baseLabel;

      const valueText = document.createElement('div');
      valueText.className = 'chart-value-number';
      valueText.textContent = Number.isFinite(lastVal) ? (lastVal.toFixed(2) + (unit ? ' ' + unit : '')) : 'нет данных';

      valueCard.appendChild(valueTitle);
      valueCard.appendChild(valueText);
      if (alertClass) valueCard.classList.add(alertClass);

      const chartContainer = document.createElement('div');
      chartContainer.className = 'chart-graph-container';

      const axisDataRow = document.createElement('div');
      axisDataRow.style.display = 'flex';
      axisDataRow.style.flexDirection = 'row';
      axisDataRow.style.alignItems = 'stretch';

      // Ось Y
      const axisContainer = document.createElement('div');
      axisContainer.className = 'chart-axis-container';
      axisCanvas = document.createElement('canvas');
      axisCanvas.className = 'chart-axis-canvas';
      axisCanvas.height = 220;
      axisCanvas.width = 60;
      axisContainer.appendChild(axisCanvas);

      // Область данных с прокруткой
      scrollWrapper = document.createElement('div');
      scrollWrapper.className = 'chart-scroll-wrapper';
      dataCanvas = document.createElement('canvas');
      dataCanvas.id = canvasId;
      dataCanvas.className = 'chart-data-canvas';
      dataCanvas.height = 220;

      const pointsCount = Math.max(rawValues?.length || 0, processedValues?.length || 0);
      const desiredWidth = Math.min(CHART_MAX_CONTENT_PX, Math.max(CHART_MIN_CANVAS_PX, pointsCount * CHART_POINT_PX));
      dataCanvas.width = desiredWidth;

      scrollWrapper.appendChild(dataCanvas);

      axisDataRow.appendChild(axisContainer);
      axisDataRow.appendChild(scrollWrapper);
      chartContainer.appendChild(axisDataRow);

      // Обработчики прокрутки и перетаскивания
      dataCanvas.addEventListener('wheel', (e) => {
        const dx = (Math.abs(e.deltaX) > 0) ? e.deltaX : e.deltaY;
        if (dx !== 0) {
          e.preventDefault();
          scrollWrapper.scrollLeft += dx;
        }
      }, { passive: false });

      (function attachDrag(canvasEl, scrollEl) {
        let isDragging = false;
        let dragStartX = 0;
        let startScrollLeft = 0;

        canvasEl.addEventListener('mousedown', (e) => {
          isDragging = true;
          scrollEl.style.cursor = 'grabbing';
          dragStartX = e.clientX;
          startScrollLeft = scrollEl.scrollLeft;
          e.preventDefault();
        });

        function onMove(e) {
          if (!isDragging) return;
          const dx = e.clientX - dragStartX;
          scrollEl.scrollLeft = startScrollLeft - dx;
        }

        function stop() { isDragging = false; scrollEl.style.cursor = 'grab'; }

        canvasEl.addEventListener('mousemove', onMove);
        canvasEl.addEventListener('mouseup', stop);
        canvasEl.addEventListener('mouseleave', stop);
      })(dataCanvas, scrollWrapper);

      wrapper.appendChild(valueCard);
      wrapper.appendChild(chartContainer);
      container.appendChild(wrapper);

      requestAnimationFrame(() => {
        scrollWrapper.scrollLeft = Math.max(0, scrollWrapper.scrollWidth - scrollWrapper.clientWidth);
      });

    } else {
      // ======== ОБНОВЛЕНИЕ СУЩЕСТВУЮЩЕЙ ОБЁРТКИ ========
      valueCard = wrapper.querySelector('.card.chart-value-card');
      if (valueCard) {
        const valueTitle = valueCard.querySelector('.chart-value-title');
        if (valueTitle) valueTitle.textContent = baseLabel;
        const valueText = valueCard.querySelector('.chart-value-number');
        if (valueText) {
          valueText.textContent = Number.isFinite(lastVal)
            ? (lastVal.toFixed(2) + (unit ? ' ' + unit : ''))
            : 'нет данных';
        }
        valueCard.classList.remove('blink-blue', 'blink-yellow', 'blink-red');
        if (alertClass) valueCard.classList.add(alertClass);
      }

      axisCanvas = wrapper.querySelector('.chart-axis-canvas');
      scrollWrapper = wrapper.querySelector('.chart-scroll-wrapper');
      dataCanvas = document.getElementById(canvasId);
      if (!dataCanvas && scrollWrapper) {
        dataCanvas = scrollWrapper.querySelector('canvas');
      }
    }

    if (dataCanvas && axisCanvas && scrollWrapper) {
      const pointsCountNow = Math.max(rawValues?.length || 0, processedValues?.length || 0);
      const desiredWidth = Math.min(CHART_MAX_CONTENT_PX, Math.max(CHART_MIN_CANVAS_PX, pointsCountNow * CHART_POINT_PX));

      const atEnd = (Math.abs(scrollWrapper.scrollLeft - (scrollWrapper.scrollWidth - scrollWrapper.clientWidth)) <= 2);
      const prevScrollWidth = scrollWrapper.scrollWidth;
      const prevScrollLeft = scrollWrapper.scrollLeft;

      if (dataCanvas.width !== desiredWidth) {
        dataCanvas.width = desiredWidth;
        if (atEnd) {
          requestAnimationFrame(() => {
            scrollWrapper.scrollLeft = Math.max(0, scrollWrapper.scrollWidth - scrollWrapper.clientWidth);
          });
        } else {
          const delta = scrollWrapper.scrollWidth - prevScrollWidth;
          scrollWrapper.scrollLeft = Math.max(0, prevScrollLeft + delta);
        }
      }

      // Вычисляем min/max для оси
      const series = [];
      if (showRaw && rawValues.length) series.push(rawValues);
      if (showProcessed && processedValues && processedValues.length) series.push(processedValues);

      if (series.length > 0) {
        let min = Infinity, max = -Infinity;
        series.forEach(data => data.forEach(v => {
          if (Number.isFinite(v)) {
            min = Math.min(min, v);
            max = Math.max(max, v);
          }
        }));
        if (Number.isFinite(min) && Number.isFinite(max)) {
          if (min === max) {
            min -= 0.5;
            max += 0.5;
          }
          drawYAxis(axisCanvas, min, max);
        }
      }

      drawChart(dataCanvas.id, showRaw ? rawValues : null, showProcessed ? processedValues : null, times, {
        rawColor: RAW_COLOR,
        processedColor: color,
        ylabel: titleText
      });
    }
  }

  const toRemove = [];
  for (const child of Array.from(container.children)) {
    if (child.id && child.id.startsWith('wrapper_chart_') && !desiredWrapperIds.has(child.id)) {
      toRemove.push(child);
    }
  }
  for (const r of toRemove) {
    r.remove();
  }
}

// Рисует ось Y на отдельном canvas
function drawYAxis(canvas, min, max) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  const rootStyles = getComputedStyle(document.documentElement);
  const textColor = rootStyles.getPropertyValue('--color-text').trim() || '#F0F4F8';
  const axisColor = rootStyles.getPropertyValue('--color-text-secondary').trim() || '#B0C0D0';

  ctx.clearRect(0, 0, w, h);

  // Настройки текста
  ctx.font = '500 12px "Segoe UI", "Arial", sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = textColor;
  ctx.textRendering = 'optimizeLegibility';

  const top = 25, bottom = 55;
  const ch = h - top - bottom;

  // Вертикальная линия оси
  ctx.strokeStyle = axisColor;
  ctx.beginPath();
  ctx.moveTo(w - 1, top);
  ctx.lineTo(w - 1, h - bottom);
  ctx.stroke();

  // Подписи значений
  for (let i = 0; i <= 5; i++) {
    const v = max - (max - min) * i / 5;
    const y = top + (ch / 5) * i;
    ctx.fillText(v.toFixed(1), w - 4, y);
  }
}

/* ========== ОТРИСОВКА ОДНОГО ГРАФИКА НА ХОЛСТЕ ========== */

// Отрисовка данных на заданном canvas
export function drawChart(id, rawData, processedData, times, options = {}) {
  const canvas = document.getElementById(id);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  const rootStyles = getComputedStyle(document.documentElement);
  const textColor = rootStyles.getPropertyValue('--color-text').trim() || '#F0F4F8';
  const gridColor = rootStyles.getPropertyValue('--color-border').trim() || '#2A3B4C';

  const left = 0; // изменено с 80 на 0
  const right = 40;
  const top = 25;
  const bottom = 55;

  ctx.clearRect(0, 0, w, h);

  const useTimes = Array.isArray(times) && times.length > 1 &&
    (!rawData || times.length === rawData.length) &&
    (!processedData || times.length === processedData.length);

  const series = [];
  if (Array.isArray(rawData) && rawData.length) {
    series.push({ data: rawData, color: options.rawColor || '#777' });
  }
  if (Array.isArray(processedData) && processedData.length) {
    series.push({ data: processedData, color: options.processedColor || '#d00' });
  }
  if (!series.length) return;

  let min = Infinity, max = -Infinity;
  series.forEach(s => s.data.forEach(v => {
    if (Number.isFinite(v)) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  if (min === max) {
    min -= 0.5;
    max += 0.5;
  }

  const cw = w - left - right;
  const ch = h - top - bottom;

  let tStart = 0, tEnd = 1, tSpan = 1;
  if (useTimes) {
    tStart = times[0];
    tEnd = times[times.length - 1];
    tSpan = Math.max(1, tEnd - tStart);
  }

  // Горизонтальные линии сетки
  ctx.strokeStyle = gridColor;
  ctx.setLineDash([4, 4]);
  for (let i = 0; i <= 5; i++) {
    const y = top + (ch / 5) * i;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(w - right, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Вертикальные линии времени и подписи
  if (useTimes) {
    const span = tSpan;
    const STEP = span < 2 * 60e3 ? 10e3 :
                 span < 15 * 60e3 ? 60e3 :
                 span < 2 * 3600e3 ? 5 * 60e3 :
                 span < 12 * 3600e3 ? 30 * 60e3 : 2 * 3600e3;

    ctx.font = '11px sans-serif';
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (let t = Math.ceil(tStart / STEP) * STEP; t <= tEnd; t += STEP) {
      const x = left + ((t - tStart) / tSpan) * cw;
      ctx.strokeStyle = gridColor;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, h - bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(formatTimeHHMMSS(t), x, h - bottom + 5);
    }
  }

  // Линии данных
  series.forEach(s => {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    s.data.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const x = useTimes
        ? left + ((times[i] - tStart) / tSpan) * cw
        : left + (i / (s.data.length - 1)) * cw;
      const y = top + ch - ((v - min) / (max - min)) * ch;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  });
}

/* ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ========== */

// Поиск ближайшего индекса в отсортированном массиве (бинарный поиск)
function findNearestIndex(arr, target) {
  if (!Array.isArray(arr) || arr.length === 0) return -1;
  let lo = 0, hi = arr.length - 1;
  if (target <= arr[0]) return 0;
  if (target >= arr[hi]) return hi;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (arr[mid] === target) return mid;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  const prev = lo - 1;
  // Сравниваем, какой индекс ближе: lo или prev
  return (Math.abs(arr[lo] - target) < Math.abs(arr[prev] - target)) ? lo : prev;
}

// Очистка холста графика (заливка прозрачным)
export function clearChart(id) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}