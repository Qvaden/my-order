/**
 * МОЙ ПОРЯДОК — Мульти-недвижимость (Квартира / Дача / Родители / Аренда)
 *
 * 1 объект — бесплатно всем (Мой дом / Квартира).
 * 2+ объектов — эксклюзив PRO подписки с раздельным учетом счетчиков, платежей и дел.
 *
 * Экспортирует window.Properties
 */

(function () {
  'use strict';

  var STORAGE_KEY = 'myorder_properties_list';
  var ACTIVE_KEY = 'myorder_active_property_id';

  var DEFAULT_PROPERTIES = [
    { id: 'primary', title: 'Моя квартира', icon: '🏠', isPrimary: true }
  ];

  function isPro() {
    return Boolean(window.ProManager && window.ProManager.isPro && window.ProManager.isPro());
  }

  function getList() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length > 0) return arr;
      }
    } catch (e) {}
    return DEFAULT_PROPERTIES;
  }

  function saveList(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch (e) {}
  }

  function getActiveId() {
    try {
      return localStorage.getItem(ACTIVE_KEY) || 'primary';
    } catch (e) {
      return 'primary';
    }
  }

  function getActive() {
    var list = getList();
    var id = getActiveId();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return list[0];
  }

  function setActive(id) {
    try {
      localStorage.setItem(ACTIVE_KEY, id);
      if (window.VK && window.VK.taptic) {
        window.VK.taptic('selection');
      }
    } catch (e) {}

    // Мгновенно обновляем кнопку-селектор в шапке
    var pill = document.querySelector('.property-pill');
    if (pill) {
      var act = getActive();
      var iconEl = pill.querySelector('.property-pill__icon');
      var titleEl = pill.querySelector('.property-pill__title');
      if (iconEl) iconEl.textContent = act.icon;
      if (titleEl) titleEl.textContent = act.title;
      pill.setAttribute('aria-label', 'Объект: ' + act.title + '. Нажмите для смены адреса');
    }

    // Мгновенное обновление текущего экрана
    if (window.App && window.App.getCurrentRoute) {
      var route = window.App.getCurrentRoute();
      if (route === 'home') {
        window.App.renderSection('home');
      } else if (route === 'tasks' && window.Tasks) {
        window.Tasks.invalidate(); window.Tasks.render();
      } else if (route === 'payments' && window.Payments) {
        window.Payments.invalidate(); window.Payments.render();
      } else if (route === 'meters' && window.Meters) {
        window.Meters.invalidate(); window.Meters.render();
      }
    }
  }

  function addProperty(title, icon) {
    if (!isPro()) {
      if (window.Backup && window.Backup.openBuyProModal) {
        window.Backup.openBuyProModal('Управление несколькими объектами (дача, квартира родителей, аренда) доступно в тарифе PRO.');
      } else if (window.VK && window.VK.notify) {
        window.VK.notify('Мульти-недвижимость доступна в PRO подписке', 'info');
      }
      return false;
    }

    var list = getList();
    var newObj = {
      id: 'prop_' + Date.now(),
      title: title || 'Новый объект',
      icon: icon || '🏡',
      isPrimary: false
    };
    list.push(newObj);
    saveList(list);
    setActive(newObj.id);
    return true;
  }

  /**
   * Карманный селектор недвижимости для шапки.
   */
  function selectorPillHtml() {
    var active = getActive();
    return '<button type="button" class="property-pill" data-property-action="open-menu" ' +
      'aria-label="Объект: ' + active.title + '. Нажмите для смены адреса">' +
      '<span class="property-pill__icon">' + active.icon + '</span>' +
      '<span class="property-pill__title">' + active.title + '</span>' +
      '<span class="property-pill__arrow">▾</span>' +
    '</button>';
  }

  /**
   * Модальное окно выбора/добавления недвижимости.
   */
  function openMenu() {
    var existing = document.getElementById('property-modal');
    if (existing) {
      if (existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }

    var list = getList();
    var activeId = getActiveId();
    var hasPro = isPro();

    try {
      if (window.VK && window.VK.taptic) {
        window.VK.taptic('impact', 'light');
      }
    } catch (e) {}

    var itemsHtml = list.map(function (item) {
      var isCur = item.id === activeId;
      return '<button type="button" class="property-menu-item' + (isCur ? ' is-active' : '') + '" ' +
        'data-property-select="' + item.id + '">' +
        '<span class="property-menu-item__icon">' + item.icon + '</span>' +
        '<span class="property-menu-item__title">' + item.title + '</span>' +
        (isCur ? '<span class="property-menu-item__check">✓</span>' : '') +
      '</button>';
    }).join('');

    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'property-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    var card = document.createElement('div');
    card.className = 'modal-content';
    card.style.maxWidth = '380px';
    card.innerHTML = '' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-2);">' +
        '<h3 class="modal-content__title" style="margin:0;">🏠 Мои объекты</h3>' +
        '<button type="button" class="icon-btn" data-action="close" aria-label="Закрыть" style="min-width:36px;min-height:36px;font-size:20px;line-height:1;">&times;</button>' +
      '</div>' +
      '<p class="modal-content__text" style="font-size:13px;color:var(--color-text-secondary);margin-bottom:var(--space-4);">' +
        'Переключайтесь между объектами для раздельного учёта платежей, счётчиков и дел.' +
      '</p>' +
      '<div class="property-menu-list">' + itemsHtml + '</div>' +
      '<div style="margin-top:var(--space-4);">' +
        '<button type="button" class="btn btn--secondary w-full" data-property-action="add-new">' +
          '<span>➕ Добавить объект</span>' +
          (hasPro ? '' : ' <span class="pro-badge">PRO</span>') +
        '</button>' +
      '</div>';

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.body.classList.add('modal-open');

    requestAnimationFrame(function () {
      overlay.classList.add('is-open');
    });

    function close() {
      if (overlay._closing) return;
      overlay._closing = true;
      overlay.classList.remove('is-open');
      setTimeout(function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (!document.querySelector('.modal-overlay')) {
          document.body.classList.remove('modal-open');
        }
      }, 200);
    }

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.closest('[data-action="close"]')) {
        close();
        return;
      }

      var selectBtn = e.target.closest('[data-property-select]');
      if (selectBtn) {
        var id = selectBtn.getAttribute('data-property-select');
        setActive(id);
        close();
        return;
      }

      var addBtn = e.target.closest('[data-property-action="add-new"]');
      if (addBtn) {
        if (!hasPro) {
          close();
          if (window.App && window.App.navigate) {
            window.App.navigate('backup');
          }
          if (window.VK && window.VK.notify) {
            window.VK.notify('Мульти-недвижимость (дача, квартира родителей) доступна в тарифе PRO', 'info');
          }
          return;
        }

        var title = prompt('Название объекта (например: Дача или Квартира родителей):');
        if (title && title.trim()) {
          addProperty(title.trim(), '🏡');
          close();
        }
      }
    });
  }

  // Делегированный клик по селектору в шапке
  document.addEventListener('click', function (e) {
    if (e.target && e.target.closest('[data-property-action="open-menu"]')) {
      openMenu();
    }
  });

  window.Properties = {
    getAll: getList,
    getActive: getActive,
    getActiveId: getActiveId,
    setActive: setActive,
    add: addProperty,
    pillHtml: selectorPillHtml,
    openMenu: openMenu
  };
})();
