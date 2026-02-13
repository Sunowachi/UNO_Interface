// Функции цифровой обработки сигналов

// Функция скользящего среднего (moving average) с окном windowSize
export function movingAverage(values, windowSize) {
  const res = []; // Массив для хранения результата
  // Проходим по всем элементам исходного массива
  for (let i = 0; i < values.length; i++) {
    // Вычисляем начальный индекс для окна: не может быть меньше 0
    const start = Math.max(0, i - windowSize + 1);
    // Извлекаем срез массива от start до i включительно, преобразуем в числа и отфильтровываем нечисловые значения
    const slice = values
      .slice(start, i + 1)
      .map(Number)          // Преобразуем каждый элемент в число
      .filter(Number.isFinite); // Оставляем только конечные числа

    // Если после фильтрации не осталось чисел, добавляем null и переходим к следующей итерации
    if (slice.length === 0) {
      res.push(null);
      continue;
    }

    // Суммируем все числа в срезе
    const sum = slice.reduce((acc, v) => acc + v, 0);
    // Вычисляем среднее и добавляем в результат
    res.push(sum / slice.length);
  }
  return res; // Возвращаем массив сглаженных значений
}

// Функция медианного фильтра с окном windowSize
export function medianFilter(values, windowSize) {
  const res = []; // Массив для результата
  // Проходим по всем элементам исходного массива
  for (let i = 0; i < values.length; i++) {
    // Вычисляем начальный индекс окна
    const start = Math.max(0, i - windowSize + 1);
    // Извлекаем срез, преобразуем в числа и фильтруем нечисловые
    const slice = values.slice(start, i + 1)
      .map(Number)
      .filter(Number.isFinite);

    // Если нет чисел, добавляем null
    if (slice.length === 0) {
      res.push(null);
      continue;
    }

    // Сортируем числа по возрастанию
    slice.sort((a, b) => a - b);
    // Находим индекс середины
    const mid = Math.floor(slice.length / 2);
    // Вычисляем медиану: если длина нечётная, берём средний элемент; если чётная — среднее двух центральных
    const med = (slice.length % 2 === 1)
      ? slice[mid]
      : (slice[mid - 1] + slice[mid]) / 2;
    res.push(med); // Добавляем медиану в результат
  }
  return res;
}

// Функция вычисления производной (разности между текущим и предыдущим значением)
export function diffSeries(values) {
  const res = []; // Массив для результата
  // Проходим по всем элементам
  for (let i = 0; i < values.length; i++) {
    // Преобразуем текущее и предыдущее значения в числа
    const curr = Number(values[i]);
    const prev = Number(values[i - 1]);

    // Для первого элемента (i === 0) или если хотя бы одно значение нечисловое — добавляем null
    if (i === 0 || !Number.isFinite(curr) || !Number.isFinite(prev)) {
      res.push(null);
    } else {
      // Иначе добавляем разность (curr - prev)
      res.push(curr - prev);
    }
  }
  return res;
}

// Применение выбранного метода обработки к данным
// Параметры: исходный массив values, режим mode ('none', 'moving_avg', 'median', 'diff'), размер окна (по умолчанию 10)
export function applyProcessing(values, mode, windowSize = 10) {
  // Если values не массив или пустой, возвращаем пустой массив
  if (!Array.isArray(values) || values.length === 0) return [];

  // Выбираем нужную функцию в зависимости от mode
  const result = (() => {
    switch (mode) {
      case 'moving_avg':
        return movingAverage(values, windowSize); // Скользящее среднее
      case 'median':
        return medianFilter(values, windowSize);  // Медианный фильтр
      case 'diff':
        return diffSeries(values);                // Производная
      case 'none':
      default:
        return values.slice();                    // Без обработки (копия)
    }
  })();

  // Проверяем, что результат, массив и его длина совпадает с исходной
  return Array.isArray(result) && result.length === values.length
    ? result               // Возвращаем обработанный массив
    : values.map(() => null); // Если что-то пошло не так, возвращаем массив из null
}