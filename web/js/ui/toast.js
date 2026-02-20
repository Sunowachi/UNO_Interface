let toastTimer = null;

// Показать всплывающее уведомление (toast)
export function showToast(message) {
  let toast = document.getElementById('toastMessage'); // Ищем существующий элемент
  if (!toast) {
    // Если элемента нет, создаём его
    toast = document.createElement('div');
    toast.id = 'toastMessage';
    toast.className = 'toast'; // Базовый класс для стилей
    document.body.appendChild(toast);
  }

  toast.textContent = message;               // Устанавливаем текст
  toast.classList.add('toast-show');          // Добавляем класс для отображения (анимация)

  // Если уже есть запущенный таймер скрытия, сбрасываем его
  if (toastTimer) clearTimeout(toastTimer);
  // Устанавливаем новый таймер на скрытие через 2.5 секунды
  toastTimer = setTimeout(() => {
    toast.classList.remove('toast-show');     // Убираем класс, скрываем
  }, 2500);
}