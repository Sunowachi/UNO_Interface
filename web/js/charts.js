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
  // Находим контейнер, в котором будут располагаться все графики
  const container = document.getElementById('chartsContainer');
  // Цвет для сырых данных (RAW) по умолчанию
  const RAW_COLOR = '#999999';

  // Если нет выбранного датчика или контейнер не найден, очищаем контейнер и выходим
  if (!currentSensor || !container) {
    if (container) container.innerHTML = "";
    return;
  }

  // Ищем конфигурацию текущего датчика в общем списке (исключаем удалённые)
  const sCfg = config.sensors.find(s => String(s.id) === String(currentSensor) && !s.deleted);
  if (!sCfg) {
    // Если датчик не найден, очищаем контейнер
    container.innerHTML = "";
    return;
  }

  // Получаем список переменных для этого датчика:
  // может быть массивом или строкой через запятую. Приводим к массиву строк, обрезаем пробелы, удаляем пустые
  const vars = Array.isArray(sCfg.vars)
    ? sCfg.vars.map(v => String(v).trim()).filter(Boolean)
    : String(sCfg.vars || '').split(',').map(v => v.trim()).filter(Boolean);

  // Множество ID обёрток (wrapper), которые должны остаться (для удаления лишних)
  const desiredWrapperIds = new Set();
  // Настройки переменных (varSettings) из конфигурации, если есть
  const varSettings = Array.isArray(sCfg.varSettings) ? sCfg.varSettings : [];
  // Получаем выбранный временной диапазон в миллисекундах
  const rangeMs = getSelectedTimeRangeMs();
  // Текущее время (метка в миллисекундах)
  const now = Date.now();

  // Перебираем все переменные датчика
  for (let idx = 0; idx < vars.length; idx++) {
    const varName = vars[idx];
    // Возможные ключи для поиска в allSensors (с исходным регистром и в нижнем регистре)
    const keyColon = `${sCfg.id}:${varName}`;
    const keyLowerColon = `${sCfg.id}:${varName.toLowerCase()}`;
    let dataKey = null;

    // Определяем, по какому ключу есть данные
    if (allSensors[keyColon]) dataKey = keyColon;
    else if (allSensors[keyLowerColon]) dataKey = keyLowerColon;

    // Если данных для этой переменной нет, пропускаем
    if (!dataKey) continue;

    // Получаем объект с данными для этой переменной
    const sData = allSensors[dataKey];
    // Проверяем, что данные существуют, что это массив значений и он не пуст
    if (!sData || !Array.isArray(sData.values) || sData.values.length === 0) continue;

    // Получаем временные метки для этой переменной (если есть)
    let times = sensorTimes[dataKey] || null;
    // Получаем настройки для этой переменной из varSettings (если есть)
    const vs = varSettings.find(v => v.var === varName) || {};
    // Название для графика (если не задано, используем имя переменной)
    const baseLabel = vs.label || varName;
    // Единица измерения (если есть)
    const unit = vs.unit || '';
    // Выбираем цвет по умолчанию из списка (циклически по индексу)
    const defaultColor = COLOR_CHOICES[idx % COLOR_CHOICES.length].value;
    // Используем заданный цвет или цвет по умолчанию
    const color = vs.color || defaultColor;

    // Копируем сырые значения
    let rawValues = sData.values.slice();
    // Режим обработки (по умолчанию 'none')
    const processingMode = vs.processing || 'none';
    // Если режим не 'none', применяем обработку
    let processedValues = (processingMode && processingMode !== 'none')
      ? applyProcessing(rawValues, processingMode)
      : null;

    // Если после обработки длина массива изменилась (что не должно происходить), сбрасываем обработанные данные
    if (processedValues && processedValues.length !== rawValues.length) {
      processedValues = null;
    }

    // Флаг отображения сырых данных (по умолчанию true)
    const showRaw = (typeof vs.showRaw === 'boolean') ? vs.showRaw : true;
    // Флаг отображения обработанных данных (по умолчанию true, если режим не 'none')
    const showProcessed = (processingMode !== 'none')
      ? ((typeof vs.showProcessed === 'boolean') ? vs.showProcessed : true)
      : false;

    // Заголовок графика: если есть единица измерения, добавляем её в скобках
    const titleText = unit ? `${baseLabel} (${unit})` : baseLabel;

    // Если задан временной диапазон и есть временные метки той же длины, что и значения,
    // обрезаем данные, оставляя только те, что попадают в диапазон
    if (rangeMs > 0 && Array.isArray(times) && times.length === rawValues.length) {
      const minAllowedTime = now - rangeMs; // Минимально допустимое время
      let startIdx = 0;
      // Ищем первый индекс, время которого >= minAllowedTime
      for (let i = 0; i < times.length; i++) {
        if (times[i] >= minAllowedTime) { startIdx = i; break; }
      }
      // Обрезаем массивы
      times = times.slice(startIdx);
      rawValues = rawValues.slice(startIdx);
      if (processedValues) processedValues = processedValues.slice(startIdx);
    }

    // Если после обрезки нет данных, пропускаем эту переменную
    if (!rawValues.length && (!processedValues || !processedValues.length)) continue;

    // Последнее значение для отображения в карточке
    const lastVal = rawValues.length ? rawValues[rawValues.length - 1] : NaN;
    // Определяем класс предупреждения (мигание) для карточки
    const alertClass = getAlertClass(vs, lastVal);
    // Формируем уникальный ID для canvas и обёртки
    const canvasId = `chart_${sCfg.id}_${varName}`;
    const wrapperId = `wrapper_${canvasId}`;
    // Добавляем ID обёртки в множество желаемых (чтобы потом не удалить)
    desiredWrapperIds.add(wrapperId);

    // Пытаемся найти существующую обёртку в DOM
    let wrapper = document.getElementById(wrapperId);
    let scrollWrapper, canvas, valueCard;

    // Если обёртка ещё не создана, создаём её
    if (!wrapper) {
      // Создаём основной контейнер для графика и карточки
      wrapper = document.createElement('div');
      wrapper.className = 'chart-wrapper';
      wrapper.id = wrapperId;
      wrapper.style.cssText = 'display: flex; flex-direction: row; gap: 15px; align-items: flex-start; margin-bottom: 20px;';

      // Создаём карточку с текущим значением
      valueCard = document.createElement('div');
      valueCard.className = 'card';
      valueCard.style.cssText = 'width: 180px; height: 200px; padding: 15px; text-align: center; display: flex; flex-direction: column; justify-content: center; align-items: center; flex-shrink: 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); border-radius: 8px; background-color: #f8f9fa;';

      // Заголовок карточки (имя переменной)
      const valueTitle = document.createElement('div');
      valueTitle.textContent = baseLabel;
      valueTitle.style.cssText = 'font-weight: bold; font-size: 16px; margin-bottom: 8px; color: #333;';

      // Текст с последним значением
      const valueText = document.createElement('div');
      valueText.style.cssText = 'font-size: 20px; font-weight: 600; color: #007bff;';
      valueText.textContent = Number.isFinite(lastVal) ? (lastVal.toFixed(2) + (unit ? ' ' + unit : '')) : 'нет данных';

      // Собираем карточку
      valueCard.appendChild(valueTitle);
      valueCard.appendChild(valueText);
      if (alertClass) valueCard.classList.add(alertClass); // Добавляем класс мигания, если есть

      // Контейнер для графика (заголовок + область прокрутки)
      const chartContainer = document.createElement('div');
      chartContainer.style.cssText = 'flex: 1 1 auto; display: flex; flex-direction: column; gap: 8px; max-width: calc(100vw - 350px); overflow: hidden;';

      // Заголовок графика
      const title = document.createElement('h3');
      title.textContent = titleText;
      title.style.cssText = 'margin: 0 0 5px 0; font-size: 18px; color: #444;';
      chartContainer.appendChild(title);

      // Обёртка для прокрутки (горизонтальный скролл)
      scrollWrapper = document.createElement('div');
      scrollWrapper.style.cssText = 'overflow-x: auto; overflow-y: hidden; width: 100%; max-width: 100%; padding-bottom: 6px; cursor: grab; background-color: #fff; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);';

      // Сам холст для рисования графика
      canvas = document.createElement('canvas');
      canvas.id = canvasId;
      canvas.height = 220; // Фиксированная высота
      canvas.style.display = 'block';

      // Вычисляем желаемую ширину холста на основе количества точек и CHART_POINT_PX
      const pointsCount = Math.max(rawValues?.length || 0, processedValues?.length || 0);
      const desiredWidth = Math.min(CHART_MAX_CONTENT_PX, Math.max(CHART_MIN_CANVAS_PX, pointsCount * CHART_POINT_PX));
      canvas.width = desiredWidth; // Устанавливаем ширину

      // Обработчик колесика мыши для горизонтальной прокрутки
      canvas.addEventListener('wheel', (e) => {
        // Определяем направление прокрутки (deltaX или deltaY)
        const dx = (Math.abs(e.deltaX) > 0) ? e.deltaX : e.deltaY;
        if (dx !== 0) {
          e.preventDefault(); // Предотвращаем вертикальную прокрутку страницы
          scrollWrapper.scrollLeft += dx; // Прокручиваем горизонтально
        }
      }, { passive: false });

      // Функция для реализации перетаскивания графика мышью (drag to scroll)
      (function attachDrag(canvasEl, scrollEl) {
        let isDragging = false;
        let dragStartX = 0;
        let startScrollLeft = 0;

        // При нажатии кнопки мыши начинаем перетаскивание
        canvasEl.addEventListener('mousedown', (e) => {
          isDragging = true;
          scrollEl.style.cursor = 'grabbing'; // Меняем курсор
          dragStartX = e.clientX;              // Запоминаем начальную позицию мыши
          startScrollLeft = scrollEl.scrollLeft; // Запоминаем текущий скролл
          e.preventDefault();                  // Предотвращаем выделение текста
        });

        // При движении мыши перемещаем скролл
        function onMove(e) {
          if (!isDragging) return;
          const dx = e.clientX - dragStartX; // Смещение мыши
          scrollEl.scrollLeft = startScrollLeft - dx; // Прокручиваем в противоположную сторону
        }

        // Завершение перетаскивания
        function stop() { isDragging = false; scrollEl.style.cursor = 'grab'; }

        // Добавляем обработчики
        canvasEl.addEventListener('mousemove', onMove);
        canvasEl.addEventListener('mouseup', stop);
        canvasEl.addEventListener('mouseleave', stop);
      })(canvas, scrollWrapper);

      // Собираем структуру
      scrollWrapper.appendChild(canvas);
      chartContainer.appendChild(scrollWrapper);
      wrapper.appendChild(valueCard);
      wrapper.appendChild(chartContainer);
      container.appendChild(wrapper);

      // После добавления в DOM прокручиваем в конец (чтобы видеть последние данные)
      requestAnimationFrame(() => {
        scrollWrapper.scrollLeft = Math.max(0, scrollWrapper.scrollWidth - scrollWrapper.clientWidth);
      });

    } else {
      // Если обёртка уже существует, обновляем её содержимое
      valueCard = wrapper.querySelector('.card'); // Ищем карточку
      scrollWrapper = wrapper.querySelector('div[style*="overflowX"]') || wrapper.querySelector('div'); // Ищем элемент с прокруткой
      canvas = document.getElementById(canvasId) || wrapper.querySelector('canvas'); // Ищем холст

      // Обновляем заголовок карточки
      const valueTitle = valueCard ? valueCard.querySelector('div:nth-child(1)') : null;
      if (valueTitle) {
        valueTitle.textContent = baseLabel;
        valueTitle.style.cssText = 'font-weight: bold; font-size: 16px; color: #333;';
      }

      // Обновляем текст значения в карточке
      const valueText = valueCard ? valueCard.querySelector('div:nth-child(2)') : null;
      if (valueText) {
        valueText.textContent = Number.isFinite(lastVal)
          ? (lastVal.toFixed(2) + (unit ? ' ' + unit : ''))
          : 'нет данных';
        valueText.style.cssText = 'font-size: 20px; color: #007bff;';
      }

      // Обновляем классы мигания
      if (valueCard) {
        valueCard.classList.remove('blink-blue', 'blink-yellow', 'blink-red');
        if (alertClass) valueCard.classList.add(alertClass);
      }

      // Обновляем заголовок графика
      const title = wrapper.querySelector('h3');
      if (title) {
        title.textContent = titleText;
        title.style.cssText = 'margin: 0 0 5px 0; font-size: 18px; color: #444;';
      }

      // Убеждаемся, что стили wrapper правильные (на случай изменений)
      wrapper.style.cssText = 'display: flex; flex-direction: row; gap: 15px; align-items: flex-start; margin-bottom: 20px;';

      if (valueCard) {
        valueCard.style.cssText = 'width: 180px; height: 200px; padding: 15px; text-align: center; display: flex; flex-direction: column; justify-content: center; align-items: center; flex-shrink: 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); border-radius: 8px; background-color: #f8f9fa;';
      }
    }

    // Если холст найден или создан, обновляем его размер и перерисовываем
    if (canvas) {
      // Количество точек для определения ширины
      const pointsCountNow = Math.max(rawValues?.length || 0, processedValues?.length || 0);
      const desiredWidth = Math.min(CHART_MAX_CONTENT_PX, Math.max(CHART_MIN_CANVAS_PX, pointsCountNow * CHART_POINT_PX));

      // Определяем, находится ли прокрутка в конце (чтобы после изменения ширины остаться там же)
      const atEnd = scrollWrapper ? (Math.abs(scrollWrapper.scrollLeft - (scrollWrapper.scrollWidth - scrollWrapper.clientWidth)) <= 2) : true;
      const prevScrollWidth = scrollWrapper ? scrollWrapper.scrollWidth : 0;
      const prevScrollLeft = scrollWrapper ? scrollWrapper.scrollLeft : 0;

      // Если ширина холста изменилась
      if (canvas.width !== desiredWidth) {
        canvas.width = desiredWidth;
        if (scrollWrapper) {
          if (atEnd) {
            // Если были в конце, после изменения ширины снова прокручиваем в конец
            requestAnimationFrame(() => {
              scrollWrapper.scrollLeft = Math.max(0, scrollWrapper.scrollWidth - scrollWrapper.clientWidth);
            });
          } else {
            // Иначе сохраняем относительную позицию (добавляем разницу в ширине)
            const delta = (scrollWrapper.scrollWidth - prevScrollWidth);
            scrollWrapper.scrollLeft = Math.max(0, prevScrollLeft + delta);
          }
        }
      }

      // Вызываем функцию отрисовки графика на холсте
      drawChart(canvas.id, showRaw ? rawValues : null, showProcessed ? processedValues : null, times, {
        rawColor: RAW_COLOR,
        processedColor: color,
        ylabel: titleText
      });
    }
  }

  // Удаляем лишние обёртки, которые больше не нужны (например, для переменных, которых больше нет)
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
  // Получаем элемент canvas по ID
  const canvas = document.getElementById(id);
  if (!canvas) return;

  // Получаем 2D-контекст для рисования
  const ctx = canvas.getContext('2d');
  const w = canvas.width;   // ширина холста
  const h = canvas.height;  // высота холста

  // Отступы от краёв для области рисования графика
  const left = 80;
  const right = 40;
  const top = 25;
  const bottom = 55;

  // Очищаем холст (заливаем прозрачным)
  ctx.clearRect(0, 0, w, h);

  // Проверяем, можно ли использовать временные метки (если они есть и длины совпадают)
  const useTimes = Array.isArray(times) && times.length > 1 &&
    (!rawData || times.length === rawData.length) &&
    (!processedData || times.length === processedData.length);

  // Формируем массив серий данных для отрисовки (каждая серия: data, color)
  const series = [];
  if (Array.isArray(rawData) && rawData.length) {
    series.push({ data: rawData, color: options.rawColor || '#777' });
  }
  if (Array.isArray(processedData) && processedData.length) {
    series.push({ data: processedData, color: options.processedColor || '#d00' });
  }
  // Если нет данных, выходим
  if (!series.length) return;

  // Находим минимальное и максимальное значения среди всех серий
  let min = Infinity;
  let max = -Infinity;

  series.forEach(s => s.data.forEach(v => {
    if (Number.isFinite(v)) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }));

  // Если нет ни одного числового значения, выходим
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  // Если минимум равен максимуму, добавляем небольшие отступы для визуализации
  if (min === max) {
    min -= 0.5;
    max += 0.5;
  }

  // Ширина и высота области графика (внутри отступов)
  const cw = w - left - right;
  const ch = h - top - bottom;

  // Переменные для временной шкалы
  let tStart = 0, tEnd = 1, tSpan = 1;
  if (useTimes) {
    tStart = times[0];               // начальное время
    tEnd = times[times.length - 1];   // конечное время
    tSpan = Math.max(1, tEnd - tStart); // диапазон времени
  }

  // Отрисовка горизонтальных линий сетки (пунктир)
  ctx.strokeStyle = '#ddd';
  ctx.setLineDash([4, 4]);
  for (let i = 0; i <= 5; i++) {
    const y = top + (ch / 5) * i; // позиция по Y
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(w - right, y);
    ctx.stroke();
  }
  ctx.setLineDash([]); // сбрасываем пунктир

  // Отрисовка осей (вертикальная и горизонтальная линии)
  ctx.strokeStyle = '#000';
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, h - bottom);
  ctx.lineTo(w - right, h - bottom);
  ctx.stroke();

  // Подписи значений по оси Y (слева)
  ctx.fillStyle = '#333';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 5; i++) {
    const v = max - (max - min) * i / 5; // значение от max до min
    const y = top + (ch / 5) * i;         // позиция по Y
    ctx.fillText(v.toFixed(1), left - 8, y); // рисуем текст с одним знаком после запятой
  }

  // Подпись оси Y (если передана в options)
  if (options.ylabel) {
    ctx.save(); // сохраняем состояние контекста
    ctx.translate(18, h / 2); // смещаем в левую часть по центру высоты
    ctx.rotate(-Math.PI / 2); // поворачиваем на -90 градусов (вертикально)
    ctx.textAlign = 'center';
    ctx.fillText(options.ylabel, 0, 0); // рисуем текст
    ctx.restore(); // восстанавливаем состояние
  }

  // Временные метки и вертикальные линии сетки (если используются времена)
  if (useTimes) {
    const span = tSpan; // общий временной диапазон
    // Определяем шаг между метками в зависимости от диапазона
    const STEP = span < 2 * 60e3  ? 10e3 :   // менее 2 минут -> шаг 10 секунд
      span < 15 * 60e3 ? 60e3 :               // менее 15 минут -> шаг 1 минута
      span < 2 * 3600e3 ? 5 * 60e3 :          // менее 2 часов -> шаг 5 минут
      span < 12 * 3600e3 ? 30 * 60e3 :        // менее 12 часов -> шаг 30 минут
      2 * 3600e3;                              // иначе шаг 2 часа

    ctx.font = '11px sans-serif';
    ctx.fillStyle = '#333';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    // Проходим по временным меткам с шагом STEP, начиная с округлённого tStart
    for (let t = Math.ceil(tStart / STEP) * STEP; t <= tEnd; t += STEP) {
      // Вычисляем позицию X на холсте
      const x = left + ((t - tStart) / tSpan) * cw;

      // Рисуем пунктирную вертикальную линию
      ctx.strokeStyle = '#ddd';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, h - bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      // Подписываем время в формате HH:MM:SS
      ctx.fillText(formatTimeHHMMSS(t), x, h - bottom + 5);
    }
  }

  // Отрисовка линий данных для каждой серии
  series.forEach(s => {
    ctx.strokeStyle = s.color; // цвет линии
    ctx.lineWidth = 2;          // толщина
    ctx.beginPath();
    let started = false;        // флаг, начата ли линия

    s.data.forEach((v, i) => {
      if (!Number.isFinite(v)) return; // пропускаем нечисловые значения

      // Вычисляем X координату: если есть времена, интерполируем по времени, иначе по индексу
      const x = useTimes
        ? left + ((times[i] - tStart) / tSpan) * cw
        : left + (i / (s.data.length - 1)) * cw; // линейно от 0 до 1

      // Y координата: отображаем значение в пределах [min, max] на область графика
      const y = top + ch - ((v - min) / (max - min)) * ch;

      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke(); // рисуем линию
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