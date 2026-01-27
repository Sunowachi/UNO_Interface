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

/*
  Комментарии в коде — на русском.

  Повышение удобства прокрутки и обновлений:
  - добавлено сохранение позиции прокрутки для каждого chart (chartScroll),
    позиция обновляется при событии scroll.
  - холст (canvas) теперь остаётся в разумных пределах по ширине
    (CHART_MIN_CANVAS_PX..CHART_MAX_CANVAS_PX), а "виртуальная" ширина содержимого
    (контента, определяющего scrollbar) соответствует количеству точек * CHART_POINT_PX,
    но ограничена CHART_MAX_CONTENT_PX — это предотвращает бесконечный рост DOM.
  - при отрисовке рисуем только видимую область данных, рассчитывая индекс начальной точки
    согласно scrollLeft и CHART_POINT_PX. Это экономит работу при больших наборах данных.
  - добавлен обработчик scroll для плавного обновления overlay'а и сохранения позиции.
  - при обновлении данных (fetchData -> drawCurrent) позиция прокрутки восстанавливается
    из chartScroll, если пользователь её установил; по умолчанию позиция прокрутки
    устанавливается в конец (последние данные).
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

  // Сохраняем предыдущие позиции прокрутки для существующих графиков
  const prevScrolls = Object.assign({}, chartScroll);

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
    // Для корректного позиционирования overlay используем relative
    scrollWrapper.style.position = 'relative';

    const canvas = document.createElement('canvas');
    const chartId = `chart_${sCfg.id}_${varName}`;
    canvas.id = chartId;

    const pointsCount = Math.max(
      rawValues?.length || 0,
      processedValues?.length || 0
    );

    // виртуальная ширина контента, которая определяет scrollbar
    const virtualContentWidth = Math.min(
      CHART_MAX_CONTENT_PX,
      Math.max(CHART_MIN_CANVAS_PX, pointsCount * CHART_POINT_PX)
    );

    // создаём spacer — невидимый блок, который заставит scrollWrapper иметь нужную ширину
    const spacer = document.createElement('div');
    spacer.className = 'chart-content-spacer';
    spacer.style.width = String(virtualContentWidth) + 'px';
    spacer.style.height = canvas.height + 'px';

    // Размер видимого canvas в CSS-пикселях (по ширине контейнера)
    // canvas элемент центрируем абсолютом над spacer и будем рендерить в нём видимую част��.
    const visibleCssWidth = Math.max(CHART_MIN_CANVAS_PX, Math.min(CHART_MAX_CANVAS_PX,  // ограничиваем реальный холст
      Math.round(Math.min(virtualContentWidth, Math.max(700, Math.floor((window.innerWidth || 900) * 0.6))))));

    // Устанавливаем размеры холста (атрибуты width/height в device-pixel)
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(visibleCssWidth * dpr);
    canvas.height = 220 * dpr;
    // задаём CSS ширину/высоту (inline стили используются для точной подгонки)
    canvas.style.width = visibleCssWidth + 'px';
    canvas.style.height = '220px';
    canvas.style.display = 'block';
    canvas.style.position = 'absolute';
    canvas.style.left = '0px';
    canvas.style.top = '0px';
    canvas.style.zIndex = '1';

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

    // Добавляем spacer и холст в wrapper
    scrollWrapper.appendChild(spacer);
    scrollWrapper.appendChild(canvas);
    chartContainer.appendChild(scrollWrapper);

    // ЛЕГЕНДА под графиком: RAW и обработанная ��иния
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

    // Восстанавливаем позицию скролла, если была
    const saved = prevScrolls[chartId];
    if (typeof saved === 'number') {
      // Ожидаем следующий event loop, чт��бы размеры DOM применились
      requestAnimationFrame(() => {
        // clamp значение
        const maxLeft = Math.max(0, virtualContentWidth - scrollWrapper.clientWidth);
        scrollWrapper.scrollLeft = Math.max(0, Math.min(saved, maxLeft));
        // после установки скролла — отрисовать видимую часть
        drawChartViewport(chartId, canvas, rawValues, processedValues, times, {
          rawColor: RAW_COLOR,
          processedColor: color,
          ylabel: titleText
        }, scrollWrapper);
      });
    } else {
      // по умолчанию — в конец (последние точки)
      requestAnimationFrame(() => {
        const maxLeft = Math.max(0, virtualContentWidth - scrollWrapper.clientWidth);
        scrollWrapper.scrollLeft = maxLeft;
        drawChartViewport(chartId, canvas, rawValues, processedValues, times, {
          rawColor: RAW_COLOR,
          processedColor: color,
          ylabel: titleText
        }, scrollWrapper);
      });
    }

    // Сохраняем скролл при прокрутке пользователем и перерисовываем область overlay при скролле
    scrollWrapper.addEventListener('scroll', () => {
      chartScroll[chartId] = scrollWrapper.scrollLeft;
      drawChartViewport(chartId, canvas, rawValues, processedValues, times, {
        rawColor: RAW_COLOR,
        processedColor: color,
        ylabel: titleText
      }, scrollWrapper);
    }, { passive: true });

    // Если данные обновляются (fetchData), drawCurrent перезапустит этот цикл и
    // восстановит позицию из chartScroll — тем самым пользовательский сдвиг сохраняется.
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
  const prev = lo - 1;
  return (Math.abs(arr[lo] - target) < Math.abs(arr[prev] - target)) ? lo : prev;
}

/* ================== ОТДЕЛЬНАЯ ОТРИСОВКА ВИДИМОЙ ОБЛАСТИ ================== */

function drawChartViewport(id, canvas, rawData, processedData, times, options = {}, scrollWrapper) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // приводим device-pixel размеры
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.round(parseFloat(canvas.style.width) || canvas.clientWidth || 800);
  const cssH = Math.round(parseFloat(canvas.style.height) || canvas.clientHeight || 220);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // работаем в CSS-пикселях

  const w = cssW;
  const h = cssH;

  const left = 80;
  const right = 40;
  const top = 25;
  const bottom = 70;

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

  // параметры виртуальной области
  const pointsCount = Math.max(
    rawData?.length || 0,
    processedData?.length || 0
  );

  const virtualWidth = Math.min(CHART_MAX_CONTENT_PX, Math.max(CHART_MIN_CANVAS_PX, pointsCount * CHART_POINT_PX));

  // текущий сдвиг в пикселях относительно глобальной виртуальной области
  const scrollLeft = scrollWrapper ? scrollWrapper.scrollLeft : (virtualWidth - cw);
  // диапазон видимых глобальных координат
  const viewLeft = scrollLeft;
  const viewRight = scrollLeft + cw;

  // вычисляем индексы видимых точек
  const firstIdx = Math.max(0, Math.floor((viewLeft - left) / CHART_POINT_PX));
  const lastIdx = Math.min(pointsCount - 1, Math.ceil((viewRight - left) / CHART_POINT_PX));

  // если используем times — определяем видимый временной интервал
  let tStart = 0, tEnd = 1, tSpan = 1;
  if (useTimes) {
    tStart = times[0];
    tEnd = times[times.length - 1];
    tSpan = Math.max(1, tEnd - tStart);
  }

  // Сетка Y
  ctx.strokeStyle = '#ddd';
  ctx.setLineDash([4, 4]);
  for (let i = 0; i <= 5; i++) {
    const y = top + (ch / 5) * i;
    ctx.beginPath();
    ctx.moveTo(left - viewLeft, y);
    ctx.lineTo(left - viewLeft + cw, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Оси
  ctx.strokeStyle = '#000';
  ctx.beginPath();
  ctx.moveTo(left - viewLeft, top);
  ctx.lineTo(left - viewLeft, h - bottom);
  ctx.lineTo(left - viewLeft + cw, h - bottom);
  ctx.stroke();

  // подписи Y
  ctx.fillStyle = '#333';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= 5; i++) {
    const v = max - (max - min) * i / 5;
    const y = top + (ch / 5) * i;
    ctx.fillText(v.toFixed(1), left - 8 - viewLeft, y);
  }

  // подпись Y вертикально
  if (options.ylabel) {
    ctx.save();
    ctx.translate(18 - viewLeft, h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(options.ylabel, 0, 0);
    ctx.restore();
  }

  // временная ось (рисуем подписи для видимой интервала)
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

    // определяем временной шаг в пикселях для подписи
    const pxPerMs = (virtualWidth - left - right) / Math.max(1, tSpan);
    // находим первый t в видимой области кратный STEP
    const tViewStart = tStart + ((viewLeft - left) / pxPerMs);
    const tViewEnd = tStart + ((viewRight - left) / pxPerMs);
    for (
      let t = Math.ceil(tViewStart / STEP) * STEP;
      t <= tViewEnd;
      t += STEP
    ) {
      const xGlobal = left + ((t - tStart) / tSpan) * (virtualWidth - left - right);
      const x = xGlobal - viewLeft;
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

  // рисуем линии — только для видимого диапазона индексов
  series.forEach(s => {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.beginPath();

    let started = false;

    for (let i = firstIdx; i <= lastIdx; i++) {
      const v = s.data[i];
      if (!Number.isFinite(v)) continue;

      const xGlobal = left + i * CHART_POINT_PX;
      const x = xGlobal - viewLeft;
      const y = top + ch - ((v - min) / (max - min)) * ch;

      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  });

  canvas.onmousemove = function (e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX;
    const xInCanvas = clientX - rect.left; // CSS-пиксели внутри canvas
    const xGlobal = viewLeft + xInCanvas;

    // ограничиваем
    if (xGlobal < left || xGlobal > left + (pointsCount - 1) * CHART_POINT_PX) {
      // перерисуем без overlay (просто сброс)
      drawChartViewport(id, canvas, rawData, processedData, times, options, scrollWrapper);
      return;
    }

    // находим индекс ближайшей точки
    const idx = Math.round((xGlobal - left) / CHART_POINT_PX);
    if (idx < 0 || idx >= pointsCount) {
      drawChartViewport(id, canvas, rawData, processedData, times, options, scrollWrapper);
      return;
    }

    // перерисовываем базовый слой
    drawChartViewport(id, canvas, rawData, processedData, times, options, scrollWrapper);

    // рисуем overlay элементы напрямую
    // вертикальная линия
    const xLocal = left + idx * CHART_POINT_PX - viewLeft;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 2]);
    ctx.beginPath();
    ctx.moveTo(xLocal, top);
    ctx.lineTo(xLocal, h - bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    // собираем значения всех серий в этой точке
    const values = series.map(s => {
      const v = s.data[idx];
      return Number.isFinite(v) ? v : NaN;
    });

    // маркеры
    for (let si = 0; si < series.length; si++) {
      const v = values[si];
      if (!Number.isFinite(v)) continue;
      const yPos = top + ch - ((v - min) / (max - min)) * ch;
      ctx.fillStyle = series[si].color;
      ctx.beginPath();
      ctx.arc(xLocal, yPos, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // тултип рисуем в canvas (в левом верхнем углу видимой области)
    const timeText = useTimes && times && times[idx] ? formatTimeHHMMSS(times[idx]) : `idx:${idx}`;
    const lines = [];
    lines.push({ text: timeText, bold: true });
    for (let si = 0; si < series.length; si++) {
      const nm = series[si].name || `s${si}`;
      const v = values[si];
      const vtxt = Number.isFinite(v) ? v.toFixed(3) : '—';
      lines.push({ text: `${nm}: ${vtxt}`, color: series[si].color, bold: false });
    }

    const padding = 6;
    const lineHeight = 16;
    ctx.font = 'bold 12px sans-serif';
    let maxW = ctx.measureText(lines[0].text).width;
    ctx.font = '12px sans-serif';
    for (let i = 1; i < lines.length; i++) {
      const wtxt = ctx.measureText(lines[i].text).width;
      maxW = Math.max(maxW, wtxt + 12 + 6);
    }

    const boxW = Math.round(maxW + padding * 2);
    const boxH = Math.round(lines.length * lineHeight + padding * 2);

    let boxX = Math.round(xLocal - boxW / 2);
    if (boxX < left - viewLeft) boxX = left - viewLeft + 4;
    if (boxX + boxW > w - right) boxX = w - right - boxW - 4;
    let boxY = top + 6;

    // фон
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    const r = 6;
    ctx.beginPath();
    ctx.moveTo(boxX + r, boxY);
    ctx.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + boxH, r);
    ctx.arcTo(boxX + boxW, boxY + boxH, boxX, boxY + boxH, r);
    ctx.arcTo(boxX, boxY + boxH, boxX, boxY, r);
    ctx.arcTo(boxX, boxY, boxX + boxW, boxY, r);
    ctx.closePath();
    ctx.fill();

    // текст и цветные кружки
    let tx = boxX + padding;
    let ty = boxY + padding + 12;

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (ln.bold) {
        ctx.font = 'bold 12px sans-serif';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(ln.text, tx, ty);
        ty += lineHeight;
      } else {
        const dotX = tx + 4;
        const dotY = ty - 6;
        ctx.fillStyle = ln.color || '#fff';
        ctx.beginPath();
        ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.font = '12px sans-serif';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(ln.text, tx + 12, ty);
        ty += lineHeight;
      }
    }
  };

  canvas.onmouseleave = function () {
    // при уходе мыши — перерисовать базовый слой без overlay
    drawChartViewport(id, canvas, rawData, processedData, times, options, scrollWrapper);
  };
}

export function clearChart(id) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // нет дополнительного overlay-элемента больше
}