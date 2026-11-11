/**
 * МОЙ ПОРЯДОК — Раздел «Платежи» (Этап 4)
 *
 * Список платежей, сводка за месяц, фильтры, сортировка,
 * форма добавления/редактирования в модальном окне, удаление с подтверждением.
 *
 * Данные читаются и пишутся только через window.DB.
 * Суммы хранятся в копейках (integer), даты — в ISO 8601.
 *
 * Экспортирует window.Payments.
 */

(function () {
  'use strict';

  /* ================================================================
     1. КОНФИГУРАЦИЯ
     ================================================================ */

  /** @const {string} Имя хранилища платежей */
  var STORE = 'payments';

  /** @const {Array<{name: string, bg: string, fg: string}>} Категории и цвета бейджей */
  var CATEGORIES = [
    { name: 'Коммунальные', bg: '#DCFCE7', fg: '#15803D' },
    { name: 'Интернет', bg: '#DBEAFE', fg: '#1D4ED8' },
    { name: 'Мобильная связь', bg: '#FEF3C7', fg: '#A16207' },
    { name: 'Кредиты', bg: '#FEE2E2', fg: '#B91C1C' },
    { name: 'Подписки', bg: '#F3E5F5', fg: '#7E22CE' },
    { name: 'Личные', bg: '#E0E7FF', fg: '#4338CA' },
    { name: 'Другое', bg: '#E2E8F0', fg: '#475569' }
  ];

  /** @const {Array<{value: string, label: string}>} Варианты периодичности */
  var FREQUENCIES = [
    { value: 'once', label: 'Разовый' },
    { value: 'monthly', label: 'Ежемесячно' },
    { value: 'quarterly', label: 'Ежеквартально' },
    { value: 'yearly', label: 'Ежегодно' }
  ];

  /** @const {Object.<string, string>} Подписи статусов */
  var STATUS_LABELS = { pending: 'Ожидает', paid: 'Оплачено' };

  /** @const {Object.<string, string>} Значения фильтров */
  var FILTERS = { ALL: 'all', PENDING: 'pending', PAID: 'paid' };

  /** @const {string} SVG-иконка квитанции (PRO, Этап 12.5) */
  var ICON_RECEIPT =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>' +
    '<rect x="6" y="14" width="12" height="8"/></svg>';

  /** @const {string} SVG-иконка повтора для периодических платежей */
  var ICON_REPEAT =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/>' +
    '<polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';

  /** @const {string} SVG-иконка корзины */
  var ICON_TRASH =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="3 6 5 6 21 6"/>' +
    '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

  /* ================================================================
     2. СОСТОЯНИЕ МОДУЛЯ
     ================================================================ */

  /** @type {Array<Object>} Все платежи из БД без фильтрации */
  var allPayments = [];

  /** @type {string} Активный фильтр: all | pending | paid */
  var filter = FILTERS.ALL;

  /** @type {'date-asc'|'date-desc'} Активная сортировка */
  var sort = 'date-asc';

  /** @type {number|null} ID платежа в форме редактирования, null — новая запись */
  var editingId = null;

  /** @type {boolean} Идёт ли загрузка (показан skeleton) */
  var loading = false;

  /** @type {boolean} Привязаны ли делегаты событий */
  var listenersBound = false;

  /**
   * @returns {HTMLElement} Контейнер разделов
   */
  function appEl() {
    return document.getElementById('app');
  }

  /* ================================================================
     3. УТИЛИТЫ ФОРМАТИРОВАНИЯ
     ================================================================ */

  /**
   * Форматирует копейки в рубли.
   * Выбранный формат (единый для всего приложения):
   *   15000 → '150 ₽'        (копейки .00 не показываем)
   *   15050 → '150,50 ₽'
   *   1500000 → '1 500 ₽'    (разделитель тысяч — пробел)
   * @param {number} kopecks — целое число копеек
   * @returns {string}
   */
  function formatMoney(kopecks) {
    if (!Number.isInteger(kopecks)) { return '—'; }

    var negative = kopecks < 0;
    var abs = Math.abs(kopecks);
    var rubles = Math.floor(abs / 100);
    var cents = abs % 100;

    var rublesStr = String(rubles).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
    var value = cents > 0
      ? rublesStr + ',' + String(cents).padStart(2, '0')
      : rublesStr;

    return (negative ? '−' : '') + value + ' ₽';
  }

  /**
   * Преобразует ISO-дату в локализованный формат ДД.ММ.ГГГГ.
   * @param {string|null} iso — '2026-01-15' или полная ISO-строка
   * @returns {string} '15.01.2026' или '—'
   */
  function formatDate(iso) {
    if (!iso) { return '—'; }

    var d = new Date(iso);
    if (isNaN(d.getTime())) { return '—'; }

    var day = String(d.getDate()).padStart(2, '0');
    var month = String(d.getMonth() + 1).padStart(2, '0');
    return day + '.' + month + '.' + d.getFullYear();
  }

  /**
   * Сегодняшняя дата как YYYY-MM-DD — значение для input[type=date] и ISO-поля БД.
   * @returns {string}
   */
  function todayISO() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  /**
   * Название текущего месяца для заголовка сводки.
   * @returns {string} например 'ноябрь 2026'
   */
  function currentMonthLabel() {
    var now = new Date();
    var months = [
      'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
      'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'
    ];
    return months[now.getMonth()] + ' ' + now.getFullYear();
  }

  /**
   * Цвета бейджа категории.
   * @param {string} category
   * @returns {{bg: string, fg: string}}
   */
  function getCategoryColor(category) {
    if (window.Personalization && window.Personalization.getCategoryColors) {
      var custom = window.Personalization.getCategoryColors(category);
      if (custom) {
        return { bg: custom.bg, fg: custom.fg };
      }
    }
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].name === category) {
        return { bg: CATEGORIES[i].bg, fg: CATEGORIES[i].fg };
      }
    }
    return { bg: '#E2E8F0', fg: '#475569' };
  }

  /**
   * Русская подпись периодичности.
   * @param {string} value
   * @returns {string}
   */
  function frequencyLabel(value) {
    for (var i = 0; i < FREQUENCIES.length; i++) {
      if (FREQUENCIES[i].value === value) { return FREQUENCIES[i].label; }
    }
    return 'Разовый';
  }

  /**
   * Экранирует текст для безопасной вставки в HTML.
   * @param {*} text
   * @returns {string}
   */
  function esc(text) {
    if (text === null || text === undefined) { return ''; }
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ================================================================
     4. ФИЛЬТРАЦИЯ И ВЫЧИСЛЕНИЯ
     ================================================================ */

  /**
   * Применяет активный фильтр.
   * @param {Array<Object>} items
   * @returns {Array<Object>}
   */
  function applyFilter(items) {
    /* Этап 12.7: мягко удалённые соседом по семье строки не показываем —
       запись остаётся в базе ради tombstone, но в списке её быть не должно */
    var out = items.filter(function (p) {
      return !(window.FamilyUI && window.FamilyUI.isHidden(p));
    });

    if (filter === FILTERS.PENDING) {
      return out.filter(function (p) { return p.status === 'pending'; });
    }
    if (filter === FILTERS.PAID) {
      return out.filter(function (p) { return p.status === 'paid'; });
    }
    return out;
  }

  /**
   * Фильтр по доступу (Этап 12.7): «Все / 👥 Семейные / 🔒 Личные».
   * Вне семьи FamilyUI возвращает список без изменений.
   * @param {Array<Object>} items @returns {Array<Object>}
   */
  function applyScopeFilter(items) {
    if (!window.FamilyUI) { return items; }
    return window.FamilyUI.applyScopeFilter(items);
  }

  /**
   * Сортирует по дате. При равных датах неоплаченные идут выше.
   * @param {Array<Object>} items
   * @returns {Array<Object>}
   */
  function applySort(items) {
    return items.sort(function (a, b) {
      var ta = a.date ? new Date(a.date).getTime() : Infinity;
      var tb = b.date ? new Date(b.date).getTime() : Infinity;

      if (ta !== tb) { return sort === 'date-asc' ? ta - tb : tb - ta; }

      var wa = a.status === 'paid' ? 1 : 0;
      var wb = b.status === 'paid' ? 1 : 0;
      return wa - wb;
    });
  }

  /**
   * Суммы за текущий календарный месяц по полю date.
   * @param {Array<Object>} items — ВСЕ платежи, без фильтра
   * @returns {{paid: number, pending: number, count: number}}
   */
  function monthSummary(items) {
    var prefix = todayISO().slice(0, 7); // YYYY-MM
    var result = { paid: 0, pending: 0, count: 0 };

    items.forEach(function (p) {
      if (!p.date || String(p.date).slice(0, 7) !== prefix) { return; }

      result.count++;
      if (p.status === 'paid') {
        result.paid += p.amount;
      } else {
        result.pending += p.amount;
      }
    });

    return result;
  }

  /* ================================================================
     5. РЕНДЕР
     ================================================================ */

  /**
   * Skeleton-разметка списка.
   * @returns {string}
   */
  function skeletonHtml() {
    var cards = '';
    for (var i = 0; i < 3; i++) {
      cards +=
        '<div class="card">' +
          '<div class="flex items-center gap-3">' +
            '<div class="flex flex-col gap-2" style="flex: 1;">' +
              '<div class="skeleton skeleton--text" style="width: ' + (50 + i * 12) + '%;"></div>' +
              '<div class="skeleton skeleton--text" style="width: 32%;"></div>' +
            '</div>' +
            '<div class="skeleton" style="width: 76px; height: 26px; border-radius: var(--radius-full);"></div>' +
          '</div>' +
        '</div>';
    }

    return '<div class="header-actions">' +
        '<h1 class="page-header">Платежи</h1>' +
        '<div class="skeleton btn--icon" style="width: 48px; height: 48px; border-radius: var(--radius-full);"></div>' +
      '</div>' +
      '<div class="card summary-card mb-4">' +
        '<div class="skeleton skeleton--text" style="width: 40%;"></div>' +
        '<div class="skeleton skeleton--text" style="width: 65%; height: 28px;"></div>' +
      '</div>' +
      '<div class="flex flex-col gap-3">' + cards + '</div>';
  }

  /**
   * HTML сводки за месяц.
   * @param {{paid: number, pending: number, count: number}} summary
   * @returns {string}
   */
  function summaryHtml(summary) {
    var total = summary.paid + summary.pending;

    return '' +
      '<div class="card summary-card mb-4">' +
        '<div class="summary-card__label">В этом месяце · ' + esc(currentMonthLabel()) + '</div>' +

        '<div class="summary-card__row">' +
          '<div>' +
            '<div class="summary-card__value summary-card__value--paid">' + formatMoney(summary.paid) + '</div>' +
            '<div class="summary-card__hint">оплачено</div>' +
          '</div>' +
          '<div style="text-align: right;">' +
            '<div class="summary-card__value summary-card__value--pending">' + formatMoney(summary.pending) + '</div>' +
            '<div class="summary-card__hint">ожидает</div>' +
          '</div>' +
        '</div>' +

        '<hr class="card__divider">' +

        '<div class="flex justify-between">' +
          '<span class="summary-card__hint">Платежей в месяце</span>' +
          '<span class="summary-card__hint">' + summary.count + ' · ' + formatMoney(total) + '</span>' +
        '</div>' +
      '</div>';
  }

  /**
   * HTML фильтров и переключателя сортировки.
   * @returns {string}
   */
  function filtersHtml() {
    var chips = [
      { value: FILTERS.ALL, label: 'Все' },
      { value: FILTERS.PENDING, label: 'Ожидают' },
      { value: FILTERS.PAID, label: 'Оплаченные' }
    ].map(function (f) {
      var active = filter === f.value;
      return '<button type="button" class="chip' + (active ? ' chip--active' : '') + '" ' +
        'data-filter="' + f.value + '" aria-pressed="' + active + '">' + f.label + '</button>';
    }).join('');

    var sortLabel = sort === 'date-asc' ? 'Ближайшие' : 'Поздние';

    var scopeChips = window.FamilyUI ? window.FamilyUI.scopeChips('data-scope-filter') : '';

    return '<div class="filter-row">' + chips +
      '<button type="button" class="chip" data-action="toggle-sort" aria-label="Изменить сортировку">' +
        sortLabel + ' ↕' +
      '</button>' +
      scopeChips +
    '</div>';
  }

  /**
   * HTML карточки платежа.
   * @param {Object} p
   * @returns {string}
   */
  function paymentCardHtml(p) {
    var paid = p.status === 'paid';
    var colors = getCategoryColor(p.category);
    var isRecurring = p.frequency && p.frequency !== 'once';

    return '' +
    '<article class="card payment-card" data-id="' + p.id + '" tabindex="0" role="button" ' +
      'aria-label="Платёж «' + esc(p.title) + '», ' + formatMoney(p.amount) + '. Нажми для изменения.">' +

      '<div class="payment-card__top">' +
        '<div class="payment-card__info">' +
          '<h3 class="payment-card__title">' + esc(p.title) + '</h3>' +
          '<div class="payment-card__meta">' +
            '<span class="badge" style="background: ' + colors.bg + '; color: ' + colors.fg +
              '; --badge-fg: ' + colors.fg + ';">' +
              esc(p.category) +
            '</span>' +
            '<span class="payment-card__date">' + formatDate(p.date) + '</span>' +
             (window.FamilyUI ? window.FamilyUI.badgeHtml(p) : '') +
            (isRecurring
              ? '<span class="payment-card__repeat">' + ICON_REPEAT +
                  '<span>' + frequencyLabel(p.frequency) + '</span></span>'
              : '') +
          '</div>' +
        '</div>' +
        '<div class="payment-card__amount' + (paid ? ' payment-card__amount--paid' : '') + '">' +
          formatMoney(p.amount) +
        '</div>' +
      '</div>' +

      '<div class="payment-card__actions">' +
        '<button type="button" class="status-toggle' + (paid ? ' status-toggle--paid' : '') + '" ' +
          'data-action="toggle-status" data-id="' + p.id + '" ' +
          'aria-label="Статус: ' + STATUS_LABELS[p.status] + '. Нажми, чтобы изменить.">' +
          '<span class="status-toggle__dot"></span>' + STATUS_LABELS[p.status] +
        '</button>' +
        (canPrintReceipt()
          ? '<button type="button" class="icon-btn" data-action="gost-qr" data-id="' + p.id + '" ' +
              'title="Оплатить через банковский QR ГОСТ" aria-label="Банковский QR-код ГОСТ">' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><line x1="7" y1="7" x2="7.01" y2="7"/><line x1="17" y1="7" x2="17.01" y2="7"/><line x1="7" y1="17" x2="7.01" y2="17"/><line x1="17" y1="17" x2="17.01" y2="17"/></svg>' +
            '</button>' +
            '<button type="button" class="icon-btn" data-action="receipt" data-id="' + p.id + '" ' +
              'aria-label="Распечатать квитанцию по платежу «' + esc(p.title) + '">' + ICON_RECEIPT + '</button>'
          : '') +
        '<button type="button" class="icon-btn" data-action="delete" data-id="' + p.id + '" ' +
          'aria-label="Удалить платёж «' + esc(p.title) + '»">' + ICON_TRASH + '</button>' +
      '</div>' +
    '</article>';
  }

  /**
   * Доступна ли печать квитанции: PRO + модуль отчётов загрузился.
   * Проверяем в момент render(), а не в CSS: Free не должен получать
   * кнопку в разметке вообще, иначе её можно нажать из devtools.
   * @returns {boolean}
   */
  function canPrintReceipt() {
    return Boolean(window.PdfExporter && window.ProManager && window.ProManager.isPro());
  }

  /**
   * Empty state: нет вообще платежей или ничего не нашлось по фильтру.
   * @param {boolean} filteredEmpty
   * @returns {string}
   */
  function emptyHtml(filteredEmpty) {
    if (filteredEmpty) {
      return '<section class="empty-state">' +
        '<div class="empty-state__icon" aria-hidden="true">🔍</div>' +
        '<h2 class="empty-state__title">Ничего не найдено</h2>' +
        '<p class="empty-state__text">Под этот фильтр не подходит ни один платёж.</p>' +
        '<button type="button" class="btn btn--secondary" data-action="reset-filter">Показать все</button>' +
        '</section>';
    }

    return '<section class="empty-state">' +
      '<div class="empty-state__icon" aria-hidden="true">💳</div>' +
      '<h2 class="empty-state__title">Пока нет платежей</h2>' +
      '<p class="empty-state__text">Добавь первый платёж — учёт поможет не пропустить срок оплаты.</p>' +
      '<button type="button" class="btn btn--primary" data-action="add">Добавить платёж</button>' +
      '</section>';
  }

  /**
   * Сообщение об ошибке с кнопкой повтора.
   * @param {string} message
   * @returns {string}
   */
  function errorHtml(message) {
    return '<header class="page-header">Платежи</header>' +
      '<section class="empty-state">' +
        '<div class="empty-state__icon" aria-hidden="true">⚠️</div>' +
        '<h2 class="empty-state__title">Не удалось загрузить платежи</h2>' +
        '<p class="empty-state__text">' + esc(message) + '</p>' +
        '<button type="button" class="btn btn--primary" data-action="retry">Попробовать снова</button>' +
      '</section>';
  }

  /**
   * Разрисовывает содержимое раздела.
   */
  function paint() {
    var el = appEl();
    if (!el) { return; }

    var visible = applyScopeFilter(applySort(applyFilter(allPayments)));
    var summary = monthSummary(allPayments);

    var body = visible.length === 0
      ? emptyHtml(allPayments.length > 0)
      : visible.map(paymentCardHtml).join('');

    var subInspectorHtml = (window.ValuePack && window.ValuePack.renderSubscriptionInspectorHtml)
      ? window.ValuePack.renderSubscriptionInspectorHtml(allPayments)
      : '';

    el.innerHTML = '' +
      '<div class="header-actions">' +
        '<h1 class="page-header">Платежи</h1>' +
        '<button type="button" class="btn btn--primary btn--icon" data-action="add" aria-label="Добавить платёж">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
        '</button>' +
      '</div>' +
      summaryHtml(summary) +
      subInspectorHtml +
      filtersHtml() +
      '<div class="flex flex-col gap-3">' + body + '</div>';
  }

  /**
   * Читает платежи из БД в состояние модуля.
   * @returns {Promise<Array<Object>>}
   */
  function loadPayments() {
    return DB.getAll(STORE).then(function (rows) {
      allPayments = rows || [];
      return allPayments;
    });
  }

  /**
   * Рендер раздела: skeleton → данные → контент.
   */
  function render() {
    var el = appEl();
    if (!el) { return; }

    init();

    // Уже есть данные — рисуем сразу, без skeleton
    if (allPayments.length > 0) {
      paint();
      return;
    }

    if (loading) { return; }

    loading = true;
    el.innerHTML = skeletonHtml();

    loadPayments().then(function () {
      loading = false;
      paint();
    }).catch(function (err) {
      loading = false;
      console.error('[Payments] Ошибка загрузки:', err);
      el.innerHTML = errorHtml(err.message);
    });
  }

  /**
   * Сбрасывает кэш — вызывается роутером при входе в раздел,
   * чтобы список всегда был актуален.
   */
  function invalidate() {
    allPayments = [];
    loading = false;
  }

  /* ================================================================
     6. МОДАЛЬНОЕ ОКНО
     ================================================================ */

  /**
   * Создаёт overlay с карточкой, запускает анимацию появления.
   * @param {string} innerHtml — содержимое карточки
   * @param {function(HTMLElement, function(): void): void} onMount — привязка обработчиков
   */
  function openModal(innerHtml, onMount) {
    // Защита от «стопки» одинаковых диалогов (Этап 11, баг №6): быстрый
    // повторный клик по «+» открывал несколько идентичных окон сразу, и
    // закрытие одного оставляло висеть остальные. Диалог с тем же
    // содержимым, который уже открыт, повторно не открываем. Разные
    // диалоги (форма → подтверждение) при этом наслаиваются как раньше.
    var opened = document.querySelectorAll('.modal-overlay');
    for (var i = 0; i < opened.length; i++) {
      if (!opened[i]._closing && opened[i]._signature === innerHtml) { return; }
    }

    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay._signature = innerHtml;

    var card = document.createElement('div');
    card.className = 'modal-content';
    card.innerHTML = innerHtml;

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.body.classList.add('modal-open');

    // Класс добавляем на следующем кадре, иначе transition не проиграется
    requestAnimationFrame(function () {
      overlay.classList.add('is-open');
    });

    function close() {
      closeModal(overlay);
    }

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) { close(); }
    });

    overlay._onKeydown = function (e) {
      if (e.key === 'Escape') { close(); }
    };
    document.addEventListener('keydown', overlay._onKeydown);

    if (onMount) { onMount(card, close); }
  }

  /**
   * Плавно закрывает overlay.
   * @param {HTMLElement} overlay
   */
  function closeModal(overlay) {
    if (!overlay || overlay._closing) { return; }
    overlay._closing = true;

    document.removeEventListener('keydown', overlay._onKeydown);
    overlay.classList.remove('is-open');

    setTimeout(function () {
      if (overlay.parentNode) { overlay.parentNode.removeChild(overlay); }
      if (!document.querySelector('.modal-overlay')) {
        document.body.classList.remove('modal-open');
      }
    }, 250);
  }

  /* ================================================================
     7. ФОРМА ПЛАТЕЖА
     ================================================================ */

  /**
   * Разметка формы.
   * @param {Object|null} payment — данные для редактирования или null
   * @returns {string}
   */
  function formHtml(payment) {
    var isNew = !payment;
    var dateValue = isNew ? todayISO() : String(payment.date || todayISO()).slice(0, 10);

    // Копейки → рубли для поля ввода
    var amountValue = isNew ? '' : (payment.amount / 100).toFixed(2).replace('.', ',');

    var categoryOptions = (window.Personalization && window.Personalization.buildCategorySelectOptions)
      ? window.Personalization.buildCategorySelectOptions('payment', !isNew ? payment.category : '', CATEGORIES)
      : CATEGORIES.map(function (c) {
          var selected = !isNew && payment.category === c.name ? ' selected' : '';
          return '<option value="' + esc(c.name) + '"' + selected + '>' + esc(c.name) + '</option>';
        }).join('');

    // У новой записи пустой выбор — пользователь обязан указать категорию
    var categorySelect = isNew
      ? '<option value="">Выберите категорию</option>' + categoryOptions
      : categoryOptions;

    var currentFrequency = isNew ? 'once' : (payment.frequency || 'once');
    var frequencyOptions = FREQUENCIES.map(function (f) {
      var selected = f.value === currentFrequency ? ' selected' : '';
      return '<option value="' + f.value + '"' + selected + '>' + f.label + '</option>';
    }).join('');

    var isPaid = !isNew && payment.status === 'paid';

    return '' +
      '<h2 class="modal-content__title">' + (isNew ? 'Новый платёж' : 'Редактировать платёж') + '</h2>' +

      '<form id="payment-form" novalidate>' +

        '<div class="form-group">' +
          '<label class="form-label" for="f-title">Название</label>' +
          '<input class="form-input" id="f-title" name="title" type="text" maxlength="100" ' +
            'autocomplete="off" placeholder="Например: Интернет" value="' + esc(isNew ? '' : payment.title) + '">' +
          '<div class="form-error" id="e-title"></div>' +
        '</div>' +

        '<div class="form-group">' +
          '<label class="form-label" for="f-amount">Сумма, ₽</label>' +
          '<input class="form-input" id="f-amount" name="amount" type="text" inputmode="decimal" ' +
            'autocomplete="off" placeholder="599,00" value="' + esc(amountValue) + '">' +
          '<div class="form-error" id="e-amount"></div>' +
        '</div>' +

        '<div class="form-group">' +
          '<label class="form-label" for="f-date">Дата оплаты</label>' +
          '<input class="form-input" id="f-date" name="date" type="date" value="' + esc(dateValue) + '">' +
          '<div class="form-error" id="e-date"></div>' +
        '</div>' +

        '<div class="form-group">' +
          '<label class="form-label" for="f-category">Категория</label>' +
          '<select class="form-select" id="f-category" name="category">' + categorySelect + '</select>' +
          '<div class="form-error" id="e-category"></div>' +
        '</div>' +

        '<div class="form-group">' +
          '<label class="form-label" for="f-frequency">Периодичность</label>' +
          '<select class="form-select" id="f-frequency" name="frequency">' + frequencyOptions + '</select>' +
        '</div>' +

        /* Этап 12.7: доступ. Вне семьи поле не рисуется совсем */
        (window.FamilyUI ? window.FamilyUI.scopeFieldHtml(isNew ? '' : payment.familyScope) : '') +

        '<div class="form-group">' +
          '<label class="switch" for="f-paid">' +
            '<input type="checkbox" id="f-paid"' + (isPaid ? ' checked' : '') + '>' +
            '<span class="switch__track" aria-hidden="true"></span>' +
            '<span class="switch__label" id="f-paid-label">' +
              (isPaid ? 'Оплачено' : 'Ожидает оплаты') +
            '</span>' +
          '</label>' +
        '</div>' +

        '<div class="form-error" id="e-save" role="alert"></div>' +

        '<div class="flex gap-3 mt-4">' +
          '<button type="button" class="btn btn--secondary" style="flex: 1;" data-action="cancel">Отмена</button>' +
          '<button type="submit" class="btn btn--primary" style="flex: 1;">Сохранить</button>' +
        '</div>' +
      '</form>';
  }

  /**
   * Открывает форму добавления.
   */
  function openAddForm() {
    editingId = null;
    openModal(formHtml(null), bindForm);
  }

  /**
   * Открывает форму редактирования.
   * @param {number} id
   */
  function openEditForm(id) {
    DB.get(STORE, id).then(function (payment) {
      if (!payment) {
        console.warn('[Payments] Платёж не найден:', id);
        return;
      }
      editingId = id;
      openModal(formHtml(payment), bindForm);
    }).catch(function (err) {
      console.error('[Payments] Ошибка загрузки платежа для редактирования:', err);
    });
  }

  /**
   * Привязывает обработчики формы.
   * @param {HTMLElement} card
   * @param {function(): void} close
   */
  function bindForm(card, close) {
    var paidInput = card.querySelector('#f-paid');
    var paidLabel = card.querySelector('#f-paid-label');

    paidInput.addEventListener('change', function () {
      paidLabel.textContent = paidInput.checked ? 'Оплачено' : 'Ожидает оплаты';
    });

    // Снимаем подсветку ошибки при вводе
    ['title', 'amount', 'date', 'category'].forEach(function (name) {
      var input = card.querySelector('[name="' + name + '"]');
      input.addEventListener('input', function () {
        input.classList.remove('is-invalid');
        card.querySelector('#e-' + name).textContent = '';
      });
    });

    card.querySelector('[data-action="cancel"]').addEventListener('click', close);

    card.querySelector('#payment-form').addEventListener('submit', function (e) {
      e.preventDefault();
      save(card, close);
    });

    // Фокус после завершения анимации появления
    setTimeout(function () {
      card.querySelector('#f-title').focus();
    }, 260);
  }

  /**
   * Валидирует форму.
   * @param {HTMLElement} card
   * @returns {Object|null} данные для записи или null при ошибках
   */
  function readForm(card) {
    var ok = true;

    function fail(name, message) {
      var input = card.querySelector('[name="' + name + '"]');
      if (input) { input.classList.add('is-invalid'); }
      card.querySelector('#e-' + name).textContent = message;
      ok = false;
    }

    var title = card.querySelector('[name="title"]').value.trim();
    var rawAmount = card.querySelector('[name="amount"]').value.trim();
    var date = card.querySelector('[name="date"]').value;
    var category = card.querySelector('[name="category"]').value;
    var frequency = card.querySelector('[name="frequency"]').value;
    var status = card.querySelector('#f-paid').checked ? 'paid' : 'pending';

    if (!title) {
      fail('title', 'Укажи название платежа');
    } else if (title.length > 100) {
      fail('title', 'Не длиннее 100 символов');
    }

    // Сумму принимаем с запятой или точкой; в БД — строго целые копейки
    var normalized = rawAmount.replace(',', '.');
    var amount = null;

    if (!normalized) {
      fail('amount', 'Укажи сумму');
    } else if (!/^\d*\.?\d{0,2}$/.test(normalized)) {
      fail('amount', 'Не больше двух знаков после разделителя');
    } else {
      amount = Math.round(parseFloat(normalized) * 100);
      if (!Number.isInteger(amount) || amount <= 0) {
        fail('amount', 'Сумма должна быть больше нуля');
      }
    }

    if (!date) {
      fail('date', 'Выбери дату оплаты');
    } else if (isNaN(new Date(date).getTime())) {
      fail('date', 'Некорректная дата');
    }

    if (!category) {
      fail('category', 'Выбери категорию');
    }

    if (!ok) {
      if (window.Personalization) { window.Personalization.triggerFeedback('validation_error'); }
      return null;
    }

    var data = {
      title: title,
      amount: amount,   // integer, копейки
      date: date,       // YYYY-MM-DD — валидная ISO-строка
      category: category,
      frequency: frequency,
      status: status
    };

    /* Этап 12.7: переключатель «Общая/Личная». null — поля в форме нет
       (человек вне семьи), и лезть в запись со служебным флагом нельзя */
    var scope = window.FamilyUI ? window.FamilyUI.readScope(card) : null;
    if (scope) { data.familyScope = scope; }

    return data;
  }

  /**
   * Сохраняет форму: создаёт или обновляет запись.
   * @param {HTMLElement} card
   * @param {function(): void} close
   */
  function save(card, close) {
    var data = readForm(card);
    if (!data) { return; }

    // Платёж с периодичностью помечаем шаблоном (подход 2 из спецификации).
    // Реальные записи на следующие периоды НЕ создаются автоматически:
    // это исключает дубликаты при каждой перезагрузке приложения.
    // TODO: recurring logic v2 — генерация следующего периода по шаблону.
    data.isTemplate = data.frequency !== 'once';
    data.nextDueDate = null;

    /* Этап 12.7: владельца, семью и флаг доступа проставляет Family. Вне
       семьи функция ничего не добавляет — личное приложение не обрастает
       служебными полями. */
    if (window.Family && window.Family.stampScope) {
      window.Family.stampScope(data, STORE, Boolean(editingId));
    }

    var operation = editingId
      ? DB.update(STORE, editingId, data)
      : DB.add(STORE, data);

    operation.then(function () {
      if (window.Personalization) { window.Personalization.triggerFeedback('payment_saved'); }
      close();
      return loadPayments();
    }).then(function () {
      paint();
    }).catch(function (err) {
      console.error('[Payments] Ошибка сохранения:', err);
      card.querySelector('#e-save').textContent = 'Не удалось сохранить: ' + err.message;
    });
  }

  /* ================================================================
     8. УДАЛЕНИЕ И СМЕНА СТАТУСА
     ================================================================ */

  /**
   * Удаляет платёж после подтверждения в модальном окне.
   * @param {number} id
   */
  function removePayment(id) {
    var payment = findPayment(id);
    if (!payment) { return; }

    var html = '' +
      '<h2 class="modal-content__title">Удалить платёж?</h2>' +
      '<p class="modal-content__text">' +
        '«' + esc(payment.title) + '» на сумму ' + formatMoney(payment.amount) +
        ' будет удалён без возможности восстановления.' +
      '</p>' +
      '<div class="form-error" id="e-delete" role="alert"></div>' +
      '<div class="flex gap-3 mt-4">' +
        '<button type="button" class="btn btn--secondary" style="flex: 1;" data-action="cancel">Отмена</button>' +
        '<button type="button" class="btn btn--danger" style="flex: 1;" data-action="confirm">Удалить</button>' +
      '</div>';

    openModal(html, function (card, close) {
      card.querySelector('[data-action="cancel"]').addEventListener('click', close);

      card.querySelector('[data-action="confirm"]').addEventListener('click', function () {
        var btn = this;
        btn.disabled = true;

        DB.delete(STORE, id).then(function () {
          close();
          allPayments = allPayments.filter(function (p) { return p.id !== id; });
          paint();
        }).catch(function (err) {
          btn.disabled = false;
          console.error('[Payments] Ошибка удаления:', err);
          card.querySelector('#e-delete').textContent = 'Не удалось удалить: ' + err.message;
        });
      });
    });
  }

  /**
   * Переключает статус pending ↔ paid.
   * @param {number} id
   */
  function toggleStatus(id) {
    var payment = findPayment(id);
    if (!payment) { return; }

    var nextStatus = payment.status === 'paid' ? 'pending' : 'paid';

    DB.update(STORE, id, { status: nextStatus }).then(function (updated) {
      var index = allPayments.findIndex(function (p) { return p.id === id; });
      if (index !== -1) { allPayments[index] = updated; }

      // TODO: recurring logic v2 — при paid и шаблоне здесь появится
      // создание следующего экземпляра (с проверкой на дубликат).
      paint();
    }).catch(function (err) {
      console.error('[Payments] Ошибка смены статуса:', err);
    });
  }

  /**
   * Печатает квитанцию по платежу (PRO, Этап 12.5).
   *
   * Модуль отчётов тянет jsPDF/QR лениво — здесь только вызов. Ошибка
   * не считается падением приложения: пользователю показываем причину
   * и оставляем обычный путь «экспорт данных».
   *
   * @param {number} id
   */
  function printReceipt(id) {
    var payment = findPayment(id);
    if (!payment) { return; }

    if (!window.PdfExporter || !window.PdfExporter.printReceipt) {
      if (window.VK && window.VK.notify) {
        window.VK.notify('Модуль печатных форм не загружен', 'error');
      }
      return;
    }

    window.PdfExporter.printReceipt(id).then(function (res) {
      if (res && res.shown) { return; }
      if (window.VK && window.VK.notify) {
        window.VK.notify((res && res.message) || 'Квитанцию не удалось показать', 'error');
      }
    }).catch(function (err) {
      if (window.VK && window.VK.notify) {
        window.VK.notify('Ошибка подготовки квитанции: ' + (err && err.message || err), 'error');
      }
    });
  }

  /**
   * Ищет платёж в кэше по id.
   * @param {number} id
   * @returns {Object|null}
   */
  function findPayment(id) {
    for (var i = 0; i < allPayments.length; i++) {
      if (allPayments[i].id === id) { return allPayments[i]; }
    }
    return null;
  }

  /* ================================================================
     9. ДЕЛЕГИРОВАНИЕ СОБЫТИЙ
     ================================================================ */

  /**
   * Единый обработчик кликов: навешивается один раз,
   * переживает любую перерисовку списка.
   * @param {Event} e
   */
  function onAppClick(e) {
    var actionEl = e.target.closest('[data-action]');

    if (actionEl) {
      var action = actionEl.getAttribute('data-action');
      var id = actionEl.hasAttribute('data-id') ? Number(actionEl.getAttribute('data-id')) : null;

      switch (action) {
        case 'add':
          openAddForm();
          return;
        case 'toggle-status':
          toggleStatus(id);
          return;
        case 'delete':
          removePayment(id);
          return;
        case 'receipt':
          printReceipt(id);
          return;
        case 'gost-qr':
          if (id && window.GostQr) {
            var pm = findPayment(id);
            if (pm) window.GostQr.showPaymentQrModal(pm);
          }
          return;
        case 'retry':
          loading = false;
          render();
          return;
        case 'reset-filter':
          filter = FILTERS.ALL;
          paint();
          return;
        case 'toggle-sort':
          sort = sort === 'date-asc' ? 'date-desc' : 'date-asc';
          paint();
          return;
      }
    }

    var chip = e.target.closest('[data-filter]');
    if (chip) {
      filter = chip.getAttribute('data-filter');
      paint();
      return;
    }

    /* Этап 12.7: чипы «👥 Семейные / 🔒 Личные» */
    var scopeChip = e.target.closest('[data-scope-filter]');
    if (scopeChip && window.FamilyUI) {
      window.FamilyUI.setScopeFilter(scopeChip.getAttribute('data-scope-filter'));
      paint();
      return;
    }

    // Клик по карточке (мимо кнопок) — открываем редактирование
    var card = e.target.closest('.payment-card');
    if (card) {
      openEditForm(Number(card.getAttribute('data-id')));
    }
  }

  /**
   * Enter/Space на сфокусированной карточке — редактирование.
   * @param {KeyboardEvent} e
   */
  function onAppKeydown(e) {
    if (e.key !== 'Enter' && e.key !== ' ') { return; }
    if (!e.target.closest) { return; }

    var card = e.target.closest('.payment-card');
    if (!card || card.contains(e.target.closest('button'))) { return; }

    e.preventDefault();
    openEditForm(Number(card.getAttribute('data-id')));
  }

  /* ================================================================
     10. ИНИЦИАЛИЗАЦИЯ И ПУБЛИЧНЫЙ API
     ================================================================ */

  /**
   * Привязывает делегаты к #app. Повторные вызовы игнорируются.
   */
  function init() {
    if (listenersBound) { return; }

    var el = appEl();
    if (!el) { return; }

    el.addEventListener('click', onAppClick);
    el.addEventListener('keydown', onAppKeydown);

    listenersBound = true;
    console.info('[Payments] Делегаты событий привязаны.');
  }

  window.Payments = {
    init: init,
    render: render,
    invalidate: invalidate,
    openAddForm: openAddForm,
    openEditForm: openEditForm,
    save: save,
    delete: removePayment,
    toggleStatus: toggleStatus,

    /** Утилиты форматирования — пригодятся другим разделам */
    formatMoney: formatMoney,
    formatDate: formatDate,
    getCategoryColor: getCategoryColor,
    CATEGORIES: CATEGORIES,
    FREQUENCIES: FREQUENCIES
  };

  console.info('[Payments] Модуль загружен. API: window.Payments');
})();
