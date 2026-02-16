export function initCustomNumberInputs(container = document) {
    // Ищем все числовые поля, которые ещё не обработаны
    const inputs = container.querySelectorAll('input[type="number"]:not([data-custom-number])');
    inputs.forEach(input => {
        // Помечаем, чтобы повторно не обрабатывать
        input.setAttribute('data-custom-number', 'true');

        // Создаём обёртку
        const wrapper = document.createElement('div');
        wrapper.className = 'custom-number-wrapper';

        // Вставляем обёртку перед полем, затем перемещаем поле внутрь
        input.parentNode.insertBefore(wrapper, input);
        wrapper.appendChild(input);

        // Контейнер для кнопок
        const btnContainer = document.createElement('div');
        btnContainer.className = 'custom-number-buttons';

        // Кнопка увеличения
        const incBtn = document.createElement('button');
        incBtn.type = 'button';
        incBtn.className = 'custom-number-inc';
        incBtn.innerHTML = '▲';
        incBtn.addEventListener('click', (e) => {
            e.preventDefault();
            stepValue(input, 1);
        });

        // Кнопка уменьшения
        const decBtn = document.createElement('button');
        decBtn.type = 'button';
        decBtn.className = 'custom-number-dec';
        decBtn.innerHTML = '▼';
        decBtn.addEventListener('click', (e) => {
            e.preventDefault();
            stepValue(input, -1);
        });

        btnContainer.appendChild(incBtn);
        btnContainer.appendChild(decBtn);
        wrapper.appendChild(btnContainer);
    });
}

function stepValue(input, direction) {
    let step = parseFloat(input.step);
    if (isNaN(step) || step === 0) step = 1;
    let min = input.min !== '' ? parseFloat(input.min) : -Infinity;
    let max = input.max !== '' ? parseFloat(input.max) : Infinity;
    let current = parseFloat(input.value) || 0;
    let newVal = current + direction * step;
    if (newVal < min) newVal = min;
    if (newVal > max) newVal = max;
    input.value = newVal;
    // Генерируем событие change для возможных обработчиков
    input.dispatchEvent(new Event('change', { bubbles: true }));
}