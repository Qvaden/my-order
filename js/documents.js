/**
 * МОЙ ПОРЯДОК — Раздел «Документы» (Этап 6)
 *
 * Учёт документов: паспорт, водительское удостоверение, страховка, медицинские,
 * договоры. Карточки со статусами, фильтры, сортировка (истекающие сверху),
 * форма добавления/редактирования, блок предупреждений о близком истечении.
 *
 * Хранилище DB: 'documents'  { id, name, category, issuedDate, expiryDate,
 * reminderDays, createdAt, updatedAt }
 *
 * ВАЖНО: раздел НЕ хранит фотографии, серии, номера и другие конфиденциальные
 * данные. Только название, категорию и даты.
 *
 * Статус (active/expiring/expired) НЕ хранится в БД — вычисляется на лету.
 * Все операции через window.DB.
 *
 * Экспортирует window.Documents.
 */

(function () {
  'use strict';

  /* ================================================================
     1. КОНСТАНТЫ
     ================================================================ */

  /** @const {string} Хранилище документов */
  var STORE = 'documents';

  /**
   * Категории документов и цвета бейджей.
   * @const {Array<{name: string, bg: string, fg: string}>}
   */
  var CATEGORIES = [
    { name: 'Паспорт',                    bg: '#DBEAFE', fg: '#1D4ED8' },
    { name: 'Водительское удостоверение', bg: '#F3E5F5', fg: '#7E22CE' },
    { name: 'Страховка',                  bg: '#FEF9C3', fg: '#A16207' },
    { name: 'Медицинские',                bg: '#DCFCE7', fg: '#15803D' },
    { name: 'Договоры',                   bg: '#FFEDD5', fg: '#C2410C' },
    { name: 'Другое',                     bg: '#E2E8F0', fg: '#475569' }
  ];

  /**
   * Варианты «Напоминание за». value=0 — не напоминать.
   * @const {Array<{value: number, label: string}>}
   */
  var REMINDER_OPTIONS = [
    { value: 7,  label: '7 дней' },
    { value: 14, label: '14 дней' },
    { value: 30, label: '30 дней' },
    { value: 60, label: '60 дней' },
    { value: 0,  label: 'Не напоминать' }
  ];

  /** @const {number} Порог «красного» статуса, дней */
  var URGENT_DAYS = 7;

  /** @const {number} Порог «оранжевого» статуса по умолчанию, дней */
  var DEFAULT_REMINDER = 30;

  /** SVG-иконки */
  var ICON_TRASH =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

  var ICON_EDIT =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>' +
    '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';

  var ICON_CLOCK =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

  var ICON_ALERT =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
    '<line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

  /* ================================================================
     2. СОСТОЯНИЕ МОДУЛЯ
     ================================================================ */

  /** @type {Array<Object>} Кэш всех документов */
  var documents = [];

  /** @type {boolean} Идёт первичная загрузка (показан skeleton) */
  var loading = false;

  /** @type {boolean} Привязаны ли делегаты */
  var listenersBound = false;

  /** @type {string} Текущий фильтр: all | active | expiring | expired */
  var activeFilter = 'all';

  /** @type {number|null} ID редактируемого документа (null — создание) */
  var editingId = null;

  /** @returns {HTMLElement} Контейнер разделов */
  function appEl() {
    return document.getElementById('app');
  }

  /* ================================================================
     3. УТИЛИТЫ ДАТ, СТАТУСОВ, ФОРМАТИРОВАНИЯ
     ================================================================ */

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

  /**
   * ISO-дата → ДД.ММ.ГГГГ, без даты → «—».
   * @param {string|null} isoString
   * @returns {string}
   */
  function formatDate(isoString) {
    if (!isoString) { return '\u2014'; }
    var d = new Date(isoString);
    if (isNaN(d.getTime())) { return '\u2014'; }
    var day = String(d.getDate()).padStart(2, '0');
    var month = String(d.getMonth() + 1).padStart(2, '0');
    return day + '.' + month + '.' + d.getFullYear();
  }

  /** Сегодня как YYYY-MM-DD */
  function todayISO() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  /**
   * Целое число дней от сегодня до даты.
   * Отрицательное, если дата в прошлом; Infinity, если даты нет.
   * @param {string|null} isoString
   * @returns {number}
   */
  function getDaysUntil(isoString) {
    if (!isoString) { return Infinity; }
    var target = new Date(isoString);
    if (isNaN(target.getTime())) { return Infinity; }
    var now = new Date();
    now.setHours(0, 0, 0, 0);
    target.setHours(0, 0, 0, 0);
    return Math.round((target.getTime() - now.getTime()) / 86400000);
  }

  /**
   * Цвета бейджа категории.
   * @param {string} category
   * @returns {{bg: string, fg: string}}
   */
  function getCategoryColor(category) {
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].name === category) {
        return { bg: CATEGORIES[i].bg, fg: CATEGORIES[i].fg };
      }
    }
    return { bg: '#E2E8F0', fg: '#475569' };
  }

  /**
   * Статус документа (вычисляется на лету, пороги фиксированы ТЗ: 30 / 7).
   * @param {string|null} expiryDate
   * @param {number} [reminderDays] — используется только для баннера, не для статуса
   * @returns {{status: string, color: string, text: string, tone: string}}
   */
  function getStatus(expiryDate, reminderDays) {
    if (!expiryDate) {
      return { status: 'active', tone: 'ok', color: 'var(--color-success)', text: 'Активен' };
    }
    var days = getDaysUntil(expiryDate);

    if (days < 0) {
      return { status: 'expired', tone: 'danger', color: 'var(--color-error)', text: 'Просрочен' };
    }
    if (days <= URGENT_DAYS) {
      return { status: 'expiring', tone: 'urgent', color: 'var(--color-error)', text: 'Истекает' };
    }
    if (days <= 30) {
      return { status: 'expiring', tone: 'warn', color: 'var(--color-warning)', text: 'Истекает скоро' };
    }
    return { status: 'active', tone: 'ok', color: 'var(--color-success)', text: 'Активен' };
  }

  /** CSS-класс индикатора дней по близости истечения */
  function daysIndicatorClass(days) {
    if (days <= URGENT_DAYS) { return 'days-indicator days-indicator--danger'; }
    if (days <= 30) { return 'days-indicator days-indicator--warn'; }
    return 'days-indicator days-indicator--ok';
  }

  /** Склонение слова «день» */
  function dayWord(n) {
    var abs = Math.abs(n) % 100;
    if (abs >= 11 && abs <= 14) { return 'дней'; }
    abs = abs % 10;
    if (abs === 1) { return 'день'; }
    if (abs >= 2 && abs <= 4) { return 'дня'; }
    return 'дней';
  }

  /**
   * Эффективный порог напоминания.
   * 0 («Не напоминать») → Infinity: документ никогда не попадает в баннер.
   * Не задано → 30 по умолчанию.
   * @param {Object} doc
   * @returns {number}
   */
  function reminderFor(doc) {
    var v = Number(doc.reminderDays);
    if (v === 0) { return Infinity; }
    if (!v || isNaN(v)) { return DEFAULT_REMINDER; }
    return v;
  }

  /* ================================================================
     4. РАБОТА С ДАННЫМИ
     ================================================================ */

  /** Читает документы в кэш состояния */
  function loadData() {
    return DB.getAll(STORE).then(function (rows) {
      documents = rows || [];
    });
  }

  /** Документ по id из кэша */
  function findDoc(id) {
    for (var i = 0; i < documents.length; i++) {
      if (documents[i].id === id) { return documents[i]; }
    }
    return null;
  }

  /**
   * Документы, истекающие в пределах reminderDays (и строго в будущем).
   * @param {number} [days=30] — верхняя граница, если у документа напоминание не задано
   * @returns {Array<{doc: Object, days: number}>}
   */
  function getExpiringSoon(days) {
    var cap = typeof days === 'number' && days > 0 ? days : DEFAULT_REMINDER;
    var result = [];
    for (var i = 0; i < documents.length; i++) {
      var doc = documents[i];
      if (!doc.expiryDate) { continue; }
      var d = getDaysUntil(doc.expiryDate);
      // d === 0 (истекает сегодня) обязан попадать в список: getStatus
      // относит его к «expiring», а раньше он выпадал и из этого списка,
      // и из getExpired (d < 0) — предупреждение не показывалось вовсе.
      if (d < 0) { continue; }
      var threshold = reminderFor(doc) || cap;
      if (threshold > 0 && d <= threshold) {
        result.push({ doc: doc, days: d });
      }
    }
    result.sort(function (a, b) { return a.days - b.days; });
    return result;
  }

  /** Просроченные документы (дата окончания в прошлом) */
  function getExpired() {
    var result = [];
    for (var i = 0; i < documents.length; i++) {
      var doc = documents[i];
      if (!doc.expiryDate) { continue; }
      var d = getDaysUntil(doc.expiryDate);
      if (d < 0) { result.push({ doc: doc, days: d }); }
    }
    result.sort(function (a, b) { return a.days - b.days; });
    return result;
  }

  /**
   * Список с учётом фильтра и сортировки.
   * Сортировка: истекающие скоро — сверху, далее по expiryDate asc,
   * документы без срока — в конце по алфавиту.
   * @returns {Array<Object>}
   */
  function visibleDocuments() {
    var list = documents.slice();

    if (window.FamilyUI) {
      list = list.filter(function (d) { return !window.FamilyUI.isHidden(d); });
    }

    if (activeFilter !== 'all') {
      list = list.filter(function (d) {
        return getStatus(d.expiryDate, d.reminderDays).status === activeFilter;
      });
    }

    if (window.FamilyUI) {
      list = window.FamilyUI.applyScopeFilter(list);
    }

    list.sort(function (a, b) {
      var da = a.expiryDate ? getDaysUntil(a.expiryDate) : Infinity;
      var db = b.expiryDate ? getDaysUntil(b.expiryDate) : Infinity;
      if (da !== db) { return da - db; }
      return String(a.name).localeCompare(String(b.name), 'ru');
    });

    return list;
  }

  /* ================================================================
     5. РЕНДЕР
     ================================================================ */

  /** Skeleton */
  function skeletonHtml() {
    var cards = '';
    for (var i = 0; i < 3; i++) {
      cards +=
        '<div class="card">' +
          '<div class="flex items-center gap-3">' +
            '<div class="flex flex-col gap-2" style="flex: 1;">' +
              '<div class="skeleton skeleton--text" style="width: ' + (48 + i * 10) + '%;"></div>' +
              '<div class="skeleton skeleton--text" style="width: 32%;"></div>' +
            '</div>' +
            '<div class="skeleton skeleton--text" style="width: 24%; height: 26px; border-radius: var(--radius-full);"></div>' +
          '</div>' +
        '</div>';
    }

    return '<div class="header-actions">' +
        '<h1 class="page-header">Документы</h1>' +
        '<div class="skeleton" style="width: 48px; height: 48px; border-radius: var(--radius-full);"></div>' +
      '</div>' +
      '<div class="flex flex-col gap-3">' + cards + '</div>';
  }

  /** Empty state раздела */
  function emptyHtml() {
    return '<section class="empty-state">' +
      '<div class="empty-state__icon" aria-hidden="true">\uD83D\uDCC4</div>' +
      '<h2 class="empty-state__title">Пока нет документов</h2>' +
      '<p class="empty-state__text">Добавь паспорт, страховку или договор — приложение напомнит, когда подходит срок.</p>' +
      '<button type="button" class="btn btn--primary" data-doc-action="add">Добавить документ</button>' +
      '</section>';
  }

  /** Пусто по фильтру */
  function noResultsHtml() {
    return '<section class="empty-state">' +
      '<div class="empty-state__icon" aria-hidden="true">\uD83D\uDD0D</div>' +
      '<h2 class="empty-state__title">Ничего не найдено</h2>' +
      '<p class="empty-state__text">В этом фильтре нет документов.</p>' +
      '<button type="button" class="btn btn--secondary" data-doc-action="filter-all">Показать все</button>' +
      '</section>';
  }

  /** Ошибка загрузки */
  function errorHtml(message) {
    return '<div class="header-actions"><h1 class="page-header">Документы</h1></div>' +
      '<section class="empty-state">' +
        '<div class="empty-state__icon" aria-hidden="true">\u26A0\uFE0F</div>' +
        '<h2 class="empty-state__title">Не удалось загрузить</h2>' +
        '<p class="empty-state__text">' + esc(message) + '</p>' +
        '<button type="button" class="btn btn--primary" data-doc-action="retry">Попробовать снова</button>' +
      '</section>';
  }

  /** Блок предупреждений: истекающие + просроченные */
  function warningsHtml() {
    var soon = getExpiringSoon();
    var expired = getExpired();

    if (soon.length === 0 && expired.length === 0) { return ''; }

    var rows = '';

    for (var i = 0; i < expired.length; i++) {
      var e = expired[i];
      var overdueDays = Math.abs(e.days);
      rows +=
        '<div class="warning-banner warning-banner--expired">' +
          '<span class="warning-banner__icon">' + ICON_ALERT + '</span>' +
          '<div class="warning-banner__text">' +
            'Просрочен срок действия: <strong>' + esc(e.doc.name) + '</strong> ' +
            '(' + overdueDays + ' ' + dayWord(overdueDays) + ' назад)' +
          '</div>' +
        '</div>';
    }

    for (var j = 0; j < soon.length; j++) {
      var s = soon[j];
      var when = s.days === 0 ? 'сегодня' : 'через ' + s.days + ' ' + dayWord(s.days);
      rows +=
        '<div class="warning-banner warning-banner--expiring">' +
          '<span class="warning-banner__icon">' + ICON_CLOCK + '</span>' +
          '<div class="warning-banner__text">' +
            'Скоро истекает срок действия: <strong>' + esc(s.doc.name) + '</strong> ' +
            '(' + when + ')' +
          '</div>' +
        '</div>';
    }

    return '<div class="warning-banner-stack">' + rows + '</div>';
  }

  /** Ряд чипов фильтра */
  function filtersHtml() {
    var defs = [
      { value: 'all',      label: 'Все' },
      { value: 'active',   label: 'Активные' },
      { value: 'expiring', label: 'Истекают скоро' },
      { value: 'expired',  label: 'Просрочены' }
    ];

    var chips = defs.map(function (f) {
      var active = activeFilter === f.value;
      return '<button type="button" class="chip' + (active ? ' chip--active' : '') + '" ' +
        'data-doc-filter="' + f.value + '" aria-pressed="' + active + '">' + f.label + '</button>';
    }).join('');

    var scopeChips = window.FamilyUI ? window.FamilyUI.scopeChips('data-scope-filter') : '';

    return '<div class="filter-row">' + chips + scopeChips + '</div>';
  }

  /**
   * HTML карточки документа.
   * @param {Object} doc
   * @returns {string}
   */
  function documentCardHtml(doc) {
    var cat = getCategoryColor(doc.category);
    var status = getStatus(doc.expiryDate, doc.reminderDays);
    var days = getDaysUntil(doc.expiryDate);

    // Индикатор даты окончания с цветом по близости истечения
    var expiryHtml;
    if (doc.expiryDate) {
      var toneCls = daysIndicatorClass(days);
      var note = days < 0
        ? 'просрочен на ' + Math.abs(days) + ' ' + dayWord(days)
        : (days === 0 ? 'истекает сегодня' : 'осталось ' + days + ' ' + dayWord(days));
      expiryHtml =
        '<span class="' + toneCls + '">' +
          formatDate(doc.expiryDate) +
          ' <span class="' + toneCls + '__note">· ' + note + '</span>' +
        '</span>';
    } else {
      expiryHtml = '<span class="days-indicator days-indicator--none">\u2014 бессрочно</span>';
    }

    var issuedHtml = doc.issuedDate
      ? '<span class="document-card__issued">Выдан: ' + formatDate(doc.issuedDate) + '</span>'
      : '';

    return '' +
    '<article class="card document-card" data-id="' + doc.id + '" tabindex="0" role="button" ' +
      'aria-label="' + esc(doc.name) + '. ' + esc(status.text) + '. Нажми, чтобы открыть.">' +

      '<div class="document-card__top">' +
        '<div class="document-card__info" style="min-width: 0;">' +
          '<h3 class="document-card__name">' + esc(doc.name) + '</h3>' +
          '<div class="document-card__meta">' +
            '<span class="badge" style="background: ' + cat.bg + '; color: ' + cat.fg +
              '; --badge-fg: ' + cat.fg + ';">' +
              esc(doc.category) + '</span>' +
            (window.FamilyUI ? window.FamilyUI.badgeHtml(doc) : '') +
            issuedHtml +
          '</div>' +
        '</div>' +
        '<span class="status-badge status-badge--' + status.status +
          ' status-badge--' + status.tone + '">' + esc(status.text) + '</span>' +
      '</div>' +

      '<div class="document-card__expiry-row">' + expiryHtml + '</div>' +

      '<div class="document-card__actions">' +
        '<button type="button" class="icon-btn" data-doc-action="edit" data-id="' + doc.id + '" ' +
          'aria-label="Редактировать «' + esc(doc.name) + '»">' + ICON_EDIT + '</button>' +
        '<button type="button" class="icon-btn" data-doc-action="delete" data-id="' + doc.id + '" ' +
          'aria-label="Удалить «' + esc(doc.name) + '»">' + ICON_TRASH + '</button>' +
      '</div>' +
    '</article>';
  }

  /** Разрисовывает список */
  function paint() {
    var el = appEl();
    if (!el) { return; }

    var list = visibleDocuments();
    var body;

    if (documents.length === 0) {
      body = emptyHtml();
    } else if (list.length === 0) {
      body = noResultsHtml();
    } else {
      body = '<div class="flex flex-col gap-3">' +
        list.map(documentCardHtml).join('') +
      '</div>';
    }

    var warrantiesHtml = (window.ValuePack && window.ValuePack.renderWarrantiesSectionHtml)
      ? window.ValuePack.renderWarrantiesSectionHtml()
      : '';

    el.innerHTML = '<div class="header-actions">' +
        '<h1 class="page-header">Документы</h1>' +
        '<button type="button" class="btn btn--primary btn--icon" data-doc-action="add" aria-label="Добавить документ">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
        '</button>' +
      '</div>' +
      warningsHtml() +
      (documents.length > 0 ? filtersHtml() : '') +
      body +
      warrantiesHtml;
  }

  /** Точка входа рендера: skeleton → данные → контент */
  function render() {
    var el = appEl();
    if (!el) { return; }

    init();

    if (documents.length > 0) {
      paint();
      return;
    }

    if (loading) { return; }
    loading = true;
    el.innerHTML = skeletonHtml();

    loadData().then(function () {
      loading = false;
      paint();
    }).catch(function (err) {
      loading = false;
      console.error('[Documents] Ошибка загрузки:', err);
      el.innerHTML = errorHtml(err.message);
    });
  }

  /** Сброс кэша — роутер вызывает при входе в раздел */
  function invalidate() {
    documents = [];
    loading = false;
    activeFilter = 'all';
    editingId = null;
  }

  /* ================================================================
     6. МОДАЛЬНОЕ ОКНО (паттерн payments.js / meters.js)
     ================================================================ */

  /**
   * Открывает overlay с карточкой.
   * @param {string} innerHtml
   * @param {function(HTMLElement, function(): void): void} onMount
   */
  function openModal(innerHtml, onMount) {
    // Защита от «стопки» одинаковых диалогов (Этап 11, баг №6): быстрый
    // повторный клик по той же кнопке открывал несколько идентичных окон,
    // и закрытие одного оставляло висеть остальные. Диалог с тем же
    // содержимым, который уже открыт, повторно не открываем.
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
      if (e.key !== 'Escape') { return; }
      var list = document.querySelectorAll('.modal-overlay');
      if (list.length && list[list.length - 1] !== overlay) { return; }
      close();
    };
    document.addEventListener('keydown', overlay._onKeydown);

    if (onMount) { onMount(card, close); }
  }

  /** Плавно закрывает overlay */
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
     7. ФОРМА ДОКУМЕНТА
     ================================================================ */

  /** Разметка select категорий */
  function categoryOptions(selected) {
    return CATEGORIES.map(function (c) {
      return '<option value="' + esc(c.name) + '"' + (c.name === selected ? ' selected' : '') + '>' +
        esc(c.name) + '</option>';
    }).join('');
  }

  /** Разметка select напоминаний */
  function reminderOptions(selected) {
    return REMINDER_OPTIONS.map(function (r) {
      return '<option value="' + r.value + '"' + (r.value === selected ? ' selected' : '') + '>' +
        esc(r.label) + '</option>';
    }).join('');
  }

  /**
   * Разметка формы добавления/редактирования.
   * @param {Object|null} doc — null при создании
   * @returns {string}
   */
  function formHtml(doc) {
    var isNew = !doc;
    var reminder = isNew ? DEFAULT_REMINDER : reminderFor(doc);

    return '' +
      '<h2 class="modal-content__title">' + (isNew ? 'Новый документ' : 'Редактировать документ') + '</h2>' +

      '<div class="doc-status-display mb-4" id="status-box"></div>' +

      '<form id="doc-form" novalidate>' +
        '<div class="form-group">' +
          '<label class="form-label" for="f-name">Название</label>' +
          '<input class="form-input" id="f-name" name="name" type="text" maxlength="100" ' +
            'autocomplete="off" placeholder="Паспорт РФ" value="' + esc(isNew ? '' : doc.name) + '">' +
          '<div class="form-error" id="e-name"></div>' +
        '</div>' +

        '<div class="form-group">' +
          '<label class="form-label" for="f-category">Категория</label>' +
          '<select class="form-select" id="f-category" name="category">' +
            categoryOptions(isNew ? CATEGORIES[0].name : doc.category) + '</select>' +
        '</div>' +

        '<div class="form-group">' +
          '<label class="form-label" for="f-issued">Дата выдачи</label>' +
          '<input class="form-input" id="f-issued" name="issuedDate" type="date" ' +
            'value="' + esc(isNew ? '' : (doc.issuedDate || '')) + '">' +
          '<div class="form-error" id="e-issuedDate"></div>' +
        '</div>' +

        '<div class="form-group">' +
          '<label class="form-label" for="f-expiry">Дата окончания действия</label>' +
          '<input class="form-input" id="f-expiry" name="expiryDate" type="date" ' +
            'value="' + esc(isNew ? '' : (doc.expiryDate || '')) + '">' +
          '<div class="form-error" id="e-expiryDate"></div>' +
        '</div>' +

        '<div class="form-group">' +
          '<label class="form-label" for="f-reminder">Напоминание за</label>' +
          '<select class="form-select" id="f-reminder" name="reminderDays">' +
            reminderOptions(reminder) + '</select>' +
        '</div>' +

        /* Доступ (Этап 12.7) */
        (window.FamilyUI ? window.FamilyUI.scopeFieldHtml(isNew ? '' : doc.familyScope) : '') +

        '<div class="form-error" id="e-save" role="alert"></div>' +

        '<div class="flex gap-3 mt-4">' +
          '<button type="button" class="btn btn--secondary" style="flex: 1;" data-action="cancel">Отмена</button>' +
          '<button type="submit" class="btn btn--primary" style="flex: 1;">Сохранить</button>' +
        '</div>' +
      '</form>';
  }

  /**
   * Живое отображение авто-статуса в форме.
   * @param {HTMLElement} card
   */
  function refreshStatusDisplay(card) {
    var box = card.querySelector('#status-box');
    var expiry = card.querySelector('[name="expiryDate"]').value;
    var status = getStatus(expiry || null, DEFAULT_REMINDER);
    box.innerHTML = 'Статус: <strong style="color: ' + status.color + ';">' +
      esc(status.text) + '</strong>';
    box.className = 'doc-status-display doc-status-display--' + status.status + ' mb-4';
  }

  /** Открыть форму добавления */
  function openAddForm() {
    editingId = null;
    openModal(formHtml(null), function (card, close) {
      bindForm(card, close);
      refreshStatusDisplay(card);
    });
  }

  /** Открыть форму редактирования */
  function openEditForm(id) {
    var doc = findDoc(id);
    if (!doc) {
      console.warn('[Documents] Документ не найден:', id);
      return;
    }
    editingId = id;
    openModal(formHtml(doc), function (card, close) {
      bindForm(card, close);
      refreshStatusDisplay(card);
    });
  }

  /** Привязка обработчиков формы */
  function bindForm(card, close) {
    function clearError(name) {
      var input = card.querySelector('[name="' + name + '"]');
      if (input) { input.classList.remove('is-invalid'); }
      var errBox = card.querySelector('#e-' + name);
      if (errBox) { errBox.textContent = ''; }
    }

    ['name', 'issuedDate', 'expiryDate'].forEach(function (n) {
      var input = card.querySelector('[name="' + n + '"]');
      input.addEventListener('input', function () { clearError(n); });
      input.addEventListener('change', function () { clearError(n); });
    });

    // Авто-статус реагирует на даты и напоминание
    card.querySelector('[name="expiryDate"]').addEventListener('change', function () {
      refreshStatusDisplay(card);
    });

    card.querySelector('[data-action="cancel"]').addEventListener('click', close);

    card.querySelector('#doc-form').addEventListener('submit', function (e) {
      e.preventDefault();
      save(card, close);
    });

    setTimeout(function () {
      card.querySelector('#f-name').focus();
    }, 260);
  }

  /**
   * Валидирует и собирает данные формы.
   * @param {HTMLElement} card
   * @returns {Object|null}
   */
  function readForm(card) {
    var ok = true;

    function fail(name, message) {
      var input = card.querySelector('[name="' + name + '"]');
      if (input) { input.classList.add('is-invalid'); }
      card.querySelector('#e-' + name).textContent = message;
      ok = false;
    }

    var name = card.querySelector('[name="name"]').value.trim();
    var category = card.querySelector('[name="category"]').value;
    var issuedDate = card.querySelector('[name="issuedDate"]').value;
    var expiryDate = card.querySelector('[name="expiryDate"]').value;
    var reminderDays = Number(card.querySelector('[name="reminderDays"]').value);

    if (!name) {
      fail('name', 'Укажи название документа');
    } else if (name.length > 100) {
      fail('name', 'Не длиннее 100 символов');
    }

    if (issuedDate && isNaN(new Date(issuedDate).getTime())) {
      fail('issuedDate', 'Некорректная дата выдачи');
    }

    if (expiryDate) {
      if (isNaN(new Date(expiryDate).getTime())) {
        fail('expiryDate', 'Некорректная дата окончания');
      } else if (issuedDate && expiryDate < issuedDate) {
        fail('expiryDate', 'Дата окончания не может быть раньше даты выдачи');
      }
    }

    if (reminderDays === 0) { reminderDays = 0; }
    else if (!reminderDays || isNaN(reminderDays)) { reminderDays = DEFAULT_REMINDER; }

    if (!ok) { return null; }

    var out = {
      name: name,
      category: category,
      issuedDate: issuedDate || undefined,
      expiryDate: expiryDate || undefined,
      reminderDays: reminderDays
    };

    var scope = window.FamilyUI ? window.FamilyUI.readScope(card) : null;
    if (scope) {
      out.familyScope = scope;
      out.familyScoped = (scope === 'family');
    }

    return out;
  }

  /**
   * Сохраняет документ (создание или обновление).
   * @param {HTMLElement} card
   * @param {function(): void} close
   */
  function save(card, close) {
    var data = readForm(card);
    if (!data) { return; }

    if (window.Family && window.Family.stampScope) {
      window.Family.stampScope(data, STORE, Boolean(editingId));
    }

    var op = editingId
      ? DB.update(STORE, editingId, data)
      : DB.add(STORE, data);

    op.then(function () {
      close();
      return loadData();
    }).then(function () {
      paint();
    }).catch(function (err) {
      console.error('[Documents] Ошибка сохранения:', err);
      card.querySelector('#e-save').textContent = 'Не удалось сохранить: ' + err.message;
    });
  }

  /* ================================================================
     8. УДАЛЕНИЕ С ПОДТВЕРЖДЕНИЕМ
     ================================================================ */

  /**
   * Диалог подтверждения удаления документа.
   * @param {number} id
   */
  function removeDoc(id) {
    var doc = findDoc(id);
    if (!doc) { return; }

    var html = '' +
      '<h2 class="modal-content__title">Удалить документ?</h2>' +
      '<p class="modal-content__text">«' + esc(doc.name) + '» будет удалён без возможности восстановления.</p>' +
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
          return loadData();
        }).then(function () {
          paint();
        }).catch(function (err) {
          btn.disabled = false;
          console.error('[Documents] Ошибка удаления:', err);
          card.querySelector('#e-delete').textContent = 'Не удалось удалить: ' + err.message;
        });
      });
    });
  }

  /* ================================================================
     9. ДЕЛЕГИРОВАНИЕ СОБЫТИЙ
     ================================================================ */

  /** Единый обработчик кликов по #app */
  function onAppClick(e) {
    var scopeChip = e.target.closest('[data-scope-filter]');
    if (scopeChip && window.FamilyUI) {
      window.FamilyUI.setScopeFilter(scopeChip.getAttribute('data-scope-filter'));
      paint();
      return;
    }

    // Фильтр-чипы (атрибут data-doc-filter, не data-filter как в payments.js)
    var chip = e.target.closest('[data-doc-filter]');
    if (chip) {
      activeFilter = chip.getAttribute('data-doc-filter');
      paint();
      return;
    }

    var warrantyBtn = e.target.closest('[data-warranty-action]');
    if (warrantyBtn && window.ValuePack) {
      var wAction = warrantyBtn.getAttribute('data-warranty-action');
      var wId = warrantyBtn.getAttribute('data-id');
      if (wAction === 'add') {
        window.ValuePack.openAddWarrantyModal(function () { paint(); });
      } else if (wAction === 'delete' && wId) {
        window.ValuePack.removeWarranty(wId).then(function () { paint(); });
      }
      return;
    }

    var actionEl = e.target.closest('[data-doc-action]');
    if (actionEl) {
      var action = actionEl.getAttribute('data-doc-action');
      var id = actionEl.hasAttribute('data-id') ? Number(actionEl.getAttribute('data-id')) : null;

      switch (action) {
        case 'add':        openAddForm(); return;
        case 'edit':       openEditForm(id); return;
        case 'delete':     removeDoc(id); return;
        case 'filter-all': activeFilter = 'all'; paint(); return;
        case 'retry':
          loading = false;
          invalidate();
          render();
          return;
      }
      return;
    }

    // Клик по карточке мимо кнопок — редактирование
    var card = e.target.closest('.document-card');
    if (card) {
      openEditForm(Number(card.getAttribute('data-id')));
    }
  }

  /** Enter/Space на карточке — открыть редактирование */
  function onAppKeydown(e) {
    if (e.key !== 'Enter' && e.key !== ' ') { return; }
    if (!e.target.closest) { return; }

    var card = e.target.closest('.document-card');
    if (!card || card.contains(e.target.closest('button'))) { return; }

    e.preventDefault();
    openEditForm(Number(card.getAttribute('data-id')));
  }

  /* ================================================================
     10. ИНИЦИАЛИЗАЦИЯ И ПУБЛИЧНЫЙ API
     ================================================================ */

  /** Привязывает делегаты к #app (идемпотентно) */
  function init() {
    if (listenersBound) { return; }

    var el = appEl();
    if (!el) { return; }

    el.addEventListener('click', onAppClick);
    el.addEventListener('keydown', onAppKeydown);

    listenersBound = true;
    console.info('[Documents] Делегаты событий привязаны.');
  }

  window.Documents = {
    init: init,
    render: render,
    invalidate: invalidate,
    openAddForm: openAddForm,
    openEditForm: openEditForm,
    save: save,
    delete: removeDoc,
    getExpiringSoon: getExpiringSoon,

    // Утилиты форматирования для внешнего использования
    formatDate: formatDate,
    getDaysUntil: getDaysUntil,
    getStatus: getStatus,
    getCategoryColor: getCategoryColor,
    CATEGORIES: CATEGORIES
  };

  console.info('[Documents] Модуль загружен. API: window.Documents');
})();
