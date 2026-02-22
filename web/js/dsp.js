// ==================== ЦИФРОВАЯ ОБРАБОТКА СИГНАЛОВ ====================

/** Функция скользящего среднего (окно windowSize) */
export function movingAverage(values, windowSize) {
    const res = [];
    for (let i = 0; i < values.length; i++) {
        const start = Math.max(0, i - windowSize + 1);
        const slice = values
            .slice(start, i + 1)
            .map(Number)
            .filter(Number.isFinite);

        if (slice.length === 0) {
            res.push(null);
            continue;
        }

        const sum = slice.reduce((acc, v) => acc + v, 0);
        res.push(sum / slice.length);
    }
    return res;
}

/** Медианный фильтр с окном windowSize */
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

/** Вычисление производной (разность между текущим и предыдущим значением) */
export function diffSeries(values) {
    const res = [];
    for (let i = 0; i < values.length; i++) {
        const curr = Number(values[i]);
        const prev = Number(values[i - 1]);

        if (i === 0 || !Number.isFinite(curr) || !Number.isFinite(prev)) {
            res.push(null);
        } else {
            res.push(curr - prev);
        }
    }
    return res;
}

/** Применение выбранного метода обработки к данным */
export function applyProcessing(values, mode, windowSize = 10) {
    if (!Array.isArray(values) || values.length === 0) return [];

    const result = (() => {
        switch (mode) {
            case 'moving_avg':
                return movingAverage(values, windowSize);
            case 'median':
                return medianFilter(values, windowSize);
            case 'diff':
                return diffSeries(values);
            case 'none':
            default:
                return values.slice();
        }
    })();

    return Array.isArray(result) && result.length === values.length
        ? result
        : values.map(() => null);
}
