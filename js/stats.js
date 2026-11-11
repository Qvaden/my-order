/**
 * МОЙ ПОРЯДОК — Раздел «Статистика» (Этап 8)
 *
 * Визуализация данных пользователя:
 *   - Сводные карточки (оплачено/ожидает/задачи/документы)
 *   - Платежи по категориям (горизонтальные бары)
 *   - Динамика показаний (SVG polyline)
 *   - Активность задач (круговой прогресс)
 *   - Ближайшие истечения документов
 *
 * Все данные берутся из window.DB, агрегация на лету.
 * Экспортирует window.Stats.
 */

(function () {
  'use strict';

  /* ================================================================
     1. КОНСТАНТЫ
     ================================================================ */

  var PERIODS = [
    { value: 'month', label: 'Месяц' },
    { value: '3months', label: '3 месяца' },
    { value: 'year', label: 'Год' }
  ];

  var STORAGE_KEY = 'myorder_stats_period';

  /** Окружность кольца прогресса (r=16 в viewBox 36x36) */
  var CIRCUMFERENCE = String(Math.round(2 * Math.PI * 16 * 100) / 100);

  /** Цвета категорий платежей */
  var CATEGORY_COLORS = {
    'Коммунальные': '#15803D',
    'Интернет': '#1D4ED8',
    'Мобильная связь': '#A16207',
    'Кредиты': '#B91C1C',
    'Подписки': '#7E22CE',
    'Личные': '#4338CA',
    'Другое': '#475569'
  };

  /* ================================================================
     2. СОСТОЯНИЕ МОДУЛЯ
     ================================================================ */

  var activePeriod = localStorage.getItem(STORAGE_KEY) || 'month';
  var listenersBound = false;

  /* ================================================================
     3. УТИЛИТЫ
     ================================================================ */

  /**
   * Форматирует копейки в рубли (12345 → "12 345,45 ₽")
   * @param {number} kopecks
   * @returns {string}
   */
  function formatMoney(kopecks) {
    if (!Number.isInteger(kopecks)) return '—';
    var negative = kopecks < 0;
    var abs = Math.abs(kopecks);
    var rubles = Math.floor(abs / 100);
    var cents = abs % 100;
    var rublesStr = String(rubles).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
    var value = cents > 0
      ? rublesStr + ',' + String(cents).padStart(2, '0')
      : rublesStr;
    return (negative ? '\u2212' : '') + value + ' \u20BD';
  }

  /**
   * Форматирует ISO-дату в DD.MM.YYYY
   * @param {string|null} iso
   * @returns {string}
   */
  function formatDate(iso) {
    if (!iso) return '\u2014';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    if (!m) return '\u2014';
    return m[3] + '.' + m[2] + '.' + m[1];
  }

  /**
   * Возвращает начало и конец периода (ISO-даты)
   * @param {string} period
   * @returns {{start: string, end: string}}
   */
  function getPeriodRange(period) {
    var now = new Date();
    var end = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    var start;
    if (period === 'month') {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (period === '3months') {
      start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    } else {
      start = new Date(now.getFullYear() - 1, now.getMonth(), 1);
    }

    function toISO(d) {
      return d.getFullYear() + '-' +
             String(d.getMonth() + 1).padStart(2, '0') + '-' +
             String(d.getDate()).padStart(2, '0');
    }

    return { start: toISO(start), end: toISO(end) };
  }

  /**
   * Эскейпит HTML-специальные символы
   * @param {string} text
   * @returns {string}
   */
  function esc(text) {
    var div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  /**
   * Эскейпит для вставки в HTML-атрибут в двойных кавычках.
   * esc() через textContent кавычку не экранирует, а она в атрибуте ломает
   * разметку — например если пользователь назовёт платёж «"Газпром"».
   * @param {string} text
   * @returns {string}
   */
  function escAttr(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ================================================================
     4. РАСЧЁТЫ (из DB)
     ================================================================ */

  /**
   * Сводка по платежам за период
   * @returns {Promise<{paid: number, pending: number, total: number, byCategory: Array}>}
   */
  function getPaymentStats() {
    var range = getPeriodRange(activePeriod);
    return window.DB.getAll('payments').then(function (payments) {
      var paid = 0, pending = 0, total = 0;
      var byCategory = {};

      for (var i = 0; i < payments.length; i++) {
        var p = payments[i];
        if (!p.date) continue;
        if (p.date < range.start || p.date > range.end) continue;

        total += p.amount || 0;
        if (p.status === 'paid') paid += p.amount || 0;
        else pending += p.amount || 0;

        var cat = p.category || 'Другое';
        if (!byCategory[cat]) byCategory[cat] = { name: cat, amount: 0 };
        byCategory[cat].amount += p.amount || 0;
      }

      var sorted = Object.keys(byCategory).map(function (k) {
        return byCategory[k];
      }).sort(function (a, b) { return b.amount - a.amount; });

      return { paid: paid, pending: pending, total: total, byCategory: sorted };
    });
  }

  /**
   * Сводка по задачам за период
   * @returns {Promise<{total: number, completed: number, byPriority: Object}>}
   */
  function getTaskStats() {
    var range = getPeriodRange(activePeriod);
    return window.DB.getAll('tasks').then(function (tasks) {
      var total = 0, completed = 0;
      var byPriority = {
        high: { total: 0, completed: 0 },
        medium: { total: 0, completed: 0 },
        low: { total: 0, completed: 0 }
      };

      for (var i = 0; i < tasks.length; i++) {
        var t = tasks[i];
        if (!t.dueDate) continue;
        if (t.dueDate < range.start || t.dueDate > range.end) continue;

        total++;
        if (t.completed) completed++;

        var prio = t.priority || 'medium';
        if (byPriority[prio]) {
          byPriority[prio].total++;
          if (t.completed) byPriority[prio].completed++;
        }
      }

      return { total: total, completed: completed, byPriority: byPriority };
    });
  }

  /**
   * Ближайшие истечения документов (в пределах 30 дней от конца периода)
   * @returns {Promise<Array>}
   */
  function getDocumentStats() {
    var range = getPeriodRange(activePeriod);
    var endDate = new Date(range.end + 'T00:00:00');
    var cutoff = new Date(endDate.getTime() + 30 * 86400000);
    var cutoffStr = cutoff.getFullYear() + '-' +
                    String(cutoff.getMonth() + 1).padStart(2, '0') + '-' +
                    String(cutoff.getDate()).padStart(2, '0');

    return window.DB.getAll('documents').then(function (docs) {
      var expiring = [];
      for (var i = 0; i < docs.length; i++) {
        var d = docs[i];
        if (!d.expiryDate) continue;
        if (d.expiryDate < range.start || d.expiryDate > cutoffStr) continue;

        var days = Math.round((new Date(d.expiryDate) - endDate) / 86400000);
        expiring.push({
          id: d.id,
          name: d.name,
          expiryDate: d.expiryDate,
          days: days
        });
      }

      expiring.sort(function (a, b) { return a.days - b.days; });
      return expiring.slice(0, 5);
    });
  }

  /**
   * Последние 5 показаний для каждого счётчика
   * @returns {Promise<Array>}
   */
  function getMeterStats() {
    return Promise.all([
      window.DB.getAll('meters'),
      window.DB.getAll('meter_readings')
    ]).then(function (results) {
      var meters = results[0];
      var readings = results[1];
      var range = getPeriodRange(activePeriod);
      var out = [];

      for (var i = 0; i < meters.length; i++) {
        var meter = meters[i];
        var meterReadings = readings.filter(function (r) {
          return r.meterId === meter.id;
        });

        // Последние 5 по дате desc, потом reverse для графика asc
        meterReadings.sort(function (a, b) { return b.date.localeCompare(a.date); });
        var last5 = meterReadings.slice(0, 5).reverse();

        // Расход за период
        var periodReadings = readings.filter(function (r) {
          return r.meterId === meter.id && r.date >= range.start && r.date <= range.end;
        });
        periodReadings.sort(function (a, b) { return a.date.localeCompare(b.date); });

        var consumption = 0;
        if (periodReadings.length >= 2) {
          consumption = periodReadings[periodReadings.length - 1].value - periodReadings[0].value;
        } else if (periodReadings.length === 1) {
          consumption = periodReadings[0].value - (meter.initialValue || 0);
        }

        // Текущее значение — последние показания, если есть; иначе стартовое
        var current = null;
        if (meterReadings.length > 0) {
          current = meterReadings[0].value;
        } else if (meter.initialValue !== undefined) {
          current = meter.initialValue;
        }

        out.push({
          id: meter.id,
          label: meter.name,
          unit: meter.unit || '',
          current: current,
          readings: last5,
          consumption: Math.round(consumption * 10) / 10
        });
      }

      return out;
    });
  }

  /* ================================================================
     5. РЕНДЕР
     ================================================================ */

  function skeletonHtml() {
    return '<div class="flex flex-col gap-4">' +
      '<div class="skeleton" style="width:100%;height:48px;border-radius:var(--radius-lg);"></div>' +
      '<div class="skeleton" style="width:100%;height:48px;border-radius:var(--radius-lg);"></div>' +
      '<div class="skeleton" style="width:100%;height:200px;border-radius:var(--radius-lg);"></div>' +
      '<div class="skeleton" style="width:100%;height:200px;border-radius:var(--radius-lg);"></div>' +
      '</div>';
  }

  function emptyHtml() {
    return '<section class="empty-state">' +
      '<div class="empty-state__icon" aria-hidden="true">\uD83D\uDCCA</div>' +
      '<h2 class="empty-state__title">Пока нет данных</h2>' +
      '<p class="empty-state__text">Заполните данные в других разделах, чтобы увидеть статистику.</p>' +
      '<button type="button" class="btn btn--primary" data-stats-action="go-home">Перейти на главную</button>' +
      '</section>';
  }

  function summaryCardsHtml(stats) {
    var tasks = stats.tasks;
    var docs = stats.docs;
    var tasksPercent = tasks.total > 0 ? Math.round((tasks.completed / tasks.total) * 100) : 0;

    return '<div class="stats-grid">' +
      '<div class="stats-card stats-card--paid">' +
        '<div class="stats-card__label">Оплачено</div>' +
        '<div class="stats-card__value summary-card__value--paid">' + formatMoney(stats.paid) + '</div>' +
      '</div>' +
      '<div class="stats-card stats-card--pending">' +
        '<div class="stats-card__label">Ожидает оплаты</div>' +
        '<div class="stats-card__value summary-card__value--pending">' + formatMoney(stats.pending) + '</div>' +
      '</div>' +
      '<div class="stats-card stats-card--tasks">' +
        '<div class="stats-card__label">Выполнено задач</div>' +
        '<div class="stats-card__value">' + tasks.completed + ' / ' + tasks.total + '</div>' +
        '<div class="stats-card__hint">' + tasksPercent + '% выполнено</div>' +
      '</div>' +
      '<div class="stats-card stats-card--docs">' +
        '<div class="stats-card__label">Истекает документов</div>' +
        '<div class="stats-card__value">' + docs.length + ' шт.</div>' +
        (docs.length > 0 ? '<div class="stats-card__hint" style="color:var(--color-error);">Внимание!</div>' : '') +
      '</div>' +
      '</div>';
  }

  function categoryBarsHtml(byCategory, total) {
    if (!byCategory || byCategory.length === 0) return '';

    var html = '<div class="stats-section">' +
      '<h2 class="stats-section__title">Платежи по категориям</h2>' +
      '<div class="stats-bars">';

    for (var i = 0; i < byCategory.length; i++) {
      var cat = byCategory[i];
      var percent = total > 0 ? Math.round((cat.amount / total) * 100) : 0;
      var width = total > 0 ? (cat.amount / total) * 100 : 0;
      var customColor = (window.Personalization && window.Personalization.getCategoryColors)
        ? window.Personalization.getCategoryColors(cat.name) : null;
      var color = (customColor && customColor.bg) || CATEGORY_COLORS[cat.name] || '#2563EB';

      html += '<div class="stats-bar-item">' +
        '<div class="stats-bar-label">' + esc(cat.name) + ' &mdash; ' + formatMoney(cat.amount) + ' (' + percent + '%)</div>' +
        '<div class="stats-bar">' +
          '<div class="stats-bar-fill" style="width:0%;background:' + color + ';" data-target-width="' + width + '"></div>' +
        '</div>' +
      '</div>';
    }

    html += '</div></div>';
    return html;
  }

  function meterChartsHtml(meters) {
    if (!meters || meters.length === 0) return '';

    var html = '<div class="stats-section">' +
      '<h2 class="stats-section__title">Динамика показаний</h2>' +
      '<div class="stats-charts">';

    for (var i = 0; i < meters.length; i++) {
      var m = meters[i];
      if (!m.readings || m.readings.length === 0) continue;

      var points = '';
      var circles = '';
      var maxVal = 0, minVal = Infinity;

      for (var j = 0; j < m.readings.length; j++) {
        var r = m.readings[j];
        var val = r.value || 0;
        if (val > maxVal) maxVal = val;
        if (val < minVal) minVal = val;
      }

      var range = maxVal - minVal || 1;
      var svgW = 100, svgH = 40;
      var padding = 4;
      var stepX = svgW / Math.max(m.readings.length - 1, 1);

      var dots = '';
      for (var j = 0; j < m.readings.length; j++) {
        var r = m.readings[j];
        var val = r.value || 0;
        var x = j * stepX;
        var y = svgH - padding - ((val - minVal) / range) * (svgH - 2 * padding);

        points += x.toFixed(1) + ',' + y.toFixed(1) + ' ';

        // Баг 3 (Этап 8.1): SVG растянут (preserveAspectRatio="none"),
        // поэтому circle внутри него превращался в эллипс. Точки вынесены
        // в HTML-дивы поверх графика — они не наследуют искажение и всегда
        // идеально круглые (border-radius:50%), диаметр 7px.
        var tipText = escAttr(formatDate(r.date) + ': ' + val + ' ' + m.unit);
        dots += '<span class="stats-chart__dot" ' +
          'style="left:' + (x / svgW * 100).toFixed(3) + '%;top:' + (y / svgH * 100).toFixed(3) + '%;" ' +
          'data-tooltip="' + tipText + '" title="' + tipText + '"></span>';
      }

      html += '<div class="stats-chart">' +
        '<div class="stats-chart__info">' +
          '<div class="stats-chart__label">' + esc(m.label) + '</div>' +
          '<div class="stats-chart__value">' + (m.current !== null ? m.current + ' ' + m.unit : '\u2014') + '</div>' +
          '<div class="stats-chart__hint">' + (m.consumption !== 0 ? 'Расход: ' + m.consumption + ' ' + m.unit : 'Нет данных') + '</div>' +
        '</div>' +
        '<div class="stats-chart__graph">' +
          '<svg class="stats-chart__svg" viewBox="0 0 ' + svgW + ' ' + svgH + '" preserveAspectRatio="none">' +
            '<polyline points="' + points.trim() + '" fill="none" stroke="var(--color-primary)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
          '</svg>' +
          '<div class="stats-chart__dots">' + dots + '</div>' +
        '</div>' +
      '</div>';
    }

    html += '</div></div>';
    return html;
  }

  function progressCircleHtml(tasks) {
    var percent = tasks.total > 0 ? Math.round((tasks.completed / tasks.total) * 100) : 0;

    var html = '<div class="stats-section">' +
      '<h2 class="stats-section__title">Активность по задачам</h2>' +
      '<div class="stats-progress-container">' +
        '<div class="stats-progress">' +
          '<svg viewBox="0 0 36 36">' +
            '<circle cx="18" cy="18" r="16" fill="none" stroke="var(--color-border)" stroke-width="2"/>' +
            '<circle class="stats-progress__circle" cx="18" cy="18" r="16" fill="none" ' +
              'stroke="var(--color-primary)" stroke-width="2.5" stroke-linecap="round" ' +
              'stroke-dasharray="' + CIRCUMFERENCE + '" stroke-dashoffset="' + CIRCUMFERENCE + '" ' +
              'transform="rotate(-90 18 18)"/>' +
          '</svg>' +
          '<div class="stats-progress__text">' +
            '<span class="stats-progress__percent">' + percent + '%</span>' +
            '<span class="stats-progress__label">Задачи</span>' +
          '</div>' +
        '</div>' +

        '<div class="stats-priority-bars">' +
          '<div class="stats-priority-bar">' +
            '<div class="stats-priority-bar__label">Высокий</div>' +
            '<div class="stats-bar">' +
              '<div class="stats-bar-fill" style="width:0%;background:var(--color-error);" ' +
                'data-target-width="' + (tasks.byPriority.high.total > 0 ? (tasks.byPriority.high.completed / tasks.byPriority.high.total) * 100 : 0) + '"></div>' +
            '</div>' +
          '</div>' +
          '<div class="stats-priority-bar">' +
            '<div class="stats-priority-bar__label">Средний</div>' +
            '<div class="stats-bar">' +
              '<div class="stats-bar-fill" style="width:0%;background:var(--color-warning);" ' +
                'data-target-width="' + (tasks.byPriority.medium.total > 0 ? (tasks.byPriority.medium.completed / tasks.byPriority.medium.total) * 100 : 0) + '"></div>' +
            '</div>' +
          '</div>' +
          '<div class="stats-priority-bar">' +
            '<div class="stats-priority-bar__label">Низкий</div>' +
            '<div class="stats-bar">' +
              '<div class="stats-bar-fill" style="width:0%;background:var(--color-text-secondary);" ' +
                'data-target-width="' + (tasks.byPriority.low.total > 0 ? (tasks.byPriority.low.completed / tasks.byPriority.low.total) * 100 : 0) + '"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

    return html;
  }

  function docExpiryHtml(docs) {
    if (!docs || docs.length === 0) return '';

    var html = '<div class="stats-section">' +
      '<h2 class="stats-section__title">Ближайшие истечения</h2>' +
      '<div class="stats-docs">';

    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      var colorClass = d.days < 0 ? 'stats-doc--expired' : (d.days <= 7 ? 'stats-doc--urgent' : 'stats-doc--ok');

      html += '<div class="stats-doc ' + colorClass + '">' +
        '<div class="stats-doc__title">' + esc(d.name) + '</div>' +
        '<div class="stats-doc__meta">' + formatDate(d.expiryDate) + ' \u00B7 ' + Math.abs(d.days) + ' дн.' + (d.days < 0 ? ' (просрочено)' : '') + '</div>' +
      '</div>';
    }

    html += '</div></div>';
    return html;
  }

  function periodToggleHtml() {
    var html = '<div class="stats-period-toggle">';
    for (var i = 0; i < PERIODS.length; i++) {
      var p = PERIODS[i];
      var active = activePeriod === p.value ? ' chip--active' : '';
      html += '<button type="button" class="chip' + active + '" data-stats-period="' + p.value + '">' + p.label + '</button>';
    }
    html += '</div>';
    return html;
  }

  /** @type {HTMLElement|null} Контейнер #app (кэш) */
  var container = null;

  /**
   * Возвращает и кэширует контейнер #app.
   * @returns {HTMLElement|null}
   */
  function getAppEl() {
    if (!container) { container = document.getElementById('app'); }
    return container;
  }

  /**
   * Экран статистики всё ещё на месте.
   *
   * Раздел рисуется асинхронно (данные из DB, PRO-блоки — отдельным шагом),
   * и пока идёт чтение, человек мог уйти в другой раздел: el — общий #app,
   * и запись в него затёр бы чужой экран. Модуль App может не загрузиться
   * (обрезанный кэш), поэтому при отсутствии роутера считаем экран своим.
   * @returns {boolean}
   */
  function onStatsScreen() {
    if (!window.App || typeof window.App.getCurrentRoute !== 'function') { return true; }
    return window.App.getCurrentRoute() === 'stats';
  }

  /**
   * Есть ли вообще данные во всех разделах.
   * @param {Object} payments
   * @param {Object} tasks
   * @param {Array} docs
   * @param {Array} meters
   * @returns {boolean}
   */
  function hasAnyData(payments, tasks, docs, meters) {
    return payments.total > 0 || tasks.total > 0 || docs.length > 0 || meters.length > 0;
  }

  function render() {
    var el = getAppEl();
    if (!el) return;

    el.innerHTML = '<header class="page-header">Статистика</header>' +
      periodToggleHtml() +
      skeletonHtml();

    loadData();
  }

  function loadData() {
    var el = getAppEl();
    if (!el) { return; }

    Promise.all([
      getPaymentStats(),
      getTaskStats(),
      getDocumentStats(),
      getMeterStats()
    ]).then(function (results) {
      var payments = results[0];
      var tasks = results[1];
      var docs = results[2];
      var meters = results[3];

      if (!onStatsScreen()) { return; }

      if (!hasAnyData(payments, tasks, docs, meters)) {
        el.innerHTML = '<header class="page-header">Статистика</header>' +
          periodToggleHtml() + emptyHtml();
        return;
      }

      var html = '<header class="page-header">Статистика</header>' +
        periodToggleHtml() +
        summaryCardsHtml({ paid: payments.paid, pending: payments.pending, tasks: tasks, docs: docs }) +
        categoryBarsHtml(payments.byCategory, payments.total) +
        meterChartsHtml(meters) +
        progressCircleHtml(tasks) +
        docExpiryHtml(docs);

      el.innerHTML = html;

      // Анимация заполнения баров: width 0 → target (500ms ease-out из CSS)
      setTimeout(function () {
        var fills = el.querySelectorAll('[data-target-width]');
        for (var i = 0; i < fills.length; i++) {
          fills[i].style.width = fills[i].getAttribute('data-target-width') + '%';
        }
      }, 100);

      // Анимация кругового прогресса: dashoffset 100 → target (500ms ease-out)
      var progressCircle = el.querySelector('.stats-progress__circle');
      if (progressCircle) {
        var percent = tasks.total > 0 ? Math.round((tasks.completed / tasks.total) * 100) : 0;
        progressCircle.setAttribute('stroke-dasharray', CIRCUMFERENCE);
        progressCircle.setAttribute('stroke-dashoffset', CIRCUMFERENCE);
        setTimeout(function () {
          progressCircle.setAttribute(
            'stroke-dashoffset',
            String(Math.round(CIRCUMFERENCE * (1 - percent / 100) * 100) / 100)
          );
        }, 100);
      }

      // Этап 12.5: PRO-аналитика догружается ПОСЛЕ отрисовки основного
      // контента. Прогноз и heatmap читают всю базу, и синхронно они удорожали
      // бы переход в раздел; Free вообще не платит за эти запросы.
      if (window.ProManager && window.ProManager.isPro()) {
        setTimeout(function () { renderProAnalytics(); }, 0);
      }
    }).catch(function (err) {
      console.error('[Stats] Ошибка загрузки:', err);
      el.innerHTML = '<header class="page-header">Статистика</header>' +
        '<section class="empty-state">' +
          '<div class="empty-state__icon" aria-hidden="true">\u26A0\uFE0F</div>' +
          '<h2 class="empty-state__title">Не удалось загрузить</h2>' +
          '<p class="empty-state__text">' + esc(err.message) + '</p>' +
          '<button type="button" class="btn btn--primary" data-stats-action="retry">Попробовать снова</button>' +
        '</section>';
    });
  }

  /* ================================================================
     5b. PRO: РАСШИРЕННАЯ АНАЛИТИКА (Этап 12.5)
     ==============================================================
     *
     * Прогноз, тепловая карта и сравнение периодов считаются только для
     * PRO-подписки и догружаются ПОСЛЕ основного контента. Причина не
     * только в монетизации: forecast тянет все платежи за 4 месяца, а
     * heatmap — все задачи. Вешать это на критический путь раздела
     * означало бы уронить рендер «Статистики» и Lighthouse ниже 85 у всех,
     * включая Free.
     ================================================================ */

  /** @const {string[]} Короткие названия месяцев для осей и подписей */
  var MONTH_NAMES = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
  ];

  /** @const {string[]} Дни недели, начиная с понедельника (как в РФ) */
  var WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  /** @type {boolean} идёт ли загрузка PRO-блоков (защита от двойного вызова) */
  var proLoading = false;

  /**
   * Ключ месяца по ISO-дате: '2026-11'.
   * @param {string} iso
   * @returns {?string}
   */
  function monthKey(iso) {
    var m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
    return m ? m[1] + '-' + m[2] : null;
  }

  /**
   * Массив из N последних ЗАКРЫТЫХ месяцев (текущий не берём: он неполный,
   * и сравнение с ним занижало бы прошлые периоды).
   * @param {number} count
   * @returns {Array<{key: string, label: string, start: string, end: string}>}
   */
  function lastClosedMonths(count) {
    var out = [];
    var now = new Date();

    for (var i = 1; i <= count; i++) {
      var start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      var end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);

      out.push({
        key: start.getFullYear() + '-' + String(start.getMonth() + 1).padStart(2, '0'),
        label: MONTH_NAMES[start.getMonth()] + ' ' + start.getFullYear(),
        start: start.getFullYear() + '-' + String(start.getMonth() + 1).padStart(2, '0') + '-01',
        end: end.getFullYear() + '-' + String(end.getMonth() + 1).padStart(2, '0') + '-' +
             String(end.getDate()).padStart(2, '0')
      });
    }

    // От старого к новому: прогноз строится по временному ряду
    return out.reverse();
  }

  /**
   * Расход за месяц по категории. Считаем только оплаченное и ожидающее
   * одинаково: пользователю важен начисленный объём, а не факт списания.
   * @param {Array} payments
   * @param {Object} month
   * @returns {{total: number, byCategory: Object.<string, number>}}
   */
  function sumMonth(payments, month) {
    var total = 0;
    var byCategory = {};

    for (var i = 0; i < payments.length; i++) {
      var p = payments[i];
      if (!p.date || p.date < month.start || p.date > month.end) { continue; }

      var amount = Number(p.amount) || 0;
      var cat = p.category || 'Другое';

      total += amount;
      byCategory[cat] = (byCategory[cat] || 0) + amount;
    }

    return { total: total, byCategory: byCategory };
  }

  /**
   * Прогноз расходов на следующий месяц: среднее арифметическое за
   * последние 3 закрытых месяца по каждой категории.
   *
   * Почему среднее, а не тренд: при 3 точках линейная регрессия
   * переучивается на выбросах (разовый крупный платёж → «прогноз +40%»),
   * а пользователю нужна спокойная оценка бюджета. Алгоритм честно
   * показывает, на каких данных он построен.
   *
   * @param {Array} payments — все платежи
   * @returns {Object}
   */
  function buildForecast(payments) {
    var months = lastClosedMonths(3);
    var sums = months.map(function (m) { return sumMonth(payments, m); });

    var totalExpected = 0;
    var monthsWithData = 0;

    sums.forEach(function (s) {
      if (s.total > 0) { monthsWithData += 1; }
      totalExpected += s.total;
    });

    var average = monthsWithData > 0 ? Math.round(totalExpected / monthsWithData) : 0;

    // Категорийный прогноз: среднее по месяцам, где категория встречалась.
    // Делить на все 3 месяца было бы неверно — редкая категория (газ раз
    // в квартал) показала бы ложное падение.
    var categories = {};
    sums.forEach(function (s) {
      Object.keys(s.byCategory).forEach(function (cat) {
        if (!categories[cat]) { categories[cat] = { sum: 0, months: 0 }; }
        categories[cat].sum += s.byCategory[cat];
        categories[cat].months += 1;
      });
    });

    var byCategory = Object.keys(categories).map(function (cat) {
      return {
        name: cat,
        forecast: Math.round(categories[cat].sum / categories[cat].months)
      };
    }).sort(function (a, b) { return b.forecast - a.forecast; });

    var lastActual = sums[sums.length - 1] ? sums[sums.length - 1].total : 0;

    return {
      months: months,
      sums: sums,
      expected: average,
      lastActual: lastActual,
      lastMonthLabel: months.length ? months[months.length - 1].label : '',
      nextMonthLabel: nextMonthLabel(),
      byCategory: byCategory,
      monthsWithData: monthsWithData,
      enoughData: monthsWithData >= 2
    };
  }

  /** @returns {string} название месяца, на который строим прогноз */
  function nextMonthLabel() {
    var now = new Date();
    var next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return MONTH_NAMES[next.getMonth()] + ' ' + next.getFullYear();
  }

  /**
   * Сравнение текущего периода с тем же периодом прошлого месяца:
   * абсолютная дельта и процент.
   * @param {Array} payments
   * @returns {Object}
   */
  function buildComparison(payments) {
    var current = getPeriodRange(activePeriod);
    var prev = previousPeriodRange(current);

    var now = 0;
    var before = 0;

    for (var i = 0; i < payments.length; i++) {
      var p = payments[i];
      if (!p.date) { continue; }
      var amount = Number(p.amount) || 0;

      if (p.date >= current.start && p.date <= current.end) { now += amount; }
      if (p.date >= prev.start && p.date <= prev.end) { before += amount; }
    }

    var delta = now - before;
    var percent = before > 0 ? Math.round((delta / before) * 100) : (now > 0 ? 100 : 0);

    return {
      now: now,
      before: before,
      delta: delta,
      percent: percent,
      current: current,
      previous: prev,
      hasBaseline: before > 0
    };
  }

  /**
   * Зеркало периода месяц назад — с тем же числом дней, чтобы сравнивать
   * корректные объёмы (с 1 по 9 число сравниваем с 1–9 числом прошлого месяца,
   * а не с полным месяцем).
   * @param {{start: string, end: string}} range
   * @returns {{start: string, end: string}}
   */
  function previousPeriodRange(range) {
    var start = new Date(range.start + 'T00:00:00');
    var end = new Date(range.end + 'T00:00:00');
    var days = Math.round((end - start) / 86400000) + 1;

    var prevStart = new Date(start.getFullYear(), start.getMonth() - 1, start.getDate());
    var prevEnd = new Date(prevStart.getTime() + (days - 1) * 86400000);

    function toISO(d) {
      return d.getFullYear() + '-' +
             String(d.getMonth() + 1).padStart(2, '0') + '-' +
             String(d.getDate()).padStart(2, '0');
    }

    return { start: toISO(prevStart), end: toISO(prevEnd), days: days };
  }

  /**
   * Активность по дням недели за активный период.
   *
   * Ячейка = строка дня недели × столбец «неделя периода». Цвет ячейки
   * пропорционален сумме событий: так видно не «в какой день вообще что-то
   * было», а насколько день нагружен относительно других.
   *
   * @param {Array} payments
   * @param {Array} tasks
   * @returns {Object}
   */
  function buildWeekdayMatrix(payments, tasks) {
    var range = getPeriodRange(activePeriod);
    var startDate = new Date(range.start + 'T00:00:00');
    var endDate = new Date(range.end + 'T00:00:00');

    // Сколько полных недель покрывает период (столбцы heatmap)
    var totalDays = Math.max(1, Math.round((endDate - startDate) / 86400000) + 1);
    var columns = Math.min(6, Math.max(1, Math.ceil(totalDays / 7)));

    var matrix = [];
    for (var r = 0; r < 7; r++) {
      matrix.push([]);
      for (var c = 0; c < columns; c++) {
        matrix[r].push({ payments: 0, amount: 0, tasks: 0, date: null });
      }
    }

    var dayIndex = 0;
    for (var d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1), dayIndex++) {
      var col = Math.floor(dayIndex / 7);
      if (col >= columns) { break; }

      var iso = d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');

      // getDay(): 0=вс. Переводим к нашему ряду, где 0=Пн
      var row = (d.getDay() + 6) % 7;
      var cell = matrix[row][col];
      cell.date = iso;

      for (var i = 0; i < payments.length; i++) {
        if (payments[i].date === iso) {
          cell.payments += 1;
          cell.amount += Number(payments[i].amount) || 0;
        }
      }

      for (var j = 0; j < tasks.length; j++) {
        var t = tasks[j];
        if (t.dueDate === iso || (t.completed && t.completedAt && String(t.completedAt).slice(0, 10) === iso)) {
          cell.tasks += 1;
        }
      }
    }

    var maxAmount = 0;
    var maxTasks = 0;
    matrix.forEach(function (rowArr) {
      rowArr.forEach(function (cell) {
        if (cell.amount > maxAmount) { maxAmount = cell.amount; }
        if (cell.tasks > maxTasks) { maxTasks = cell.tasks; }
      });
    });

    return { matrix: matrix, columns: columns, maxAmount: maxAmount, maxTasks: maxTasks, range: range };
  }

  /**
   * Интенсивность 0..1 для окраски ячейки.
   * @param {number} value
   * @param {number} max
   * @returns {number}
   */
  function intensity(value, max) {
    if (!max || value <= 0) { return 0; }
    return Math.min(1, value / max);
  }

  function forecastHtml(forecast) {
    var max = Math.max(forecast.expected, forecast.lastActual, 1);
    var expectedWidth = Math.round((forecast.expected / max) * 100);
    var actualWidth = Math.round((forecast.lastActual / max) * 100);
    var diff = forecast.expected - forecast.lastActual;
    var diffPercent = forecast.lastActual > 0
      ? Math.round((diff / forecast.lastActual) * 100)
      : (forecast.expected > 0 ? 100 : 0);

    var body;

    if (!forecast.enoughData) {
      body = '<p class="pro-analytics__note">' +
        'Прогнозу нужно минимум два месяца истории. Пока данных ' +
        forecast.monthsWithData + ' — прогноз появится, когда накопите больше платежей.</p>';
    } else {
      body = '' +
        '<div class="forecast-row">' +
          '<div class="forecast-row__label">Ожидаемые расходы · ' + esc(forecast.nextMonthLabel) + '</div>' +
          '<div class="forecast-row__track">' +
            '<div class="forecast-row__fill forecast-row__fill--expected" ' +
              'data-target-width="' + expectedWidth + '" style="width:0%;"></div>' +
            '<span class="forecast-row__value">' + formatMoney(forecast.expected) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="forecast-row">' +
          '<div class="forecast-row__label">Фактические · ' + esc(forecast.lastMonthLabel) + '</div>' +
          '<div class="forecast-row__track">' +
            '<div class="forecast-row__fill forecast-row__fill--actual" ' +
              'data-target-width="' + actualWidth + '" style="width:0%;"></div>' +
            '<span class="forecast-row__value">' + formatMoney(forecast.lastActual) + '</span>' +
          '</div>' +
        '</div>' +
        '<p class="forecast-row__delta ' + (diff > 0 ? 'forecast-row__delta--up' : 'forecast-row__delta--down') + '">' +
          (diff > 0 ? '▲' : '▼') + ' ' + Math.abs(diffPercent) + '% · ' +
          (diff >= 0 ? '+' : '\u2212') + formatMoney(Math.abs(diff)) +
          ' к прошлому месяцу' +
        '</p>' +
        (forecast.byCategory.length
          ? '<ul class="forecast-cats">' + forecast.byCategory.slice(0, 5).map(function (c) {
              return '<li><span>' + esc(c.name) + '</span><b>' + formatMoney(c.forecast) + '</b></li>';
            }).join('') + '</ul>'
          : '') +
        '<p class="pro-analytics__note">Среднее за ' + forecast.months.length + ' закрытых месяца, ' +
          'без текущих неполных данных.</p>';
    }

    return '<div class="stats-section stats-section--pro pro-analytics" data-pro-only="forecast">' +
      '<h2 class="stats-section__title">Прогноз расходов <span class="pro-badge">PRO</span></h2>' +
      body +
      '</div>';
  }

  function comparisonHtml(cmp) {
    var up = cmp.delta > 0;
    var same = cmp.delta === 0;

    return '<div class="stats-section stats-section--pro pro-analytics" data-pro-only="compare">' +
      '<h2 class="stats-section__title">Сравнить с прошлым месяцем <span class="pro-badge">PRO</span></h2>' +
      '<div class="compare-grid">' +
        '<div class="compare-cell">' +
          '<div class="compare-cell__label">Текущий период</div>' +
          '<div class="compare-cell__value">' + formatMoney(cmp.now) + '</div>' +
          '<div class="compare-cell__hint">' + formatDate(cmp.current.start) + ' — ' + formatDate(cmp.current.end) + '</div>' +
        '</div>' +
        '<div class="compare-cell">' +
          '<div class="compare-cell__label">Прошлый месяц</div>' +
          '<div class="compare-cell__value">' + formatMoney(cmp.before) + '</div>' +
          '<div class="compare-cell__hint">' + formatDate(cmp.previous.start) + ' — ' + formatDate(cmp.previous.end) + '</div>' +
        '</div>' +
        '<div class="compare-cell compare-cell--delta">' +
          '<div class="compare-cell__label">Разница</div>' +
          '<div class="compare-cell__value ' + (same ? '' : (up ? 'compare-cell__value--up' : 'compare-cell__value--down')) + '">' +
            (same ? '0 ₽' : (up ? '+' : '\u2212') + formatMoney(Math.abs(cmp.delta))) +
          '</div>' +
          '<div class="compare-cell__hint">' +
            (cmp.hasBaseline
              ? (same ? 'без изменений' : (up ? '▲ ' : '▼ ') + Math.abs(cmp.percent) + '%')
              : 'нет базы для сравнения') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<p class="pro-analytics__note">Сравниваются одинаковые по длине периоды (' +
        cmp.previous.days + ' дн.), чтобы начало месяца не выглядело «экономией».</p>' +
      '</div>';
  }

  function heatmapHtml(data) {
    // Строки — дни недели, столбцы — недели периода. Порядок в разметке
    // строчный (label + ячейки строки), поэтому сетка остаётся понятной
    // при любом числе столбцов и не требует grid-auto-flow: column.
    var rows = '<div class="heatmap-row heatmap-row--head">' +
        /* Угол сетки: пустая клетка над подписями дней. Отдельный класс,
           а не .heatmap-day, — иначе «день недели» из заголовка попадает
           в список подписей и ломает порядок строки (7 подписей вместо 8
           узлов). */
        '<div class="heatmap-corner" aria-hidden="true"></div>' +
        (function () {
          var out = '';
          for (var c = 0; c < data.columns; c++) {
            out += '<div class="heatmap-col-label">нед.' + (c + 1) + '</div>';
          }
          return out;
        })() +
      '</div>';

    for (var r = 0; r < 7; r++) {
      var cells = '';

      for (var c = 0; c < data.columns; c++) {
        var cell = data.matrix[r][c];
        var level = Math.max(
          intensity(cell.amount, data.maxAmount),
          intensity(cell.tasks, data.maxTasks) * 0.8
        );

        var title = cell.date
          ? WEEKDAYS[r] + ' ' + formatDate(cell.date) + ': ' +
            cell.payments + ' плат. на ' + formatMoney(cell.amount) + ', дел: ' + cell.tasks
          : WEEKDAYS[r] + ': нет данных';

        cells += '<div class="heatmap-cell' + (level > 0 ? ' heatmap-cell--on' : '') + '"' +
          ' style="--heat:' + level.toFixed(2) + '"' +
          ' title="' + escAttr(title) + '"' +
          ' aria-label="' + escAttr(title) + '"></div>';
      }

      rows += '<div class="heatmap-row">' +
        '<div class="heatmap-day">' + WEEKDAYS[r] + '</div>' +
        cells +
        '</div>';
    }

    return '<div class="stats-section stats-section--pro pro-analytics" data-pro-only="heatmap">' +
      '<h2 class="stats-section__title">Динамика по дням недели <span class="pro-badge">PRO</span></h2>' +
      '<div class="heatmap" style="--cols:' + data.columns + '">' +
        rows +
      '</div>' +
      '<div class="heatmap-legend">' +
        '<span>меньше</span>' +
        '<i class="heatmap-cell heatmap-cell--on" style="--heat:0.2"></i>' +
        '<i class="heatmap-cell heatmap-cell--on" style="--heat:0.5"></i>' +
        '<i class="heatmap-cell heatmap-cell--on" style="--heat:0.8"></i>' +
        '<i class="heatmap-cell heatmap-cell--on" style="--heat:1"></i>' +
        '<span>больше</span>' +
      '</div>' +
      '<p class="pro-analytics__note">Строки — дни недели, столбцы — недели выбранного периода. ' +
        'Ячейка темнее, когда в этот день больше платежей и дел.</p>' +
      '</div>';
  }

  /**
   * Блок «Календарь»: экспорт .ics прямо из статистики.
   *
   * Почему это стоит здесь, а не только в настройках: человек смотрит
   * статистику в момент, когда думает о сроках и долгах, — тогда предложение
   * «выгрузить их в календарь» уместно. Настройки он открывает редко.
   * @returns {string}
   */
  function calendarExportHtml() {
    var CE = window.CalendarExport;
    var stale = CE && CE.isStale ? CE.isStale() : true;
    var last = CE && CE.lastExportedAt ? CE.lastExportedAt() : null;

    return '<div class="stats-section stats-section--pro pro-analytics" data-pro-only="calendar">' +
      '<h2 class="stats-section__title">Напоминания в календаре <span class="pro-badge">PRO</span></h2>' +
      '<p class="pro-analytics__note">' +
        'Платежи, дела и сроки документов выгружаются в файл .ics. Добавьте его ' +
        'в Google, Apple или Outlook календарь — напоминание придёт даже с ' +
        'закрытым приложением.' +
      '</p>' +
      '<div class="ics-row">' +
        '<button type="button" class="btn btn--primary" data-stats-action="ics-export">' +
          '<span class="backup-label">Экспорт в календарь</span>' +
        '</button>' +
        '<button type="button" class="btn btn--secondary" data-stats-action="csv-export">' +
          '📊 Таблица Excel (.CSV)' +
        '</button>' +
        '<button type="button" class="btn btn--ghost" data-stats-action="ics-settings">Настройки</button>' +
      '</div>' +
      '<p class="pro-analytics__note" data-stats-ics-status>' +
        (stale
          ? 'Календарь отстаёт от данных — стоит выгрузить заново.'
          : 'Выгружено ' + formatDate(String(last)) + ' — файл актуален.') +
      '</p>' +
      '</div>';
  }

  /**
   * Догружает PRO-блоки аналитики. Рисует только при активном тарифе;
   * для Free не делает ни одного запроса к БД.
   * @returns {Promise<boolean>} добавлены ли блоки
   */
  function renderProAnalytics() {
    var el = getAppEl();
    if (!el) { return Promise.resolve(false); }
    if (!window.ProManager || !window.ProManager.isPro()) { return Promise.resolve(false); }
    if (proLoading) { return Promise.resolve(false); }
    if (el.querySelector('[data-pro-only="forecast"]')) { return Promise.resolve(true); }

    proLoading = true;

    return Promise.all([
      window.DB.getAll('payments'),
      window.DB.getAll('tasks'),
      window.DB.getAll('meters'),
      window.DB.getAll('meter_readings')
    ]).then(function (results) {
      var payments = results[0] || [];
      var tasks = results[1] || [];
      var meters = results[2] || [];
      var readings = results[3] || [];

      proLoading = false;

      // Раздел могли успеть покинуть — не вставляем в чужую разметку
      if (!onStatsScreen()) { return false; }
      if (!el.querySelector('.stats-section') && !el.querySelector('.empty-state')) { return false; }

      var extraProHtml = '';
      if (window.ProAnalyticsPlus) {
        var audit = window.ProAnalyticsPlus.auditUtilities(meters, readings);
        var cashFlow = window.ProAnalyticsPlus.buildCashFlowCalendar(payments);
        extraProHtml = window.ProAnalyticsPlus.renderProPlusHtml(audit, cashFlow);
      }

      var valuePackHtml = '';
      if (window.ValuePack) {
        valuePackHtml =
          (window.ValuePack.renderSubscriptionInspectorHtml ? window.ValuePack.renderSubscriptionInspectorHtml(payments) : '') +
          (window.ValuePack.renderSavingsGoalHtml ? window.ValuePack.renderSavingsGoalHtml() : '');
      }

      var smartRadarSectionHtml = (window.SmartRadar
        ? '<div class="stats-section stats-section--pro pro-analytics" data-pro-only="smart-radar">' +
            '<h2 class="stats-section__title">Умный финансовый радар <span class="pro-badge">PRO</span></h2>' +
            '<div id="stats-smart-radar-content"></div>' +
          '</div>'
        : '');

      var holder = document.createElement('div');
      holder.innerHTML =
        forecastHtml(buildForecast(payments)) +
        comparisonHtml(buildComparison(payments)) +
        heatmapHtml(buildWeekdayMatrix(payments, tasks)) +
        smartRadarSectionHtml +
        extraProHtml +
        valuePackHtml +
        calendarExportHtml();

      var nodes = [].slice.call(holder.children);
      for (var i = 0; i < nodes.length; i++) { el.appendChild(nodes[i]); }

      if (window.SmartRadar && window.SmartRadar.insights) {
        window.SmartRadar.insights().then(function (ins) {
          var rBox = document.getElementById('stats-smart-radar-content');
          if (rBox) {
            rBox.innerHTML = window.SmartRadar.radarHtml(ins);
          }
        });
      }

      var fills = el.querySelectorAll('[data-target-width]');
      /* Ширину ставим в СЛЕДУЮЩЕМ кадре: если присвоить её сразу после
         insertAdjacent, браузер ещё не отрисовал состояние width:0% и
         transition не срабатывает — бары появились бы «мгновенно», а
         шкала прогноза задумана именно как анимация сравнения. */
      requestAnimationFrame(function () {
        for (var j = 0; j < fills.length; j++) {
          fills[j].style.width = fills[j].getAttribute('data-target-width') + '%';
        }
      });

      console.info('[Stats] PRO-аналитика догружена.');
      return true;
    }).catch(function (err) {
      proLoading = false;
      console.info('[Stats] PRO-аналитика не догрузилась:', err && err.message || err);
      return false;
    });
  }

  /* ================================================================
     6. ДЕЛЕГИРОВАНИЕ СОБЫТИЙ (data-stats-*)
     ================================================================ */

  /**
   * Экспорт .ics из статистики. Тот же календарный модуль, что и в
   * «Резервных копиях», — две кнопки, один источник правды.
   * @param {HTMLElement} btn
   */
  function handleIcsExport(btn) {
    var el = getAppEl();
    if (!el) { return; }

    if (!window.ProManager || !window.ProManager.isPro()) {
      if (window.VK && window.VK.notify) {
        window.VK.notify('Экспорт в календарь доступен только в PRO', 'info');
      }
      return;
    }
    if (!window.CalendarExport) {
      setStatus('Модуль экспорта не загружен.', true);
      return;
    }

    var label = btn.querySelector('.backup-label');
    var original = label ? label.textContent : '';
    if (label) { label.textContent = 'Собираем…'; }
    btn.disabled = true;

    window.CalendarExport.exportNow().then(function (res) {
      setStatus('Файл ' + res.fileName + ' скачан — добавьте его в календарь телефона.', false);
      var line = el.querySelector('[data-stats-ics-status]');
      if (line) { line.textContent = 'Выгружено только что — файл актуален.'; }
    }).catch(function (err) {
      setStatus('Экспорт не удался: ' + (err && err.message || err), true);
    }).finally(function () {
      btn.disabled = false;
      if (label) { label.textContent = original; }
    });
  }

  /**
   * Подпись под кнопками экспорта.
   * @param {string} text
   * @param {boolean} failed
   */
  function setStatus(text, failed) {
    var el = getAppEl();
    var line = el && el.querySelector('[data-stats-ics-status]');
    if (!line) { return; }
    line.textContent = text;
    line.classList.toggle('is-error', !!failed);
  }

  function onAppClick(e) {
    if (!e.target.closest) { return; }

    var savingsEl = e.target.closest('[data-savings-action]');
    if (savingsEl && window.ValuePack && window.ValuePack.openSavingsGoalModal) {
      var sAct = savingsEl.getAttribute('data-savings-action');
      window.ValuePack.openSavingsGoalModal(sAct, function () { render(); });
      return;
    }

    var actionEl = e.target.closest('[data-stats-action]');
    if (actionEl) {
      var action = actionEl.getAttribute('data-stats-action');
      if (action === 'retry') { render(); }
      else if (action === 'go-home') { window.location.hash = 'home'; }
      else if (action === 'ics-export') { handleIcsExport(actionEl); }
      else if (action === 'csv-export' && window.ValuePack) { window.ValuePack.downloadCsv(); }
      else if (action === 'ics-settings') { window.location.hash = 'backup'; }
      return;
    }

    var periodBtn = e.target.closest('[data-stats-period]');
    if (periodBtn) {
      activePeriod = periodBtn.getAttribute('data-stats-period');
      localStorage.setItem(STORAGE_KEY, activePeriod);
      render();
    }
  }

  /* ================================================================
     7. ИНИЦИАЛИЗАЦИЯ И ПУБЛИЧНЫЙ API
     ================================================================ */

  function init() {
    if (listenersBound) return;
    var el = getAppEl();
    if (!el) return;

    el.addEventListener('click', onAppClick);
    listenersBound = true;
    console.info('[Stats] Делегаты событий привязаны.');
  }

  window.Stats = {
    init: init,
    render: render,
    getPaymentStats: getPaymentStats,
    getTaskStats: getTaskStats,
    getDocumentStats: getDocumentStats,
    getMeterStats: getMeterStats,
    formatMoney: formatMoney,
    formatDate: formatDate,

    // Этап 12.5 (PRO)
    renderProAnalytics: renderProAnalytics,
    buildForecast: buildForecast,
    buildComparison: buildComparison,
    buildWeekdayMatrix: buildWeekdayMatrix,
    lastClosedMonths: lastClosedMonths,
    getPeriodRange: getPeriodRange
  };

  console.info('[Stats] Модуль загружен. API: window.Stats');
})();
