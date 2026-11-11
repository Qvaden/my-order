/**
 * МОЙ ПОРЯДОК — Раздел «Счётчики» (Этап 5)
 *
 * Учёт показаний счётчиков: холодная/горячая вода, электричество, газ.
 * Карточки счётчиков с текущим показанием и расходом, форма счётчика,
 * форма показания с живым расходом и валидацией monotонности,
 * история показаний с удалением, каскадное удаление счётчика.
 *
 * Хранилища DB: 'meters' + 'meter_readings'.
 * Все операции только через window.DB.
 *
 * Экспортирует window.Meters.
 */

(function () {
  'use strict';

  /* ================================================================
     1. КОНСТАНТЫ
     ================================================================ */

  /** @const {string} Хранилище счётчиков */
  var STORE_METERS = 'meters';

  /** @const {string} Хранилище показаний */
  var STORE_READINGS = 'meter_readings';

  /**
   * Типы счётчиков: подпись, цвета бейджа, единица по умолчанию.
   * @const {Array<{type: string, label: string, bg: string, fg: string, unit: string}>}
   */
  var METER_TYPES = [
    { type: 'cold',        label: 'Холодная вода', bg: '#DBEAFE', fg: '#1D4ED8', unit: 'м³' },
    { type: 'hot',         label: 'Горячая вода',  bg: '#FEE2E2', fg: '#B91C1C', unit: 'м³' },
    { type: 'electricity', label: 'Электричество', bg: '#FEF9C3', fg: '#A16207', unit: 'кВт·ч' },
    { type: 'gas',         label: 'Газ',           bg: '#FFEDD5', fg: '#C2410C', unit: 'м³' },
    { type: 'other',       label: 'Другое',        bg: '#E2E8F0', fg: '#475569', unit: '' }
  ];

  /** @const {number} Расход больше среднего × N считается аномальным */
  var ANOMALY_FACTOR = 3;

  /** @const {string} SVG-иконка корзины */
  var ICON_TRASH =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="3 6 5 6 21 6"/>' +
    '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

  /** @const {string} SVG-иконка часов (история) */
  var ICON_HISTORY =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>' +
    '<path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>';

  /** @const {string} SVG-стрелка «назад» */
  var ICON_BACK =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>';

  /* ================================================================
     2. СОСТОЯНИЕ МОДУЛЯ
     ================================================================ */

  /** @type {Array<Object>} Все счётчики */
  var meters = [];

  /** @type {Array<Object>} Все показания (все счётчики) */
  var allReadings = [];

  /** @type {boolean} Идёт загрузка (показан skeleton) */
  var loading = false;

  /** @type {boolean} Привязаны ли делегаты */
  var listenersBound = false;

  /** @returns {HTMLElement} Контейнер разделов */
  function appEl() {
    return document.getElementById('app');
  }

  /* ================================================================
     3. УТИЛИТЫ ФОРМАТИРОВАНИЯ
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
   * ISO-дата → ДД.ММ.ГГГГ.
   * @param {string|null} iso
   * @returns {string}
   */
  function formatDate(iso) {
    if (!iso) { return '—'; }
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return '—'; }
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

  /** Конфигурация типа по ключу */
  function typeConfig(type) {
    for (var i = 0; i < METER_TYPES.length; i++) {
      if (METER_TYPES[i].type === type) { return METER_TYPES[i]; }
    }
    return null;
  }

  /**
   * Цвета бейджа типа счётчика.
   * @param {string} type
   * @returns {{bg: string, fg: string}}
   */
  function getTypeColor(type) {
    var t = typeConfig(type);
    return t ? { bg: t.bg, fg: t.fg } : { bg: '#E2E8F0', fg: '#475569' };
  }

  /** Подпись типа */
  function getTypeLabel(type) {
    var t = typeConfig(type);
    return t ? t.label : (type || 'Другое');
  }

  /** Единица измерения по умолчанию для типа */
  function getTypeUnit(type) {
    var t = typeConfig(type);
    return t ? t.unit : '';
  }

  /**
   * Итоговая единица конкретного счётчика: сохранённая или по типу.
   * @param {Object} meter
   * @returns {string}
   */
  function unitFor(meter) {
    if (meter && typeof meter.unit === 'string') { return meter.unit; }
    return meter ? getTypeUnit(meter.type) : '';
  }

  /**
   * Показание с единицей: formatReading(123, 'м³') → '123 м³'.
   * Вторым аргументом можно передать тип — подставится его единица.
   * @param {number|string} value
   * @param {string} unitOrType
   * @returns {string}
   */
  function formatReading(value, unitOrType) {
    var num = typeof value === 'number' ? value : parseFloat(String(value).replace(',', '.'));
    if (value === null || value === undefined || isNaN(num)) { return '—'; }
    var unit = typeConfig(unitOrType) ? getTypeUnit(unitOrType) : (unitOrType || '');
    return String(num) + (unit ? ' ' + unit : '');
  }

  /**
   * Расход: formatConsumption(12, 'м³') → '+12 м³', 0 → '0 м³'.
   * @param {number} value
   * @param {string} unitOrType
   * @returns {string}
   */
  function formatConsumption(value, unitOrType) {
    if (typeof value !== 'number' || isNaN(value)) { return '—'; }
    var unit = typeConfig(unitOrType) ? getTypeUnit(unitOrType) : (unitOrType || '');
    var sign = value > 0 ? '+' : '';
    return sign + String(value) + (unit ? ' ' + unit : '');
  }

  /**
   * Разбирает десятичное число с одной цифрой после разделителя.
   * Принимает и запятую, и точку. 123 → 123; 12,5 → 12.5; '12,75' → null.
   * @param {string} raw
   * @returns {number|null}
   */
  function parseDecimal(raw) {
    if (raw === null || raw === undefined) { return null; }
    var str = String(raw).trim().replace(',', '.');
    if (!/^\d+(\.\d)?$/.test(str)) { return null; }
    var num = parseFloat(str);
    return isNaN(num) ? null : num;
  }

  /* ================================================================
     4. РАБОТА С ДАННЫМИ
     ================================================================ */

  /** Счётчик по id из кэша */
  function findMeter(id) {
    for (var i = 0; i < meters.length; i++) {
      if (meters[i].id === id) { return meters[i]; }
    }
    return null;
  }

  /**
   * Показания счётчика, отсортированные по дате desc (новые сверху).
   * @param {number} meterId
   * @returns {Array<Object>}
   */
  function readingsOf(meterId) {
    return allReadings
      .filter(function (r) { return r.meterId === meterId; })
      .sort(function (a, b) {
        var cmp = String(b.date).localeCompare(String(a.date));
        // При одинаковых датах — по id (последнее добавление сверху)
        return cmp !== 0 ? cmp : b.id - a.id;
      });
  }

  /**
   * Значение, от которого считаем расход: последнее показание,
   * а если показаний нет — начальное показание счётчика.
   * @param {Object} meter
   * @param {Array<Object>} readingsDesc — readingsOf(meter.id)
   * @returns {{value: number|null, isInitial: boolean}}
   */
  function previousValue(meter, readingsDesc) {
    if (readingsDesc.length > 0) {
      return { value: readingsDesc[0].value, isInitial: false };
    }
    var init = typeof meter.initialValue === 'number' ? meter.initialValue : null;
    return { value: init, isInitial: true };
  }

  /**
   * Средний расход по последним разностям (до 3 последних показаний).
   * @param {Array<Object>} readingsDesc
   * @param {number|null} initialValue
   * @returns {number|null}
   */
  function avgConsumption(readingsDesc, initialValue) {
    if (readingsDesc.length === 0) { return null; }

    // Цепочка значений: новые → старые, в конце начальное (если есть)
    var values = readingsDesc.map(function (r) { return r.value; });
    if (typeof initialValue === 'number') { values.push(initialValue); }

    // Берём не больше 4 значений → не больше 3 разностей
    var window_ = values.slice(0, 4);
    if (window_.length < 2) { return null; }

    var sum = 0;
    for (var i = 1; i < window_.length; i++) {
      var diff = window_[i - 1] - window_[i];
      sum += diff > 0 ? diff : 0; // откаты не участвуют в среднем
    }
    return sum / (window_.length - 1);
  }

  /** Аномален ли расход (> среднего × ANOMALY_FACTOR) */
  function isAnomalous(consumption, readingsDesc, initialValue) {
    if (!(consumption > 0)) { return false; }
    var avg = avgConsumption(readingsDesc, initialValue);
    if (!avg || avg <= 0) { return false; }
    return consumption > avg * ANOMALY_FACTOR;
  }

  /** Читает счётчики и показания в кэш состояния */
  function loadData() {
    return Promise.all([
      DB.getAll(STORE_METERS).then(function (rows) { meters = rows || []; }),
      DB.getAll(STORE_READINGS).then(function (rows) { allReadings = rows || []; })
    ]);
  }

  /* ================================================================
     5. РЕНДЕР
     ================================================================ */

  /** Skeleton списка счётчиков */
  function skeletonHtml() {
    var cards = '';
    for (var i = 0; i < 3; i++) {
      cards +=
        '<div class="card">' +
          '<div class="flex items-center gap-3">' +
            '<div class="flex flex-col gap-2" style="flex: 1;">' +
              '<div class="skeleton skeleton--text" style="width: ' + (45 + i * 12) + '%;"></div>' +
              '<div class="skeleton skeleton--text" style="width: 30%;"></div>' +
            '</div>' +
            '<div class="skeleton skeleton--text" style="width: 22%; height: 26px;"></div>' +
          '</div>' +
        '</div>';
    }

    return '<div class="header-actions">' +
        '<h1 class="page-header">Счётчики</h1>' +
        '<div class="skeleton" style="width: 48px; height: 48px; border-radius: var(--radius-full);"></div>' +
      '</div>' +
      '<div class="flex flex-col gap-3">' + cards + '</div>';
  }

  /** Empty state раздела */
  function emptyHtml() {
    return '<section class="empty-state">' +
      '<div class="empty-state__icon" aria-hidden="true">⏱️</div>' +
      '<h2 class="empty-state__title">Пока нет счётчиков</h2>' +
      '<p class="empty-state__text">Добавь первый счётчик — например холодную воду — и передавай показания вовремя.</p>' +
      '<button type="button" class="btn btn--primary" data-action="add-meter">Добавить счётчик</button>' +
      '</section>';
  }

  /** Сообщение об ошибке загрузки */
  function errorHtml(message) {
    return '<div class="header-actions">' +
        '<h1 class="page-header">Счётчики</h1>' +
      '</div>' +
      '<section class="empty-state">' +
        '<div class="empty-state__icon" aria-hidden="true">⚠️</div>' +
        '<h2 class="empty-state__title">Не удалось загрузить счётчики</h2>' +
        '<p class="empty-state__text">' + esc(message) + '</p>' +
        '<button type="button" class="btn btn--primary" data-action="retry">Попробовать снова</button>' +
      '</section>';
  }

  /**
   * HTML карточки счётчика.
   * @param {Object} meter
   * @returns {string}
   */
  function meterCardHtml(meter) {
    var readings = readingsOf(meter.id);
    var last = readings.length ? readings[0] : null;
    var prev = previousValue(meter, readings);
    var unit = unitFor(meter);
    var colors = getTypeColor(meter.type);

    // Текущее показание: последнее или начальное
    var currentDisplay = prev.value !== null
      ? formatReading(prev.value, unit)
      : '—';

    // Расход с прошлого раза: только если есть хотя бы одно показание
    var consumptionHtml = '';
    var deltaForTariff = 0;
    if (last && readings.length >= 2 || (last && prev.isInitial === false && readings.length >= 2)) {
      // расход между последними двумя показаниями
      var cons = readings[0].value - readings[1].value;
      deltaForTariff = cons > 0 ? cons : 0;
      var anomalous = isAnomalous(cons, readings, meter.initialValue);
      var costBadge = (window.ValuePack && deltaForTariff > 0)
        ? ' · <strong>' + String(window.ValuePack.calcConsumptionRub(meter, deltaForTariff)).replace('.', ',') + '\u00A0\u20BD</strong>'
        : '';
      consumptionHtml =
        '<span class="consumption-badge ' + (anomalous ? 'consumption-badge--warn' : 'consumption-badge--ok') + '">' +
          formatConsumption(cons, unit) + ' за период' + costBadge +
        '</span>';
    } else if (last && typeof meter.initialValue === 'number') {
      // Одно показание: расход от начального
      var cons0 = last.value - meter.initialValue;
      if (cons0 >= 0) {
        deltaForTariff = cons0;
        var costBadge0 = (window.ValuePack && deltaForTariff > 0)
          ? ' · <strong>' + String(window.ValuePack.calcConsumptionRub(meter, deltaForTariff)).replace('.', ',') + '\u00A0\u20BD</strong>'
          : '';
        consumptionHtml =
          '<span class="consumption-badge consumption-badge--ok">' +
            formatConsumption(cons0, unit) + ' с начала учёта' + costBadge0 +
          '</span>';
      }
    }

    var lastDateHtml = last
      ? '<span class="meter-card__date">' + formatDate(last.date) + '</span>'
      : '<span class="meter-card__date">показаний ещё не было</span>';

    return '' +
    '<article class="card meter-card" data-id="' + meter.id + '" tabindex="0" role="button" ' +
      'aria-label="Счётчик «' + esc(meter.name) + '», ' + currentDisplay + '. Нажми, чтобы добавить показание.">' +

      '<div class="meter-card__top">' +
        '<div class="meter-card__info">' +
          '<h3 class="meter-card__name">' + esc(meter.name) + '</h3>' +
          '<div class="meter-card__meta">' +
            '<span class="badge" style="background: ' + colors.bg + '; color: ' + colors.fg +
              '; --badge-fg: ' + colors.fg + ';">' +
              esc(getTypeLabel(meter.type)) +
            '</span>' +
            lastDateHtml +
            (window.FamilyUI ? window.FamilyUI.badgeHtml(meter) : '') +
          '</div>' +
        '</div>' +
        '<div class="meter-card__reading">' + currentDisplay + '</div>' +
      '</div>' +

      (consumptionHtml ? '<div>' + consumptionHtml + '</div>' : '') +

      '<div class="meter-card__actions">' +
        '<button type="button" class="btn btn--secondary btn--sm" data-action="add-reading" data-id="' + meter.id + '" ' +
          'aria-label="Добавить показание для «' + esc(meter.name) + '»">+ Показание</button>' +
        '<button type="button" class="icon-btn" data-action="history" data-id="' + meter.id + '" ' +
          'aria-label="История показаний «' + esc(meter.name) + '»">' + ICON_HISTORY + '</button>' +
        '<button type="button" class="icon-btn" data-action="delete-meter" data-id="' + meter.id + '" ' +
          'aria-label="Удалить счётчик «' + esc(meter.name) + '»">' + ICON_TRASH + '</button>' +
      '</div>' +
    '</article>';
  }

  /** Разрисовывает список счётчиков */
  function paint() {
    var el = appEl();
    if (!el) { return; }

    var visibleMeters = meters.filter(function (m) {
      return !(window.FamilyUI && window.FamilyUI.isHidden(m));
    });

    var toolbarHtml = (visibleMeters.length > 0 && window.ValuePack && window.ValuePack.renderMetersToolbarHtml)
      ? window.ValuePack.renderMetersToolbarHtml(visibleMeters, allReadings)
      : '';

    var body = visibleMeters.length === 0
      ? emptyHtml()
      : toolbarHtml + '<div class="flex flex-col gap-3">' + visibleMeters.map(meterCardHtml).join('') + '</div>';

    el.innerHTML = '' +
      '<div class="header-actions">' +
        '<h1 class="page-header">Счётчики</h1>' +
        '<button type="button" class="btn btn--primary btn--icon" data-action="add-meter" aria-label="Добавить счётчик">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
        '</button>' +
      '</div>' + body;
  }

  /**
   * Рендер раздела: skeleton → данные → контент.
   */
  function render() {
    var el = appEl();
    if (!el) { return; }

    init();

    if (meters.length > 0) {
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
      console.error('[Meters] Ошибка загрузки:', err);
      el.innerHTML = errorHtml(err.message);
    });
  }

  /** Сброс кэша — вызывается роутером при входе в раздел */
  function invalidate() {
    meters = [];
    allReadings = [];
    loading = false;
  }

  /* ================================================================
     6. МОДАЛЬНОЕ ОКНО (те же паттерны, что в payments.js)
     ================================================================ */

  /**
   * Создаёт overlay с карточкой, запускает анимацию появления.
   * @param {string} innerHtml — содержимое карточки
   * @param {function(HTMLElement, function(): void): void} onMount
   */
  function openModal(innerHtml, onMount) {
    // Защита от «стопки» одинаковых диалогов (Этап 11, баг №6): быстрый
    // повторный клик по той же кнопке открывал несколько идентичных окон,
    // и закрытие одного оставляло висеть остальные. Диалог с тем же
    // содержимым, который уже открыт, повторно не открываем. Разные
    // диалоги (история показаний → подтверждение удаления) наслаиваются
    // по-прежнему, потому что их разметка различается.
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

    // Escape закрывает только верхнюю (последнюю открытую) модалку
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
     7. ФОРМА СЧЁТЧИКА
     ================================================================ */

  /**
   * Разметка формы добавления счётчика.
   * @returns {string}
   */
  function meterFormHtml() {
    var typeOptions = METER_TYPES.map(function (t) {
      return '<option value="' + t.type + '">' + esc(t.label) + '</option>';
    }).join('');

    return '' +
      '<h2 class="modal-content__title">Новый счётчик</h2>' +

      '<form id="meter-form" novalidate>' +
        '<div class="form-group">' +
          '<label class="form-label" for="f-name">Название</label>' +
          '<input class="form-input" id="f-name" name="name" type="text" maxlength="100" ' +
            'autocomplete="off" placeholder="Холодная вода в ванной">' +
          '<div class="form-error" id="e-name"></div>' +
        '</div>' +

        '<div class="form-group">' +
          '<label class="form-label" for="f-type">Тип</label>' +
          '<select class="form-select" id="f-type" name="type">' + typeOptions + '</select>' +
          '<div class="form-error" id="e-type"></div>' +
        '</div>' +

        '<div class="form-group">' +
          '<label class="form-label" for="f-unit">Единица измерения</label>' +
          '<input class="form-input" id="f-unit" name="unit" type="text" maxlength="10" ' +
            'autocomplete="off" placeholder="м³" value="' + METER_TYPES[0].unit + '">' +
          '<div class="form-error" id="e-unit"></div>' +
        '</div>' +

        '<div class="form-group">' +
          '<label class="form-label" for="f-initial">Начальное показание</label>' +
          '<input class="form-input" id="f-initial" name="initial" type="text" inputmode="decimal" ' +
            'autocomplete="off" placeholder="0" value="0">' +
          '<div class="form-error" id="e-initial"></div>' +
        '</div>' +

        '<div class="form-error" id="e-save" role="alert"></div>' +

        '<div class="flex gap-3 mt-4">' +
          '<button type="button" class="btn btn--secondary" style="flex: 1;" data-action="cancel">Отмена</button>' +
          '<button type="submit" class="btn btn--primary" style="flex: 1;">Сохранить</button>' +
        '</div>' +
      '</form>';
  }

  /** Открывает форму добавления счётчика */
  function openAddMeterForm() {
    openModal(meterFormHtml(), bindMeterForm);
  }

  /**
   * Привязывает обработчики формы счётчика.
   * @param {HTMLElement} card
   * @param {function(): void} close
   */
  function bindMeterForm(card, close) {
    var typeSelect = card.querySelector('#f-type');
    var unitInput = card.querySelector('#f-unit');

    // Единица подставляется по типу, пока пользователь не вписал свою
    typeSelect.addEventListener('change', function () {
      if (unitInput.dataset.touched !== '1') {
        unitInput.value = getTypeUnit(typeSelect.value);
      }
    });
    unitInput.addEventListener('input', function () {
      unitInput.dataset.touched = '1';
      unitInput.classList.remove('is-invalid');
      card.querySelector('#e-unit').textContent = '';
    });

    ['name', 'initial'].forEach(function (name) {
      var input = card.querySelector('[name="' + name + '"]');
      input.addEventListener('input', function () {
        input.classList.remove('is-invalid');
        card.querySelector('#e-' + name).textContent = '';
      });
    });

    card.querySelector('[data-action="cancel"]').addEventListener('click', close);

    card.querySelector('#meter-form').addEventListener('submit', function (e) {
      e.preventDefault();
      saveMeter(card, close);
    });

    setTimeout(function () {
      card.querySelector('#f-name').focus();
    }, 260);
  }

  /**
   * Валидирует форму счётчика.
   * @param {HTMLElement} card
   * @returns {Object|null}
   */
  function readMeterForm(card) {
    var ok = true;

    function fail(name, message) {
      var input = card.querySelector('[name="' + name + '"]');
      if (input) { input.classList.add('is-invalid'); }
      card.querySelector('#e-' + name).textContent = message;
      ok = false;
    }

    var name = card.querySelector('[name="name"]').value.trim();
    var type = card.querySelector('[name="type"]').value;
    var unit = card.querySelector('[name="unit"]').value.trim();
    var rawInitial = card.querySelector('[name="initial"]').value.trim();

    if (!name) {
      fail('name', 'Укажи название счётчика');
    } else if (name.length > 100) {
      fail('name', 'Не длиннее 100 символов');
    }

    if (!typeConfig(type)) { fail('type', 'Выбери тип счётчика'); }

    // Начальное показание: optional, default 0, >= 0, ≤ 1 знака
    var initial = 0;
    if (rawInitial !== '') {
      var parsed = parseDecimal(rawInitial);
      if (parsed === null) {
        fail('initial', 'Число, не больше одного знака после запятой');
      } else if (parsed < 0) {
        fail('initial', 'Начальное показание не может быть отрицательным');
      } else {
        initial = parsed;
      }
    }

    if (unit.length > 10) { fail('unit', 'Не длиннее 10 символов'); }

    if (!ok) { return null; }

    return {
      name: name,
      type: type,
      unit: unit,
      initialValue: initial
    };
  }

  /**
   * Сохраняет новый счётчик в БД.
   * @param {HTMLElement} card
   * @param {function(): void} close
   */
  function saveMeter(card, close) {
    var data = readMeterForm(card);
    if (!data) { return; }

    if (window.Family && window.Family.stampScope) {
      window.Family.stampScope(data, STORE_METERS, false);
    }

    DB.add(STORE_METERS, data).then(function () {
      close();
      return loadData();
    }).then(function () {
      paint();
    }).catch(function (err) {
      console.error('[Meters] Ошибка сохранения счётчика:', err);
      card.querySelector('#e-save').textContent = 'Не удалось сохранить: ' + err.message;
    });
  }

  /* ================================================================
     8. ФОРМА ПОКАЗАНИЯ
     ================================================================ */

  /**
   * Разметка формы добавления показания.
   * @param {Object} meter
   * @param {number|null} prevValue — значение для отсчёта расхода
   * @param {boolean} isInitial — prevValue это начальное показание?
   * @param {number|null} avg — средний расход или null
   * @param {string} unit
   * @returns {string}
   */
  function readingFormHtml(meter, prevValue, isInitial, avg, unit) {
    var prevDisplay = prevValue !== null ? formatReading(prevValue, unit) : '—';
    var prevLabel = prevValue !== null
      ? (isInitial ? 'Начальное: <strong>' + prevDisplay + '</strong>' : 'Последнее: <strong>' + prevDisplay + '</strong>')
      : 'Показаний ещё нет';
    var avgDisplay = avg !== null ? formatReading(Math.round(avg * 10) / 10, unit) : '—';

    return '' +
      '<h2 class="modal-content__title">Новое показание</h2>' +
      '<p class="modal-content__text mb-4">' + esc(meter.name) + ' · ' + esc(getTypeLabel(meter.type)) + '</p>' +

      '<div class="reading-context mb-4">' +
        '<span>' + prevLabel + '</span>' +
        '<span>Средний расход: <strong>' + avgDisplay + '</strong></span>' +
      '</div>' +

      '<form id="reading-form" novalidate>' +
        '<div class="form-group">' +
          '<label class="form-label" for="f-value">Текущее показание' + (unit ? ' (' + esc(unit) + ')' : '') + '</label>' +
          '<input class="form-input" id="f-value" name="value" type="text" inputmode="decimal" ' +
            'autocomplete="off" placeholder="Например: ' + (prevValue !== null ? prevValue + 5 : '105') + '" ' +
            'aria-describedby="e-value">' +
          '<div class="form-error" id="e-value"></div>' +
        '</div>' +

        '<div class="form-group">' +
          '<label class="form-label" for="f-rdate">Дата показания</label>' +
          '<input class="form-input" id="f-rdate" name="date" type="date" value="' + todayISO() + '">' +
          '<div class="form-error" id="e-date"></div>' +
        '</div>' +

        '<div class="form-error" id="e-preview" role="status" style="min-height: 1.5rem;"></div>' +
        '<div class="form-error" id="e-save" role="alert"></div>' +

        '<div class="flex gap-3 mt-4">' +
          '<button type="button" class="btn btn--secondary" style="flex: 1;" data-action="cancel">Отмена</button>' +
          '<button type="submit" class="btn btn--primary" style="flex: 1;">Сохранить</button>' +
        '</div>' +
      '</form>';
  }

  /**
   * Открывает форму добавления показания.
   * @param {number} meterId
   */
  function openAddReadingForm(meterId) {
    var meter = findMeter(meterId);
    if (!meter) {
      console.warn('[Meters] Счётчик не найден:', meterId);
      return;
    }

    var readings = readingsOf(meterId);
    var prev = previousValue(meter, readings);
    var avg = avgConsumption(readings, meter.initialValue);
    var unit = unitFor(meter);

    openModal(readingFormHtml(meter, prev.value, prev.isInitial, avg, unit), function (card, close) {
      var valueInput = card.querySelector('#f-value');
      var previewBox = card.querySelector('#e-preview');

      // Живой расчёт расхода при вводе
      valueInput.addEventListener('input', function () {
        valueInput.classList.remove('is-invalid');
        card.querySelector('#e-value').textContent = '';
        card.querySelector('#e-save').textContent = '';

        var value = parseDecimal(valueInput.value);
        previewBox.textContent = '';
        previewBox.className = 'form-error';

        if (value === null) { return; }

        if (prev.value !== null && value < prev.value) {
          previewBox.textContent = 'Меньше предыдущего (' + formatReading(prev.value, unit) + ') — сохранить нельзя';
          previewBox.classList.add('error-text');
          return;
        }

        var cons = prev.value !== null ? Math.round((value - prev.value) * 10) / 10 : null;
        if (cons === null) { return; }

        if (isAnomalous(cons, readings, meter.initialValue)) {
          previewBox.textContent = 'Расход ' + formatConsumption(cons, unit) +
            ' — аномально много (средний ' + formatReading(Math.round((avg || 0) * 10) / 10, unit) +
            '). Проверь, верно ли переписано.';
          previewBox.classList.add('warning-text');
        } else {
          previewBox.textContent = 'Расход за период: ' + formatConsumption(cons, unit);
          previewBox.classList.add('success-text');
        }
      });

      ['value', 'date'].forEach(function (name) {
        var input = card.querySelector('[name="' + name + '"]');
        input.addEventListener('input', function () {
          input.classList.remove('is-invalid');
          card.querySelector('#e-' + name).textContent = '';
        });
      });

      card.querySelector('[data-action="cancel"]').addEventListener('click', close);

      card.querySelector('#reading-form').addEventListener('submit', function (e) {
        e.preventDefault();
        saveReading(meterId, card, close);
      });

      setTimeout(function () {
        valueInput.focus();
      }, 260);
    });
  }

  /**
   * Валидирует и сохраняет показание.
   * @param {number} meterId
   * @param {HTMLElement} card
   * @param {function(): void} close
   */
  function saveReading(meterId, card, close) {
    var meter = findMeter(meterId);
    if (!meter) { return; }

    var readings = readingsOf(meterId);
    var prev = previousValue(meter, readings);
    var unit = unitFor(meter);
    var ok = true;

    function fail(name, message) {
      var input = card.querySelector('[name="' + name + '"]');
      if (input) { input.classList.add('is-invalid'); }
      card.querySelector('#e-' + name).textContent = message;
      ok = false;
    }

    var rawValue = card.querySelector('[name="value"]').value.trim();
    var date = card.querySelector('[name="date"]').value;

    var value = parseDecimal(rawValue);
    if (!rawValue) {
      fail('value', 'Введи текущее показание');
    } else if (value === null) {
      fail('value', 'Число, не больше одного знака после запятой');
    } else if (value < 0) {
      fail('value', 'Показание не может быть отрицательным');
    } else if (prev.value !== null && value < prev.value) {
      // КРИТИЧЕСКАЯ ВАЛИДАЦИЯ из ТЗ
      fail('value', 'Новое показание не может быть меньше предыдущего (' +
        formatReading(prev.value, unit) + '). Если счётчик заменён — удалите старые ' +
        'показания или создайте новый счётчик.');
    }

    if (!date) {
      fail('date', 'Выбери дату показания');
    } else if (isNaN(new Date(date).getTime())) {
      fail('date', 'Некорректная дата');
    }

    if (!ok) { return; }

    // Расход: от последнего показания или от начального значения
    var consumption = prev.value !== null ? Math.round((value - prev.value) * 10) / 10 : 0;

    var readingData = {
      meterId: meterId,
      value: value,          // number (integer или 1 знак после запятой)
      date: date,            // YYYY-MM-DD, ISO
      consumption: consumption
    };
    if (window.Family && window.Family.stampScope) {
      window.Family.stampScope(readingData, STORE_READINGS, false);
    }

    DB.add(STORE_READINGS, readingData).then(function () {
      close();
      return loadData();
    }).then(function () {
      paint();
    }).catch(function (err) {
      console.error('[Meters] Ошибка сохранения показания:', err);
      card.querySelector('#e-save').textContent = 'Не удалось сохранить: ' + err.message;
    });
  }

  /* ================================================================
     9. ИСТОРИЯ ПОКАЗАНИЙ
     ================================================================ */

  /**
   * Разметка таблицы истории.
   * @param {Object} meter
   * @param {Array<Object>} readingsDesc
   * @returns {string}
   */
  function historyHtml(meter, readingsDesc) {
    var unit = unitFor(meter);

    var rows = readingsDesc.map(function (r, idx) {
      // Расход: значение минус следующее по старости показание,
      // для самого старого — минус начальное показание счётчика
      var older = idx + 1 < readingsDesc.length ? readingsDesc[idx + 1].value : meter.initialValue;
      var hasBase = typeof older === 'number';
      var cons = hasBase ? Math.round((r.value - older) * 10) / 10 : null;

      var consHtml;
      if (cons === null) {
        consHtml = '—';
      } else if (isAnomalous(cons, readingsDesc.slice(idx), meter.initialValue)) {
        consHtml = '<span class="consumption-badge consumption-badge--warn">' + formatConsumption(cons, unit) + '</span>';
      } else {
        consHtml = '<span class="consumption-badge consumption-badge--ok">' + formatConsumption(cons, unit) + '</span>';
      }

      return '<tr>' +
        '<td class="reading-history__date">' + formatDate(r.date) + '</td>' +
        '<td class="reading-history__value">' + formatReading(r.value, unit) + '</td>' +
        '<td>' + consHtml + '</td>' +
        '<td><button type="button" class="icon-btn" data-action="del-reading" data-id="' + r.id + '" ' +
          'aria-label="Удалить показание от ' + formatDate(r.date) + '">' + ICON_TRASH + '</button></td>' +
      '</tr>';
    }).join('');

    var table = readingsDesc.length === 0
      ? '<p class="text-secondary text-center" style="padding: var(--space-6);">Показаний ещё нет.</p>'
      : '<div class="reading-history__scroll"><table class="reading-history">' +
          '<thead><tr><th>Дата</th><th>Показание</th><th>Расход</th><th></th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table></div>';

    return '' +
      '<div class="history-header">' +
        '<button type="button" class="icon-btn" data-action="back" aria-label="Назад к списку счётчиков">' + ICON_BACK + '</button>' +
        '<div style="min-width: 0;">' +
          '<h2 class="modal-content__title" style="margin-bottom: 0;">История показаний</h2>' +
          '<p class="modal-content__text">' + esc(meter.name) + ' · ' + readingsDesc.length + ' записей</p>' +
        '</div>' +
      '</div>' +
      '<div class="form-error" id="e-delete" role="alert"></div>' +
      table;
  }

  /**
   * Открывает модалку истории показаний счётчика.
   * @param {number} meterId
   */
  function showHistory(meterId) {
    var meter = findMeter(meterId);
    if (!meter) { return; }

    openModal(historyHtml(meter, readingsOf(meterId)), function (card, close) {
      card.addEventListener('click', function (e) {
        var back = e.target.closest('[data-action="back"]');
        if (back) {
          close();
          return;
        }

        var del = e.target.closest('[data-action="del-reading"]');
        if (del) {
          // Удаление отдельного показания — только с подтверждением
          confirmDeleteReading(meterId, Number(del.getAttribute('data-id')), function () {
            card.innerHTML = historyHtml(meter, readingsOf(meterId));
            paint();
          });
        }
      });
    });
  }

  /**
   * Удаляет показание и пересчитывает сохранённый расход у соседа,
   * который считался от удалённого значения.
   * @param {number} meterId
   * @param {number} readingId
   * @returns {Promise}
   */
  function deleteReadingAndFixChain(meterId, readingId) {
    var readingsDesc = readingsOf(meterId);
    var index = -1;
    for (var i = 0; i < readingsDesc.length; i++) {
      if (readingsDesc[i].id === readingId) { index = i; break; }
    }
    if (index === -1) { return Promise.reject(new Error('Показание не найдено.')); }

    // Более новое показание, чей расход считался от удаляемого
    var affected = index > 0 ? readingsDesc[index - 1] : null;
    var newBase = index + 1 < readingsDesc.length ? readingsDesc[index + 1].value : meter0initial(meterId);

    return DB.delete(STORE_READINGS, readingId).then(function () {
      if (affected && typeof newBase === 'number') {
        var cons = Math.round((affected.value - newBase) * 10) / 10;
        return DB.update(STORE_READINGS, affected.id, { consumption: cons });
      }
    }).then(loadData);
  }

  /** Начальное показание счётчика по id (для пересчёта цепочки) */
  function meter0initial(meterId) {
    var m = findMeter(meterId);
    return m && typeof m.initialValue === 'number' ? m.initialValue : null;
  }

  /**
   * Диалог подтверждения удаления одного показания.
   * @param {number} meterId
   * @param {number} readingId
   * @param {function(): void} onDeleted — после успешного удаления и обновления кэша
   */
  function confirmDeleteReading(meterId, readingId, onDeleted) {
    var reading = null;
    for (var i = 0; i < allReadings.length; i++) {
      if (allReadings[i].id === readingId) { reading = allReadings[i]; break; }
    }
    if (!reading) { return; }

    var meter = findMeter(meterId);
    var unit = unitFor(meter || {});

    var html = '' +
      '<h2 class="modal-content__title">Удалить показание?</h2>' +
      '<p class="modal-content__text">Показание ' + formatReading(reading.value, unit) +
        ' от ' + formatDate(reading.date) + ' будет удалено. Это действие нельзя отменить.</p>' +
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

        deleteReadingAndFixChain(meterId, readingId).then(function () {
          close();
          if (onDeleted) { onDeleted(); }
        }).catch(function (err) {
          btn.disabled = false;
          console.error('[Meters] Ошибка удаления показания:', err);
          card.querySelector('#e-delete').textContent = 'Не удалось удалить: ' + err.message;
        });
      });
    });
  }

  /* ================================================================
     10. УДАЛЕНИЕ С ЧИСТКОЙ ПОКАЗАНИЙ
     ================================================================ */

  /**
   * Удаляет показания счётчика (каскадно, через цикл DB.delete).
   * @param {number} meterId
   * @returns {Promise}
   */
  function deleteReadingsOf(meterId) {
    var ids = allReadings
      .filter(function (r) { return r.meterId === meterId; })
      .map(function (r) { return r.id; });

    // Последовательно, чтобы не держать много открытых транзакций
    return ids.reduce(function (chain, id) {
      return chain.then(function () { return DB.delete(STORE_READINGS, id); });
    }, Promise.resolve());
  }

  /**
   * Диалог удаления счётчика с подтверждением.
   * @param {number} meterId
   */
  function removeMeter(meterId) {
    var meter = findMeter(meterId);
    if (!meter) { return; }

    var readingsCount = readingsOf(meterId).length;
    var countNote = readingsCount > 0
      ? ' Вместе с ним будут удалены все ' + readingsCount + ' показаний(я).'
      : ' Показаний у этого счётчика нет.';

    var html = '' +
      '<h2 class="modal-content__title">Удалить счётчик?</h2>' +
      '<p class="modal-content__text">Счётчик «' + esc(meter.name) + '» будет удалён без возможности восстановления.' +
        countNote + '</p>' +
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

        deleteReadingsOf(meterId).then(function () {
          return DB.delete(STORE_METERS, meterId);
        }).then(function () {
          close();
          return loadData();
        }).then(function () {
          paint();
        }).catch(function (err) {
          btn.disabled = false;
          console.error('[Meters] Ошибка удаления счётчика:', err);
          card.querySelector('#e-delete').textContent = 'Не удалось удалить: ' + err.message;
        });
      });
    });
  }

  /* ================================================================
     11. ДЕЛЕГИРОВАНИЕ СОБЫТИЙ
     ================================================================ */

  /** Единый обработчик кликов по #app */
  function onAppClick(e) {
    var actionEl = e.target.closest('[data-action]');

    if (actionEl) {
      var action = actionEl.getAttribute('data-action');
      var id = actionEl.hasAttribute('data-id') ? Number(actionEl.getAttribute('data-id')) : null;

      switch (action) {
        case 'add-meter':
          openAddMeterForm();
          return;
        case 'add-reading':
          openAddReadingForm(id);
          return;
        case 'history':
          showHistory(id);
          return;
        case 'delete-meter':
          removeMeter(id);
          return;
        case 'tariffs':
          if (window.ValuePack && window.ValuePack.openTariffsModal) {
            window.ValuePack.openTariffsModal(function () { paint(); });
          }
          return;
        case 'share-readings':
          if (window.ValuePack && window.ValuePack.shareReadings) {
            var visible = meters.filter(function (m) {
              return !(window.FamilyUI && window.FamilyUI.isHidden(m));
            });
            window.ValuePack.shareReadings(visible, allReadings);
          }
          return;
        case 'retry':
          loading = false;
          render();
          return;
      }
      return;
    }

    // Клик по карточке мимо кнопок — быстрое добавление показания
    var card = e.target.closest('.meter-card');
    if (card) {
      openAddReadingForm(Number(card.getAttribute('data-id')));
    }
  }

  /** Enter/Space на карточке — форма показания */
  function onAppKeydown(e) {
    if (e.key !== 'Enter' && e.key !== ' ') { return; }
    if (!e.target.closest) { return; }

    var card = e.target.closest('.meter-card');
    if (!card || card.contains(e.target.closest('button'))) { return; }

    e.preventDefault();
    openAddReadingForm(Number(card.getAttribute('data-id')));
  }

  /* ================================================================
     12. ИНИЦИАЛИЗАЦИЯ И ПУБЛИЧНЫЙ API
     ================================================================ */

  /** Привязывает делегаты к #app. Повторные вызовы игнорируются. */
  function init() {
    if (listenersBound) { return; }

    var el = appEl();
    if (!el) { return; }

    el.addEventListener('click', onAppClick);
    el.addEventListener('keydown', onAppKeydown);

    listenersBound = true;
    console.info('[Meters] Делегаты событий привязаны.');
  }

  window.Meters = {
    init: init,
    render: render,
    invalidate: invalidate,
    openAddMeterForm: openAddMeterForm,
    openAddReadingForm: openAddReadingForm,

    /**
     * Есть ли счётчик в рабочем кэше модуля. Нужно быстрым действиям:
     * openAddReadingForm() принимает только meterId и молча выходит, если
     * кэш ещё не загружен (после navigate()), а проверять готовность
     * по-другому снаружи нельзя.
     * @param {number} id
     * @returns {boolean}
     */
    hasMeter: function (id) {
      return Boolean(findMeter(id));
    },

    showHistory: showHistory,
    saveMeter: saveMeter,
    saveReading: saveReading,
    deleteMeter: removeMeter,

    /**
     * Удаление показания с подтверждением.
     * @param {number} readingId
     */
    deleteReading: function (readingId) {
      var reading = null;
      for (var i = 0; i < allReadings.length; i++) {
        if (allReadings[i].id === readingId) { reading = allReadings[i]; break; }
      }
      if (!reading) { return; }

      var meter = findMeter(reading.meterId);
      var html = '' +
        '<h2 class="modal-content__title">Удалить показание?</h2>' +
        '<p class="modal-content__text">Показание ' + formatReading(reading.value, unitFor(meter || {})) +
          ' от ' + formatDate(reading.date) + ' будет удалено.</p>' +
        '<div class="flex gap-3 mt-4">' +
          '<button type="button" class="btn btn--secondary" style="flex: 1;" data-action="cancel">Отмена</button>' +
          '<button type="button" class="btn btn--danger" style="flex: 1;" data-action="confirm">Удалить</button>' +
        '</div>';

      openModal(html, function (card, close) {
        card.querySelector('[data-action="cancel"]').addEventListener('click', close);
        card.querySelector('[data-action="confirm"]').addEventListener('click', function () {
          DB.delete(STORE_READINGS, readingId).then(function () {
            close();
            return loadData();
          }).then(function () {
            paint();
          }).catch(function (err) {
            console.error('[Meters] Ошибка удаления показания:', err);
          });
        });
      });
    },

    /**
     * История показаний счётчика (Promise, desc по дате).
     * @param {number} meterId
     * @returns {Promise<Array<Object>>}
     */
    getHistory: function (meterId) {
      return DB.getByIndex(STORE_READINGS, 'meterId', meterId).then(function (rows) {
        return (rows || []).sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
      });
    },

    /** Утилиты форматирования */
    formatReading: formatReading,
    formatConsumption: formatConsumption,
    getTypeColor: getTypeColor,
    getTypeUnit: getTypeUnit,
    METER_TYPES: METER_TYPES
  };

  console.info('[Meters] Модуль загружен. API: window.Meters');
})();
