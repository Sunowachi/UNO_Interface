console.log('charts.js загружен');

import {
  allSensors,
  sensorTimes,
  config,
  currentSensor,
  timeRange,
  COLOR_CHOICES,
  PROCESSING_LABELS,
  chartScroll,
  chartFollow,
  CHART_POINT_PX,
  CHART_MIN_CANVAS_PX,
  CHART_MAX_CANVAS_PX,
  CHART_MAX_CONTENT_PX
} from './constants.js';

import { applyProcessing } from './dsp.js';

import {
  getAlertClass,
  getSelectedTimeRangeMs,
  formatTimeHHMMSS
} from './utils.js';

const chartState = new Map();

export function drawCurrent() {
  const container = document.getElementById('chartsContainer');
  const RAW_COLOR = '#999999';

  // если нет датчика — очищаем контейнер и выходим
  if (!currentSensor || !container) {
    if (container) container.innerHTML = "";
    return;
  }

  const sCfg = config.sensors.find(s => String(s.id) === String(currentSensor) && !s.deleted);
  if (!sCfg) {
    container.innerHTML = "";
    return;
  }

  // Нормализация vars: поддерживаем либо строку с запятыми, либо массив
  const vars = Array.isArray(sCfg.vars)
    ? sCfg.vars.map(v => String(v).trim()).filter(Boolean)
    : String(sCfg.vars || '').split(',').map(v => v.trim()).filter(Boolean);

  // Подготовим набор желаемых wrapper id, чтобы удалить лишние
  const desiredWrapperIds = new Set();

  const varSettings = Array.isArray(sCfg.varSettings) ? sCfg.varSettings : [];
  const rangeMs = getSelectedTimeRangeMs();
  const now = Date.now();

  // Итерируем переменные; повторно используем DOM если возможно
  for (let idx = 0; idx < vars.length; idx++) {
    const varName = vars[idx];

    // Определяем ключи данных
    const keyColon      = `${sCfg.id}:${varName}`;
    const keyLowerColon = `${sCfg.id}:${varName.toLowerCase()}`;
    let dataKey = null;
    if (allSensors[keyColon]) dataKey = keyColon;
    else if (allSensors[keyLowerColon]) dataKey = keyLowerColon;
    if (!dataKey) {
      console.warn(`Нет данных для переменной ${varName}`);
      continue;
    }

    const sData = allSensors[dataKey];
    if (!sData || !Array.isArray(sData.values) || sData.values.length === 0) {
      console.warn(`Нет данных для переменной ${varName}`);
      continue;
    }

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
      console.warn(`DSP изменил длину данных для ${varName}`);
      processedValues = null;
    }

    const showRaw = (typeof vs.showRaw === 'boolean') ? vs.showRaw : true;
    const showProcessed = (processingMode !== 'none')
      ? ((typeof vs.showProcessed === 'boolean') ? vs.showProcessed : true)
      : false;

    const titleText = unit ? `${baseLabel} (${unit})` : baseLabel;

    // применяем range если нужно
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

    if (!rawValues.length && (!processedValues || !processedValues.length)) {
      console.warn(`Нет точек в выбранном диапазоне времени для ${varName}`);
      continue;
    }

    const lastVal = rawValues.length ? rawValues[rawValues.length - 1] : NaN;
    const alertClass = getAlertClass(vs, lastVal);

    // Имена элементов
    const canvasId = `chart_${sCfg.id}_${varName}`;
    const wrapperId = `wrapper_${canvasId}`;
    desiredWrapperIds.add(wrapperId);

    // Найдём существующий wrapper
    let wrapper = document.getElementById(wrapperId);
    let scrollWrapper, canvas, valueCard;

    if (!wrapper) {
      // Создаём новый wrapper (только если его нет)
      wrapper = document.createElement('div');
      wrapper.className = 'chart-wrapper';
      wrapper.id = wrapperId;

      // valueCard
      valueCard = document.createElement('div');
      valueCard.className = 'card';
      valueCard.style.width = '160px';
      valueCard.style.padding = '10px';
      valueCard.style.textAlign = 'center';
      valueCard.style.display = 'flex';
      valueCard.style.flexDirection = 'column';
      valueCard.style.justifyContent = 'center';
      valueCard.style.alignItems = 'center';

      const valueTitle = document.createElement('div');
      valueTitle.textContent = baseLabel;
      valueTitle.style.fontWeight = 'bold';
      valueTitle.style.marginBottom = '6px';

      const valueText = document.createElement('div');
      valueText.style.fontSize = '18px';
      valueText.textContent = Number.isFinite(lastVal) ? (lastVal.toFixed(2) + (unit ? ' ' + unit : '')) : 'нет данных';

      valueCard.appendChild(valueTitle);
      valueCard.appendChild(valueText);
      if (alertClass) valueCard.classList.add(alertClass);

      // chartContainer + title + scrollWrapper + canvas
      const chartContainer = document.createElement('div');
      chartContainer.style.flex = '1 1 auto';
      chartContainer.style.display = 'flex';
      chartContainer.style.flexDirection = 'column';
      chartContainer.style.gap = '5px';

      const title = document.createElement('h3');
      title.textContent = titleText;
      chartContainer.appendChild(title);

      scrollWrapper = document.createElement('div');
      scrollWrapper.style.overflowX = 'auto';
      scrollWrapper.style.overflowY = 'hidden';
      scrollWrapper.style.width = '100%';
      scrollWrapper.style.paddingBottom = '6px';
      scrollWrapper.style.cursor = 'grab';

      canvas = document.createElement('canvas');
      canvas.id = canvasId;
      canvas.height = 220;
      canvas.style.display = 'block';

      // ширина по количеству точек (css/логическое значение)
      const pointsCount = Math.max(rawValues?.length || 0, processedValues?.length || 0);
      const desiredWidth = Math.min(CHART_MAX_CONTENT_PX, Math.max(CHART_MIN_CANVAS_PX, pointsCount * CHART_POINT_PX));
      canvas.width = desiredWidth;

      // добавляем слушатели один раз
      canvas.addEventListener('wheel', (e) => {
        const dx = (Math.abs(e.deltaX) > 0) ? e.deltaX : e.deltaY;
        if (dx !== 0) {
          e.preventDefault();
          scrollWrapper.scrollLeft += dx;
        }
      }, { passive: false });

      // drag handlers
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

      // собираем DOM
      scrollWrapper.appendChild(canvas);
      chartContainer.appendChild(scrollWrapper);

      wrapper.appendChild(valueCard);
      wrapper.appendChild(chartContainer);
      container.appendChild(wrapper);

      // при создании пролистываем в конец
      requestAnimationFrame(() => {
        scrollWrapper.scrollLeft = Math.max(0, scrollWrapper.scrollWidth - scrollWrapper.clientWidth);
      });

    } else {
      // Повторное использование wrapper: найдем элементы внутри
      valueCard = wrapper.querySelector('.card');
      scrollWrapper = wrapper.querySelector('div[style*="overflowX"]') || wrapper.querySelector('div');
      canvas = document.getElementById(canvasId) || wrapper.querySelector('canvas');
      // обновим текст последнего значения и alert класс
      const valueText = valueCard ? valueCard.querySelector('div:nth-child(2)') : null;
      if (valueText) {
        valueText.textContent = Number.isFinite(lastVal) ? (lastVal.toFixed(2) + (unit ? ' ' + unit : '')) : 'нет данных';
      }
      if (valueCard) {
        valueCard.classList.remove('blink-blue','blink-yellow','blink-red');
        if (alertClass) valueCard.classList.add(alertClass);
      }
    }

    // Перерисовка: изменяем только ширину canvas при необходимости, аккуратно работая с прокруткой
    if (canvas) {
      const pointsCountNow = Math.max(rawValues?.length || 0, processedValues?.length || 0);
      const desiredWidth = Math.min(CHART_MAX_CONTENT_PX, Math.max(CHART_MIN_CANVAS_PX, pointsCountNow * CHART_POINT_PX));

      // определяем, находится ли пользователь в конце
      const atEnd = scrollWrapper ? (Math.abs(scrollWrapper.scrollLeft - (scrollWrapper.scrollWidth - scrollWrapper.clientWidth)) <= 2) : true;
      const prevScrollWidth = scrollWrapper ? scrollWrapper.scrollWidth : 0;
      const prevScrollLeft = scrollWrapper ? scrollWrapper.scrollLeft : 0;

      if (canvas.width !== desiredWidth) {
        canvas.width = desiredWidth;
        // корретно восстанавливаем позицию
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

      // Наконец, рисуем данные на canvas (drawChart умеет работать с id)
      drawChart(canvas.id, showRaw ? rawValues : null, showProcessed ? processedValues : null, times, {
        rawColor: RAW_COLOR,
        processedColor: color,
        ylabel: titleText
      });
    }
  } // конец цикла vars

  // Удаляем лишние wrapper'ы, которых больше нет в vars (чтобы не накапливались)
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

export function drawChart(id, rawData, processedData, times, options = {}) {
  const canvas = document.getElementById(id);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');

  // Размеры canvas берутся из атрибутов width/height (устанавливаются при создании/когда реально меняется)
  const w = canvas.width;
  const h = canvas.height;

  // Настройки от вызывающего
  const left = 80;
  const right = 40;
  const top = 25;
  const bottom = 55;

  ctx.clearRect(0, 0, w, h);

  const useTimes =
    Array.isArray(times) &&
    times.length > 1 &&
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

  series.forEach(s =>
    s.data.forEach(v => {
      if (Number.isFinite(v)) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    })
  );

  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  if (min === max) {
    min -= 0.5;
    max += 0.5;
  }

  const cw = w - left - right;
  const ch = h - top - bottom;

  let tStart = 0;
  let tEnd = 1;
  let tSpan = 1;

  if (useTimes) {
    tStart = times[0];
    tEnd = times[times.length - 1];
    tSpan = Math.max(1, tEnd - tStart);
  }

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

  ctx.strokeStyle = '#000';
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, h - bottom);
  ctx.lineTo(w - right, h - bottom);
  ctx.stroke();

  ctx.fillStyle = '#333';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= 5; i++) {
    const v = max - (max - min) * i / 5;
    const y = top + (ch / 5) * i;
    ctx.fillText(v.toFixed(1), left - 8, y);
  }

  if (options.ylabel) {
    ctx.save();
    ctx.translate(18, h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(options.ylabel, 0, 0);
    ctx.restore();
  }

  if (useTimes) {
    const span = tSpan;

    const STEP =
      span < 2 * 60e3  ? 10e3 :
      span < 15 * 60e3 ? 60e3 :
      span < 2 * 3600e3 ? 5 * 60e3 :
      span < 12 * 3600e3 ? 30 * 60e3 :
      2 * 3600e3;

    ctx.font = '11px sans-serif';
    ctx.fillStyle = '#333';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (
      let t = Math.ceil(tStart / STEP) * STEP;
      t <= tEnd;
      t += STEP
    ) {
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

      const y =
        top + ch - ((v - min) / (max - min)) * ch;

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

export function clearChart(id) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}