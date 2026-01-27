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

/*
  Исправления и улучшения:
  - Добавлен оверлейный canvas и всплывающая подсказка (tooltip) для показа точного значения в момент времени.
  - Реализён поиск ближайшей точки по времени (бинпоиск) — точное соответствие времени->значение.
  - Оверлей рисуется отдельно, основной график не перерисовывается при наведении (ускорение).
  - Учтён scroll контейнера при вычислении позиции мыши (просчет координат относительно полного canvas).
  - Комментарии на русском.
*/

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

  // Нормализация vars: поддерживаем либо строку с запятыми, либо массив
  const vars = Array.isArray(sCfg.vars)
    ? sCfg.vars.map(v => String(v).trim()).filter(Boolean)
    : String(sCfg.vars || '').split(',').map(v => v.trim()).filter(Boolean);

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

    const keyColon      = `${sCfg.id}:${varName}`;
    const keyLowerColon = `${sCfg.id}:${varName.toLowerCase()}`;

    if (allSensors[keyColon]) {
      dataKey = keyColon;
    } else if (allSensors[keyLowerColon]) {
      dataKey = keyLowerColon;
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

    let rawValues = sData.values.slice();

    const processingMode = vs.processing || 'none';
    let processedValues = (processingMode && processingMode !== 'none')
      ? applyProcessing(rawValues, processingMode)
      : null;

    if (
      processedValues &&
      processedValues.length !== rawValues.length
    ) {
      console.warn(`DSP изменил длину данных для ${varName}`);
      processedValues = null;
    }

    const showRaw = (typeof vs.showRaw === 'boolean') ? vs.showRaw : true;
    const showProcessed = (processingMode !== 'none')
      ? ((typeof vs.showProcessed === 'boolean') ? vs.showProcessed : true)
      : false;

    const titleText = unit ? `${baseLabel} (${unit})` : baseLabel;

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

    const lastVal = rawValues.length
      ? rawValues[rawValues.length - 1]
      : NaN;

    const alertClass = getAlertClass(vs, lastVal);

    // ОБЩАЯ ОБЁРТКА
    const wrapper = document.createElement('div');
    wrapper.className = 'chart-wrapper';
    wrapper.style.display = 'flex';
    wrapper.style.gap = '10px';
    wrapper.style.alignItems = 'flex-start';

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
    // Для корректного позиционирования tooltip/overlay
    scrollWrapper.style.position = 'relative';

    const canvas = document.createElement('canvas');
    const chartId = `chart_${sCfg.id}_${varName}`;
    canvas.id = chartId;

    const pointsCount = Math.max(
      rawValues?.length || 0,
      processedValues?.length || 0
    );

    canvas.width = Math.max(700, pointsCount * 8);
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

    canvas.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartX;
      scrollWrapper.scrollLeft = startScrollLeft - dx;
    });

    canvas.addEventListener('mouseup', () => {
      isDragging = false;
      scrollWrapper.style.cursor = 'grab';
    });

    canvas.addEventListener('mouseleave', () => {
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
      rawSpan.style.color = RAW_COLOR;
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
        rawColor: RAW_COLOR,
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

/* ================= ВСПОМОГАТЕЛИ ================= */

// бинарный поиск ближайшего индекса в сортированном массиве times
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
  // lo - первый элемент >= target
  const prev = lo - 1;
  return (Math.abs(arr[lo] - target) < Math.abs(arr[prev] - target)) ? lo : prev;
}

/* ================== РИСОВАНИЕ ГРАФИКА ================== */

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
    series.push({ data: rawData, color: options.rawColor || '#777', name: 'RAW' });
  }
  if (Array.isArray(processedData) && processedData.length) {
    series.push({ data: processedData, color: options.processedColor || '#d00', name: 'PROC' });
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

  // сетка Y
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

  // оси
  ctx.strokeStyle = '#000';
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, h - bottom);
  ctx.lineTo(w - right, h - bottom);
  ctx.stroke();

  // подписи Y
  ctx.fillStyle = '#333';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= 5; i++) {
    const v = max - (max - min) * i / 5;
    const y = top + (ch / 5) * i;
    ctx.fillText(v.toFixed(1), left - 8, y);
  }

  // подпись Y вертикально
  if (options.ylabel) {
    ctx.save();
    ctx.translate(18, h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(options.ylabel, 0, 0);
    ctx.restore();
  }

  // временная ось
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

  // рисуем линии
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

  // ====== overlay canvas + tooltip: показываем точное значение при наведении ======
  const scrollWrapper = canvas.parentElement; // ожидаем, что canvas вложен в scrollWrapper
  if (!scrollWrapper) return;

  // создаём (или переиспользуем) оверлейный canvas
  const overlayId = id + '_overlay';
  let overlay = document.getElementById(overlayId);
  if (!overlay) {
    overlay = document.createElement('canvas');
    overlay.id = overlayId;
    overlay.style.position = 'absolute';
    overlay.style.left = '0';
    overlay.style.top = '0';
    overlay.style.pointerEvents = 'auto';
    overlay.style.background = 'transparent';
    scrollWrapper.appendChild(overlay);
  }
  // привязываем размеры оверлея к основному canvas (включая высокий DPI)
  overlay.width = canvas.width;
  overlay.height = canvas.height;
  overlay.style.width = canvas.style.width || canvas.width + 'px';
  overlay.style.height = canvas.style.height || canvas.height + 'px';

  const octx = overlay.getContext('2d');
  octx.clearRect(0, 0, overlay.width, overlay.height);

  // tooltip элемент
  const tipId = id + '_tip';
  let tip = document.getElementById(tipId);
  if (!tip) {
    tip = document.createElement('div');
    tip.id = tipId;
    tip.style.position = 'absolute';
    tip.style.pointerEvents = 'none';
    tip.style.background = 'rgba(0,0,0,0.8)';
    tip.style.color = '#fff';
    tip.style.padding = '6px 8px';
    tip.style.borderRadius = '6px';
    tip.style.fontSize = '12px';
    tip.style.whiteSpace = 'nowrap';
    tip.style.transform = 'translate(-50%, -110%)';
    tip.style.display = 'none';
    scrollWrapper.appendChild(tip);
  }

  function clearOverlay() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    tip.style.display = 'none';
  }

  // Обработчики мыши
  overlay.onmousemove = function (e) {
    // rect и scrollLeft используются, чтобы получить координату в системе полного canvas
    const rect = canvas.getBoundingClientRect();
    const scrollLeft = scrollWrapper.scrollLeft || 0;
    const xCanvas = (e.clientX - rect.left) + scrollLeft;
    const yCanvas = (e.clientY - rect.top);

    // ограничиваем по границам области рисования
    if (xCanvas < left || xCanvas > left + cw) {
      clearOverlay();
      return;
    }

    // вычисляем время, соответствующее x
    let tAtX;
    if (useTimes) {
      tAtX = tStart + ((xCanvas - left) / cw) * tSpan;
    } else {
      // если времён нет — сопоставляем индекс по относительной позиции
      const idxFloat = ((xCanvas - left) / cw) * (series[0].data.length - 1);
      const idx = Math.round(idxFloat);
      tAtX = idx; // в режиме без times используем индекс вместо времени
    }

    // находим ближайшую точку (по времени или по индексу)
    let idx;
    if (useTimes) {
      idx = findNearestIndex(times, tAtX);
    } else {
      idx = Math.max(0, Math.min(series[0].data.length - 1, Math.round(tAtX)));
    }
    if (idx < 0) {
      clearOverlay();
      return;
    }

    // собираем значения всех серий в этой точке
    const values = series.map(s => {
      const v = s.data[idx];
      return Number.isFinite(v) ? v : NaN;
    });

    // позиция по X для выбранного индекса
    const xPos = useTimes ? left + ((times[idx] - tStart) / tSpan) * cw : left + (idx / (series[0].data.length - 1)) * cw;

    // чистим и рисуем вертикальную линию и маркеры
    octx.clearRect(0, 0, overlay.width, overlay.height);

    // вертикальная линия
    octx.strokeStyle = 'rgba(0,0,0,0.6)';
    octx.lineWidth = 1;
    octx.setLineDash([4, 2]);
    octx.beginPath();
    octx.moveTo(xPos, top);
    octx.lineTo(xPos, h - bottom);
    octx.stroke();
    octx.setLineDash([]);

    // маркеры для каждой серии (показываем только конечную Y если число больших)
    for (let si = 0; si < series.length; si++) {
      const v = values[si];
      if (!Number.isFinite(v)) continue;
      const yPos = top + ch - ((v - min) / (max - min)) * ch;
      octx.fillStyle = series[si].color;
      octx.beginPath();
      octx.arc(xPos, yPos, 4, 0, Math.PI * 2);
      octx.fill();
      octx.strokeStyle = '#fff';
      octx.lineWidth = 1;
      octx.stroke();
    }

    // формируем текст тултипа: время + значения
    let timeText = useTimes ? formatTimeHHMMSS(times[idx]) : `idx:${idx}`;
    let txt = `<b>${timeText}</b><br>`;
    for (let si = 0; si < series.length; si++) {
      const nm = series[si].name || `s${si}`;
      const v = values[si];
      const vtxt = Number.isFinite(v) ? v.toFixed(3) : '—';
      txt += `<span style="color:${series[si].color}">●</span> ${nm}: ${vtxt}`;
      if (si < series.length - 1) txt += '<br>';
    }

    // показываем tooltip рядом с линией
    tip.innerHTML = txt;
    tip.style.display = 'block';

    // вычисляем позицию tooltip относительно scrollWrapper (overlay и canvas используют ту же систему координат)
    // left = xPos, top = top (смещение вверху области рисования)
    const tipX = xPos;
    // ставим чуть выше верхней области графика
    const tipY = top + 6;

    tip.style.left = tipX + 'px';
    tip.style.top = tipY + 'px';
  };

  overlay.onmouseleave = function () {
    clearOverlay();
  };

  // При клике — фиксируем/анимируем (пока просто очищаем оверлей)
  overlay.onclick = function () {
    // впоследствии можно добавить "фиксацию" точки
  };
}

export function clearChart(id) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const overlay = document.getElementById(id + '_overlay');
  if (overlay) {
    const octx = overlay.getContext('2d');
    octx.clearRect(0, 0, overlay.width, overlay.height);
  }
}