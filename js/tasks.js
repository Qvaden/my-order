/**
 * МОЙ ПОРЯДОК — Раздел «Мои дела» (Этап 7)
 *
 * Управление задачами: приоритеты, даты, время, повторение,
 * кастомные чекбоксы с анимацией, фильтры, сортировка.
 *
 * Хранилище DB: 'tasks'.
 * Все операции только через window.DB. Никаких внешних зависимостей.
 * Атрибуты делегирования изолированы префиксом data-task-* для избежания
 * коллизий с другими модулями (#app кликается всеми модулями).
 *
 * Экспортирует window.Tasks.
 */

(function () {
  'use strict';

  /* ================================================================
     1. КОНСТАНТЫ
     ================================================================ */

  /** @const {string} Хранилище задач в IndexedDB */
  var STORE = 'tasks';

  /**
   * Приоритеты и их визуальные свойства.
   * @const {Array<{value: string, label: string, bg: string, fg: string}>}
   */
  var PRIORITIES = [
    { value: 'high',      label: 'Высокий',    bg: '#FEE2E2', fg: '#B91C1C' },
    { value: 'medium',    label: 'Средний',    bg: '#FEF3C7', fg: '#A16207' },
    { value: 'low',       label: 'Низкий',     bg: '#E2E8F0', fg: '#475569' }
  ];

  /** Варианты повторяемости */
  var RECURRING_OPTIONS = [
    { value: 'none',      label: 'Не повторять' },
    { value: 'daily',     label: 'Ежедневно' },
    { value: 'weekly',    label: 'Еженедельно' },
    { value: 'monthly',   label: 'Ежемесячно' }
  ];

  /** Порядок при сортировке по приоритету (убывание важности) */
  var PRIORITY_ORDER = { high: 3, medium: 2, low: 1 };

  /** SVG-иконки */
  var ICON_TRASH =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

  var ICON_EDIT =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/> ' +
    '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';

  var ICON_REPEAT =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/> ' +
    '<polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';

  var ICON_ALERT =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

  var ICON_CLOCK =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

  /* ================================================================
     2. СОСТОЯНИЕ МОДУЛЯ
     ================================================================ */

  /** @type {Array<Object>} Кэш всех задач */
  var tasks = [];

  /** @type {boolean} Первая загрузка (показан skeleton) */
  var loading = false;

  /** @type {boolean} Привязаны ли делегаты */
  var listenersBound = false;

  /** @type {string} Текущий фильтр */
  var activeFilter = 'all'; // all | today | overdue | completed | archived

  /** ID редактируемой задачи (null = создание новой) */
  var editingId = null;

  function appEl() { return document.getElementById('app'); }

  /* ================================================================
     3. УТИЛИТЫ ДАТ И ФОРМАТИРОВАНИЯ
     ================================================================ */

  function esc(text) {
    if (text === null || text === undefined) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Безопасное форматирование текста (жирный, курсив, зачёркнутый, маркер, цвета) */
  function renderRichText(raw) {
    if (!raw) return '';
    var safe = esc(raw);

    // 1. Жирный: **текст**
    safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // 2. Курсив: *текст*
    safe = safe.replace(/\*([^\*]+?)\*/g, '<em>$1</em>');

    // 3. Зачёркнутый: ~~текст~~
    safe = safe.replace(/~~(.+?)~~/g, '<del class="task-del">$1</del>');

    // 4. Маркер: ==текст==
    safe = safe.replace(/==(.+?)==/g, '<mark class="task-mark">$1</mark>');

    // 5. Цветной текст: {color:red}текст{/color}
    safe = safe.replace(/\{color:(red|green|blue|orange|purple)\}(.+?)\{\/color\}/gi, function (_, c, t) {
      return '<span class="task-color task-color--' + c.toLowerCase() + '">' + t + '</span>';
    });

    // 6. Фон/бейдж: {bg:yellow}текст{/bg}
    safe = safe.replace(/\{bg:(yellow|green|blue|pink|purple)\}(.+?)\{\/bg\}/gi, function (_, b, t) {
      return '<span class="task-badge-hl task-badge-hl--' + b.toLowerCase() + '">' + t + '</span>';
    });

    return safe;
  }

  /** ISO дата → ДД.ММ.ГГГГ или "—" */
  function formatDate(iso) {
    if (!iso) return '\u2014';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '\u2014';
    return String(d.getDate()).padStart(2, '0') + '.' +
           String(d.getMonth() + 1).padStart(2, '0') + '.' +
           d.getFullYear();
  }

  /** Время HH:MM из ISO или time-value → "HH:MM" или "—" */
  function formatTime(v) {
    if (!v) return '';
    var s = v.substring(0, 5);
    return s !== '00:00' ? s : '';
  }

  /** Сегодня YYYY-MM-DD */
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  /**
   * Разбирает 'YYYY-MM-DD' (или ISO-строку) в локальную Date.
   * new Date('2026-11-09') парсится как UTC и в западных TZ сдвигает день,
   * поэтому дата без времени трактуется как локальная полночь явно.
   * @param {string} iso
   * @returns {Date|null}
   */
  function parseDate(iso) {
    if (!iso) { return null; }
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    if (m) {
      var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return isNaN(d.getTime()) ? null : d;
    }
    var dt = new Date(iso);
    return isNaN(dt.getTime()) ? null : dt;
  }

  /** Целое число дней от сегодня до даты (отрицательный если в прошлом). Infinity если нет даты. */
  function getDaysUntil(isoDate) {
    var target = parseDate(isoDate);
    if (!target) return Infinity;
    target.setHours(0, 0, 0, 0);
    var now = new Date();
    now.setHours(0, 0, 0, 0);
    return Math.round((target - now) / 86400000);
  }

    /** Цвет бейджа приоритета */
  function getPriorityColor(value) {
    for (var i = 0; i < PRIORITIES.length; i++) {
      if (PRIORITIES[i].value === value) return { bg: PRIORITIES[i].bg, fg: PRIORITIES[i].fg };
    }
    return { bg: '#E2E8F0', fg: '#475569' };
  }

  /** Подпись приоритета */
  function getPriorityLabel(value) {
    for (var i = 0; i < PRIORITIES.length; i++) {
      if (PRIORITIES[i].value === value) return PRIORITIES[i].label;
    }
    return value || 'Средний';
  }

  /** Подпись повторяемости */
  function getRecurringLabel(value) {
    for (var i = 0; i < RECURRING_OPTIONS.length; i++) {
      if (RECURRING_OPTIONS[i].value === value) return RECURRING_OPTIONS[i].label;
    }
    return value || 'Нет';
  }

  /** Текст метки даты для UI с учётом времени */
  function dueText(task) {
    if (!task.dueDate && !task.dueTime) return '\u2014';
    var parts = [formatDate(task.dueDate)];
    var t = task.dueTime ? formatTime(task.dueTime) : '';
    if (t) parts.push(t);
    return parts.join('\u00A0'); // non-breaking space для компактности
  }

  /** Цвет текстового индикатора даты по близости (для невыполненных задач) */
  function dueDayClass(task) {
    if (!task.dueDate) return 'due-day--future';
    var days = getDaysUntil(task.dueDate);
    if (days < 0) return 'due-day--overdue';
    if (days === 0) return 'due-day--today';
    return 'due-day--future';
  }

  /* ================================================================
     4. ФИЗИЧЕСКАЯ ЛОГИКА РАБОТЫ С ДАННЫМИ
     ================================================================ */

  function loadData() {
    return DB.getAll(STORE).then(function (rows) {
      tasks = rows || [];
    });
  }

  function findTask(id) {
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].id === id) return tasks[i];
    }
    return null;
  }

  /** Проверка на просроченность: не выполнена и дата в прошлом */
  function isOverdue(task) {
    if (task.completed || !task.dueDate) return false;
    return getDaysUntil(task.dueDate) < 0;
  }

  /** Проверка: задача на сегодня */
  function isToday(task) {
    if (!task.dueDate) return false;
    return getDaysUntil(task.dueDate) === 0;
  }

  /** Просроченные невыполненные задачи */
  function overdueTasks() {
    var out = [];
    for (var i = 0; i < tasks.length; i++) {
      if (isOverdue(tasks[i])) out.push(tasks[i]);
    }
    return out;
  }

  /** Невыполненные задачи на сегодня */
  function todayTasks() {
    var out = [];
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (!t.completed && isToday(t)) out.push(t);
    }
    return out;
  }

  /** Выполненные задачи */
  function completedTasks() {
    var out = [];
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].completed) out.push(tasks[i]);
    }
    return out;
  }

  /** Получить следующую дату для повторяющейся задачи */
  function nextDueDate(parentDate, recurring) {
    if (!parentDate) return null;
    var d = new Date(parentDate + 'T00:00:00');
    switch (recurring) {
      case 'daily':   d.setDate(d.getDate() + 1); break;
      case 'weekly':  d.setDate(d.getDate() + 7); break;
      case 'monthly': d.setMonth(d.getMonth() + 1); break;
    }
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  /** Создать следующую копию задачи, избегая дубликатов */
  function createNextIfRecurring(currentTask) {
    if (!currentTask.recurring || currentTask.recurring === 'none') return Promise.resolve();

    var nextDate = nextDueDate(currentTask.dueDate, currentTask.recurring);
    if (!nextDate) return Promise.resolve();

    // Не создавать новую задачу, если уже есть незавершённая копия с той же датой
    var dupExists = false;
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (!t.completed && t.dueDate === nextDate && t.title === currentTask.title && t.parentTaskId) {
        dupExists = true;
        break;
      }
    }
    if (dupExists) return Promise.resolve();

    return DB.add(STORE, {
      title: currentTask.title,
      description: currentTask.description || '',
      dueDate: nextDate,
      dueTime: currentTask.dueTime || null,
      priority: currentTask.priority || 'medium',
      recurring: currentTask.recurring,
      isTemplate: false,
      parentTaskId: currentTask.id,
      completed: false,
      completedAt: null
    }).catch(function (err) {
      console.warn('[Tasks] Не удалось создать следующее повторение:', err.message);
    });
  }

  /* ================================================================
     5. РЕНДЕР
     ================================================================ */

  /* Skeleton */
  function skeletonHtml() {
    var cards = '';
    for (var i = 0; i < 3; i++) {
      cards += '<div class="card">' +
        '<div class="flex items-center gap-3">' +
          '<div class="skeleton" style="width:48px;height:48px;border-radius:var(--radius-full);"></div>' +
          '<div class="flex flex-col gap-2" style="flex:1;">' +
            '<div class="skeleton skeleton--text" style="width:' + (50 + i * 10) + '%;"></div>' +
            '<div class="skeleton skeleton--text" style="width:60%;"></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    }
    return '<div class="header-actions">' +
      '<h1 class="page-header">Мои дела</h1>' +
      '<div class="skeleton" style="width:48px;height:48px;border-radius:var(--radius-full);"></div>' +
    '</div><div class="flex flex-col gap-3">' + cards + '</div>';
  }

  /* Empty state */
  function emptyHtml() {
    return '<section class="empty-state">' +
      '<div class="empty-state__icon" aria-hidden="true">\uD83D\uDDD3\uFE0F</div>' +
      '<h2 class="empty-state__title">Пока нет дел</h2>' +
      '<p class="empty-state__text">Добавьте первую задачу или воспользуйтесь готовыми чек-листами вверху.</p>' +
      '<div class="flex gap-2 justify-center flex-wrap">' +
        '<button type="button" class="btn btn--primary" data-task-action="add">+ Добавить дело</button>' +
      '</div>' +
    '</section>';
  }

  /* Ничего не найдено по фильтру */
  function noResultsHtml() {
    return '<section class="empty-state">' +
      '<div class="empty-state__icon" aria-hidden="true">\uD83D\uDD0D</div>' +
      '<h2 class="empty-state__title">Ничего не найдено</h2>' +
      '<p class="empty-state__text">В этой категории дел нет.</p>' +
      '<button type="button" class="btn btn--secondary" data-task-action="filter-all">Показать все</button>' +
    '</section>';
  }

  /* Ошибка загрузки */
  function errorHtml(message) {
    return '<div class="header-actions"><h1 class="page-header">Мои дела</h1></div>' +
      '<section class="empty-state">' +
        '<div class="empty-state__icon" aria-hidden="true">\u26A0\uFE0F</div>' +
        '<h2 class="empty-state__title">Не удалось загрузить</h2>' +
        '<p class="empty-state__text">' + esc(message) + '</p>' +
        '<button type="button" class="btn btn--primary" data-task-action="retry">Попробовать снова</button>' +
      '</section>';
  }

  /* Блок срочных дел */
  function urgentBannersHtml() {
    var ov = overdueTasks();
    var td = todayTasks();
    if (ov.length === 0 && td.length === 0) { return ''; }

    var html = '<div class="urgent-banner-stack">';

    if (ov.length > 0) {
      html += '<div class="warning-banner warning-banner--expired urgent-banner--overdue">' +
        '<span class="warning-banner__icon">' + ICON_ALERT + '</span>' +
        '<div class="warning-banner__text"><strong>Просрочено:</strong> ' +
          ov.length + ' ' + dayWord(ov.length) + '</div>' +
      '</div>';
    }

    if (td.length > 0) {
      html += '<div class="warning-banner warning-banner--expiring urgent-banner--today">' +
        '<span class="warning-banner__icon">' + ICON_CLOCK + '</span>' +
        '<div class="warning-banner__text"><strong>Сегодня:</strong> ' +
          td.length + ' ' + dayWord(td.length) + '</div>' +
      '</div>';
    }

    html += '</div>';
    return html;
  }

  /** Склонение слова "дело" */
  function dayWord(n) {
    var a = Math.abs(n) % 100;
    if (a >= 11 && a <= 14) return 'дел';
    a = a % 10;
    if (a === 1) return 'дело';
    if (a >= 2 && a <= 4) return 'дела';
    return 'дел';
  }

  /* Чип фильтра */
  function filterChip(activeVal, f) {
    var cls = activeVal === f.value ? ' chip chip--active' : 'chip';
    return '<button type="button" class="' + cls + '" ' +
      'data-task-filter="' + esc(f.value) + '" aria-pressed="' + (activeVal === f.value) + '">' +
      esc(f.label) + '</button>';
  }

  function taskCategoryBadgeHtml(cat) {
    if (!cat) return '';
    var colors = (window.Personalization && window.Personalization.getCategoryColors)
      ? window.Personalization.getCategoryColors(cat) : null;
    var bg = colors ? colors.bg : 'var(--color-border)';
    var fg = colors ? colors.fg : 'var(--color-text-secondary)';
    var icon = (colors && colors.icon) ? colors.icon + ' ' : '';
    return '<span class="badge" style="background:' + bg + ';color:' + fg + ';font-size:11px;padding:2px 8px;">' +
      icon + esc(cat) + '</span>';
  }

  /** Карта HTML одной задачи */
  function taskCardHtml(task) {
    var prioCls = 'priority-badge--' + (task.priority || 'medium');
    var statusCls = task.completed ? 'task-card--completed' : '';

    var dueInfo = dueText(task);
    var dueCls = 'due-day ' + (task.completed ? 'due-day--done' : dueDayClass(task));
    var repeatIcon = task.recurring && task.recurring !== 'none' ?
      '<span class="recurring-icon" title="' + esc(getRecurringLabel(task.recurring)) + '" aria-label="Повторяющаяся задача: ' + esc(getRecurringLabel(task.recurring)) + '">' + ICON_REPEAT + '</span>' : '';

    return '' +
    '<article class="card task-card ' + statusCls + '" data-id="' + task.id + '" tabindex="0" role="button" ' +
      'aria-label="' + esc(task.title) + (task.completed ? '. Выполнено' : '') + '">' +

      '<div class="task-card__top">' +
        /* span, а не label: label генерирует лишний синтетический click на input → двойной toggle */
        '<span class="task-checkbox-wrapper">' +
          '<input type="checkbox" class="task-checkbox" data-task-toggle="' + task.id + '" ' +
            (task.completed ? ' checked' : '') + ' aria-label="Отметить «' + esc(task.title) + '» выполненным">' +
          '<span class="task-checkbox__mark">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>' +
          '</span>' +
        '</span>' +

        '<div class="task-card__info">' +
          '<h3 class="task-card__title">' + renderRichText(task.title) + '</h3>' +
          (task.description ? '<p class="task-card__desc">' + renderRichText(truncate(task.description, 120)) + '</p>' : '') +
          '<div class="task-card__meta">' +
            '<span class="' + dueCls + '">' + dueInfo + '</span>' +
            (task.category ? taskCategoryBadgeHtml(task.category) : '') +
            (repeatIcon ? repeatIcon : '') +
            (window.FamilyUI ? window.FamilyUI.badgeHtml(task) : '') +
          '</div>' +
        '</div>' +

        '<div class="task-card__side">' +
          '<span class="priority-badge ' + prioCls + '">' + esc(getPriorityLabel(task.priority)) + '</span>' +
          '<div class="task-card__actions">' +
            '<button type="button" class="icon-btn" data-task-action="edit" data-id="' + task.id + '" aria-label="Редактировать дело">' +
              ICON_EDIT + '</button>' +
            '<button type="button" class="icon-btn" data-task-action="delete" data-id="' + task.id + '" aria-label="Удалить дело">' +
              ICON_TRASH + '</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function truncate(str, max) {
    if (!str) return '';
    str = String(str);
    return str.length > max ? str.slice(0, max) + '\u2026' : str;
  }

  /* Полная отрисовка контента */
  function paint() {
    var el = appEl();
    if (!el) return;

    var chips = ['Все','Сегодня','Просрочены','Выполненные','Архив'].map(function (lbl, i) {
      return filterChip(activeFilter, { value: ['all','today','overdue','completed','archived'][i], label: lbl });
    }).join('');

    /* Этап 12.7: чипы доступа (пусто вне семьи) */
    var scopeChips = window.FamilyUI ? window.FamilyUI.scopeChips('data-scope-filter') : '';

    var visible = visibleTasks();

    var body;
    if (tasks.length === 0) {
      body = emptyHtml();
    } else if (visible.length === 0) {
      body = noResultsHtml();
    } else {
      body = '<div class="flex flex-col gap-3">' + visible.map(taskCardHtml).join('') + '</div>';
    }

    el.innerHTML = '<div class="header-actions">' +
      '<h1 class="page-header">Мои дела</h1>' +
      '<div class="flex items-center gap-2">' +
        '<button type="button" class="btn btn--secondary" data-task-action="checklists" aria-label="Готовые чек-листы для дома">📋 Чек-листы</button>' +
        '<button type="button" class="btn btn--primary btn--icon" data-task-action="add" aria-label="Добавить дело">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
        '</button>' +
      '</div>' +
    '</div>' +
    (window.SmartRadar ? window.SmartRadar.barHtml() : '') +
    urgentBannersHtml() +
    (tasks.length > 0 ? '<div class="filter-row mb-3">' + chips + scopeChips + '</div>' : '') +
    (activeFilter === 'archived' ? '<button type="button" class="btn btn--ghost" style="margin-bottom:var(--space-3);" data-task-action="clear-archive">&#x267B; Очистить архив</button>' : '') +
    body;

    if (window.SmartRadar && window.SmartRadar.bindBarEvents) {
      window.SmartRadar.bindBarEvents();
    }
  }

  /* Видимые задачи с учётом фильтра и сортировки */
  function visibleTasks() {
    var list = tasks.slice();

    /* Этап 12.7: мягко удалённые по семье не показываем; чипы
       «👥 Семейные / 🔒 Личные» */
    if (window.FamilyUI) {
      list = list.filter(function (t) { return !window.FamilyUI.isHidden(t); });
      list = window.FamilyUI.applyScopeFilter(list);
    }

    switch (activeFilter) {
      case 'today':
        /* Только сегодняшние НЕвыполненные (по ТЗ) */
        list = list.filter(function (t) { return !t.completed && isToday(t); });
        break;
      case 'overdue':
        list = list.filter(isOverdue);
        break;
      case 'completed':
      case 'archived':
        list = list.filter(function (t) { return !!t.completed; });
        break;
    }

    /* Сортировка */
    list.sort(function (a, b) {
      /* 1. Невыполненные первые */
      var ac = !!a.completed, bc = !!b.completed;
      if (ac !== bc) { return ac ? 1 : -1; }
      /* 2. Просроченные первые */
      var ao = isOverdue(a), bo = isOverdue(b);
      if (ao && !bo) return -1;
      if (!ao && bo) return 1;
      /* 3. По дате asc (без даты — в конец) */
      var da = a.dueDate || '9999-12-31';
      var db = b.dueDate || '9999-12-31';
      var cmp = da.localeCompare(db);
      if (cmp !== 0) return cmp;
      /* 4. По приоритету desc */
      return (PRIORITY_ORDER[b.priority] || 0) - (PRIORITY_ORDER[a.priority] || 0);
    });

    return list;
  }

  /* Точка входа рендера */
  function render() {
    var el = appEl();
    if (!el) return;

    init();

    if (tasks.length > 0) { paint(); return; }
    if (loading) return;

    loading = true;
    el.innerHTML = skeletonHtml();

    loadData().then(function () {
      loading = false;
      paint();
    }).catch(function (err) {
      loading = false;
      console.error('[Tasks] Ошибка загрузки:', err);
      el.innerHTML = errorHtml(err.message);
    });
  }

  function invalidate() {
    tasks = [];
    loading = false;
    activeFilter = 'all';
    editingId = null;
  }

  /* ================================================================
     6. МОДАЛЬНОЕ ОКНО
     ================================================================ */

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
    card.style.maxWidth = '440px';
    card.innerHTML = innerHtml;

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.body.classList.add('modal-open');

    requestAnimationFrame(function () { overlay.classList.add('is-open'); });

    function closeFn() { closeModalOverlay(overlay); }

    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeFn(); });

    overlay._onKeydown = function (e) {
      if (e.key !== 'Escape') return;
      var list = document.querySelectorAll('.modal-overlay');
      if (list.length && list[list.length - 1] === overlay) closeFn();
    };
    document.addEventListener('keydown', overlay._onKeydown);

    if (onMount) onMount(card, closeFn);
  }

  function closeModalOverlay(overlay) {
    if (!overlay || overlay._closing) return;
    overlay._closing = true;
    document.removeEventListener('keydown', overlay._onKeydown);
    overlay.classList.remove('is-open');
    setTimeout(function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (!document.querySelector('.modal-overlay')) document.body.classList.remove('modal-open');
    }, 250);
  }

  /* ================================================================
     7. ФОРМА ЗАДАЧИ
     ================================================================ */

  function priorityOptions(sel) {
    return PRIORITIES.map(function (p) {
      return '<option value="' + p.value + '"' + (p.value === sel ? ' selected' : '') + '>' + esc(p.label) + '</option>';
    }).join('');
  }

  function recurringOptions(sel) {
    return RECURRING_OPTIONS.map(function (r) {
      return '<option value="' + r.value + '"' + (r.value === sel ? ' selected' : '') + '>' + esc(r.label) + '</option>';
    }).join('');
  }

  var TASK_EMOJIS = ['🔥', '⚡', '📌', '❗', '✅', '⏰', '📞', '🛒', '💼', '🏠', '⭐', '❤️', '💊', '💳', '🎉', '✈️', '🚗', '💡', '🎯', '🏋️', '🍕', '☕', '👶', '🐾', '📚', '💻', '🔑', '🧹', '📦', '🎁'];
  var TASK_QUICK_EMOJIS = ['🔥', '⚡', '📌', '❗', '✅', '⏰', '📞', '🛒', '💼', '⭐'];

  function formHtml(task) {
    var isNew = !task;
    var prio = isNew ? 'medium' : (task.priority || 'medium');
    var rec = isNew ? 'none' : (task.recurring || 'none');

    var descRows = task && task.description ? ' rows="3"' : ' rows="3"';

    return '' +
      '<h2 class="modal-content__title">' + (isNew ? 'Новое дело' : 'Редактировать дело') + '</h2>' +
      '<form id="task-form" novalidate>' +

        '<div class="form-group">' +
          '<label class="form-label" for="f-title">Название</label>' +
          '<input class="form-input" id="f-title" name="title" type="text" maxlength="100" ' +
            'autocomplete="off" placeholder="Позвонить врачу" ' +
            'value="' + esc(isNew ? '' : task.title) + '">' +
          '<div class="form-error" id="e-title"></div>' +
        '</div>' +

        '<div class="form-group">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
            '<label class="form-label" for="f-desc" style="margin:0;">Описание</label>' +
            '<span style="font-size:11px;color:var(--color-text-secondary);">Форматирование текста</span>' +
          '</div>' +
          '<div class="task-format-toolbar">' +
            '<div class="task-format-btns">' +
              '<button type="button" class="task-fmt-btn" data-fmt="bold" title="Жирный (**текст**)"><b>B</b></button>' +
              '<button type="button" class="task-fmt-btn" data-fmt="italic" title="Курсив (*текст*)"><i>I</i></button>' +
              '<button type="button" class="task-fmt-btn" data-fmt="strike" title="Зачёркнутый (~~текст~~)"><s>S</s></button>' +
              '<button type="button" class="task-fmt-btn" data-fmt="highlight" title="Маркер (==текст==)"><span class="task-fmt-hl">H</span></button>' +
              '<div class="task-fmt-color-wrap">' +
                '<button type="button" class="task-fmt-btn" data-fmt-toggle="color" title="Цветной текст">🎨 Цвет</button>' +
                '<div class="task-fmt-color-popover" style="display:none;">' +
                  '<button type="button" class="task-color-dot" data-fmt-color="red" style="background:#EF4444;" title="Красный"></button>' +
                  '<button type="button" class="task-color-dot" data-fmt-color="orange" style="background:#F97316;" title="Оранжевый"></button>' +
                  '<button type="button" class="task-color-dot" data-fmt-color="green" style="background:#10B981;" title="Зелёный"></button>' +
                  '<button type="button" class="task-color-dot" data-fmt-color="blue" style="background:#3B82F6;" title="Синий"></button>' +
                  '<button type="button" class="task-color-dot" data-fmt-color="purple" style="background:#8B5CF6;" title="Фиолетовый"></button>' +
                '</div>' +
              '</div>' +
              '<div class="task-fmt-emoji-wrap">' +
                '<button type="button" class="task-fmt-btn" data-fmt-toggle="emoji" title="Все эмодзи">😊 Эмодзи</button>' +
                '<div class="task-fmt-emoji-popover" style="display:none;">' +
                  TASK_EMOJIS.map(function (em) { return '<button type="button" class="task-fmt-emoji-item" data-insert-emoji="' + em + '">' + em + '</button>'; }).join('') +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div class="task-fmt-quick-emojis">' +
              TASK_QUICK_EMOJIS.map(function (em) { return '<button type="button" class="task-quick-emoji" data-insert-emoji="' + em + '" title="Вставить ' + em + '">' + em + '</button>'; }).join('') +
            '</div>' +
          '</div>' +
          '<textarea class="form-input form-textarea" id="f-desc" name="description" maxlength="500"' + descRows +
            ' autocomplete="off" placeholder="Подробности дела (поддерживается **жирный**, *курсив*, цвета и эмодзи)…">' + esc(isNew ? '' : (task.description || '')) + '</textarea>' +
          '<div class="task-fmt-preview-box" id="task-fmt-preview" style="display:none;">' +
            '<span class="task-fmt-preview-label">Предпросмотр:</span>' +
            '<div class="task-fmt-preview-content"></div>' +
          '</div>' +
        '</div>' +

        '<div class="form-group">' +
          '<label class="form-label" for="f-due">Дата</label>' +
          '<input class="form-input" id="f-due" name="dueDate" type="date" ' +
            'value="' + esc(isNew ? '' : (task.dueDate || '')) + '">' +
          '<div class="form-error" id="e-dueDate"></div>' +
        '</div>' +

        '<div class="form-group" id="group-time"' + ((task && task.dueDate) ? '' : ' style="display:none;"') + '>' +
          '<label class="form-label" for="f-time">Время</label>' +
          '<input class="form-input" id="f-time" name="dueTime" type="time" ' +
            'value="' + esc(isNew ? '' : (task.dueTime || '')) + '">' +
          '<div class="form-error" id="e-dueTime"></div>' +
        '</div>' +

        '<div class="form-group">' +
          '<label class="form-label" for="f-prio">Приоритет</label>' +
          '<select class="form-select" id="f-prio" name="priority">' + priorityOptions(prio) + '</select>' +
        '</div>' +

        '<div class="form-group">' +
          '<label class="form-label" for="f-rec">Повторяемость</label>' +
          '<select class="form-select" id="f-rec" name="recurring">' + recurringOptions(rec) + '</select>' +
        '</div>' +

        '<div class="form-group">' +
          '<label class="form-label" for="f-category">Категория</label>' +
          '<select class="form-select" id="f-category" name="category">' +
            '<option value="">Без категории</option>' +
            (window.Personalization && window.Personalization.buildCategorySelectOptions
              ? window.Personalization.buildCategorySelectOptions('task', task ? task.category : '', [
                  { name: 'Личное' }, { name: 'Работа' }, { name: 'Дом' }, { name: 'Здоровье' }
                ])
              : '') +
          '</select>' +
        '</div>' +

        /* Этап 12.7: доступ (пусто вне семьи) */
        (window.FamilyUI ? window.FamilyUI.scopeFieldHtml(task ? task.familyScope : '') : '') +

        '<div class="form-error" id="e-save" role="alert"></div>' +

        '<div class="flex gap-3 mt-4">' +
          '<button type="button" class="btn btn--secondary w-full" data-task-action="cancel">Отмена</button>' +
          '<button type="submit" class="btn btn--primary w-full">Сохранить</button>' +
        '</div>' +
      '</form>';
  }

  /* Открыть форму добавления */
  function openAddForm() {
    editingId = null;
    openModal(formHtml(null), bindForm);
  }

  /* Открыть форму редактирования */
  function openEditForm(id) {
    var task = findTask(id);
    if (!task) { console.warn('[Tasks] Задача не найдена:', id); return; }
    editingId = id;
    openModal(formHtml(task), bindForm);
  }

  /* Привязка обработчиков формы */
  function bindForm(card, close) {
    var hideTime = function () { card.querySelector('#group-time').style.display = 'none'; };
    var showTime = function () { card.querySelector('#group-time').style.display = ''; };

    var dueInput = card.querySelector('[name="dueDate"]');
    if (dueInput && dueInput.value) { showTime(); } else if (dueInput) { hideTime(); }
    if (dueInput) {
      dueInput.addEventListener('change', function () {
        if (dueInput.value) { showTime(); } else { hideTime(); }
      });
    }

    ['title','description','dueDate','dueTime'].forEach(function (n) {
      var input = card.querySelector('[name="' + n + '"]');
      input.addEventListener('input', function () {
        input.classList.remove('is-invalid');
        var box = card.querySelector('#e-' + n);
        if (box) box.textContent = '';
      });
    });

    card.querySelector('[data-task-action="cancel"]').addEventListener('click', close);

    card.querySelector('#task-form').addEventListener('submit', function (e) {
      e.preventDefault();
      save(card, close);
    });

    // Отслеживание активного поля для форматирования
    var activeTarget = card.querySelector('#f-desc');
    var titleInp = card.querySelector('#f-title');
    var descInp = card.querySelector('#f-desc');

    if (titleInp) {
      titleInp.addEventListener('focus', function () { activeTarget = titleInp; });
    }
    if (descInp) {
      descInp.addEventListener('focus', function () { activeTarget = descInp; });
    }

    function updatePreview() {
      var prevBox = card.querySelector('#task-fmt-preview');
      var prevContent = card.querySelector('.task-fmt-preview-content');
      var tVal = (titleInp && titleInp.value) || '';
      var dVal = (descInp && descInp.value) || '';
      var hasFormatting = /[\*~=]|\{color:|\{bg:/.test(tVal + dVal);
      if (prevBox && prevContent) {
        if (hasFormatting) {
          prevBox.style.display = 'block';
          var html = '';
          if (tVal) html += '<strong>' + renderRichText(tVal) + '</strong><br>';
          if (dVal) html += renderRichText(dVal);
          prevContent.innerHTML = html;
        } else {
          prevBox.style.display = 'none';
        }
      }
    }

    if (titleInp) titleInp.addEventListener('input', updatePreview);
    if (descInp) descInp.addEventListener('input', updatePreview);
    updatePreview();

    function applyFormat(openTag, closeTag, placeholder) {
      var input = activeTarget || descInp || titleInp;
      if (!input) return;
      var start = input.selectionStart != null ? input.selectionStart : input.value.length;
      var end = input.selectionEnd != null ? input.selectionEnd : input.value.length;
      var val = input.value;
      var selected = val.substring(start, end);
      var ins = selected ? (openTag + selected + closeTag) : (openTag + (placeholder || 'текст') + closeTag);
      input.value = val.substring(0, start) + ins + val.substring(end);
      var newCursor = start + ins.length;
      if (!selected && placeholder) {
        input.setSelectionRange(start + openTag.length, start + openTag.length + placeholder.length);
      } else {
        input.setSelectionRange(newCursor, newCursor);
      }
      input.focus();
      input.dispatchEvent(new Event('input'));
      updatePreview();
    }

    function insertEmoji(em) {
      var input = activeTarget || descInp || titleInp;
      if (!input) return;
      var start = input.selectionStart != null ? input.selectionStart : input.value.length;
      var end = input.selectionEnd != null ? input.selectionEnd : input.value.length;
      var val = input.value;
      input.value = val.substring(0, start) + em + val.substring(end);
      var newPos = start + em.length;
      input.setSelectionRange(newPos, newPos);
      input.focus();
      input.dispatchEvent(new Event('input'));
      updatePreview();
    }

    var fmtBtns = card.querySelectorAll('[data-fmt]');
    Array.prototype.forEach.call(fmtBtns, function (btn) {
      btn.addEventListener('click', function () {
        var fmt = btn.getAttribute('data-fmt');
        if (fmt === 'bold') applyFormat('**', '**', 'жирный');
        else if (fmt === 'italic') applyFormat('*', '*', 'курсив');
        else if (fmt === 'strike') applyFormat('~~', '~~', 'зачёркнутый');
        else if (fmt === 'highlight') applyFormat('==', '==', 'важно');
      });
    });

    var colorPopover = card.querySelector('.task-fmt-color-popover');
    var emojiPopover = card.querySelector('.task-fmt-emoji-popover');

    var colorToggle = card.querySelector('[data-fmt-toggle="color"]');
    if (colorToggle && colorPopover) {
      colorToggle.addEventListener('click', function (e) {
        e.stopPropagation();
        var isHidden = colorPopover.style.display === 'none';
        if (emojiPopover) emojiPopover.style.display = 'none';
        colorPopover.style.display = isHidden ? 'flex' : 'none';
      });
    }

    var emojiToggle = card.querySelector('[data-fmt-toggle="emoji"]');
    if (emojiToggle && emojiPopover) {
      emojiToggle.addEventListener('click', function (e) {
        e.stopPropagation();
        var isHidden = emojiPopover.style.display === 'none';
        if (colorPopover) colorPopover.style.display = 'none';
        emojiPopover.style.display = isHidden ? 'grid' : 'none';
      });
    }

    var colorDots = card.querySelectorAll('[data-fmt-color]');
    Array.prototype.forEach.call(colorDots, function (dot) {
      dot.addEventListener('click', function (e) {
        e.stopPropagation();
        var c = dot.getAttribute('data-fmt-color');
        applyFormat('{color:' + c + '}', '{/color}', 'цвет');
        if (colorPopover) colorPopover.style.display = 'none';
      });
    });

    var emojiBtns = card.querySelectorAll('[data-insert-emoji]');
    Array.prototype.forEach.call(emojiBtns, function (emBtn) {
      emBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var em = emBtn.getAttribute('data-insert-emoji');
        insertEmoji(em);
        if (emojiPopover) emojiPopover.style.display = 'none';
      });
    });

    card.addEventListener('click', function () {
      if (colorPopover) colorPopover.style.display = 'none';
      if (emojiPopover) emojiPopover.style.display = 'none';
    });

    setTimeout(function () { card.querySelector('#f-title').focus(); }, 260);
  }

  /* Валидация и чтение данных формы */
  function readForm(card) {
    var ok = true;
    function fail(name, msg) {
      var inp = card.querySelector('[name="' + name + '"]');
      if (inp) inp.classList.add('is-invalid');
      card.querySelector('#e-' + name).textContent = msg;
      ok = false;
    }

    var title = card.querySelector('[name="title"]').value.trim();
    var description = card.querySelector('[name="description"]').value.trim();
    var dueDate = card.querySelector('[name="dueDate"]').value;
    var dueTime = card.querySelector('[name="dueTime"]').value;
    var priority = card.querySelector('[name="priority"]').value;
    var recurring = card.querySelector('[name="recurring"]').value;

    if (!title) fail('title', 'Укажите название дела');
    else if (title.length > 100) fail('title', 'Не длиннее 100 символов');

    if (dueTime && !dueDate) {
      fail('dueTime', 'Если указано время — должна быть указана дата');
    }

    if (!ok) {
      if (window.Personalization) { window.Personalization.triggerFeedback('validation_error'); }
      return null;
    }

    var catEl = card.querySelector('[name="category"]');
    var category = catEl ? catEl.value.trim() : '';

    var out = {
      title: title,
      description: description || undefined,
      dueDate: dueDate || undefined,
      dueTime: dueTime || undefined,
      priority: priority,
      recurring: recurring,
      category: category || undefined
    };

    /* Этап 12.7: переключатель «Общая/Личная» (null — вне семьи) */
    var scope = window.FamilyUI ? window.FamilyUI.readScope(card) : null;
    if (scope) { out.familyScope = scope; }

    return out;
  }

  /* Сохранение задачи */
  function save(card, close) {
    var data = readForm(card);
    if (!data) return;

    if (editingId) {
      /* При редактировании сохраняем completed/completedAt из кэша */
      var existing = findTask(editingId);
      data.isTemplate = existing ? existing.isTemplate : false;
      data.parentTaskId = existing ? existing.parentTaskId : null;
      data.completed = existing ? existing.completed : false;
      data.completedAt = existing ? existing.completedAt : null;
    } else {
      data.isTemplate = false;
      data.parentTaskId = null;
      data.completed = false;
      data.completedAt = null;
    }

    /* Этап 12.7: владелец / семья / флаг доступа — за Family */
    if (window.Family && window.Family.stampScope) {
      window.Family.stampScope(data, STORE, Boolean(editingId));
    }

    var op = editingId
      ? DB.update(STORE, editingId, data)
      : DB.add(STORE, data);

    op.then(function () {
      if (window.Personalization) { window.Personalization.triggerFeedback('payment_saved'); }
      close();
      return loadData();
    }).then(function () {
      paint();
    }).catch(function (err) {
      console.error('[Tasks] Ошибка сохранения:', err);
      card.querySelector('#e-save').textContent = 'Не удалось сохранить: ' + err.message;
    });
  }

  /* ================================================================
     8. ВЫПОЛНЕНИЕ / ОТМЕНА выполненой
     ================================================================ */

  function toggleComplete(id) {
    var task = findTask(id);
    if (!task) return;

    var newCompleted = !task.completed;
    var updates = { completed: newCompleted };
    if (newCompleted) {
      updates.completedAt = new Date().toISOString();
    } else {
      updates.completedAt = null;
    }

    DB.update(STORE, id, updates).then(function () {
      if (newCompleted && window.Personalization) {
        window.Personalization.triggerFeedback('task_done');
      }
      if (newCompleted) {
        return createNextIfRecurring(task).then(loadData);
      } else {
        return loadData();
      }
    }).then(function () {
      paint();
    }).catch(function (err) {
      console.error('[Tasks] Ошибка отметки выполнения:', err);
    });
  }

  /* ================================================================
     9. УДАЛЕНИЕ
     ================================================================ */

  function removeTask(id) {
    var task = findTask(id);
    if (!task) return;

    var html = '<h2 class="modal-content__title">Удалить дело?</h2>' +
      '<p class="modal-content__text">«' + esc(task.title) + '» будет удалён без возможности восстановления.</p>' +
      '<div class="form-error" id="e-del" role="alert"></div>' +
      '<div class="flex gap-3 mt-4">' +
        '<button type="button" class="btn btn--secondary w-full" data-task-action="cancel">Отмена</button>' +
        '<button type="button" class="btn btn--danger w-full" data-task-action="confirm">Удалить</button>' +
      '</div>';

    openModal(html, function (card, close) {
      card.querySelector('[data-task-action="cancel"]').addEventListener('click', close);

      card.querySelector('[data-task-action="confirm"]').addEventListener('click', function () {
        var btn = this;
        btn.disabled = true;

        DB.delete(STORE, id).then(function () {
          close();
          return loadData();
        }).then(function () {
          paint();
        }).catch(function (err) {
          btn.disabled = false;
          console.error('[Tasks] Ошибка удаления:', err);
          card.querySelector('#e-del').textContent = 'Не удалось удалить: ' + err.message;
        });
      });
    });
  }

  /* ================================================================
     10. ОЧИСТКА АРХИВА
     ================================================================ */

  function clearArchive() {
    var count = 0;
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].completed) count++;
    }

    var html = '<h2 class="modal-content__title">Очистить архив?</h2>' +
      '<p class="modal-content__text">Будут удалены все выполненные задачи (' + count + ' шт.). Это действие нельзя отменить.</p>' +
      '<div class="form-error" id="e-clear" role="alert"></div>' +
      '<div class="flex gap-3 mt-4">' +
        '<button type="button" class="btn btn--secondary w-full" data-task-action="cancel">Отмена</button>' +
        '<button type="button" class="btn btn--danger w-full" data-task-action="confirm">Очистить</button>' +
      '</div>';

    openModal(html, function (card, close) {
      card.querySelector('[data-task-action="cancel"]').addEventListener('click', close);

      card.querySelector('[data-task-action="confirm"]').addEventListener('click', function () {
        var btn = this;
        btn.disabled = true;

        var ids = [];
        for (var i = 0; i < tasks.length; i++) {
          if (tasks[i].completed) ids.push(tasks[i].id);
        }

        var ops = ids.map(function (id) { return DB.delete(STORE, id); });
        Promise.all(ops).then(function () {
          close();
          return loadData();
        }).then(function () {
          paint();
        }).catch(function (err) {
          btn.disabled = false;
          console.error('[Tasks] Ошибка очистки архива:', err);
          card.querySelector('#e-clear').textContent = 'Не удалось очистить: ' + err.message;
        });
      });
    });
  }

  /* ================================================================
     11. ДЕЛЕГИРОВАНИЕ СОБЫТИЙ (data-task-* префикс)
     ================================================================ */

  function onAppClick(e) {
    // Фильтр-чипы
    var chip = e.target.closest('[data-task-filter]');
    if (chip) {
      activeFilter = chip.getAttribute('data-task-filter');
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

    var actionEl = e.target.closest('[data-task-action]');
    if (actionEl) {
      var action = actionEl.getAttribute('data-task-action');
      var id = actionEl.hasAttribute('data-id') ? Number(actionEl.getAttribute('data-id')) : null;

      switch (action) {
        case 'add':         openAddForm(); return;
        case 'checklists':
          if (window.ValuePack && window.ValuePack.openChecklistsModal) {
            window.ValuePack.openChecklistsModal(function () {
              loadData().then(paint);
            });
          }
          return;
        case 'edit':        openEditForm(id); return;
        case 'delete':      removeTask(id); return;
        case 'clear-archive': clearArchive(); return;
        case 'filter-all':  activeFilter = 'all'; paint(); return;
        case 'retry':
          loading = false; invalidate(); render(); return;
        case 'cancel':
          closeModalOverlay(document.querySelector('.modal-overlay')); return;
        case 'confirm':
          // Удаление из confirm-диалога обрабатывается внутри removeTask/clearArchive
          break;
      }
      return;
    }

    // Клики по таск-чекбоксу напрямую (event delegation)
    var checkbox = e.target.closest('[data-task-toggle]');
    if (checkbox) {
      toggleComplete(Number(checkbox.getAttribute('data-task-toggle')));
      return;
    }

    // Клик по карточке мимо кнопок — переключение чекбокса
    var card = e.target.closest('.task-card');
    if (card) {
      toggleComplete(Number(card.getAttribute('data-id')));
    }
  }

  function onAppKeydown(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (!e.target.closest) return;

    var card = e.target.closest('.task-card');
    if (card && !card.contains(e.target.closest('button'))) {
      e.preventDefault();
      toggleComplete(Number(card.getAttribute('data-id')));
    }
  }

  /* ================================================================
     12. ИНИЦИАЛИЗАЦИЯ И ПУБЛИЧНЫЙ API
     ================================================================ */

  function init() {
    if (listenersBound) return;
    var el = appEl();
    if (!el) return;

    el.addEventListener('click', onAppClick);
    el.addEventListener('keydown', onAppKeydown);

    listenersBound = true;
    console.info('[Tasks] Делегаты событий привязаны.');
  }

  window.Tasks = {
    init: init,
    render: render,
    invalidate: invalidate,
    openAddForm: openAddForm,
    openEditForm: openEditForm,
    save: save,
    delete: removeTask,
    toggleComplete: toggleComplete,

    /** Возвращает просроченные невыполненные задачи */
    getOverdueTasks: overdueTasks,

    /** Возвращает невыполненные задачи на сегодня */
    getTodayTasks: todayTasks,

    /** Утилиты форматирования */
    formatDate: formatDate,
    getDaysUntil: getDaysUntil,
    getPriorityColor: getPriorityColor,
    isOverdue: isOverdue,
    isToday: isToday
  };

  console.info('[Tasks] Модуль загружен. API: window.Tasks');
})();
