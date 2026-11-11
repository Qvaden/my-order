/**
 * МОЙ ПОРЯДОК — панель быстрых действий (Этап 12.6)
 *
 * Что это и почему не «настоящий» виджет. У VK Mini Apps нет домашних
 * виджетов и системных shortcuts: приложение живёт внутри webview, и ОС
 * не даёт ему разместить кнопку на рабочем столе. Платформенный эквивалент
 * — webmanifest shortcuts (для установленного PWA, см. app-manifest.webmanifest)
 * плюс быстрая панель на первом экране. Здесь второй слой.
 *
 * Панель отвечает на вопрос «что сделать прямо сейчас». Раньше для одного
 * действия нужно было три тапа: плитка → переход → «+». Здесь переход и
 * форма сливаются в один тап, а показания открываются сразу на счётчике,
 * который ждёт в этом месяце.
 *
 * Про PRO: сама панель бесплатна (это навигация, а не функция), но пункт
 * «Экспорт в календарь» показывается только подписчику — иначе человек
 * тыкнул бы в заведомо закрытую кнопку.
 *
 * Экспортирует: window.QuickActions
 */

(function () {
  'use strict';

  /* ================================================================
     1. ДЕЙСТВИЯ ПАНЕЛИ
     ================================================================ */

  /** @const {Array<Object>} порядок = порядок показов, самые частые выше */
  var ACTIONS = [
    {
      id: 'reading',
      label: 'Передать показания',
      hint: 'Счётчики',
      icon: '⏱️',
      run: openReading
    },
    {
      id: 'payment',
      label: 'Добавить платёж',
      hint: 'Разовый или регулярный',
      icon: '💳',
      run: function () { openForm('payments'); }
    },
    {
      id: 'task',
      label: 'Поставить дело',
      hint: 'Со сроком',
      icon: '✅',
      run: function () { openForm('tasks'); }
    },
    {
      id: 'document',
      label: 'Добавить документ',
      hint: 'Срок действия',
      icon: '📄',
      run: function () { openForm('documents'); }
    },
    {
      id: 'calendar',
      label: 'Экспорт в календарь',
      hint: 'Напоминания в телефоне',
      icon: '📅',
      pro: true,
      run: exportCalendar
    }
  ];

  /* ================================================================
     2. УТИЛИТЫ
     ================================================================ */

  /** @returns {boolean} активен ли PRO (модуль мог ещё не подняться) */
  function isPro() {
    return Boolean(window.ProManager && window.ProManager.isPro && window.ProManager.isPro());
  }

  /**
   * Тост через общий слой интеграции. Вне VK window.VK.notify тоже работает:
   * модуль сам рисует #vk-toasts.
   * @param {string} message
   * @param {string} [type]
   */
  function toast(message, type) {
    if (window.VK && typeof window.VK.notify === 'function') {
      window.VK.notify(message, type || 'info');
    }
  }

  /** @param {string} id @returns {?Object} */
  function findAction(id) {
    for (var i = 0; i < ACTIONS.length; i++) {
      if (ACTIONS[i].id === id) { return ACTIONS[i]; }
    }
    return null;
  }

  /* ================================================================
     3. РЕНДЕР
     ================================================================ */

  /**
   * Каркас панели — часть каркаса #home, отдельного роутера у неё нет.
   * Бейдж срочности на пункте показаний проставляет paint (см.
   * paintReadingBadge): в момент рисования каркаса сводка ещё не посчитана.
   * @returns {string}
   */
  function panelHtml() {
    var pro = isPro();

    var items = ACTIONS.filter(function (a) {
      return !a.pro || pro;
    }).map(function (a) {
      /* Бейдж — семантический статус, а не «красная точка»: тон и текст
         задаёт paint, здесь только пустой контейнер, чтобы каркас не прыгал
         (hidden не участвует в layout — reserve-zero, как было с цифрой) */
      var badge = a.id === 'reading'
        ? '<span class="quick-panel__badge" data-quick-badge="reading" hidden></span>'
        : '';

      return '<button type="button" class="quick-panel__item" data-quick-action="' + a.id + '">' +
          '<span class="quick-panel__icon" aria-hidden="true">' + a.icon + '</span>' +
          '<span class="quick-panel__text">' +
            '<span class="quick-panel__label">' + a.label + badge + '</span>' +
            '<span class="quick-panel__hint">' + a.hint + '</span>' +
          '</span>' +
          '<span class="quick-panel__arrow" aria-hidden="true">&#8250;</span>' +
        '</button>';
    }).join('');

    return '<section class="quick-panel" aria-label="Быстрые действия">' +
        '<h2 class="quick-panel__title">Быстрые действия</h2>' +
        '<div class="quick-panel__list">' + items + '</div>' +
      '</section>';
  }

  /**
   * Бейдж срочности на пункте «Передать показания».
   *
   * Это статус, а не счётчик: стиль берём у .status-badge из документов и
   * дел, чтобы один визуальный язык объяснял «пора действовать» во всех
   * разделах. Тона ровно два, оба из существующего словаря:
   *   • `expired` (красный) + «Срочно» — передача просрочена: у счётчика нет
   *     показания не только этого, но и прошлого месяца, т.е. данные уже
   *     устарели и плата начисляется по нормативу;
   *   • `expiring` (янтарный) + «Нужно» — за текущий месяц показания ещё не
   *     переданы, но пропуска нет: это напоминание, а не тревога.
   * Когда передавать нечего (need === 0) — бейдж скрыт: пустая плашка рядом
   * с названием читалась бы как постоянный шум.
   *
   * @param {Object|number} state — { need, overdue } или просто число need
   */
  function paintReadingBadge(state) {
    var el = document.querySelector('[data-quick-badge="reading"]');
    if (!el) { return; }

    var need = typeof state === 'number' ? state : Number(state && state.need) || 0;
    var overdue = typeof state === 'number'
      ? 0 : Number(state && state.overdue) || 0;

    if (need <= 0) {
      el.hidden = true;
      el.textContent = '';
      el.className = 'quick-panel__badge';
      return;
    }

    el.textContent = overdue > 0 ? 'Срочно' : 'Нужно';
    el.className = 'quick-panel__badge status-badge ' +
      (overdue > 0 ? 'status-badge--expired' : 'status-badge--expiring');
    el.hidden = false;
  }

  /* ================================================================
     4. ДЕЙСТВИЯ
     ================================================================ */

  /**
   * Открывает форму добавления раздела: переход + модалка одним тапом.
   * @param {string} section — payments | tasks | documents
   */
  function openForm(section) {
    var MODULES = { payments: 'Payments', tasks: 'Tasks', documents: 'Documents' };
    var mod = window[MODULES[section]];

    if (!mod || typeof mod.openAddForm !== 'function') {
      toast('Модуль раздела не загружен', 'error');
      return;
    }

    if (window.App && window.App.navigate) { window.App.navigate(section); }
    mod.openAddForm();
  }

  /**
   * Передача показаний: нужный счётчик выбираем сами.
   *
   * Порядок именно такой, потому что Meters.openAddReadingForm(meterId)
   * берёт данные из внутреннего кэша модуля: после navigate() он пуст, а
   * функция в этом случае молча уходит в console.warn. Поэтому сначала
   * просим раздел отрисоваться (он и загрузит кэш), и только затем
   * проверяем готовность через Meters.hasMeter().
   */
  function openReading() {
    if (!window.DB) {
      toast('База данных ещё не готова', 'info');
      return;
    }
    if (!window.Meters || typeof window.Meters.openAddReadingForm !== 'function') {
      toast('Модуль счётчиков не загружен', 'error');
      return;
    }

    Promise.all([
      window.DB.getAll('meters'),
      window.DB.getAll('meter_readings')
    ]).then(function (res) {
      var meters = res[0] || [];
      var readings = res[1] || [];

      if (!meters.length) {
        toast('Сначала добавьте счётчик', 'info');
        if (window.App && window.App.navigate) { window.App.navigate('meters'); }
        if (window.Meters.openAddMeterForm) { window.Meters.openAddMeterForm(); }
        return;
      }

      // Кандидат — счётчик без показания за текущий месяц; берём локальный
      // месяц: toISOString() в первой декаде месяца дал бы предыдущий
      var now = new Date();
      var month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      var covered = {};
      readings.forEach(function (r) {
        if (String(r.date).slice(0, 7) === month) { covered[r.meterId] = true; }
      });

      var target = null;
      for (var i = 0; i < meters.length; i++) {
        if (!covered[meters[i].id]) { target = meters[i]; break; }
      }
      if (!target) { target = meters[0]; }

      if (window.App && window.App.navigate) { window.App.navigate('meters'); }

      var tries = 0;
      (function attempt() {
        if (window.Meters.hasMeter(target.id)) {
          window.Meters.openAddReadingForm(target.id);
          return;
        }
        tries += 1;
        // Раздел мог остаться за блокировкой PIN или не догрузиться:
        // 12 попыток по 100 мс — это те же ~1.2 с, что ждёт paint-цикл
        if (tries < 12) { window.setTimeout(attempt, 100); }
        else { toast('Раздел счётчиков не готов', 'error'); }
      })();
    }).catch(function (err) {
      console.info('[QuickActions] Счётчики не прочитаны:', err && err.message || err);
      toast('Не удалось загрузить счётчики', 'error');
    });
  }

  /**
   * Экспорт .ics — тот же модуль и тот же путь, что кнопки в «Статистике»
   * и «Резервных копиях»: три точки входа, один источник правды.
   */
  function exportCalendar() {
    if (!isPro()) {
      toast('Экспорт в календарь доступен только в PRO', 'info');
      if (window.App && window.App.navigate) { window.App.navigate('backup'); }
      return;
    }
    if (!window.CalendarExport) {
      toast('Модуль экспорта не загружен', 'error');
      return;
    }

    window.CalendarExport.exportNow().then(function (res) {
      toast('Файл ' + res.fileName + ' скачан — добавьте его в календарь', 'success');
    }).catch(function (err) {
      toast('Экспорт не удался: ' + (err && err.message || err), 'error');
    });
  }

  /* ================================================================
     5. ОБРАБОТКА КЛИКОВ
     ================================================================ */

  /** @type {boolean} */
  var bound = false;

  /**
   * Делегат вешается ОДИН раз на document, а не на #app: контейнер
   * перерисовывается при каждом переходе, и слушатель внутри render()
   * начал бы копироваться (тест 10.4.2 ловит такие утечки).
   */
  function bind() {
    if (bound) { return; }
    bound = true;

    document.addEventListener('click', function (e) {
      if (!e.target || !e.target.closest) { return; }

      var btn = e.target.closest('[data-quick-action]');
      if (!btn) { return; }

      var action = findAction(btn.getAttribute('data-quick-action'));
      if (!action) { return; }

      // Повторный тап по уже открытой модалке не должен плодить диалоги:
      // openModal в модулях разделов сам дедуплицирует по разметке, сюда
      // доходит только случай «панель видна»
      if (action.pro && !isPro()) {
        toast('Доступно только в PRO', 'info');
        return;
      }
      action.run();
    });
  }

  /**
   * Ярлыки из app-manifest.webmanifest («Передать показания», «Добавить
   * платёж», «Экспорт в календарь») открывают приложение с ?view=…: у
   * VK Mini Apps и установленного PWA нет способа вызвать функцию страницы
   * напрямую, поэтому единственный канал — параметр адреса.
   *
   * Вызывается один раз после первого рендера: до готовности БД форма
   * добавления всё равно не открылась бы, а hash-роутер к тому моменту уже
   * выставил раздел.
   * @returns {boolean} обработан ли параметр
   */
  function applyShortcutView() {
    var view = '';
    try {
      view = new URLSearchParams(window.location.search || '').get('view') || '';
    } catch (err) {
      // URLSearchParams мог отсутствовать в старом webview — читаем руками
      var m = /[?&]view=([\w-]+)/.exec(String(window.location.search || ''));
      view = m ? m[1] : '';
    }

    var action = findActionByView(view);
    if (!action) { return false; }

    // Параметр убираем из адреса: человек не должен «провалиться» в форму
    // повторно при каждом обновлении страницы или кнопке «назад»
    try {
      var clean = window.location.pathname + window.location.hash;
      window.history.replaceState({}, document.title, clean);
    } catch (err) { /* file:// и старые webview не дают менять URL — не беда */ }

    if (action.pro && !isPro()) {
      toast('«' + action.label + '» доступен только в PRO', 'info');
      return true;
    }

    action.run();
    return true;
  }

  /**
   * Соответствие параметра адреса действию панели. Держим словарём, а не
   * полем в ACTIONS: имя в манифесте — внешний контракт, его менять нельзя,
   * а id действия — внутреннее.
   * @param {string} view
   * @returns {?Object}
   */
  function findActionByView(view) {
    var VIEWS = { 'reading': 'reading', 'add-payment': 'payment', 'calendar': 'calendar' };
    return VIEWS[view] ? findAction(VIEWS[view]) : null;
  }

  /* ================================================================
     6. ПУБЛИЧНЫЙ API
     ================================================================ */

  window.QuickActions = {
    bind: bind,
    panelHtml: panelHtml,
    paintReadingBadge: paintReadingBadge,
    openForm: openForm,
    openReading: openReading,
    exportCalendar: exportCalendar,
    applyShortcutView: applyShortcutView,
    ACTIONS: ACTIONS
  };

  bind();
  console.info('[QuickActions] Модуль загружен. API: window.QuickActions');
})();
