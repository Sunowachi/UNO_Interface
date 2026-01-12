console.log('dsp.js загружен');

// ЦИФРОВАЯ ОБРАБОТКА СИГНАЛОВ (DSP)
export function movingAverage(values, windowSize) {
  const res = [];
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - windowSize + 1);
    const slice = values.slice(start, i + 1);
    const sum = slice.reduce((acc, v) => acc + (Number(v) || 0), 0);
    res.push(sum / slice.length);
  }
  return res;
}

export function medianFilter(values, windowSize) {
  const res = [];
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - windowSize + 1);
    const slice = values.slice(start, i + 1)
      .map(Number)
      .filter(Number.isFinite);
    if (slice.length === 0) {
      res.push(null);
      continue;
    }
    slice.sort((a, b) => a - b);
    const mid = Math.floor(slice.length / 2);
    const med = (slice.length % 2 === 1)
      ? slice[mid]
      : (slice[mid - 1] + slice[mid]) / 2;
    res.push(med);
  }
  return res;
}

export function diffSeries(values) {
  const res = [];
  for (let i = 0; i < values.length; i++) {
    if (i === 0) res.push(0);
    else res.push(values[i] - values[i - 1]);
  }
  return res;
}

export function applyProcessing(values, mode, windowSize = 10) {
  if (!Array.isArray(values) || values.length === 0) return [];
  switch (mode) {
    case 'moving_avg':
      return movingAverage(values, windowSize);
    case 'median':
      return medianFilter(values, windowSize);
    case 'diff':
      return diffSeries(values);
    case 'none':
    default:
      return values.slice(); // копия сырых данных
  }
}