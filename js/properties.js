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

    var modalHtml = '<div class="modal-overlay" id="property-modal">' +
      '<div class="modal-card modal-card--glass" role="dialog" aria-modal="true" style="max-width:380px;">' +
        '<div class="modal-header">' +
          '<h3 class="modal-title">🏠 Мои объекты</h3>' +
          '<button type="button" class="modal-close" data-action="close" aria-label="Закрыть">&times;</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<p class="modal-desc" style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;">' +
            'Переключайтесь между квартирой, дачей и родительским домом для раздельного учёта.' +
          '</p>' +
          '<div class="property-menu-list">' + itemsHtml + '</div>' +
          '<div class="property-menu-footer" style="margin-top:16px;">' +
            '<button type="button" class="btn btn--secondary w-full" data-property-action="add-new">' +
              '<span>➕ Добавить объект</span>' +
              (hasPro ? '' : ' <span class="pro-badge">PRO</span>') +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

    var div = document.createElement('div');
    div.innerHTML = modalHtml;
    var modal = div.firstElementChild;
    document.body.appendChild(modal);

    function close() {
      modal.classList.add('modal-overlay--closing');
      setTimeout(function () {
        if (modal.parentNode) modal.parentNode.removeChild(modal);
      }, 200);
    }

    modal.addEventListener('click', function (e) {
      if (e.target === modal || e.target.closest('[data-action="close"]')) {
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
