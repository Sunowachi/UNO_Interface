console.log('charts.js загружен');

import {
  allSensors,
  sensorTimes,
  config,
  currentSensor,
  timeRange,
  COLOR_CHOICES,
  PROCESSING_LABELS
} from './constants.js';

import { applyProcessing } from './dsp.js';

import {
  getAlertClass,
  getSelectedTimeRangeMs,
  formatTimeHHMMSS
} from './utils.js';

export function drawCurrent() {
  const container = document.getElementById('chartsContainer');

  if (!currentSensor || !container) {
    if (container) container.innerHTML = "";
    return;
  }

  const sCfg = config.sensors.find(s => String(s.id) === String(currentSensor) && !s.deleted);
  if (!sCfg) {
    container.innerHTML = "";
    return;
  }

  const vars = (sCfg.vars || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);

  container.innerHTML = '';

  if (vars.length === 0) {
    const msg = document.createElement('p');
    msg.textContent = 'Для этого датчика не заданы переменные.';
    msg.style.color = '#777';
    container.appendChild(msg);
    return;
  }

  const varSettings = Array.isArray(sCfg.varSettings) ? sCfg.varSettings : [];
  const rangeMs = getSelectedTimeRangeMs();
  const now = Date.now();

  vars.forEach((varName, idx) => {
    // Определяем точный ключ, под которым пришли данные
    let dataKey = null;
    if (allSensors[varName]) {
      dataKey = varName;
    } else if (allSensors[`${sCfg.id}_${varName}`]) {
      dataKey = `${sCfg.id}_${varName}`;
    } else if (allSensors[`${sCfg.id}_${varName.toLowerCase()}`]) {
      dataKey = `${sCfg.id}_${varName.toLowerCase()}`;
    }

    if (!dataKey) {
      console.warn(`Нет данных для переменной ${varName}`);
      return;
    }

    const sData = allSensors[dataKey];
    if (!sData || !Array.isArray(sData.values) || sData.values.length === 0) {
      console.warn(`Нет данных для переменной ${varName}`);
      return;
    }

    let times = sensorTimes[dataKey] || null;
    const vs = varSettings.find(v => v.var === varName) || {};
    const baseLabel = vs.label || varName;
    const unit = vs.unit || '';

    const defaultColor = COLOR_CHOICES[idx % COLOR_CHOICES.length].value;
    const color = vs.color || defaultColor;

    let rawValues = sData.values.slice(); // копия
    const lastVal = rawValues[rawValues.length - 1];

    const processingMode = vs.processing || 'none';
    let processedValues = (processingMode && processingMode !== 'none')
      ? applyProcessing(rawValues, processingMode)
      : null;

    const showRaw = (typeof vs.showRaw === 'boolean') ? vs.showRaw : true;
    const showProcessed = (processingMode !== 'none')
      ? ((typeof vs.showProcessed === 'boolean') ? vs.showProcessed : true)
      : false;

    const titleText = unit ? `${baseLabel} (${unit})` : baseLabel;
    const alertClass = getAlertClass(vs, lastVal);

    // === Применяем диапазон времени (если задан) ===
    // Режем только если times валидны и синхронизированы с values.
    if (rangeMs > 0 && Array.isArray(times) && times.length === rawValues.length) {
      const minAllowedTime = now - rangeMs;

      let startIdx = 0;
      for (let i = 0; i < times.length; i++) {
        if (times[i] >= minAllowedTime) {
          startIdx = i;
          break;
        }
      }

      times = times.slice(startIdx);
      rawValues = rawValues.slice(startIdx);
      if (processedValues) processedValues = processedValues.slice(startIdx);
    }

    if (!rawValues.length && (!processedValues || !processedValues.length)) {
      console.warn(`Нет точек в выбранном диапазоне времени для ${varName}`);
      return;
    }

    // ОБЩАЯ ОБЁРТКА
    const wrapper = document.createElement('div');
    wrapper.className = 'chart-wrapper';

    // ЛЕВАЯ ПАНЕЛЬКА С ПОСЛЕДНИМ ЗНАЧЕНИЕМ
    const valueCard = document.createElement('div');
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
    if (Number.isFinite(lastVal)) {
      valueText.textContent = lastVal.toFixed(2) + (unit ? ' ' + unit : '');
    } else {
      valueText.textContent = 'нет данных';
    }
    valueText.style.fontSize = '18px';

    valueCard.appendChild(valueTitle);
    valueCard.appendChild(valueText);

    if (alertClass) valueCard.classList.add(alertClass);

    // ПРАВАЯ ЧАСТЬ — ГРАФИК
    const chartContainer = document.createElement('div');
    chartContainer.style.flex = '1 1 auto';
    chartContainer.style.display = 'flex';
    chartContainer.style.flexDirection = 'column';
    chartContainer.style.gap = '5px';

    const title = document.createElement('h3');
    title.textContent = titleText;
    chartContainer.appendChild(title);

    // Обёртка с горизонтальной прокруткой для графика
    const scrollWrapper = document.createElement('div');
    scrollWrapper.style.overflowX = 'auto';
    scrollWrapper.style.overflowY = 'hidden';
    scrollWrapper.style.width = '100%';
    scrollWrapper.style.paddingBottom = '6px';
    scrollWrapper.style.cursor = 'grab';

    const canvas = document.createElement('canvas');
    const chartId = `chart_${sCfg.id}_${varName}`;
    canvas.id = chartId;
    canvas.width = 700; // базовая ширина, drawChart выставит корректную
    canvas.height = 220;
    canvas.style.display = 'block';

    // === Скролл прямо по графику (колесо/тачпад) ===
    canvas.addEventListener('wheel', (e) => {
      const dx = (Math.abs(e.deltaX) > 0) ? e.deltaX : e.deltaY;
      if (dx !== 0) {
        e.preventDefault();
        scrollWrapper.scrollLeft += dx;
      }
    }, { passive: false });

    // === Drag-to-pan прямо по графику ===
    let isDragging = false;
    let dragStartX = 0;
    let startScrollLeft = 0;

    canvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      scrollWrapper.style.cursor = 'grabbing';
      dragStartX = e.clientX;
      startScrollLeft = scrollWrapper.scrollLeft;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartX;
      scrollWrapper.scrollLeft = startScrollLeft - dx;
    });

    window.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      scrollWrapper.style.cursor = 'grab';
    });

    scrollWrapper.appendChild(canvas);
    chartContainer.appendChild(scrollWrapper);

    // ЛЕГЕНДА под графиком: RAW и обработанная линия
    const legend = document.createElement('div');
    legend.style.fontSize = '12px';
    legend.style.marginTop = '4px';

    if (showRaw) {
      const rawSpan = document.createElement('span');
      rawSpan.textContent = '■ RAW (сырые данные)';
      rawSpan.style.color = '#666';
      rawSpan.style.marginRight = '10px';
      legend.appendChild(rawSpan);
    }

    if (showProcessed) {
      const procSpan = document.createElement('span');
      procSpan.textContent = '■ ' + (PROCESSING_LABELS[processingMode] || processingMode);
      procSpan.style.color = color;
      legend.appendChild(procSpan);
    }

    if (legend.childNodes.length > 0) chartContainer.appendChild(legend);

    wrapper.appendChild(valueCard);
    wrapper.appendChild(chartContainer);
    container.appendChild(wrapper);

    // Рисуем график
    drawChart(
      chartId,
      showRaw ? rawValues : null,
      showProcessed ? processedValues : null,
      times,
      {
        rawColor: '#999999',
        processedColor: color,
        ylabel: titleText
      }
    );

    if (rangeMs > 0) {
      requestAnimationFrame(() => {
        scrollWrapper.scrollLeft = Math.max(0, scrollWrapper.scrollWidth - scrollWrapper.clientWidth);
      });
    }
  });
}

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

export function clearChart(id) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}