/**
 * МОЙ ПОРЯДОК — UI семейного доступа (Этап 12.7)
 *
 * Один файл на три списка, а не три копии по модулям: значок scope, чип
 * фильтра и переключатель в форме должны выглядеть и называться одинаково и
 * в платежах, и в делах, и в документах. Модулям остаётся вызвать три
 * функции на готовых данных.
 *
 * Что здесь происходит:
 *   • badgeHtml(record) — 👥 у общих записей, 🔒 у личных (только внутри
 *     семьи: вне неё все записи и так личные, и значок был бы шумом);
 *   • scopeChips() + applyScopeFilter(rows, scope) — «Все / Семейные /
 *     Личные» в ряд фильтров, который уже есть у каждого списка;
 *   • scopeFieldHtml(scope) + readScope(card) — переключатель в форме, чтобы
 *     человек СОЗНАТЕЛЬНО решал, уходит ли запись в семью;
 *   • isHidden(record) — отсекает мягко удалённые записи: они остаются в базе
 *     ради tombstone, но показывать их нельзя.
 *
 * Экспортирует: window.FamilyUI
 */

(function () {
  'use strict';

  /** @const {string} значение фильтра «только семейные» */
  var ONLY_FAMILY = 'family';

  /** @const {string} значение фильтра «только личные» */
  var ONLY_PERSONAL = 'personal';

  /** @const {string} значение «не фильтровать по доступу» */
  var ALL = 'all';

  /**
   * Активный режим просмотра по доступу. Хранится в памяти сессии, а не в
   * settings: это способ посмотреть список, а не настройка пользователя, и
   * синхронизировать его между людьми нельзя по условию этапа.
   * @type {string}
   */
  var scopeFilter = ALL;

  /** @returns {boolean} включена ли семья */
  function inFamily() {
    return Boolean(window.Family && window.Family.isActive && window.Family.isActive());
  }

  /**
   * Показывать ли строку списка вообще.
   * Мягко удалённые (deleted) скрываем всегда: их не видно и у того, кто
   * удалил, — физическая запись нужна только чтобы передать удаление соседу.
   * @param {Object} record @returns {boolean}
   */
  function isHidden(record) {
    return Boolean(record && record.deleted);
  }

  /**
   * Значок доступа для meta-строки карточки.
   * @param {Object} record
   * @returns {string} HTML или ''
   */
  function badgeHtml(record) {
    if (!inFamily() || !record) { return ''; }

    var shared = record.familyScope === 'family' || record.familyScoped === true;
    var title = shared ? 'Общая запись семьи' : 'Личная запись — не передаётся семье';

    return '<span class="family-flag' + (shared ? ' family-flag--shared' : '') + '" ' +
      'title="' + title + '" aria-label="' + title + '">' +
      (shared ? '\uD83D\uDC65' : '\uD83D\uDD12') +
      '</span>';
  }

  /**
   * Чипы режима просмотра. Возвращает '' вне семьи: человеку без семьи
   * не из чего выбирать, и мёртвые кнопки только мешают.
   * @param {string} [attr] — имя data-атрибута модуля (у списков они разные)
   * @returns {string}
   */
  function scopeChips(attr) {
    if (!inFamily()) { return ''; }

    var name = attr || 'data-scope-filter';
    var chips = [
      { value: ALL, label: 'Все' },
      { value: ONLY_FAMILY, label: '👥 Семейные' },
      { value: ONLY_PERSONAL, label: '🔒 Личные' }
    ];

    return chips.map(function (c) {
      var active = scopeFilter === c.value;
      return '<button type="button" class="chip chip--scope' + (active ? ' chip--active' : '') + '" ' +
        name + '="' + c.value + '" aria-pressed="' + active + '">' + c.label + '</button>';
    }).join('');
  }

  /**
   * Применяет режим просмотра к уже отфильтрованному по остальному списку.
   * Личной считается всё, что НЕ помечено как общее, — в том числе записи
   * прежних этапов без флага. Так «Личные» не оказывается пустым.
   * @param {Object[]} rows @param {string} [scope]
   * @returns {Object[]}
   */
  function applyScopeFilter(rows, scope) {
    var mode = scope || scopeFilter;
    if (!inFamily() || mode === ALL) { return rows; }
    if (mode === ONLY_FAMILY) {
      return rows.filter(function (r) { return r.familyScope === 'family' || r.familyScoped === true; });
    }
    return rows.filter(function (r) { return r.familyScope !== 'family' && r.familyScoped !== true; });
  }

  /** @param {string} value — 'all' | 'family' | 'personal' */
  function setScopeFilter(value) {
    scopeFilter = value === ONLY_FAMILY || value === ONLY_PERSONAL ? value : ALL;
  }

  /** @returns {string} текущий режим просмотра */
  function getScopeFilter() {
    return scopeFilter;
  }

  /** @returns {boolean} обработчик ли это чипа доступа */
  function isScopeChipValue(value) {
    return value === ALL || value === ONLY_FAMILY || value === ONLY_PERSONAL;
  }

  /**
   * Переключатель доступа в форме записи. Вне семьи поле не рисуется:
   * спрашивать «общая или личная?» у человека без семьи — смысл без вопроса.
   * @param {string} [scope] — текущее значение при правке
   * @returns {string}
   */
  function scopeFieldHtml(scope) {
    if (!inFamily()) { return ''; }

    var value = scope === 'family' ? 'family' : 'personal';

    return '<div class="form-group form-group--scope">' +
        '<span class="form-group__label">Доступ</span>' +
        '<div class="scope-switch" role="radiogroup" aria-label="Кто видит эту запись">' +
          '<label class="scope-switch__opt">' +
            '<input type="radio" name="family-scope" value="family"' +
              (value === 'family' ? ' checked' : '') + '>' +
            '<span>👥 Общая семье</span>' +
          '</label>' +
          '<label class="scope-switch__opt">' +
            '<input type="radio" name="family-scope" value="personal"' +
              (value === 'personal' ? ' checked' : '') + '>' +
            '<span>🔒 Только я</span>' +
          '</label>' +
        '</div>' +
        '<p class="form-group__hint">Общую запись увидят участники семьи в ' +
          'общем файле. Личная останется на этом устройстве.</p>' +
      '</div>';
  }

  /**
   * Что выбрал человек в форме.
   * @param {HTMLElement} card
   * @returns {?string} 'family' | 'personal' | null (поля нет — не в семье)
   */
  function readScope(card) {
    if (!card || !inFamily()) { return null; }
    var checked = card.querySelector('input[name="family-scope"]:checked');
    if (!checked) { return null; }
    return checked.value === 'family' ? 'family' : 'personal';
  }

  /**
   * Строка «кто создали» для подписи в карточке чужой записи.
   * @param {Object} record @returns {string}
   */
  function ownerNote(record) {
    if (!inFamily() || !record || record.familyScope !== 'family') { return ''; }
    var me = window.Family ? window.Family.myUserId() : null;
    if (record.ownerId && me && record.ownerId !== me) { return 'от участника семьи'; }
    return '';
  }

  window.FamilyUI = {
    ALL: ALL,
    ONLY_FAMILY: ONLY_FAMILY,
    ONLY_PERSONAL: ONLY_PERSONAL,
    inFamily: inFamily,
    isHidden: isHidden,
    badgeHtml: badgeHtml,
    scopeChips: scopeChips,
    applyScopeFilter: applyScopeFilter,
    setScopeFilter: setScopeFilter,
    getScopeFilter: getScopeFilter,
    isScopeChipValue: isScopeChipValue,
    scopeFieldHtml: scopeFieldHtml,
    readScope: readScope,
    ownerNote: ownerNote
  };

  console.info('[FamilyUI] Модуль загружен. API: window.FamilyUI');
})();
