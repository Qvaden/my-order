/**
 * МОЙ ПОРЯДОК — Премиальные свайп-действия в списках (iOS-style Swipe Actions)
 *
 * Предоставляет нативный мобильный опыт:
 *  • Свайп вправо (> 80px)  →  «Оплачено» / «Выполнено» (зелёный цвет + тактильный отклик)
 *  • Свайп влево  (> 80px)  →  «Удалить» (красный цвет + предупредительный щелчок)
 *
 * Экспортирует window.SwipeActions
 */

(function () {
  'use strict';

  var activeCard = null;
  var startX = 0;
  var startY = 0;
  var currentX = 0;
  var isSwiping = false;
  var isScrolling = false;
  var leftTray = null;
  var rightTray = null;

  var THRESHOLD = 80;

  function onTouchStart(e) {
    if (e.touches.length !== 1) { return; }
    var touch = e.touches[0];

    // Игнорируем нажатия на интерактивные элементы внутри карточки (кнопки, инпуты)
    if (e.target && e.target.closest('button, input, a, select, textarea, [tabindex="0"]')) {
      // Но если нажата сама карточка с tabindex="0", свайп должен работать
      var btn = e.target.closest('button, input, a, select, textarea');
      if (btn) { return; }
    }

    var card = e.target.closest('.payment-card, .task-card');
    if (!card) { return; }

    activeCard = card;
    startX = touch.clientX;
    startY = touch.clientY;
    currentX = 0;
    isSwiping = false;
    isScrolling = false;
  }

  function setupTrays(card) {
    var wrapper = card.parentElement;
    if (!wrapper || !wrapper.classList.contains('swipe-item-wrapper')) {
      // Оборачиваем карточку в контейнер со скрытыми подложками
      wrapper = document.createElement('div');
      wrapper.className = 'swipe-item-wrapper';
      card.parentNode.insertBefore(wrapper, card);
      wrapper.appendChild(card);
      card.classList.add('swipe-card-surface');
    }

    rightTray = wrapper.querySelector('.swipe-action-tray--right');
    if (!rightTray) {
      rightTray = document.createElement('div');
      rightTray.className = 'swipe-action-tray swipe-action-tray--right';
      var isTask = card.classList.contains('task-card');
      rightTray.innerHTML = '<span>✓ ' + (isTask ? 'Готово' : 'Оплачено') + '</span>';
      wrapper.insertBefore(rightTray, card);
    }

    leftTray = wrapper.querySelector('.swipe-action-tray--left');
    if (!leftTray) {
      leftTray = document.createElement('div');
      leftTray.className = 'swipe-action-tray swipe-action-tray--left';
      leftTray.innerHTML = '<span>🗑 Удалить</span>';
      wrapper.insertBefore(leftTray, card);
    }

    rightTray.style.opacity = '0';
    leftTray.style.opacity = '0';
  }

  function onTouchMove(e) {
    if (!activeCard || isScrolling) { return; }
    var touch = e.touches[0];
    var dx = touch.clientX - startX;
    var dy = touch.clientY - startY;

    if (!isSwiping) {
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) {
        isScrolling = true;
        return;
      }
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
        isSwiping = true;
        setupTrays(activeCard);
        activeCard.classList.add('is-dragging');
      }
    }

    if (isSwiping) {
      e.preventDefault();
      // Затухающее сопротивление свыше порога
      var damped = dx * 0.75;
      currentX = damped;
      activeCard.style.transform = 'translateX(' + damped + 'px)';

      if (damped > 0 && rightTray) {
        rightTray.style.opacity = String(Math.min(1, damped / THRESHOLD));
        if (leftTray) leftTray.style.opacity = '0';
      } else if (damped < 0 && leftTray) {
        leftTray.style.opacity = String(Math.min(1, Math.abs(damped) / THRESHOLD));
        if (rightTray) rightTray.style.opacity = '0';
      }
    }
  }

  function onTouchEnd() {
    if (!activeCard) { return; }

    var card = activeCard;
    var dx = currentX;

    card.classList.remove('is-dragging');
    activeCard = null;
    isSwiping = false;
    isScrolling = false;

    if (Math.abs(dx) >= THRESHOLD) {
      if (dx > 0) {
        // Свайп вправо: Готово / Оплачено
        triggerSuccessAction(card);
      } else {
        // Свайп влево: Удалить
        triggerDeleteAction(card);
      }
    }

    // Возврат в исходное положение с анимацией
    card.style.transform = 'translateX(0)';
    setTimeout(function () {
      if (rightTray) rightTray.style.opacity = '0';
      if (leftTray) leftTray.style.opacity = '0';
    }, 200);
  }

  function triggerSuccessAction(card) {
    try {
      if (window.VK && window.VK.taptic) {
        window.VK.taptic('notification', 'success');
      }
    } catch (e) {}

    if (card.classList.contains('task-card')) {
      var chk = card.querySelector('.task-checkbox');
      if (chk && !chk.checked) {
        chk.checked = true;
        chk.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else if (card.classList.contains('payment-card')) {
      var toggleBtn = card.querySelector('[data-action="toggle-status"]');
      if (toggleBtn) {
        toggleBtn.click();
      }
    }
  }

  function triggerDeleteAction(card) {
    try {
      if (window.VK && window.VK.taptic) {
        window.VK.taptic('notification', 'warning');
      }
    } catch (e) {}

    var delBtn = card.querySelector('[data-action="delete"], [data-task-action="delete"]');
    if (delBtn) {
      delBtn.click();
    }
  }

  function init() {
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchEnd, { passive: true });
  }

  init();

  window.SwipeActions = {
    init: init
  };
})();
