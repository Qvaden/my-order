/**
 * МОЙ ПОРЯДОК — Роутер и инициализация (Этап 3)
 *
 * SPA-роутер на основе hash с интеграцией модуля базы данных (DB).
 * Рендер разделов выполняется только после успешной инициализации IndexedDB.
 *
 * Экспортирует: window.App
 * Глобальный флаг: window.DB_READY
 */

(function () {
  'use strict';

  /* ================================================================
     1. КОНСТАНТЫ
     ================================================================ */

  /** @const {string[]} Список допустимых маршрутов */
  var ROUTES = ['home', 'payments', 'meters', 'documents', 'tasks', 'stats', 'backup'];

  /**
   * Глобальный флаг готовности базы данных.
   * false → DB инициализируется, true → можно рендерить.
   * @type {boolean}
   */
  window.DB_READY = false;

  /* ================================================================
     2. СОСТОЯНИЕ
     ================================================================ */

  /** @type {HTMLElement|null} */
  var appEl = null;

  /** @type {NodeListOf<Element>|null} */
  var navButtons = null;

  /** @type {boolean} Флаг блокировки рендера до инициализации БД */
  var pendingRoute = null;

  /* ================================================================
     3. ОШИБКИ ИНИЦИАЛИЗАЦИИ
     ================================================================ */

  /**
   * Отображает сообщение об ошибке в #app.
   * @param {string} message — текст ошибки
   */
  function renderError(message) {
    if (!appEl) {
      appEl = document.getElementById('app');
    }

    appEl.innerHTML = '<div class="empty-state">' +
      '<div class="empty-state__icon" aria-hidden="true">⚠️</div>' +
      '<h2 class="empty-state__title">Ошибка инициализации</h2>' +
      '<p class="empty-state__text">' + escapeHtml(message) + '</p>' +
      '<button class="btn btn--primary mt-4" onclick="location.reload()">Попробовать снова</button>' +
      '</div>';
  }

  /**
   * Экранирует HTML-специальные символы для безопасного отображения.
   * @param {string} text
   * @returns {string}
   */
  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /* ================================================================
     4. ЗАГРУЗКА (SKELTON)
     ================================================================ */

  /**
   * Показывает скелетон-загрузку в #app.
   */
  function showLoading() {
    if (!appEl) {
      appEl = document.getElementById('app');
    }

    appEl.innerHTML = '<div class="flex flex-col items-center justify-center" style="min-height: 60vh; gap: var(--space-4);">' +
      '<div class="skeleton" style="width: 48px; height: 48px; border-radius: var(--radius-full);"></div>' +
      '<p class="text-secondary fw-medium">Загрузка...</p>' +
      '</div>';
  }

  /* ================================================================
     5. РЕНДЕР РАЗДЕЛОВ
     ================================================================ */

  /**
   * Приветствие по времени суток.
   * @returns {string}
   */
  function greeting() {
    var h = new Date().getHours();
    if (h >= 5 && h < 12) { return 'Доброе утро!'; }
    if (h >= 12 && h < 18) { return 'Добрый день!'; }
    if (h >= 18 && h < 23) { return 'Добрый вечер!'; }
    return 'Доброй ночи!';
  }

  /**
   * Строка приветствия с учётом авторизации ВКонтакте (Этап 10).
   * Вне VK или при отказе пользователя от авторизации window.VK.firstName()
   * возвращает '' — показываем нейтральное приветствие (graceful degradation).
   * Возвращает ЧИСТЫЙ текст: экранирование делает вызывающая сторона
   * (escHome для innerHTML или textContent для точечного обновления).
   * @returns {string}
   */
  function greetingLine() {
    var name = (window.VK && window.VK.firstName) ? window.VK.firstName() : '';
    if (!name) { return greeting(); }
    // Имя в VK может быть длинным — ограничиваем, чтобы не ломать сетку
    var short = name.length > 14 ? name.slice(0, 14) + '\u2026' : name;
    return greeting().replace('!', ', ' + short + '!');
  }

  /**
   * Кнопка «Поделиться» в шапке главного экрана.
   * Рендерится всегда: внутри VK вызывает VKWebAppShare, в браузере —
   * navigator.share / копирование ссылки.
   * @returns {string}
   */
  function shareButtonHtml() {
    return '<button type="button" class="home-share-btn" data-home-action="share" ' +
      'aria-label="Поделиться приложением">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/>' +
        '<circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>' +
        '<line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>' +
      '</svg>' +
    '</button>';
  }

  /**
   * Дата в формате «понедельник, 9 ноября».
   * @returns {string}
   */
  function todayLabel() {
    try {
      return new Date().toLocaleDateString('ru-RU', {
        weekday: 'long', day: 'numeric', month: 'long'
      });
    } catch (e) {
      return '';
    }
  }

  function themeButtonHtml() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    return '<button type="button" class="home-theme-btn" data-home-action="theme" ' +
      'aria-label="Сменить тему оформления" title="' + (isDark ? 'Включить светлую тему' : 'Включить тёмную тему') + '">' +
      (isDark
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px;"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px;"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>') +
    '</button>';
  }

  /**
   * Рисует каркас главного экрана (скелетоны вместо цифр).
   * @returns {string}
   */
  function homeShellHtml() {
    return '' +
      '<header class="home-hero">' +
        '<p class="home-hero__greeting">' + escHome(greetingLine()) + '</p>' +
        '<h1 class="home-hero__date">' + todayLabel() + '</h1>' +
        (window.Properties ? window.Properties.pillHtml() : '') +
        (window.Family && window.Family.activeName && window.Family.activeName()
          ? '<div class="home-hero__family" aria-label="Семья: ' + escHome(window.Family.activeName()) + '">' +
              '<span class="home-hero__family-badge">👥 ' + escHome(window.Family.activeName()) + '</span>' +
            '</div>'
          : '') +
        shareButtonHtml() +
        themeButtonHtml() +
        '<button type="button" class="home-gear-btn" data-home-action="backup" aria-label="Настройки и резервные копии" title="Настройки">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:22px;height:22px;">' +
            '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>' +
          '</svg>' +
        '</button>' +
      '</header>' +
      homeBlocksHtml();
  }

  /**
   * Рендер блоков главной в порядке, заданном пользователем (Этап 12.8).
   * @returns {string}
   */
  function homeBlocksHtml() {
    var blocks = {
      summary: function () {
        return '' +
          '<div id="home-bento-hero-wrap"></div>' +
          '<div class="home-summary-grid">' +
            '<div class="skeleton" style="height:76px;border-radius:var(--radius-xl);"></div>' +
            '<div class="skeleton" style="height:76px;border-radius:var(--radius-xl);"></div>' +
            '<div class="skeleton" style="height:76px;border-radius:var(--radius-xl);"></div>' +
            '<div class="skeleton" style="height:76px;border-radius:var(--radius-xl);"></div>' +
          '</div>' +
          '<button type="button" class="home-stats-btn" data-home-action="stats">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
              'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:20px;height:20px;">' +
              '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/>' +
              '<line x1="6" y1="20" x2="6" y2="14"/>' +
            '</svg>' +
            '<span>Полная статистика</span>' +
          '</button>';
      },
      quickActions: function () {
        return (window.QuickActions ? window.QuickActions.panelHtml() : '') +
          (window.SmartRadar ? window.SmartRadar.barHtml() : '');
      },
      upcoming: function () {
        return '<section class="home-today" id="home-today"></section>';
      },
      proBanner: function () {
        return isProUser() ? '' : proUpsellHtml();
      }
    };

    var layout = (window.Personalization && window.Personalization.getHomeLayout)
      ? window.Personalization.getHomeLayout()
      : [
          { id: 'summary', visible: true },
          { id: 'quickActions', visible: true },
          { id: 'upcoming', visible: true },
          { id: 'proBanner', visible: true }
        ];

    var out = '';
    for (var i = 0; i < layout.length; i++) {
      var item = layout[i];
      if (item && item.visible !== false && blocks[item.id]) {
        out += blocks[item.id]();
      }
    }
    return out;
  }

  /** @returns {boolean} активен ли PRO (модуль мог ещё не подняться) */
  function isProUser() {
    return Boolean(window.ProManager && window.ProManager.isPro && window.ProManager.isPro());
  }

  /**
   * Прогрейшн-баннер для бесплатного тарифа. Одна ценность — защита
   * данных: «облако» и «прогнозы» звучат абстрактно, а «не потеряете» — нет.
   * @returns {string}
   */
  function proUpsellHtml() {
    return '<button type="button" class="home-pro-banner" data-home-action="pro">' +
        '<span class="home-pro-banner__icon" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' +
            '<path d="M9 12l2 2 4-4"/>' +
          '</svg>' +
        '</span>' +
        '<span class="home-pro-banner__text">' +
          '<b>Хотите защитить данные и получать прогнозы?</b>' +
          '<small>Облачный бэкап, PIN-код, PDF-отчёты — 99 ₽/мес или 890 ₽/год (-25%)</small>' +
        '</span>' +
        '<span class="home-pro-banner__cta">Перейти в PRO</span>' +
      '</button>';
  }

  /**
   * Считает сводки из DB и подставляет их в каркас главного экрана.
   */
  function loadHomeSummary() {
    if (!window.DB) { return; }

    var today = new Date();
    var isoToday = today.getFullYear() + '-' +
      String(today.getMonth() + 1).padStart(2, '0') + '-' +
      String(today.getDate()).padStart(2, '0');

    Promise.all([
      window.DB.getAll('payments'),
      window.DB.getAll('tasks'),
      window.DB.getAll('documents'),
      window.DB.getAll('meters'),
      window.DB.getAll('meter_readings')
    ]).then(function (res) {
      var payments = res[0], tasks = res[1], docs = res[2], meters = res[3], readings = res[4];

      /* Платежи, которые ожидают оплаты */
      var pendingCount = 0, pendingSum = 0;
      for (var i = 0; i < payments.length; i++) {
        if (payments[i].status === 'pending') {
          pendingCount++;
          pendingSum += payments[i].amount || 0;
        }
      }

      /* Дела на сегодня (невыполненные) */
      var todayCount = 0;
      for (var j = 0; j < tasks.length; j++) {
        var t = tasks[j];
        if (t.completed || t.isTemplate || t.archived) { continue; }
        if (t.dueDate && t.dueDate <= isoToday) { todayCount++; }
      }

      /* Документы: истекают или просрочены */
      var expiringCount = 0;
      for (var k = 0; k < docs.length; k++) {
        var d = docs[k];
        if (!d.expiryDate) { continue; }
        var daysLeft = Math.round((new Date(d.expiryDate + 'T00:00:00') -
          new Date(isoToday + 'T00:00:00')) / 86400000);
        if (daysLeft <= (d.reminderDays || 30)) { expiringCount++; }
      }

      /* Счётчики: сколько нужно передать показания.
         need — нет показания за текущий месяц.
         overdue — нет показания и за прошлый тоже: данные устарели,
         бейдж на панели показывает «Срочно», а не нейтральное «Нужно».
         Месяцы берём локальные: toISOString() в первой декаде месяца дал бы
         предыдущий месяц и занизило бы срочность. */
      var needReading = 0;
      var overdueReading = 0;
      var thisMonth = isoToday.slice(0, 7);
      var prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      var lastMonth = prev.getFullYear() + '-' + String(prev.getMonth() + 1).padStart(2, '0');
      for (var m = 0; m < meters.length; m++) {
        var mk = meters[m].id;
        var has = false;
        var had = false;
        for (var n = 0; n < readings.length; n++) {
          var r = readings[n];
          if (r.meterId !== mk) { continue; }
          var ym = r.date.slice(0, 7);
          if (ym === thisMonth) { has = true; }
          if (ym === lastMonth || ym > thisMonth) { had = true; }
        }
        if (!has) {
          needReading++;
          if (!had) { overdueReading++; }
        }
      }

      var money = window.Payments && window.Payments.formatMoney
        ? window.Payments.formatMoney(pendingSum) : '—';

      paintHomeSummary({
        todayCount: todayCount,
        pendingCount: pendingCount,
        pendingMoney: money,
        expiringCount: expiringCount,
        needReading: needReading,
        overdueReading: overdueReading,
        metersTotal: meters.length,
        paymentsTotal: payments.length,
        tasksTotal: tasks.length,
        docsTotal: docs.length
      });
    }).catch(function (err) {
      console.error('[App] Не удалось построить сводку главной:', err);
      var box = document.querySelector('.home-summary-grid');
      if (box) {
        box.innerHTML = '<p class="home-summary__error">Сводка недоступна. Обнови страницу.</p>';
      }
    });
  }

  /**
   * Заполняет карточки сводки и блок «Дел сегодня».
   * @param {Object} s — посчитанные сводки
   */
  function paintHomeSummary(s) {
    var box = document.querySelector('.home-summary-grid');
    if (!box) { return; }

    /* Bento Hero Card с кольцом прогресса месяца */
    var bentoWrap = document.getElementById('home-bento-hero-wrap');
    if (bentoWrap) {
      var totalItems = (s.paymentsTotal || 0) + (s.tasksTotal || 0);
      var pendingItems = (s.pendingCount || 0) + (s.todayCount || 0);
      var doneItems = Math.max(0, totalItems - pendingItems);
      var pct = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 100;
      var C = 188.5; // 2 * PI * 30
      var strokeOffset = C - (pct / 100) * C;
      var isPerfect = pct === 100;

      var bentoTitle = isPerfect ? 'Всё выполнено! 🎉' : (pct + '% месяца закрыто');
      var bentoDesc = isPerfect
        ? 'Все счета оплачены и срочных дел нет. Отличная работа!'
        : (s.pendingCount > 0 ? ('Ожидает оплаты: ' + s.pendingMoney + ' · передать ' + s.needReading + ' счётч.') : 'Остались только плановые дела');

      var isPro = Boolean(window.ProManager && window.ProManager.isPro && window.ProManager.isPro());

      bentoWrap.innerHTML = '<div class="home-bento-hero">' +
        '<div class="home-bento-hero__inner">' +
          '<div class="home-bento-hero__ring-wrap">' +
            '<svg class="home-bento-hero__ring-svg" viewBox="0 0 76 76">' +
              '<circle class="home-bento-hero__ring-bg" cx="38" cy="38" r="30" fill="none" stroke-width="6"/>' +
              '<circle class="home-bento-hero__ring-fill" cx="38" cy="38" r="30" fill="none" stroke-width="6" ' +
                'stroke-dasharray="' + C + '" stroke-dashoffset="' + strokeOffset + '"/>' +
            '</svg>' +
            '<div class="home-bento-hero__ring-text">' +
              '<span>' + pct + '%</span>' +
              '<span class="home-bento-hero__ring-sub">порядок</span>' +
            '</div>' +
          '</div>' +
          '<div class="home-bento-hero__content">' +
            '<h3 class="home-bento-hero__title">' + bentoTitle + '</h3>' +
            '<p class="home-bento-hero__desc">' + bentoDesc + '</p>' +
            '<div id="home-score-wrap"></div>' +
            (isPro
              ? '<div style="margin-top:6px;"><span class="home-bento-hero__pro-badge">👑 Умный радар: бюджет под контролем</span></div>'
              : '') +
          '</div>' +
        '</div>' +
      '</div>';

      if (window.HomeScore && window.HomeScore.calculate) {
        window.HomeScore.calculate().then(function (scoreData) {
          var sWrap = document.getElementById('home-score-wrap');
          if (sWrap) {
            sWrap.innerHTML = window.HomeScore.badgeHtml(scoreData);
          }
        });
      }
    }

    if (window.SmartRadar && window.SmartRadar.bindBarEvents) {
      window.SmartRadar.bindBarEvents();
    }

    /* Панель быстрых действий: ей нужен не только счётчик, но и признак
       просрочки — от него зависит тон бейджа. Отдельный запрос не делаем:
       сводка уже посчитана. */
    if (window.QuickActions && window.QuickActions.paintReadingBadge) {
      window.QuickActions.paintReadingBadge({
        need: s.needReading,
        overdue: s.overdueReading || 0
      });
    }

    var cards = [
      {
        key: 'tasks', cls: 'home-summary--tasks',
        label: 'Дел сегодня', value: s.todayCount, unit: 'шт.',
        hint: s.todayCount > 0 ? 'Открыть дела' : 'На сегодня всё чисто'
      },
      {
        key: 'pending', cls: 'home-summary--pending',
        label: 'Ожидает оплаты', value: s.pendingCount, unit: 'шт.',
        hint: s.pendingCount > 0 ? s.pendingMoney : 'Платежей нет'
      },
      {
        key: 'docs', cls: 'home-summary--docs',
        label: 'Документов истекает', value: s.expiringCount, unit: 'шт.',
        hint: s.expiringCount > 0 ? 'Проверь сроки' : 'Сроки в порядке'
      },
      {
        key: 'meters', cls: 'home-summary--meters',
        label: 'Показаний передать', value: s.needReading, unit: 'шт.',
        hint: s.needReading > 0 ? s.metersTotal + ' счётчиков всего' : 'За этот месяц передано'
      }
    ];

    var html = '';
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      html += '<button type="button" class="home-summary ' + c.cls + '" ' +
        'data-home-goto="' + c.key + '" style="animation-delay:' + (i * 50) + 'ms">' +
          '<span class="home-summary__label">' + c.label + '</span>' +
          '<span class="home-summary__value">' + c.value +
            '<span class="home-summary__unit">' + c.unit + '</span></span>' +
          '<span class="home-summary__hint">' + c.hint + '</span>' +
        '</button>';
    }
    box.innerHTML = html;

    paintHomeTodayTasks();
  }

  /**
   * Блок «Ближайшие дела» — до 3 невыполненных задач по дедлайну.
   */
  function paintHomeTodayTasks() {
    var box = document.getElementById('home-today');
    if (!box || !window.Tasks) { return; }

    var tasks = [];
    try {
      tasks = window.DB.getAll('tasks');
    } catch (e) {
      return;
    }

    tasks.then(function (all) {
      var today = new Date();
      var isoToday = today.getFullYear() + '-' +
        String(today.getMonth() + 1).padStart(2, '0') + '-' +
        String(today.getDate()).padStart(2, '0');

      var open = [];
      for (var i = 0; i < all.length; i++) {
        var t = all[i];
        if (t.completed || t.isTemplate || t.archived) { continue; }
        if (t.dueDate && t.dueDate <= isoToday) { open.push(t); }
      }
      open.sort(function (a, b) {
        return (a.dueDate || '9999-12-31').localeCompare(b.dueDate || '9999-12-31');
      });
      open = open.slice(0, 3);

      if (open.length === 0) {
        box.innerHTML =
          '<div class="home-today__empty">' +
            '<span class="home-today__empty-icon" aria-hidden="true">✨</span>' +
            '<span>Все дела на сегодня закрыты</span>' +
          '</div>';
        return;
      }

      var html = '<h2 class="home-section-title">Ближайшие дела</h2><div class="home-today__list">';
      for (var j = 0; j < open.length; j++) {
        var k = open[j];
        var overdue = k.dueDate < isoToday;
        html += '<div class="home-today__item' + (overdue ? ' home-today__item--overdue' : '') + '">' +
          '<span class="home-today__dot" aria-hidden="true"></span>' +
          '<span class="home-today__title">' + escHome(k.title) + '</span>' +
          '<span class="home-today__date">' + (overdue ? 'просрочено' : 'сегодня') + '</span>' +
        '</div>';
      }
      html += '</div>';
      box.innerHTML = html;
    }).catch(function () { /* блок опциональный — молча пропускаем */ });
  }

  /** Экранирование для главной */
  function escHome(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  /** @type {boolean} Привязан ли делегат главной */
  var homeClicksBound = false;

  /** @type {boolean} Привязаны ли слушатели событий VK Bridge */
  var vkEventsBound = false;

  /** @type {boolean} Привязан ли слушатель смены тарифа */
  var proEventsBound = false;

  /** @type {boolean} Привязан ли слушатель разблокировки PIN */
  var pinEventsBound = false;

  /**
   * Закрывает ли PIN содержимое разделов.
   *
   * Проверка через window.Security, а не через прямую переменную: модуль
   * безопасности опционален и мог не загрузиться (обрезанный кэш, http
   * без Web Crypto), а приложение обязано работать и в этом случае.
   * @returns {boolean}
   */
  function pinBlocksRender() {
    return Boolean(
      window.Security &&
      window.Security.shouldLock &&
      window.Security.shouldLock()
    );
  }

  /**
   * Этап 12.5: после ввода PIN дорисовываем раздел, который ждал своей
   * очереди за блокировкой.
   */
  function bindPinEvents() {
    if (pinEventsBound) { return; }
    pinEventsBound = true;

    window.addEventListener('pin:unlocked', function () {
      renderSection(getCurrentRoute());
    });
  }

  /**
   * Этап 12.5: покупка или истечение PRO меняет состав разделов — на
   * главной исчезает баннер, в «Статистике» появляется аналитика, в
   * «Резервных копиях» снимаются .pro-only. Перерисовываем ТОЛЬКО
   * текущий раздел: полная перезагрузка страницы после оплаты выглядела
   * бы как потеря состояния.
   */
  function bindProEvents() {
    if (proEventsBound) { return; }
    proEventsBound = true;

    window.addEventListener('pro:changed', function () {
      renderSection(getCurrentRoute());
    });
  }

  var familyEventsBound = false;
  function bindFamilyEvents() {
    if (familyEventsBound) { return; }
    familyEventsBound = true;

    window.addEventListener('family:ready', function () {
      if (getCurrentRoute() === 'home') { renderSection('home'); }
    });
    window.addEventListener('family:changed', function () {
      renderSection(getCurrentRoute());
    });
  }

  /**
   * Этап 10: профиль из ВКонтакте приходит асинхронно — после того как
   * шапка главной уже отрисована. Слушаем событие от модуля интеграции
   * и обновляем только строку приветствия, без перерисовки раздела.
   */
  function bindVkEvents() {
    if (vkEventsBound) { return; }
    vkEventsBound = true;

    window.addEventListener('vk:user', function () {
      var line = appEl && appEl.querySelector('.home-hero__greeting');
      if (line) { line.textContent = greetingLine(); }
    });

    // Смена темы из клиента VK: перекрашиваем зависящие от JS виджеты
    window.addEventListener('vk:theme', function () {
      window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: window.VK.theme() } }));
    });
  }

  /**
   * Этап 10: регистрация Service Worker для офлайн-режима.
   * Ошибки не считаем фатальными: без SW приложение работает как раньше.
   */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) { return; }
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        console.info('[App] Service Worker не зарегистрирован:', err && err.message || err);
      });
    });
  }

  /**
   * Делегат кликов главного экрана: сводки → разделы с фильтром,
   * быстрые кнопки → формы добавления.
   */
  function initHomeClicks() {
    if (homeClicksBound || !appEl) { return; }
    homeClicksBound = true;

    appEl.addEventListener('click', function (e) {
      if (!e.target.closest) { return; }

      /* Кнопка «Полная статистика» */
      var statsBtn = e.target.closest('[data-home-action="stats"]');
      if (statsBtn) {
        navigate('stats');
        return;
      }

      /* Иконка настроек → резервные копии */
      var gearBtn = e.target.closest('[data-home-action="backup"]');
      if (gearBtn) {
        navigate('backup');
        return;
      }

      /* Кнопка смены темы оформления (☀️ / 🌙) */
      var themeBtn = e.target.closest('[data-home-action="theme"]');
      if (themeBtn) {
        if (window.VK && window.VK.toggleTheme) {
          var nextTheme = window.VK.toggleTheme();
          var isDark = nextTheme === 'dark';
          themeBtn.setAttribute('title', isDark ? 'Включить светлую тему' : 'Включить тёмную тему');
          themeBtn.innerHTML = isDark
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px;"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px;"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
          if (window.showToast) {
            window.showToast(isDark ? 'Включена тёмная тема' : 'Включена светлая тема', 'info');
          }
        }
        return;
      }

      /* Этап 10: «Поделиться приложением» — VKWebAppShare / navigator.share */
      var shareBtn = e.target.closest('[data-home-action="share"]');
      if (shareBtn) {
        if (window.VK && window.VK.share) {
          window.VK.share();
        } else {
          // Модуль интеграции не загрузился (офлайн без кэша) — минимум: копирование
          var link = window.location.href;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(link);
          }
        }
        return;
      }

      /* Этап 12.5: баннер PRO → раздел подписки */
      var proBtn = e.target.closest('[data-home-action="pro"]');
      if (proBtn) {
        navigate('backup');
        return;
      }

      /* Сводка → раздел с нужным фильтром */
      var goto = e.target.closest('[data-home-goto]');
      if (goto) {
        applyHomeFilter(goto.getAttribute('data-home-goto'));
      }
    });
  }

  /**
   * Переходит в раздел и заранее ставит ему нужный фильтр.
   * @param {string} key — tasks | pending | docs | meters
   */
  function applyHomeFilter(key) {
    if (key === 'tasks') {
      window.__homeTaskFilter = 'today';
      navigate('tasks');
    } else if (key === 'pending') {
      window.__homePaymentFilter = 'pending';
      navigate('payments');
    } else if (key === 'docs') {
      window.__homeDocFilter = 'expiring';
      navigate('documents');
    } else if (key === 'meters') {
      navigate('meters');
    }
  }

  /**
   * Применяет фильтр, запрошенный с главного экрана, и очищает метку.
   * Вызывается после отрисовки раздела.
   * @param {string} sectionName
   */
  function applyPendingHomeFilter(sectionName) {
    var selector = null;

    if (sectionName === 'tasks' && window.__homeTaskFilter) {
      selector = '[data-task-filter="' + window.__homeTaskFilter + '"]';
      window.__homeTaskFilter = null;
    } else if (sectionName === 'payments' && window.__homePaymentFilter) {
      selector = '[data-filter="' + window.__homePaymentFilter + '"]';
      window.__homePaymentFilter = null;
    } else if (sectionName === 'documents' && window.__homeDocFilter) {
      selector = '[data-doc-filter="' + window.__homeDocFilter + '"]';
      window.__homeDocFilter = null;
    }

    if (!selector || !appEl) { return; }

    // Клик по чипу делаем только ПОСЛЕ paint(): пока в контейнере есть
    // элемент .skeleton — данные ещё грузятся.
    var waited = 0;
    (function waitPaint() {
      if (!appEl) { return; }
      if (appEl.querySelector('.skeleton')) {
        waited += 120;
        if (waited < 5000) { window.setTimeout(waitPaint, 120); }
        return;
      }
      var chip = appEl.querySelector(selector);
      if (chip) { chip.click(); return; }
      waited += 120;
      if (waited < 5000) { window.setTimeout(waitPaint, 120); }
    })();
  }

  /**
   * Карта названий и иконок разделов.
   * @type {Object.<string, {title: string, icon: string}>}
   */
  var SECTION_META = {
    home: { title: 'Главная', icon: '🏠' },
    payments: { title: 'Платежи', icon: '💳' },
    meters: { title: 'Счётчики', icon: '⏱️' },
    documents: { title: 'Документы', icon: '📄' },
    tasks: { title: 'Дела', icon: '✅' },
    stats: { title: 'Статистика', icon: '📊' },
    backup: { title: 'Резервные копии', icon: '💾' }
  };

  /**
   * Генерирует HTML-заглушку для раздела.
   * @param {string} sectionName — имя раздела (без #)
   * @returns {string} HTML-разметка
   */
  function renderPlaceholder(sectionName) {
    var meta = SECTION_META[sectionName] || { title: sectionName, icon: '📦' };
    var title = meta.title;
    var icon = meta.icon;

    return (
      '<header class="page-header">' + title + '</header>' +
      '<section class="empty-state">' +
        '<div class="empty-state__icon" aria-hidden="true">' + icon + '</div>' +
        '<h2 class="empty-state__title">Раздел «' + title + '» пуст</h2>' +
        '<p class="empty-state__text">Здесь появится функционал этого раздела. Следите за обновлениями.</p>' +
      '</section>'
    );
  }

  /**
   * Разделы с собственной реализацией (window.<Module>.render()).
   * Остальные рендерятся заглушкой.
   * @type {Object.<string, string>} маршрут → имя глобального модуля
   */
  var SECTION_MODULES = {
    payments:   'Payments',
    meters:     'Meters',
    documents:  'Documents',
    tasks:      'Tasks',
    stats:      'Stats',
    backup:     'Backup'
  };

  /**
   * Возвращает модуль раздела, если он загружен и готов к работе.
   * @param {string} sectionName
   * @returns {Object|null}
   */
  function getSectionModule(sectionName) {
    var moduleName = SECTION_MODULES[sectionName];
    if (!moduleName) { return null; }

    var mod = window[moduleName];
    if (!mod || typeof mod.render !== 'function') {
      console.warn('[App] Модуль раздела не загружен: ' + moduleName);
      return null;
    }
    return mod;
  }

  /**
   * Инициализирует модули разделов (привязка делегатов событий).
   * Вызывается один раз после инициализации БД.
   */
  function initSectionModules() {
    var modules = Object.keys(SECTION_MODULES);
    for (var i = 0; i < modules.length; i++) {
      var moduleName = SECTION_MODULES[modules[i]];
      var mod = window[moduleName];
      if (mod && typeof mod.init === 'function') {
        mod.init();
      }
    }
  }

  /** @type {number} токен перехода: older-заявка отменяется новой
   *  (покупка/истечение PRO перерисовывает раздел ровно в тот момент,
   *  когда человек уже уходит из него — без проверки отсталый paint
   *  выполнялся бы позже и затирал бы новый экран) */
  var transitionSeq = 0;

  /**
   * Плавная смена содержимого #app: fade-out → html → fade-in.
   * @param {function(): void} paint — рисует новый контент в appEl
   */
  function transitionContent(paint) {
    var token = ++transitionSeq;
    appEl.classList.add('page-exit');

    setTimeout(function () {
      // Пока ждали 250 мс, мог начаться более свежий переход — этот отменяем,
      // иначе два setTimeout рисуют вразнобой и победит старый раздел
      if (token !== transitionSeq) { return; }
      paint();
      appEl.classList.remove('page-exit');
    }, 250);
  }

  /**
   * Основная функция рендера раздела.
    * Если DB ещё не готова — откладывает рендер.
    * @param {string} sectionName — имя раздела без символа #
    */
  function renderSection(sectionName) {
    // Валидация маршрута
    if (ROUTES.indexOf(sectionName) === -1) {
      sectionName = 'home';
    }

    // Если БД ещё не инициализирована — откладываем рендер
    if (!window.DB_READY) {
      pendingRoute = sectionName;
      return;
    }

    /* Этап 12.5: данные закрыты PIN — рендер не запускаем вовсе.
       Оверлей и так перекрывает экран, но рисовать под него платежи и
       счётчики нельзя: их видно в DevTools и через экранную лупу, а
       смысл блокировки именно в том, чтобы содержимое не появлялось
       в DOM до ввода кода. Раздел дорисуем по событию 'pin:unlocked'. */
    if (pinBlocksRender()) {
      pendingRoute = sectionName;
      return;
    }

    // Обновляем активный пункт навигации
    updateNav(sectionName);

    if (!appEl) { return; }

    // Главный экран — реальная сводка из DB
    if (sectionName === 'home') {
      transitionContent(function () {
        appEl.innerHTML = homeShellHtml();
        initHomeClicks();
        loadHomeSummary();
      });
      return;
    }

    var sectionModule = getSectionModule(sectionName);

    // Раздел с реальной логикой: сбрасываем кэш и рисуем сами
    if (sectionModule) {
      transitionContent(function () {
        if (typeof sectionModule.invalidate === 'function') {
          sectionModule.invalidate();
        }
        sectionModule.render();
        applyPendingHomeFilter(sectionName);
      });
      return;
    }

    // Остальные — заглушка
    transitionContent(function () {
      appEl.innerHTML = renderPlaceholder(sectionName);
    });
  }

  /**
   * Обновляет активный класс у кнопок навигации.
   * @param {string} activeSection — текущий активный раздел
   */
  function updateNav(activeSection) {
    if (!navButtons) {
      navButtons = document.querySelectorAll('.nav-bottom__item');
    }

    // Раздел резервных копий открывается из шапки главной —
    // активным оставляем «Главную», нижняя навигация остаётся из 5 пунктов.
    var navSection = (activeSection === 'backup') ? 'home' : activeSection;

    for (var i = 0; i < navButtons.length; i++) {
      var btn = navButtons[i];
      var hash = btn.getAttribute('data-hash');
      var isActive = (hash === '#' + navSection);

      btn.classList.toggle('nav-bottom__item--active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
  }

  /* ================================================================
     6. РОУТЕР
     ================================================================ */

  /**
   * Получает текущее имя раздела из hash URL.
   * @returns {string}
   */
  function getCurrentRoute() {
    var hash = window.location.hash;
    if (typeof hash !== 'string') {
      return 'home';
    }
    var cleanHash = hash.replace(/^#/, '');
    if (ROUTES.indexOf(cleanHash) === -1) {
      return 'home';
    }
    return cleanHash;
  }

  /**
   * Навигация: установка hash и рендер нужного раздела.
   * @param {string} route — маршрут без символа #
   */
  function navigate(route) {
    window.location.hash = route;
  }

  /**
   * Обработчик кликов по кнопкам навигации.
   */
  function onNavClick(e) {
    var btn = e.target.closest('.nav-bottom__item');
    if (!btn) { return; }

    e.preventDefault();
    var hash = btn.getAttribute('data-hash');
    var route = hash.replace(/^#/, '');
    navigate(route);
  }

  /**
   * Обработчик события изменения hash (кнопки назад/вперёд браузера).
   */
  function onHashChange() {
    if (window.Family && window.Family.parseInviteUrl && window.Family.parseInviteUrl(window.location.href)) {
      window.Family.handleInviteUrl(window.location.href).then(function (handled) {
        if (!handled) {
          renderSection(getCurrentRoute());
        }
      });
      return;
    }
    var route = getCurrentRoute();
    renderSection(route);
  }

  /* ================================================================
      9. ПРЕМИУМ-АНИМАЦИИ (Этап 7.5) — невасивный UI-слой
      ================================================================ */

  /**
   * Анимация collapse при удалении записи.
   *
   * Модуль-обработчики менять нельзя, поэтому слой полностью невасивный:
   * capture-слушатель на body запоминает карточку по кнопке удаления, а по
   * подтверждению запускает схлопывание.
   *
   * Важная деталь: DB.delete → paint() перетирает innerHTML контейнера, и
   * исходная карточка исчезает мгновенно — анимация не успевает доиграть.
   * Поэтому карточка «вынимается» из потока: создаётся ghost-клон,
   * зафиксированный по её текущим координатам, он и проигрывает cardOut,
   * а по окончании удаляется. Поведение модулей при этом не меняется.
   */
  function setupPremiumAnimations() {
    var pendingCard = null;

    /**
     * Показывает схлопывающийся клон карточки поверх её прежнего места.
     * @param {HTMLElement} card
     */
    function playCollapse(card) {
      var rect = card.getBoundingClientRect();
      // Не влезает или скрыт — анимировать нечего
      if (!rect.width || !rect.height) { return; }

      var ghost = card.cloneNode(true);
      ghost.classList.add('card--removing');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.removeAttribute('id');
      ghost.querySelectorAll('[id]').forEach(function (n) { n.removeAttribute('id'); });
      ghost.querySelectorAll('input, select, textarea, button').forEach(function (n) { n.disabled = true; });

      ghost.style.position = 'fixed';
      ghost.style.top = rect.top + 'px';
      ghost.style.left = rect.left + 'px';
      ghost.style.width = rect.width + 'px';
      // height не фиксируем: cardOut анимирует max-height/padding, и именно
      // за счёт auto-высоты видно реальное схлопывание
      ghost.style.maxHeight = rect.height + 'px';
      ghost.style.margin = '0';
      ghost.style.zIndex = '150';
      ghost.style.pointerEvents = 'none';

      document.body.appendChild(ghost);

      var drop = function () {
        if (ghost.parentNode) { ghost.parentNode.removeChild(ghost); }
        ghost.removeEventListener('animationend', drop);
      };
      ghost.addEventListener('animationend', drop);
      // Страховка: если анимация не запустилась (reduced motion и т.п.)
      setTimeout(drop, 400);
    }

    document.body.addEventListener('click', function (e) {
      if (!e.target.closest) { return; }

      var delBtn = e.target.closest(
        '[data-action="delete"], [data-action="delete-meter"], ' +
        '[data-doc-action="delete"], [data-task-action="delete"]'
      );
      if (delBtn) {
        pendingCard = delBtn.closest('.card');
        return;
      }

      var confirmBtn = e.target.closest(
        '[data-action="confirm"], [data-doc-action="confirm"], [data-task-action="confirm"]'
      );
      if (confirmBtn && pendingCard && pendingCard.isConnected) {
        playCollapse(pendingCard);
        pendingCard = null;
      }
    }, true);
  }

  /* ================================================================
     10. ИНИЦИАЛИЗАЦИЯ ПРИЛОЖЕНИЯ
     ================================================================ */

  /**
   * Инициализирует приложение:
   *   1. Показывает скелетон-загрузку
   *   2. Запускает DB.init()
   *   3. После успешной инициализации — рендерит первый раздел
   *   4. При ошибке — показывает сообщение об ошибке
   */
  function init() {
    appEl = document.getElementById('app');
    var route = getCurrentRoute();

    // Привязываем обработчик кликов по навигации
    var navBottom = document.querySelector('.nav-bottom');
    if (navBottom) {
      navBottom.addEventListener('click', onNavClick);
    }

    // Слушаем изменение hash для навигации «назад/вперёд»
    window.addEventListener('hashchange', onHashChange);

    // Этап 10: интеграция с ВКонтакте и офлайн-режим
    bindVkEvents();
    registerServiceWorker();

    // Этап 12.5: после покупки/истечения PRO перерисовываем разделы
    bindProEvents();
    bindFamilyEvents();

    // ...и дорисовываем их же после ввода PIN
    bindPinEvents();

    // Этап 7.5: невасивный UI-слой (collapse при удалении). Функция была
    // определена, но не вызывалась — анимация схлопывания не срабатывала
    // ни в одном разделе (Этап 11, баг №4).
    setupPremiumAnimations();

    // Если hash не задан — ставим начальное значение
    if (!window.location.hash) {
      window.location.hash = 'home';
    }

    // Показываем скелетон-загрузку
    showLoading();

    // Инициализируем базу данных
    if (window.DB) {
      window.DB.init().then(function () {
        // База готова — ставим флаг
        window.DB_READY = true;

        // Инициализируем модули разделов (привязка делегатов событий)
        initSectionModules();

        /* Этап 12.6: настройки уведомлений лежат в store 'settings',
           поэтому их читаем только после готовности БД. Пока load() в
           полёте, модуль отдаёт значения по умолчанию — тумблеры от этого
           не врут. */
        if (window.NotifPrefs) { window.NotifPrefs.load(); }
        if (window.Personalization) { window.Personalization.init(); }

        window.addEventListener('home:layout-changed', function () {
          if (getCurrentRoute() === 'home') {
            renderSection('home');
          }
        });

        var familyInit = window.Family ? window.Family.init() : Promise.resolve();
        familyInit.then(function () {
          if (window.Family && window.Family.parseInviteUrl && window.Family.parseInviteUrl(window.location.href)) {
            return window.Family.handleInviteUrl(window.location.href);
          }
          return false;
        }).then(function (handled) {
          if (handled) { return; }
          // Если был отложенный рендер — выполняем его
          if (pendingRoute) {
            renderSection(pendingRoute);
            pendingRoute = null;
          } else {
            // Иначе рендерим текущий маршрут
            renderSection(getCurrentRoute());
          }
        });

        /* Этап 12.6: напоминания старруем ПОСЛЕ первого рисования экрана.
           Проверка читает три хранилища, и запущенная синхронно, она легла
           бы на LCP; задержка в 1.2 с отдана ещё и для того, чтобы успели
           подняться сводка главной и кэш разделов.
           init() ставит слушатели фокуса/visibilitychange/db:change — это
           единственный источник периодичности, таймеров здесь нет. */
        setTimeout(function () {
          if (!window.PushManager) { return; }
          window.PushManager.init();
          window.PushManager.checkDueEvents();
        }, 1200);

        /* Этап 12.6: приложение могли открыть домашним ярлыком PWA
           (app-manifest.webmanifest → ?view=). Раздел уже отрисован, поэтому
           форму открываем сразу — это и есть смысл ярлыка в один тап. */
        if (window.QuickActions) { window.QuickActions.applyShortcutView(); }
      }).catch(function (err) {
        console.error('[App] Ошибка инициализации базы данных:', err);
        renderError('Не удалось инициализировать базу данных. ' + err.message);
      });
    } else {
      // DB модуль не загружен
      console.error('[App] Модуль DB не загружен (db.js).');
      renderError('Модуль базы данных не найден. Убедитесь, что файл db.js загружен.');
    }
  }

  // Ждём готовности DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ================================================================
     8. ЭКСПОРТ API
     ================================================================ */

  /**
   * Публичный API приложения.
   * @namespace App
   */
  window.App = {
    /** Переход по маршруту */
    navigate: navigate,
    /** Рендер раздела (вызывается из роутера) */
    renderSection: renderSection,
    /** Получение текущего маршрута */
    getCurrentRoute: getCurrentRoute,
    /** Список допустимых маршрутов */
    routes: ROUTES,
    /** Флаг готовности БД (для внешних модулей) */
    DB_READY: function () { return window.DB_READY; }
  };
})();
