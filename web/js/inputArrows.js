// ==================== КАСТОМНЫЕ СТРЕЛКИ ДЛЯ ЧИСЛОВЫХ ПОЛЕЙ ====================

/** Инициализация кастомных элементов управления для всех числовых полей внутри указанного контейнера */
export function initCustomNumberInputs(container = document) {
    const inputs = container.querySelectorAll('input[type="number"]:not([data-custom-number])');
    inputs.forEach(input => {
        input.setAttribute('data-custom-number', 'true');

        const wrapper = document.createElement('div');
        wrapper.className = 'custom-number-wrapper';

        input.parentNode.insertBefore(wrapper, input);
        wrapper.appendChild(input);

        // Если поле отключено, не добавляем кнопки
        if (input.disabled) return;

        const btnContainer = document.createElement('div');
        btnContainer.className = 'custom-number-buttons';

        const incBtn = document.createElement('button');
        incBtn.type = 'button';
        incBtn.className = 'custom-number-inc';
        incBtn.innerHTML = '▲';
        incBtn.addEventListener('click', (e) => {
            e.preventDefault();
            stepValue(input, 1);
        });

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

/** Изменение значения поля на один шаг в указанном направлении */
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
    input.dispatchEvent(new Event('change', { bubbles: true }));
}
