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
    let scrollWrapper, canvas, valueCard;

    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.className = 'chart-wrapper';
      wrapper.id = wrapperId;
      wrapper.style.cssText = 'display: flex; flex-direction: row; gap: 15px; align-items: flex-start; margin-bottom: 20px;';

      valueCard = document.createElement('div');
      valueCard.className = 'card';
      valueCard.style.cssText = 'width: 180px; height: 200px; padding: 15px; text-align: center; display: flex; flex-direction: column; justify-content: center; align-items: center; flex-shrink: 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); border-radius: 8px; background-color: #f8f9fa;';

      const valueTitle = document.createElement('div');
      valueTitle.textContent = baseLabel;
      valueTitle.style.cssText = 'font-weight: bold; font-size: 16px; margin-bottom: 8px; color: #333;';

      const valueText = document.createElement('div');
      valueText.style.cssText = 'font-size: 20px; font-weight: 600; color: #007bff;';
      valueText.textContent = Number.isFinite(lastVal) ? (lastVal.toFixed(2) + (unit ? ' ' + unit : '')) : 'нет данных';

      valueCard.appendChild(valueTitle);
      valueCard.appendChild(valueText);
      if (alertClass) valueCard.classList.add(alertClass);

      const chartContainer = document.createElement('div');
      chartContainer.style.cssText = 'flex: 1 1 auto; display: flex; flex-direction: column; gap: 8px; max-width: calc(100vw - 350px); overflow: hidden;';

      const title = document.createElement('h3');
      title.textContent = titleText;
      title.style.cssText = 'margin: 0 0 5px 0; font-size: 18px; color: #444;';
      chartContainer.appendChild(title);

      scrollWrapper = document.createElement('div');
      scrollWrapper.style.cssText = 'overflow-x: auto; overflow-y: hidden; width: 100%; max-width: 100%; padding-bottom: 6px; cursor: grab; background-color: #fff; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);';

      canvas = document.createElement('canvas');
      canvas.id = canvasId;
      canvas.height = 220;
      canvas.style.display = 'block';

      const pointsCount = Math.max(rawValues?.length || 0, processedValues?.length || 0);
      const desiredWidth = Math.min(CHART_MAX_CONTENT_PX, Math.max(CHART_MIN_CANVAS_PX, pointsCount * CHART_POINT_PX));
      canvas.width = desiredWidth;

      canvas.addEventListener('wheel', (e) => {
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
      })(canvas, scrollWrapper);

      scrollWrapper.appendChild(canvas);
      chartContainer.appendChild(scrollWrapper);
      wrapper.appendChild(valueCard);
      wrapper.appendChild(chartContainer);
      container.appendChild(wrapper);

      requestAnimationFrame(() => {
        scrollWrapper.scrollLeft = Math.max(0, scrollWrapper.scrollWidth - scrollWrapper.clientWidth);
      });

    } else {
      valueCard = wrapper.querySelector('.card');
      scrollWrapper = wrapper.querySelector('div[style*="overflowX"]') || wrapper.querySelector('div');
      canvas = document.getElementById(canvasId) || wrapper.querySelector('canvas');

      const valueTitle = valueCard ? valueCard.querySelector('div:nth-child(1)') : null;
      if (valueTitle) {
        valueTitle.textContent = baseLabel;
        valueTitle.style.cssText = 'font-weight: bold; font-size: 16px; color: #333;';
      }

      const valueText = valueCard ? valueCard.querySelector('div:nth-child(2)') : null;
      if (valueText) {
        valueText.textContent = Number.isFinite(lastVal)
          ? (lastVal.toFixed(2) + (unit ? ' ' + unit : ''))
          : 'нет данных';
        valueText.style.cssText = 'font-size: 20px; color: #007bff;';
      }

      if (valueCard) {
        valueCard.classList.remove('blink-blue', 'blink-yellow', 'blink-red');
        if (alertClass) valueCard.classList.add(alertClass);
      }

      const title = wrapper.querySelector('h3');
      if (title) {
        title.textContent = titleText;
        title.style.cssText = 'margin: 0 0 5px 0; font-size: 18px; color: #444;';
      }

      wrapper.style.cssText = 'display: flex; flex-direction: row; gap: 15px; align-items: flex-start; margin-bottom: 20px;';

      if (valueCard) {
        valueCard.style.cssText = 'width: 180px; height: 200px; padding: 15px; text-align: center; display: flex; flex-direction: column; justify-content: center; align-items: center; flex-shrink: 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); border-radius: 8px; background-color: #f8f9fa;';
      }
    }

    if (canvas) {
      const pointsCountNow = Math.max(rawValues?.length || 0, processedValues?.length || 0);
      const desiredWidth = Math.min(CHART_MAX_CONTENT_PX, Math.max(CHART_MIN_CANVAS_PX, pointsCountNow * CHART_POINT_PX));

      const atEnd = scrollWrapper ? (Math.abs(scrollWrapper.scrollLeft - (scrollWrapper.scrollWidth - scrollWrapper.clientWidth)) <= 2) : true;
      const prevScrollWidth = scrollWrapper ? scrollWrapper.scrollWidth : 0;
      const prevScrollLeft = scrollWrapper ? scrollWrapper.scrollLeft : 0;

      if (canvas.width !== desiredWidth) {
        canvas.width = desiredWidth;
        if (scrollWrapper) {
          if (atEnd) {
            requestAnimationFrame(() => {
              scrollWrapper.scrollLeft = Math.max(0, scrollWrapper.scrollWidth - scrollWrapper.clientWidth);
            });
          } else {
            const delta = (scrollWrapper.scrollWidth - prevScrollWidth);
            scrollWrapper.scrollLeft = Math.max(0, prevScrollLeft + delta);
          }
        }
      }

      drawChart(canvas.id, showRaw ? rawValues : null, showProcessed ? processedValues : null, times, {
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

/* ========== ОТРИСОВКА ОДНОГО ГРАФИКА НА ХОЛСТЕ ========== */

// Отрисовка данных на заданном canvas
export function drawChart(id, rawData, processedData, times, options = {}) {
  const canvas = document.getElementById(id);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const left = 80;
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

  let min = Infinity;
  let max = -Infinity;

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

  // Отрисовка горизонтальных линий сетки
  ctx.strokeStyle = '#ddd';
  ctx.setLineDash([4, 4]);
  for (let i = 0; i <= 5; i++) {
    const y = top + (ch / 5) * i;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(w - right, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Оси X и Y
  ctx.strokeStyle = '#000';
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, h - bottom);
  ctx.lineTo(w - right, h - bottom);
  ctx.stroke();

  // Подписи значений по оси Y
  ctx.fillStyle = '#333';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 5; i++) {
    const v = max - (max - min) * i / 5;
    const y = top + (ch / 5) * i;
    ctx.fillText(v.toFixed(1), left - 8, y);
  }

  // Подпись оси Y
  if (options.ylabel) {
    ctx.save();
    ctx.translate(18, h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(options.ylabel, 0, 0);
    ctx.restore();
  }

  // Временные метки и вертикальные линии сетки
  if (useTimes) {
    const span = tSpan;
    const STEP = span < 2 * 60e3  ? 10e3 :
      span < 15 * 60e3 ? 60e3 :
      span < 2 * 3600e3 ? 5 * 60e3 :
      span < 12 * 3600e3 ? 30 * 60e3 :
      2 * 3600e3;

    ctx.font = '11px sans-serif';
    ctx.fillStyle = '#333';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (let t = Math.ceil(tStart / STEP) * STEP; t <= tEnd; t += STEP) {
      const x = left + ((t - tStart) / tSpan) * cw;

      ctx.strokeStyle = '#ddd';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, h - bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillText(formatTimeHHMMSS(t), x, h - bottom + 5);
    }
  }

  // Отрисовка линий данных
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

// Поиск ближайшего индекса в отсортированном массиве
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
  return (Math.abs(arr[lo] - target) < Math.abs(arr[prev] - target)) ? lo : prev;
}

// Очистка холста графика
export function clearChart(id) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}