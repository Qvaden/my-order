/**
 * МОЙ ПОРЯДОК — Пакет полезных функций Free + PRO (Этап 12.12)
 *
 * 100% автономная клиентская реализация без ИИ и платных внешних API.
 * Включает 7 ключевых бытовых и финансовых инструментов:
 *
 * БАЗОВАЯ ВЕРСИЯ (FREE + PRO):
 * 1. Калькулятор тарифов ЖКХ («Сверь с УК») — расчёт стоимости расхода по счётчикам в рублях.
 * 2. Готовые умные чек-листы для дома («В один клик») — 4 шаблона бытовых задач.
 * 3. Быстрая отправка / копирование показаний счётчиков для УК и мессенджеров.
 *
 * PRO-ВЕРСИЯ:
 * 4. 📦 Склад вещей, гарантийных талонов и чеков («Где что лежит?») в разделе #documents.
 * 5. 🧾 Инспектор подписок («Детектор забытых трат») с расчётом годового расхода.
 * 6. 🎯 Семейная цель накоплений («Копилка на мечту / ремонт») с вкладами участников.
 * 7. 🖨️ Пакетный экспорт в Excel / CSV (UTF-8 с BOM для корректного открытия в MS Excel).
 *
 * Экспортирует window.ValuePack.
 */

(function () {
  'use strict';

  /* ================================================================
     1. КОНСТАНТЫ И ХРАНЕНИЕ В НАСТРОЙКАХ
     ================================================================ */

  var LS_TARIFFS = 'myorder_tariffs';
  var LS_WARRANTIES = 'myorder_warranties';
  var LS_SAVINGS = 'myorder_savings_goal';

  var SET_TARIFFS = 'tariffs_v1';
  var SET_WARRANTIES = 'warranties_v1';
  var SET_SAVINGS = 'savings_goal_v1';

  /** Тарифы ЖКХ по умолчанию (средние по РФ, ₽ за единицу) */
  var DEFAULT_TARIFFS = {
    cold: 59.80,        // Холодная вода, ₽/м³
    hot: 272.50,        // Горячая вода, ₽/м³
    electricity: 6.15,  // Электричество, ₽/кВт·ч
    gas: 8.50,          // Газ, ₽/м³
    other: 1.00         // Другое, ₽/ед.
  };

  var TARIFF_META = [
    { key: 'cold',        label: 'Холодная вода', unit: 'м³',    icon: '💧' },
    { key: 'hot',         label: 'Горячая вода',  unit: 'м³',    icon: '♨️' },
    { key: 'electricity', label: 'Электричество', unit: 'кВт·ч', icon: '⚡' },
    { key: 'gas',         label: 'Газ',           unit: 'м³',    icon: '🔥' },
    { key: 'other',       label: 'Другое',        unit: 'ед.',   icon: '⚙️' }
  ];

  /** 4 готовых чек-листа бытовых задач (Free + PRO) */
  var CHECKLIST_TEMPLATES = [
    {
      id: 'season_flat',
      icon: '🏡',
      title: 'Сезонная подготовка квартиры',
      subtitle: 'Окна, отопление, вентиляция и сантехника перед сменой сезона',
      category: 'Дом',
      tasks: [
        { title: 'Проверить и смазать уплотнители окон и фурнитуру', priority: 'medium', daysOffset: 1 },
        { title: 'Прочистить решётки вентиляции и фильтр вытяжки', priority: 'low', daysOffset: 2 },
        { title: 'Проверить радиаторы отопления и краны Маевского', priority: 'high', daysOffset: 3 },
        { title: 'Осмотреть гибкую подводку и сифоны под раковиной', priority: 'high', daysOffset: 4 }
      ]
    },
    {
      id: 'car_service',
      icon: '🚗',
      title: 'ТО автомобиля и смена сезона',
      subtitle: 'Шины, жидкости, страховка и дорожный набор без спешки',
      category: 'Личное',
      tasks: [
        { title: 'Записаться на сезонный шиномонтаж и проверить давление', priority: 'high', daysOffset: 1 },
        { title: 'Проверить уровень моторного масла и тормозной жидкости', priority: 'high', daysOffset: 2 },
        { title: 'Проверить срок действия полиса ОСАГО и диагностической карты', priority: 'medium', daysOffset: 3 },
        { title: 'Пополнить омывающую жидкость и проверить аптечку', priority: 'low', daysOffset: 5 }
      ]
    },
    {
      id: 'vacation_pack',
      icon: '✈️',
      title: 'Сборы в отпуск — дом в безопасности',
      subtitle: 'Защита квартиры от протечек, оплата счетов и проверка документов',
      category: 'Дом',
      tasks: [
        { title: 'Перекрыть вводные краны холодной и горячей воды', priority: 'high', daysOffset: 0 },
        { title: 'Отключить бойлер, утюг и бытовые приборы из розеток', priority: 'high', daysOffset: 0 },
        { title: 'Оплатить интернет, связь и ЖКХ авансом перед поездкой', priority: 'medium', daysOffset: 1 },
        { title: 'Проверить паспорта, полисы, билеты и зарядные устройства', priority: 'high', daysOffset: 1 }
      ]
    },
    {
      id: 'home_audit',
      icon: '📦',
      title: 'Ревизия документов и счётчиков',
      subtitle: 'Ежемесячный порядок в квитанциях, приборах учёта и бэкапах',
      category: 'Дом',
      tasks: [
        { title: 'Снять и передать показания всех счётчиков воды и света', priority: 'high', daysOffset: 1 },
        { title: 'Сверить даты следующей поверки водосчётчиков', priority: 'medium', daysOffset: 3 },
        { title: 'Разобрать чеки, гарантийные талоны и договоры за месяц', priority: 'low', daysOffset: 4 },
        { title: 'Сделать свежую резервную копию данных в «Мой Порядок»', priority: 'medium', daysOffset: 2 }
      ]
    }
  ];

  /** Цель накоплений по умолчанию */
  var DEFAULT_SAVINGS_GOAL = {
    title: 'Семейный фонд / Ремонт и отпуск',
    targetRub: 150000,
    currentRub: 0,
    targetDate: '',
    contributions: []
  };

  /* ================================================================
     2. УТИЛИТЫ
     ================================================================ */

  function esc(s) {
    if (s === null || s === undefined) { return ''; }
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isPro() {
    return Boolean(window.ProManager && window.ProManager.isPro && window.ProManager.isPro());
  }

  function toast(msg, type) {
    if (window.VK && typeof window.VK.notify === 'function') {
      window.VK.notify(msg, type || 'info');
    }
  }

  function formatRub(rub) {
    var num = Number(rub) || 0;
    var hasDecimals = Math.round(num * 100) % 100 !== 0;
    var fixed = hasDecimals ? num.toFixed(2) : String(Math.round(num));
    var parts = fixed.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
    return (parts.length > 1 ? parts[0] + ',' + parts[1] : parts[0]) + '\u00A0\u20BD';
  }

  function formatKopecks(kop) {
    return formatRub((Number(kop) || 0) / 100);
  }

  function formatDateRu(iso) {
    if (!iso) { return '—'; }
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return '—'; }
    return String(d.getDate()).padStart(2, '0') + '.' +
           String(d.getMonth() + 1).padStart(2, '0') + '.' +
           d.getFullYear();
  }

  function isoOffsetDays(days) {
    var d = new Date();
    d.setDate(d.getDate() + (Number(days) || 0));
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  function lsReadJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) { return fallback; }
      var parsed = JSON.parse(raw);
      return parsed !== null && parsed !== undefined ? parsed : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function lsWriteJson(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {}
  }

  function syncSettingToDb(settingKey, val) {
    if (!window.DB || typeof window.DB.put !== 'function') { return Promise.resolve(); }
    return window.DB.put('settings', { key: settingKey, value: val }).catch(function () {});
  }

  /** Универсальное модальное окно */
  function openModal(innerHtml, onMount) {
    var existing = document.querySelectorAll('.modal-overlay');
    for (var i = 0; i < existing.length; i++) {
      if (!existing[i]._closing && existing[i]._signature === innerHtml) { return; }
    }

    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay._signature = innerHtml;

    var card = document.createElement('div');
    card.className = 'modal-content';
    card.style.maxWidth = '460px';
    card.innerHTML = innerHtml;

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.body.classList.add('modal-open');

    requestAnimationFrame(function () {
      overlay.classList.add('is-open');
    });

    function close() {
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

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) { close(); }
    });

    overlay._onKeydown = function (e) {
      if (e.key === 'Escape') { close(); }
    };
    document.addEventListener('keydown', overlay._onKeydown);

    if (onMount) { onMount(card, close); }
  }

  /* ================================================================
     3. [FREE #1] КАЛЬКУЛЯТОР ТАРИФОВ ЖКХ («СВЕРЬ С УК»)
     ================================================================ */

  function getTariffs() {
    var saved = lsReadJson(LS_TARIFFS, null);
    var out = {};
    for (var k in DEFAULT_TARIFFS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_TARIFFS, k)) {
        var v = saved && typeof saved[k] === 'number' && !isNaN(saved[k]) && saved[k] >= 0
          ? saved[k]
          : DEFAULT_TARIFFS[k];
        out[k] = Math.round(v * 100) / 100;
      }
    }
    return out;
  }

  function setTariffs(patch) {
    var current = getTariffs();
    if (patch && typeof patch === 'object') {
      Object.keys(DEFAULT_TARIFFS).forEach(function (k) {
        if (patch[k] !== undefined && patch[k] !== null) {
          var num = parseFloat(String(patch[k]).replace(',', '.'));
          if (!isNaN(num) && num >= 0 && num <= 100000) {
            current[k] = Math.round(num * 100) / 100;
          }
        }
      });
    }
    lsWriteJson(LS_TARIFFS, current);
    syncSettingToDb(SET_TARIFFS, current);
    return current;
  }

  function getTariffForMeter(meter) {
    var t = getTariffs();
    var type = meter && meter.type ? meter.type : 'other';
    return typeof t[type] === 'number' ? t[type] : t.other;
  }

  function calcConsumptionRub(meter, deltaValue) {
    var delta = Number(deltaValue) || 0;
    if (delta <= 0) { return 0; }
    var rate = getTariffForMeter(meter);
    return Math.round(delta * rate * 100) / 100;
  }

  /**
   * Вычисляет расход по каждому счётчику и общую сумму к оплате по тарифам.
   * @param {Array} meters
   * @param {Array} allReadings
   * @returns {{totalRub: number, items: Array}}
   */
  function calcMetersBillSummary(meters, allReadings) {
    var list = Array.isArray(meters) ? meters : [];
    var readings = Array.isArray(allReadings) ? allReadings : [];
    var totalRub = 0;
    var items = [];

    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var mReadings = readings
        .filter(function (r) { return r.meterId === m.id; })
        .sort(function (a, b) {
          var cmp = String(b.date).localeCompare(String(a.date));
          return cmp !== 0 ? cmp : b.id - a.id;
        });

      var currentVal = mReadings.length > 0
        ? mReadings[0].value
        : (typeof m.initialValue === 'number' ? m.initialValue : null);

      var delta = 0;
      if (mReadings.length >= 2) {
        delta = mReadings[0].value - mReadings[1].value;
      } else if (mReadings.length === 1 && typeof m.initialValue === 'number') {
        delta = mReadings[0].value - m.initialValue;
      }

      if (delta < 0) { delta = 0; }
      delta = Math.round(delta * 100) / 100;

      var rate = getTariffForMeter(m);
      var costRub = calcConsumptionRub(m, delta);
      totalRub += costRub;

      items.push({
        meterId: m.id,
        name: m.name,
        type: m.type,
        unit: m.unit || (window.Meters && window.Meters.getTypeUnit ? window.Meters.getTypeUnit(m.type) : ''),
        currentValue: currentVal,
        lastDate: mReadings.length > 0 ? mReadings[0].date : null,
        delta: delta,
        tariffRub: rate,
        costRub: costRub
      });
    }

    return {
      totalRub: Math.round(totalRub * 100) / 100,
      items: items
    };
  }

  /** Панель сводки по тарифам и быстрых действий в разделе #meters */
  function renderMetersToolbarHtml(meters, allReadings) {
    if (!meters || meters.length === 0) { return ''; }
    var summary = calcMetersBillSummary(meters, allReadings);

    return '<div class="card meters-tariff-bar mb-3">' +
      '<div class="meters-tariff-bar__main">' +
        '<div>' +
          '<div class="meters-tariff-bar__label">🧮 Расчёт квитанции по тарифам («Сверь с УК»)</div>' +
          '<div class="meters-tariff-bar__total" data-meters-bill-total>' +
            formatRub(summary.totalRub) +
          '</div>' +
        '</div>' +
        '<div class="meters-tariff-bar__actions">' +
          '<button type="button" class="btn btn--secondary btn--sm" data-action="tariffs">' +
            '⚙️ Тарифы ЖКХ' +
          '</button>' +
          '<button type="button" class="btn btn--primary btn--sm" data-action="share-readings">' +
            '📤 Переслать показания' +
          '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function openTariffsModal(onSaved) {
    var tariffs = getTariffs();
    var fieldsHtml = TARIFF_META.map(function (item) {
      var val = tariffs[item.key];
      return '<div class="form-group">' +
        '<label class="form-label" for="tariff-' + item.key + '">' +
          item.icon + ' ' + esc(item.label) + ' (\u20BD за 1 ' + esc(item.unit) + ')' +
        '</label>' +
        '<input class="form-input" id="tariff-' + item.key + '" name="' + item.key + '" ' +
          'type="text" inputmode="decimal" value="' + String(val).replace('.', ',') + '">' +
      '</div>';
    }).join('');

    var html = '<h2 class="modal-content__title">🧮 Тарифы ЖКХ</h2>' +
      '<p class="modal-content__text" style="margin-bottom:var(--space-3);">' +
        'Укажите актуальные тарифы из вашей квитанции, чтобы приложение автоматически считало сумму к оплате.' +
      '</p>' +
      '<form id="tariffs-form" novalidate>' +
        fieldsHtml +
        '<div class="flex gap-3 mt-4">' +
          '<button type="button" class="btn btn--secondary" style="flex:1;" data-tariff-cancel>Отмена</button>' +
          '<button type="submit" class="btn btn--primary" style="flex:1;">Сохранить тарифы</button>' +
        '</div>' +
      '</form>';

    openModal(html, function (card, close) {
      card.querySelector('[data-tariff-cancel]').addEventListener('click', close);
      card.querySelector('#tariffs-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var patch = {};
        TARIFF_META.forEach(function (item) {
          var inp = card.querySelector('[name="' + item.key + '"]');
          if (inp) { patch[item.key] = inp.value; }
        });
        setTariffs(patch);
        toast('Тарифы ЖКХ сохранены', 'success');
        close();
        if (typeof onSaved === 'function') { onSaved(); }
      });
    });
  }

  /* ================================================================
     4. [FREE #2] ГОТОВЫЕ УМНЫЕ ЧЕК-ЛИСТЫ ДЛЯ ДОМА («В ОДИН КЛИК»)
     ================================================================ */

  function getChecklistTemplates() {
    return CHECKLIST_TEMPLATES.slice();
  }

  function applyChecklist(templateId) {
    var tpl = null;
    for (var i = 0; i < CHECKLIST_TEMPLATES.length; i++) {
      if (CHECKLIST_TEMPLATES[i].id === templateId) {
        tpl = CHECKLIST_TEMPLATES[i];
        break;
      }
    }
    if (!tpl) {
      return Promise.reject(new Error('Шаблон чек-листа не найден'));
    }
    if (!window.DB) {
      return Promise.reject(new Error('База данных не инициализирована'));
    }

    var ops = tpl.tasks.map(function (item) {
      var taskData = {
        title: item.title,
        description: 'Из чек-листа «' + tpl.title + '»',
        dueDate: isoOffsetDays(item.daysOffset),
        priority: item.priority || 'medium',
        recurring: 'none',
        category: tpl.category || 'Дом',
        isTemplate: false,
        parentTaskId: null,
        completed: false,
        completedAt: null
      };
      if (window.Family && typeof window.Family.stampScope === 'function') {
        window.Family.stampScope(taskData, 'tasks', false);
      }
      return window.DB.add('tasks', taskData);
    });

    return Promise.all(ops).then(function () {
      if (window.Personalization && window.Personalization.triggerFeedback) {
        window.Personalization.triggerFeedback('payment_saved');
      }
      toast('Добавлено ' + tpl.tasks.length + ' задачи из чек-листа «' + tpl.title + '»', 'success');
      return {
        ok: true,
        addedCount: tpl.tasks.length,
        template: tpl
      };
    });
  }

  function openChecklistsModal(onApplied) {
    var cardsHtml = CHECKLIST_TEMPLATES.map(function (tpl) {
      var itemsList = tpl.tasks.map(function (t) {
        return '<li>• ' + esc(t.title) + '</li>';
      }).join('');

      return '<div class="checklist-template-card" data-template-card="' + esc(tpl.id) + '">' +
        '<div class="checklist-template-card__head">' +
          '<span class="checklist-template-card__icon" aria-hidden="true">' + tpl.icon + '</span>' +
          '<div>' +
            '<h3 class="checklist-template-card__title">' + esc(tpl.title) + '</h3>' +
            '<p class="checklist-template-card__sub">' + esc(tpl.subtitle) + '</p>' +
          '</div>' +
        '</div>' +
        '<ul class="checklist-template-card__list">' + itemsList + '</ul>' +
        '<button type="button" class="btn btn--primary btn--sm w-full" data-checklist-apply="' + esc(tpl.id) + '">' +
          '➕ Добавить в мои дела (' + tpl.tasks.length + ')' +
        '</button>' +
      '</div>';
    }).join('');

    var html = '<h2 class="modal-content__title">📋 Готовые чек-листы для дома</h2>' +
      '<p class="modal-content__text" style="margin-bottom:var(--space-3);">' +
        'Выберите жизненный сценарий — проверенный список задач со сроками и приоритетами добавится в один клик.' +
      '</p>' +
      '<div class="checklist-templates-grid">' + cardsHtml + '</div>' +
      '<div class="mt-4">' +
        '<button type="button" class="btn btn--secondary w-full" data-checklist-close>Закрыть</button>' +
      '</div>';

    openModal(html, function (card, close) {
      card.querySelector('[data-checklist-close]').addEventListener('click', close);

      var btns = card.querySelectorAll('[data-checklist-apply]');
      Array.prototype.forEach.call(btns, function (btn) {
        btn.addEventListener('click', function () {
          var tplId = btn.getAttribute('data-checklist-apply');
          btn.disabled = true;
          btn.textContent = 'Добавляем…';
          applyChecklist(tplId).then(function (res) {
            close();
            if (typeof onApplied === 'function') { onApplied(res); }
          }).catch(function (err) {
            btn.disabled = false;
            btn.textContent = 'Ошибка: ' + (err && err.message || err);
          });
        });
      });
    });
  }

  /* ================================================================
     5. [FREE #3] ПЕРЕСЫЛКА / КОПИРОВАНИЕ ПОКАЗАНИЙ СЧЁТЧИКОВ
     ================================================================ */

  function buildReadingsShareText(meters, allReadings) {
    var summary = calcMetersBillSummary(meters, allReadings);
    var today = formatDateRu(new Date().toISOString());

    if (summary.items.length === 0) {
      return '📊 Показания счётчиков на ' + today + ': счётчики ещё не добавлены.';
    }

    var lines = ['📊 Показания счётчиков на ' + today + ':'];
    for (var i = 0; i < summary.items.length; i++) {
      var it = summary.items[i];
      var valStr = it.currentValue !== null && it.currentValue !== undefined
        ? String(it.currentValue) + (it.unit ? ' ' + it.unit : '')
        : 'нет данных';
      var deltaStr = it.delta > 0
        ? ' (+' + it.delta + (it.unit ? ' ' + it.unit : '') + ' · ' + formatRub(it.costRub) + ')'
        : '';
      lines.push('• ' + it.name + ': ' + valStr + deltaStr);
    }

    lines.push('────────────────────');
    lines.push('💰 Итого по тарифам: ' + formatRub(summary.totalRub));
    lines.push('Сформировано в приложении «Мой Порядок»');

    return lines.join('\n');
  }

  function copyTextToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).then(function () {
        return true;
      }).catch(function () {
        return fallbackCopyText(text);
      });
    }
    return Promise.resolve(fallbackCopyText(text));
  }

  function fallbackCopyText(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch (e) {
      return false;
    }
  }

  function shareReadings(meters, allReadings) {
    var text = buildReadingsShareText(meters, allReadings);

    return copyTextToClipboard(text).then(function () {
      toast('Сводка показаний скопирована — отправьте её в чат УК или мессенджер!', 'success');
      return { ok: true, text: text, method: 'clipboard' };
    });
  }

  /* ================================================================
     6. [PRO #4] 📦 СКЛАД ВЕЩЕЙ И ГАРАНТИЙНЫХ ТАЛОНОВ («ГДЕ ЧТО ЛЕЖИТ?»)
     ================================================================ */

  function getWarranties() {
    var list = lsReadJson(LS_WARRANTIES, []);
    return Array.isArray(list) ? list : [];
  }

  function saveWarrantiesList(list) {
    lsWriteJson(LS_WARRANTIES, list);
    return syncSettingToDb(SET_WARRANTIES, list);
  }

  function calcWarrantyExpiryIso(purchaseDateIso, warrantyMonths) {
    if (!purchaseDateIso) { return ''; }
    var d = new Date(purchaseDateIso);
    if (isNaN(d.getTime())) { return ''; }
    var months = Math.max(1, Number(warrantyMonths) || 12);
    d.setMonth(d.getMonth() + months);
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  function getWarrantyDaysLeft(expiryIso) {
    if (!expiryIso) { return Infinity; }
    var target = new Date(expiryIso);
    if (isNaN(target.getTime())) { return Infinity; }
    var now = new Date();
    now.setHours(0, 0, 0, 0);
    target.setHours(0, 0, 0, 0);
    return Math.round((target.getTime() - now.getTime()) / 86400000);
  }

  function addWarranty(item) {
    if (!isPro()) {
      toast('Склад гарантий и чеков доступен в подписке PRO', 'error');
      return Promise.resolve({ ok: false, message: 'Требуется подписка PRO' });
    }
    var title = item && item.title ? String(item.title).trim() : '';
    if (!title) {
      return Promise.resolve({ ok: false, message: 'Укажите название покупки или техники' });
    }

    var purchaseDate = item.purchaseDate || isoOffsetDays(0);
    var warrantyMonths = Math.max(1, Math.min(240, Number(item.warrantyMonths) || 12));
    var expiryDate = calcWarrantyExpiryIso(purchaseDate, warrantyMonths);
    var priceRub = Math.max(0, parseFloat(String(item.priceRub || 0).replace(',', '.')) || 0);
    var storageLocation = item.storageLocation ? String(item.storageLocation).trim() : 'Папка с документами';

    var record = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      title: title,
      purchaseDate: purchaseDate,
      warrantyMonths: warrantyMonths,
      expiryDate: expiryDate,
      priceRub: Math.round(priceRub * 100) / 100,
      storageLocation: storageLocation,
      createdAt: new Date().toISOString()
    };

    var list = getWarranties();
    list.unshift(record);
    return saveWarrantiesList(list).then(function () {
      toast('Гарантийный талон сохранён на складе', 'success');
      return { ok: true, item: record };
    });
  }

  function removeWarranty(id) {
    if (!isPro()) {
      return Promise.resolve({ ok: false, message: 'Требуется подписка PRO' });
    }
    var numId = Number(id);
    var list = getWarranties().filter(function (w) { return Number(w.id) !== numId; });
    return saveWarrantiesList(list).then(function () {
      return { ok: true };
    });
  }

  function renderWarrantiesSectionHtml() {
    if (!isPro()) { return ''; }

    var list = getWarranties();
    var totalValueRub = 0;
    var activeCount = 0;

    var cardsHtml = list.map(function (w) {
      totalValueRub += Number(w.priceRub) || 0;
      var days = getWarrantyDaysLeft(w.expiryDate);
      var statusCls = 'status-badge--active status-badge--ok';
      var statusText = 'На гарантии · ещё ' + days + ' дн.';

      if (days < 0) {
        statusCls = 'status-badge--expired status-badge--danger';
        statusText = 'Гарантия истекла';
      } else if (days <= 30) {
        activeCount++;
        statusCls = 'status-badge--expiring status-badge--warn';
        statusText = 'Истекает через ' + days + ' дн.';
      } else {
        activeCount++;
      }

      return '<div class="warranty-item-card" data-warranty-id="' + w.id + '">' +
        '<div class="warranty-item-card__top">' +
          '<div>' +
            '<div class="warranty-item-card__title">' + esc(w.title) + '</div>' +
            '<div class="warranty-item-card__meta">' +
              (w.priceRub > 0 ? '<span class="warranty-price-tag">' + formatRub(w.priceRub) + '</span>' : '') +
              '<span>Куплено: ' + formatDateRu(w.purchaseDate) + ' (' + w.warrantyMonths + ' мес.)</span>' +
            '</div>' +
          '</div>' +
          '<span class="status-badge ' + statusCls + '">' + esc(statusText) + '</span>' +
        '</div>' +
        '<div class="warranty-item-card__location">' +
          '📍 Где лежит чек/коробка: <strong>' + esc(w.storageLocation) + '</strong>' +
        '</div>' +
        '<div class="warranty-item-card__foot">' +
          '<span class="warranty-item-card__expiry">Гарантия до: ' + formatDateRu(w.expiryDate) + '</span>' +
          '<button type="button" class="btn btn--ghost btn--sm" data-warranty-action="delete" data-id="' + w.id + '">' +
            'Удалить' +
          '</button>' +
        '</div>' +
      '</div>';
    }).join('');

    var emptyBox = '<div class="warranty-empty">' +
      'Добавьте бытовую технику, электронику или мебель — приложение посчитает срок гарантии и напомнит, на какой полке лежит бумажный чек.' +
    '</div>';

    return '<section class="card warranty-vault-card mt-4" data-pro-feature="warranty-vault">' +
      '<div class="warranty-vault-card__header">' +
        '<div>' +
          '<div class="flex items-center gap-2">' +
            '<h2 class="warranty-vault-card__title">📦 Склад гарантий и чеков («Где что лежит?»)</h2>' +
            '<span class="pro-badge">PRO</span>' +
          '</div>' +
          '<p class="warranty-vault-card__sub">' +
            'Защищено покупок на сумму: <strong>' + formatRub(totalValueRub) + '</strong> · Активных гарантий: <strong>' + activeCount + '</strong>' +
          '</p>' +
        '</div>' +
        '<button type="button" class="btn btn--primary btn--sm" data-warranty-action="add">' +
          '+ Чек / Гарантия' +
        '</button>' +
      '</div>' +
      (list.length > 0 ? '<div class="warranty-vault-list">' + cardsHtml + '</div>' : emptyBox) +
    '</section>';
  }

  function openAddWarrantyModal(onSaved) {
    var html = '<h2 class="modal-content__title">📦 Новая гарантия или чек</h2>' +
      '<form id="warranty-form" novalidate>' +
        '<div class="form-group">' +
          '<label class="form-label" for="w-title">Техника / Покупка</label>' +
          '<input class="form-input" id="w-title" name="title" type="text" maxlength="100" ' +
            'placeholder="Робот-пылесос Xiaomi / Стиральная машина" required>' +
          '<div class="form-error" id="w-err"></div>' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="form-label" for="w-price">Стоимость покупки (\u20BD)</label>' +
          '<input class="form-input" id="w-price" name="priceRub" type="text" inputmode="decimal" placeholder="34990">' +
        '</div>' +
        '<div class="flex gap-3">' +
          '<div class="form-group" style="flex:1;">' +
            '<label class="form-label" for="w-date">Дата покупки</label>' +
            '<input class="form-input" id="w-date" name="purchaseDate" type="date" value="' + isoOffsetDays(0) + '">' +
          '</div>' +
          '<div class="form-group" style="flex:1;">' +
            '<label class="form-label" for="w-months">Гарантия (мес.)</label>' +
            '<select class="form-select" id="w-months" name="warrantyMonths">' +
              '<option value="6">6 месяцев</option>' +
              '<option value="12" selected>12 месяцев (1 год)</option>' +
              '<option value="24">24 месяца (2 года)</option>' +
              '<option value="36">36 месяцев (3 года)</option>' +
              '<option value="60">60 месяцев (5 лет)</option>' +
            '</select>' +
          '</div>' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="form-label" for="w-loc">📍 Где лежит чек / коробка?</label>' +
          '<input class="form-input" id="w-loc" name="storageLocation" type="text" maxlength="120" ' +
            'placeholder="Шкаф в спальне, синяя папка с документами">' +
        '</div>' +
        '<div class="flex gap-3 mt-4">' +
          '<button type="button" class="btn btn--secondary" style="flex:1;" data-warranty-cancel>Отмена</button>' +
          '<button type="submit" class="btn btn--primary" style="flex:1;">Сохранить</button>' +
        '</div>' +
      '</form>';

    openModal(html, function (card, close) {
      card.querySelector('[data-warranty-cancel]').addEventListener('click', close);
      card.querySelector('#warranty-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var title = card.querySelector('[name="title"]').value.trim();
        if (!title) {
          card.querySelector('#w-err').textContent = 'Укажите название вещи';
          return;
        }
        addWarranty({
          title: title,
          priceRub: card.querySelector('[name="priceRub"]').value,
          purchaseDate: card.querySelector('[name="purchaseDate"]').value,
          warrantyMonths: card.querySelector('[name="warrantyMonths"]').value,
          storageLocation: card.querySelector('[name="storageLocation"]').value
        }).then(function (res) {
          if (res.ok) {
            close();
            if (typeof onSaved === 'function') { onSaved(res.item); }
          }
        });
      });
    });
  }

  /* ================================================================
     7. [PRO #5] 🧾 ИНСПЕКТОР ПОДПИСОК («ДЕТЕКТОР ЗАБЫТЫХ ТРАТ»)
     ================================================================ */

  function analyzeSubscriptions(payments) {
    var list = Array.isArray(payments) ? payments : [];
    var subs = [];
    var monthlyKopecks = 0;
    var upcomingSoon = [];

    var now = new Date();
    now.setHours(0, 0, 0, 0);

    // Дедупликация по названию для корректной оценки ежемесячной абонентской платы
    var seenByTitle = {};

    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p) { continue; }
      var isSubCategory = String(p.category || '') === 'Подписки';
      var isRecurringService = Boolean(p.recurring) && String(p.category || '') !== 'ЖКХ';

      if (!isSubCategory && !isRecurringService) { continue; }

      var key = String(p.title || '').trim().toLowerCase();
      var amt = Number(p.amount) || 0;

      if (!seenByTitle[key] || String(p.date || '') > String(seenByTitle[key].date || '')) {
        seenByTitle[key] = {
          id: p.id,
          title: p.title || 'Подписка',
          amount: amt,
          date: p.date,
          status: p.status,
          category: p.category || 'Подписки'
        };
      }

      if (p.status !== 'paid' && p.date) {
        var d = new Date(p.date);
        if (!isNaN(d.getTime())) {
          d.setHours(0, 0, 0, 0);
          var diffDays = Math.round((d.getTime() - now.getTime()) / 86400000);
          if (diffDays >= 0 && diffDays <= 3) {
            upcomingSoon.push({
              id: p.id,
              title: p.title,
              amount: amt,
              daysLeft: diffDays
            });
          }
        }
      }
    }

    Object.keys(seenByTitle).forEach(function (k) {
      var item = seenByTitle[k];
      subs.push(item);
      monthlyKopecks += item.amount;
    });

    subs.sort(function (a, b) { return b.amount - a.amount; });

    return {
      count: subs.length,
      monthlyKopecks: monthlyKopecks,
      yearlyKopecks: monthlyKopecks * 12,
      subscriptions: subs,
      upcomingSoon: upcomingSoon
    };
  }

  function renderSubscriptionInspectorHtml(payments) {
    if (!isPro()) { return ''; }

    var info = analyzeSubscriptions(payments);
    if (info.count === 0) { return ''; }

    var warnHtml = '';
    if (info.upcomingSoon.length > 0) {
      var names = info.upcomingSoon.map(function (u) {
        return esc(u.title) + ' (' + formatKopecks(u.amount) + ')';
      }).join(', ');
      warnHtml = '<div class="sub-inspector-card__warn">' +
        '⚠️ Скоро автосписание (в ближайшие 3 дня): <strong>' + names + '</strong>' +
      '</div>';
    }

    return '<section class="card sub-inspector-card mb-3" data-pro-feature="subscription-inspector">' +
      '<div class="sub-inspector-card__top">' +
        '<div>' +
          '<div class="flex items-center gap-2">' +
            '<span class="sub-inspector-card__title">🧾 Инспектор подписок и регулярных списаний</span>' +
            '<span class="pro-badge">PRO</span>' +
          '</div>' +
          '<div class="sub-inspector-card__meta">' +
            'Активных сервисов: <strong>' + info.count + '</strong> · В месяц: <strong>' + formatKopecks(info.monthlyKopecks) + '</strong>' +
          '</div>' +
        '</div>' +
        '<div class="sub-inspector-card__yearly">' +
          '<span class="sub-inspector-card__yearly-label">Набегает за год</span>' +
          '<strong class="sub-inspector-card__yearly-val" data-sub-yearly>' + formatKopecks(info.yearlyKopecks) + '/год</strong>' +
        '</div>' +
      '</div>' +
      warnHtml +
    '</section>';
  }

  /* ================================================================
     8. [PRO #6] 🎯 СЕМЕЙНАЯ ЦЕЛЬ НАКОПЛЕНИЙ («КОПИЛКА»)
     ================================================================ */

  function getSavingsGoal() {
    var saved = lsReadJson(LS_SAVINGS, null);
    if (!saved || typeof saved !== 'object') {
      return {
        title: DEFAULT_SAVINGS_GOAL.title,
        targetRub: DEFAULT_SAVINGS_GOAL.targetRub,
        currentRub: DEFAULT_SAVINGS_GOAL.currentRub,
        targetDate: DEFAULT_SAVINGS_GOAL.targetDate,
        contributions: []
      };
    }
    return {
      title: String(saved.title || DEFAULT_SAVINGS_GOAL.title),
      targetRub: Math.max(100, Number(saved.targetRub) || DEFAULT_SAVINGS_GOAL.targetRub),
      currentRub: Math.max(0, Number(saved.currentRub) || 0),
      targetDate: String(saved.targetDate || ''),
      contributions: Array.isArray(saved.contributions) ? saved.contributions : []
    };
  }

  function setSavingsGoal(data) {
    if (!isPro()) {
      toast('Семейная копилка доступна в подписке PRO', 'error');
      return Promise.resolve({ ok: false, message: 'Требуется PRO' });
    }
    var current = getSavingsGoal();
    if (data && typeof data === 'object') {
      if (data.title) { current.title = String(data.title).trim(); }
      if (data.targetRub !== undefined) {
        var t = parseFloat(String(data.targetRub).replace(',', '.'));
        if (!isNaN(t) && t >= 100) { current.targetRub = Math.round(t); }
      }
      if (data.currentRub !== undefined) {
        var c = parseFloat(String(data.currentRub).replace(',', '.'));
        if (!isNaN(c) && c >= 0) { current.currentRub = Math.round(c); }
      }
      if (data.targetDate !== undefined) {
        current.targetDate = String(data.targetDate || '');
      }
      if (Array.isArray(data.contributions)) {
        current.contributions = data.contributions;
      }
    }
    lsWriteJson(LS_SAVINGS, current);
    return syncSettingToDb(SET_SAVINGS, current).then(function () {
      return { ok: true, goal: current };
    });
  }

  function addContribution(amountRub, memberName) {
    if (!isPro()) {
      toast('Семейная копилка доступна в подписке PRO', 'error');
      return Promise.resolve({ ok: false, message: 'Требуется PRO' });
    }
    var addVal = parseFloat(String(amountRub).replace(',', '.'));
    if (isNaN(addVal) || addVal <= 0) {
      return Promise.resolve({ ok: false, message: 'Укажите сумму взноса больше 0 ₽' });
    }

    var goal = getSavingsGoal();
    var rounded = Math.round(addVal * 100) / 100;
    goal.currentRub = Math.round((goal.currentRub + rounded) * 100) / 100;

    var entry = {
      id: Date.now(),
      memberName: memberName ? String(memberName).trim() : 'Вы',
      amountRub: rounded,
      date: new Date().toISOString()
    };
    goal.contributions.unshift(entry);
    goal.contributions = goal.contributions.slice(0, 10);

    lsWriteJson(LS_SAVINGS, goal);
    return syncSettingToDb(SET_SAVINGS, goal).then(function () {
      if (window.MicroFX && typeof window.MicroFX.burst === 'function') {
        var bar = document.querySelector('.savings-goal-card__progress-fill');
        if (bar) { window.MicroFX.burst(bar); }
      }
      toast('В копилку добавлено ' + formatRub(rounded) + '!', 'success');
      return { ok: true, goal: goal, entry: entry };
    });
  }

  function renderSavingsGoalHtml() {
    var goal = getSavingsGoal();
    var pct = goal.targetRub > 0
      ? Math.min(100, Math.round((goal.currentRub / goal.targetRub) * 100))
      : 0;
    var leftRub = Math.max(0, goal.targetRub - goal.currentRub);

    var recentHtml = '';
    if (goal.contributions.length > 0) {
      recentHtml = '<div class="savings-goal-card__history">' +
        goal.contributions.slice(0, 3).map(function (c) {
          return '<span class="savings-contrib-chip">👤 ' + esc(c.memberName) + ': +' + formatRub(c.amountRub) + '</span>';
        }).join('') +
      '</div>';
    }

    return '<div class="card backup-section pro-only savings-goal-card" data-pro-feature="savings-goal">' +
      '<div class="savings-goal-card__head">' +
        '<div>' +
          '<h3 class="backup-section__title" style="margin-bottom:2px;">🎯 Семейная копилка: ' +
            '<span data-savings-title>' + esc(goal.title) + '</span> ' +
            '<span class="pro-badge">PRO</span>' +
          '</h3>' +
          '<p class="backup-section__desc" style="margin-bottom:0;">' +
            'Накоплено <strong data-savings-current>' + formatRub(goal.currentRub) + '</strong> из ' +
            '<strong data-savings-target>' + formatRub(goal.targetRub) + '</strong> ' +
            (leftRub > 0 ? '(осталось ' + formatRub(leftRub) + ')' : '— цель достигнута! 🎉') +
          '</p>' +
        '</div>' +
        '<div class="savings-goal-card__pct" data-savings-pct>' + pct + '%</div>' +
      '</div>' +

      '<div class="savings-goal-card__progress-track">' +
        '<div class="savings-goal-card__progress-fill" style="width:' + pct + '%;"></div>' +
      '</div>' +

      recentHtml +

      '<div class="backup-cloud__buttons" style="margin-top:var(--space-3);">' +
        '<button type="button" class="btn btn--primary btn--sm" data-savings-action="contribute">' +
          '➕ Пополнить копилку' +
        '</button>' +
        '<button type="button" class="btn btn--secondary btn--sm" data-savings-action="configure">' +
          '⚙️ Изменить цель' +
        '</button>' +
      '</div>' +
    '</div>';
  }

  function openSavingsGoalModal(mode, onSaved) {
    var goal = getSavingsGoal();
    if (mode === 'contribute') {
      var html = '<h2 class="modal-content__title">➕ Пополнить копилку</h2>' +
        '<p class="modal-content__text" style="margin-bottom:var(--space-3);">Цель: <strong>' + esc(goal.title) + '</strong></p>' +
        '<form id="savings-contrib-form" novalidate>' +
          '<div class="form-group">' +
            '<label class="form-label" for="sc-amount">Сумма взноса (\u20BD)</label>' +
            '<input class="form-input" id="sc-amount" name="amountRub" type="text" inputmode="decimal" placeholder="10000" required>' +
            '<div class="form-error" id="sc-err"></div>' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label" for="sc-member">Кто вносит</label>' +
            '<input class="form-input" id="sc-member" name="memberName" type="text" maxlength="50" value="Вы">' +
          '</div>' +
          '<div class="flex gap-3 mt-4">' +
            '<button type="button" class="btn btn--secondary" style="flex:1;" data-sc-cancel>Отмена</button>' +
            '<button type="submit" class="btn btn--primary" style="flex:1;">Внести</button>' +
          '</div>' +
        '</form>';

      openModal(html, function (card, close) {
        card.querySelector('[data-sc-cancel]').addEventListener('click', close);
        card.querySelector('#savings-contrib-form').addEventListener('submit', function (e) {
          e.preventDefault();
          var amt = card.querySelector('[name="amountRub"]').value;
          var mem = card.querySelector('[name="memberName"]').value;
          addContribution(amt, mem).then(function (res) {
            if (!res.ok) {
              card.querySelector('#sc-err').textContent = res.message;
              return;
            }
            close();
            if (typeof onSaved === 'function') { onSaved(res.goal); }
          });
        });
      });
      return;
    }

    var cfgHtml = '<h2 class="modal-content__title">🎯 Настроить цель накоплений</h2>' +
      '<form id="savings-cfg-form" novalidate>' +
        '<div class="form-group">' +
          '<label class="form-label" for="sg-title">Название цели</label>' +
          '<input class="form-input" id="sg-title" name="title" type="text" maxlength="80" value="' + esc(goal.title) + '">' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="form-label" for="sg-target">Целевая сумма (\u20BD)</label>' +
          '<input class="form-input" id="sg-target" name="targetRub" type="text" inputmode="decimal" value="' + goal.targetRub + '">' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="form-label" for="sg-current">Уже накоплено (\u20BD)</label>' +
          '<input class="form-input" id="sg-current" name="currentRub" type="text" inputmode="decimal" value="' + goal.currentRub + '">' +
        '</div>' +
        '<div class="flex gap-3 mt-4">' +
          '<button type="button" class="btn btn--secondary" style="flex:1;" data-sg-cancel>Отмена</button>' +
          '<button type="submit" class="btn btn--primary" style="flex:1;">Сохранить</button>' +
        '</div>' +
      '</form>';

    openModal(cfgHtml, function (card, close) {
      card.querySelector('[data-sg-cancel]').addEventListener('click', close);
      card.querySelector('#savings-cfg-form').addEventListener('submit', function (e) {
        e.preventDefault();
        setSavingsGoal({
          title: card.querySelector('[name="title"]').value,
          targetRub: card.querySelector('[name="targetRub"]').value,
          currentRub: card.querySelector('[name="currentRub"]').value
        }).then(function (res) {
          if (res.ok) {
            toast('Цель накоплений обновлена', 'success');
            close();
            if (typeof onSaved === 'function') { onSaved(res.goal); }
          }
        });
      });
    });
  }

  /* ================================================================
     9. [PRO #7] 🖨️ ПАКЕТНЫЙ ЭКСПОРТ В EXCEL / CSV (UTF-8 С BOM)
     ================================================================ */

  function csvCell(val) {
    if (val === null || val === undefined) { return '""'; }
    var str = String(val).replace(/\r?\n/g, ' ').replace(/"/g, '""');
    return '"' + str + '"';
  }

  function buildCsvDump() {
    if (!isPro()) {
      return Promise.reject(new Error('Экспорт в Excel (.CSV) доступен только в PRO'));
    }
    if (!window.DB) {
      return Promise.reject(new Error('База данных не инициализирована'));
    }

    return Promise.all([
      window.DB.getAll('payments'),
      window.DB.getAll('meters'),
      window.DB.getAll('meter_readings'),
      window.DB.getAll('documents'),
      window.DB.getAll('tasks')
    ]).then(function (res) {
      var payments = res[0] || [];
      var meters = res[1] || [];
      var readings = res[2] || [];
      var documents = res[3] || [];
      var tasks = res[4] || [];
      var warranties = getWarranties();

      var rows = [];
      // Заголовок таблицы для русского MS Excel (разделитель ;)
      rows.push([
        'Раздел',
        'Название',
        'Категория / Тип',
        'Сумма / Показание',
        'Статус',
        'Дата',
        'Примечание'
      ].map(csvCell).join(';'));

      // 1. Платежи
      payments.forEach(function (p) {
        var rub = ((Number(p.amount) || 0) / 100).toFixed(2).replace('.', ',');
        rows.push([
          'Платежи',
          p.title || '',
          p.category || '',
          rub + ' ₽',
          p.status === 'paid' ? 'Оплачено' : (p.status === 'overdue' ? 'Просрочено' : 'Ожидает'),
          p.date || '',
          p.note || ''
        ].map(csvCell).join(';'));
      });

      // 2. Счётчики и показания
      var calc = calcMetersBillSummary(meters, readings);
      calc.items.forEach(function (m) {
        rows.push([
          'Счётчики',
          m.name || '',
          m.type || '',
          (m.currentValue !== null ? m.currentValue + ' ' + m.unit : '—'),
          'Расход: +' + m.delta + ' ' + m.unit,
          m.lastDate || '',
          'К оплате по тарифу: ' + String(m.costRub).replace('.', ',') + ' ₽'
        ].map(csvCell).join(';'));
      });

      // 3. Документы
      documents.forEach(function (d) {
        rows.push([
          'Документы',
          d.name || '',
          d.category || '',
          '—',
          d.expiryDate ? 'До ' + d.expiryDate : 'Бессрочно',
          d.issuedDate || '',
          ''
        ].map(csvCell).join(';'));
      });

      // 4. Гарантии и чеки
      warranties.forEach(function (w) {
        rows.push([
          'Гарантии и чеки',
          w.title || '',
          'Гарантия ' + w.warrantyMonths + ' мес.',
          w.priceRub ? w.priceRub + ' ₽' : '—',
          'До ' + (w.expiryDate || ''),
          w.purchaseDate || '',
          'Где лежит: ' + (w.storageLocation || '')
        ].map(csvCell).join(';'));
      });

      // 5. Задачи
      tasks.forEach(function (t) {
        rows.push([
          'Задачи',
          t.title || '',
          t.category || t.priority || '',
          '—',
          t.completed ? 'Выполнено' : 'Активно',
          t.dueDate || '',
          t.description || ''
        ].map(csvCell).join(';'));
      });

      // UTF-8 BOM (\uFEFF) гарантирует правильную кириллицу при двойном клике в Excel
      var csv = '\uFEFF' + rows.join('\r\n');
      return {
        csv: csv,
        rowsCount: rows.length - 1
      };
    });
  }

  function downloadCsv() {
    if (!isPro()) {
      toast('Экспорт в Excel (.CSV) доступен только в подписке PRO', 'error');
      return Promise.resolve({ ok: false, message: 'Требуется подписка PRO' });
    }

    return buildCsvDump().then(function (res) {
      var now = new Date();
      var iso = now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0');
      var fileName = 'moy_poryadok_export_' + iso + '.csv';

      try {
        var blob = new Blob([res.csv], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          if (a.parentNode) { a.parentNode.removeChild(a); }
          URL.revokeObjectURL(url);
        }, 1200);
      } catch (e) {}

      toast('Таблица Excel (' + fileName + ') скачана!', 'success');
      return {
        ok: true,
        fileName: fileName,
        rowsCount: res.rowsCount,
        csv: res.csv
      };
    });
  }

  /* ================================================================
     10. ПУБЛИЧНЫЙ API WINDOW.VALUEPACK
     ================================================================ */

  window.ValuePack = {
    // 1. Тарифы ЖКХ (Free)
    DEFAULT_TARIFFS: DEFAULT_TARIFFS,
    getTariffs: getTariffs,
    setTariffs: setTariffs,
    getTariffForMeter: getTariffForMeter,
    calcConsumptionRub: calcConsumptionRub,
    calcMetersBillSummary: calcMetersBillSummary,
    renderMetersToolbarHtml: renderMetersToolbarHtml,
    openTariffsModal: openTariffsModal,

    // 2. Умные чек-листы (Free)
    CHECKLIST_TEMPLATES: CHECKLIST_TEMPLATES,
    getChecklistTemplates: getChecklistTemplates,
    applyChecklist: applyChecklist,
    openChecklistsModal: openChecklistsModal,

    // 3. Пересылка показаний (Free)
    buildReadingsShareText: buildReadingsShareText,
    shareReadings: shareReadings,

    // 4. Склад гарантий и чеков (PRO)
    getWarranties: getWarranties,
    addWarranty: addWarranty,
    removeWarranty: removeWarranty,
    renderWarrantiesSectionHtml: renderWarrantiesSectionHtml,
    openAddWarrantyModal: openAddWarrantyModal,

    // 5. Инспектор подписок (PRO)
    analyzeSubscriptions: analyzeSubscriptions,
    renderSubscriptionInspectorHtml: renderSubscriptionInspectorHtml,

    // 6. Семейная копилка (PRO)
    getSavingsGoal: getSavingsGoal,
    setSavingsGoal: setSavingsGoal,
    addContribution: addContribution,
    renderSavingsGoalHtml: renderSavingsGoalHtml,
    openSavingsGoalModal: openSavingsGoalModal,

    // 7. Экспорт в Excel / CSV (PRO)
    buildCsvDump: buildCsvDump,
    downloadCsv: downloadCsv
  };

  console.info('[ValuePack] Модуль загружен (Этап 12.12). API: window.ValuePack');
})();
