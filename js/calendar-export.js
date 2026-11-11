/**
 * МОЙ ПОРЯДОК — экспорт в календарь (.ics) (Этап 12.6, PRO)
 *
 * Зачем это нужно именно так:
 * браузер не может разбудить закрытую вкладку, поэтому гарантированно
 * «доставленные» напоминания возможны только через календарь операционной
 * системы. Файл .ics — единственный способ передать события в Google/Apple/
 * Outlook календарь без собственного сервера (условие этапа: никаких внешних
 * push-сервисов).
 *
 * Формат — RFC 5545, и здесь мелочей нет:
 *   • переносы строк ОБЯЗАТЕЛЬНО CRLF (тест 12.1.2 проверяет это буквально);
 *   • строки длиннее 75 байт складываются (folding) переводом + пробелом,
 *     иначе Apple Calendar и Outlook отвергают файл;
 *   • все тексты экранируются (\, \; \\, перенос строки в \n);
 *   • DTSTAMP всегда в UTC с суффиксом Z, события — в Europe/Moscow, поэтому
 *     в файл положен блок VTIMEZONE: без него Google Calendar ругается на TZID;
 *   • BOM в начале — так кириллица корректно читается и почтовыми клиентами
 *     Windows, которые иначе берут кодировку страницы, а не UTF-8.
 *
 * Приватность: в SUMMARY события попадает нейтральное название («Платёж»,
 * «Дело», «Документ»); имя записи и сумма — только в DESCRIPTION, и только
 * если пользователь включил показ чувствительных данных (NotifPrefs.showAmounts).
 *
 * Экспортирует: window.CalendarExport
 */

(function () {
  'use strict';

  /* ================================================================
     1. КОНСТАНТЫ
     ================================================================ */

  /** @const {string} имя файла по умолчанию (условие этапа) */
  var FILE_NAME = 'my_order_calendar.ics';

  /** @const {string} часовой пояс: приложение живёт по московскому времени */
  var TZID = 'Europe/Moscow';

  /** @const {number} максимум байт в одной строке по RFC 5545 */
  var MAX_LINE_OCTETS = 75;

  /**
   * До чего расширивать горизонт выборки событий.
   * @const {Object.<string, {label: string, days: number}>}
   */
  var HORIZONS = {
    week: { label: 'Неделя', days: 7 },
    month: { label: 'Месяц', days: 31 },
    quarter: { label: 'Квартал', days: 92 }
  };

  /** @const {Object.<string, string>} время события по умолчанию */
  var EVENT_TIMES = {
    morning: { label: 'Утро (09:00)', hhmm: '09:00' },
    evening: { label: 'Вечер (19:00)', hhmm: '19:00' },
    allday: { label: 'Весь день', hhmm: null }
  };

  /** @const {string} нейтральные названия типов для SUMMARY */
  var TYPE_LABELS = {
    payment: 'Платёж',
    task: 'Дело',
    document: 'Документ'
  };

  /* ================================================================
     2. НИЗКОУРОВНЕВЫЕ ПРИМИТИВЫ ICS
     ================================================================ */

  /**
   * Экранирование текстового значения по RFC 5545 §3.3.11.
   * @param {*} value
   * @returns {string}
   */
  function escText(value) {
    return String(value == null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n|\r|\n/g, '\\n');
  }

  /**
   * Складка строки: если значение длиннее 75 БАЙТ (не символов!), режем по
   * границам целых символов и переносим continuation-строку с одним пробелом.
   *
   * Считать нужно именно байты: кириллица в UTF-8 занимает 2 байта, поэтому
   * «75 символов» дали бы 150 байт и Apple Calendar/Outlook отвергли бы файл.
   *
   * Внутри строки ищем границу слова: разрыв посреди слова unfold восстанавли-
   * вает корректно, но файл, собранный по пробелам, можно прочитать глазами и
   * отладить без парсера.
   * @param {string} line — без переноса
   * @returns {string[]} готовые строки
   */
  function foldLine(line) {
    var enc = new TextEncoder();
    var out = [];
    var rest = String(line);

    while (enc.encode(rest).length > MAX_LINE_OCTETS) {
      var cut = 0;
      var bytes = 0;

      while (cut < rest.length) {
        var size = octetsOf(rest, cut);
        if (bytes + size > MAX_LINE_OCTETS) { break; }
        bytes += size;
        cut += size === 4 ? 2 : 1;
      }

      // Предпочитаем перенести на границе слова, если пробел недалеко:
      // 55 байт из 75 — разумный минимум, иначе строки рвутся на разную длину
      var soft = rest.lastIndexOf(' ', cut);
      if (soft >= octetsToChars(rest, MAX_LINE_OCTETS - 20)) { cut = soft; }

      // Один символ длиннее лимита (в UTF-8 максимум 4 байта, лимит 75) —
      // такой тупик невозможен, но на всякий случай не уходим в ноль
      if (cut === 0) { cut = 1; }

      out.push(rest.slice(0, cut));
      rest = ' ' + rest.slice(cut);
    }

    out.push(rest);
    return out;
  }

  /**
   * Сколько символов строки укладываются в переданные байты.
   * @param {string} text
   * @param {number} limit — байты
   * @returns {number}
   */
  function octetsToChars(text, limit) {
    var used = 0;
    var i = 0;
    while (i < text.length) {
      var size = octetsOf(text, i);
      if (used + size > limit) { break; }
      used += size;
      i += size === 4 ? 2 : 1;
    }
    return i;
  }

  /**
   * Сколько байт в UTF-8 занимает символ, начинающийся в позиции i
   * (пары суррогатов считаются одним символом по 4 байта).
   * @param {string} text
   * @param {number} i
   * @returns {number}
   */
  function octetsOf(text, i) {
    var code = text.charCodeAt(i);

    if (code < 0x80) { return 1; }
    if (code < 0x800) { return 2; }
    if (code >= 0xD800 && code <= 0xDBFF) { return 4; }
    return 3;
  }

  /**
   * Собирает содержимое из пар «имя;параметр=значение:содержимое».
   * @param {Array<Array<string>>} lines — массивы [name, params, value]
   * @returns {string}
   */
  function fold(lines) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var parts = lines[i];
      var text = parts[0] + (parts[1] ? ';' + parts[1] : '') + ':' + parts[2];
      out = out.concat(foldLine(text));
    }
    return out;
  }

  /**
   * 'YYYY-MM-DD' → 'YYYYMMDD' (или null).
   * @param {string} iso
   * @returns {?string}
   */
  function icsDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? m[1] + m[2] + m[3] : null;
  }

  /**
   * 'YYYY-MM-DD' + 'HH:MM' → 'YYYYMMDDTHHMM00'.
   * @param {string} iso
   * @param {string} hhmm
   * @returns {?string}
   */
  function icsDateTime(iso, hhmm) {
    var d = icsDate(iso);
    var t = /^(\d{2}):(\d{2})/.exec(String(hhmm || ''));
    if (!d || !t) { return null; }
    return d + 'T' + t[1] + t[2] + '00';
  }

  /** @returns {string} DTSTAMP в формате UTC (требование RFC) */
  function icsStamp() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
      'T' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
  }

  /**
   * Событие на весь день: DTSTART;VALUE=DATE. Длительность не указываем —
   * по RFC суточное событие без DTEND покрывает ровно одни сутки.
   * @param {string} iso
   * @returns {Array}
   */
  function dateProp(iso) {
    return ['DTSTART', 'VALUE=DATE', icsDate(iso)];
  }

  /**
   * Событие во времени: DTSTART;TZID=Europe/Moscow.
   * @param {string} iso
   * @param {string} hhmm
   * @returns {Array}
   */
  function dateTimeProp(iso, hhmm) {
    return ['DTSTART', 'TZID=' + TZID, icsDateTime(iso, hhmm)];
  }

  /* ================================================================
     3. СБОР СОБЫТИЙ ИЗ БАЗЫ
     ================================================================ */

  /**
   * Конец горизонта в 'YYYY-MM-DD'.
   * @param {number} days
   * @returns {string}
   */
  function horizonEnd(days) {
    var d = new Date();
    d.setDate(d.getDate() + days);
    return window.NotifPrefs ? window.NotifPrefs.localDay(d) : d.toISOString().slice(0, 10);
  }

  /**
   * Копейки → «12 500 ₽» (или «12 500 ₽ 50 к.»). Сумма попадает в описание
   * только по настройке, поэтому форматирование живёт здесь, а не в UI-модуле.
   * @param {number} kopecks
   * @returns {string}
   */
  function money(kopecks) {
    var value = Number(kopecks);
    if (!Number.isFinite(value)) { return ''; }

    var sign = value < 0 ? '\u2212' : '';
    var abs = Math.abs(Math.round(value));
    var rub = Math.floor(abs / 100);
    var cents = abs % 100;
    var rubStr = String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');

    return sign + rubStr + ' \u20BD' + (cents ? ' ' + cents + ' к.' : '');
  }

  /**
   * Время события: берём только корректное 'HH:MM', иначе запись с мусором
   * в поле не должна превращать DTSTART в ':null' — валидатор календаря
   * отверг бы весь файл.
   * @param {string} raw
   * @param {?string} fallback
   * @returns {?string}
   */
  function safeTime(raw, fallback) {
    return /^\d{2}:\d{2}$/.test(String(raw || '')) ? String(raw) : (fallback || null);
  }

  /**
   * Превращает запись базы в описание события календаря.
   * @param {string} type — payment|task|document
   * @param {Object} record
   * @param {Object} prefs — настройки NotifPrefs
   * @returns {?Object}
   */
  function toEvent(type, record, prefs) {
    if (!record || !record.id) { return null; }

    var date = type === 'payment' ? record.date
      : type === 'task' ? record.dueDate : record.expiryDate;
    if (!date || !icsDate(date)) { return null; }

    var time = EVENT_TIMES[prefs.eventTime] || EVENT_TIMES.morning;

    var item = {
      uid: 'myorder-' + type + '-' + record.id + '@myorder',
      type: type,
      id: record.id,
      date: String(date).slice(0, 10),
      name: String(type === 'document' ? record.name : record.title || ''),
      dueTime: null,
      amountLabel: null,
      statusLabel: '',
      privateLabel: ''
    };

    if (type === 'payment') {
      item.amountLabel = money(record.amount);
      item.statusLabel = 'ожидает оплаты';
      item.privateLabel = item.name + ' — ' + item.amountLabel;

      // Регулярный платёж ставим вечером: коммуналку и подписки обычно
      // закрывают после работы, а не в 9 утра
      var recurring = record.frequency && record.frequency !== 'once';
      item.dueTime = recurring ? '19:00' : time.hhmm;
    } else if (type === 'task') {
      item.dueTime = safeTime(record.dueTime, time.hhmm);
      item.privateLabel = item.name;
      item.statusLabel = 'не выполнено';
    } else {
      // Документ — событие на весь день: «срок 15 ноября», без времени
      item.dueTime = null;
      item.privateLabel = item.name;
      item.statusLabel = 'срок действия';
    }

    // «Весь день» в настройках означает, что время нужно убрать всем,
    // но у документа его и так нет
    if (prefs.eventTime === 'allday') { item.dueTime = null; }

    return item;
  }

  /**
   * Приводит горизонт выборки к известному значению.
   * @param {string} raw
   * @returns {string}
   */
  function normalizeHorizon(raw) {
    return HORIZONS[raw] ? raw : 'month';
  }

  /**
   * Собирает все предстоящие события в горизонте.
   *
   * Что отсеивается и почему:
   *   • оплаченные платежи и выполненные задачи — напоминать о закрытом бессмысленно;
   *   • шаблоны recurring-платежей (isTemplate) и архивные копии дел;
   *   • документы без expiryDate (вечно действующий паспорт напоминания не просит).
   *
   * @param {Object} [options]
   * @param {string} [options.horizon] — week|month|quarter
   * @param {Object} [options.prefs] — настройки (по умолчанию NotifPrefs.get())
   * @returns {Promise<Array>}
   */
  function collectEvents(options) {
    options = options || {};

    var prefs = options.prefs || (window.NotifPrefs
      ? window.NotifPrefs.get()
      : { showAmounts: false, eventTime: 'morning', leadDays: 7, calendarHorizon: 'month' });

    var horizon = normalizeHorizon(options.horizon || prefs.calendarHorizon);
    var days = HORIZONS[horizon].days;
    var until = horizonEnd(days);
    /* Нижняя граница — не «сегодня», а столько же суток назад. Просроченный
       долг и невыполненное дело в календаре нужны: приложение о них
       напоминает (см. push-manager, overdue показывается всегда), и файл,
       где их нет, расходился бы с тем, что человек видит в интерфейсе.
       Срез по горизонту, а не «всё когда-либо», чтобы хвост старых записей
       не превращал экспорт в архив. */
    var from = horizonEnd(-days);

    if (!window.DB) { return Promise.reject(new Error('База данных недоступна.')); }

    return Promise.all([
      window.DB.getAll('payments'),
      window.DB.getAll('tasks'),
      window.DB.getAll('documents')
    ]).then(function (res) {
      var events = [];

      function push(type, list) {
        (list || []).forEach(function (record) {
          if (record.isTemplate || record.archived) { return; }
          if (type === 'task' && record.completed) { return; }
          if (type === 'payment' && record.status === 'paid') { return; }
          var item = toEvent(type, record, prefs);
          if (!item) { return; }
          // Горизонт: только с сегодня и до конца выбранного периода
          if (item.date < from || item.date > until) { return; }
          events.push(item);
        });
      }

      push('payment', res[0]);
      push('task', res[1]);
      push('document', res[2]);

      events.sort(function (a, b) {
        if (a.date !== b.date) { return a.date < b.date ? -1 : 1; }
        if (a.dueTime !== b.dueTime) { return (a.dueTime || '99') < (b.dueTime || '99') ? -1 : 1; }
        return a.uid < b.uid ? -1 : 1;
      });

      events.horizon = horizon;
      events.from = from;
      events.until = until;
      return events;
    });
  }

  /* ================================================================
     4. НАПОМИНАНИЯ (VALARM)
     ================================================================ */

  /**
   * Сколько VALARM поставить на событие и с какими TRIGGER.
   *
   * Правила (согласованы с условиями этапа):
   *   • платёж: за час, если у события есть время, иначе за день;
   *   • задача: за 30 минут, если задано время, иначе за день;
   *   • документ: за `leadDays` из настроек — ровно тот же порог, что
   *     показывает баннер в разделе «Документы»;
   *   • плюс суточное напоминание для всех документов, когда leadDays > 1,
   *     чтобы не было сюрприза «срок завтра, а предупреждали за две недели».
   *
   * @param {Object} item
   * @param {Object} prefs
   * @returns {Array<string>} список TRIGGER-значений
   */
  function triggersFor(item, prefs) {
    var out = [];

    if (item.type === 'document') {
      var lead = Number(prefs.leadDays) || 7;
      out.push('-P' + lead + 'D');
      if (lead > 1) { out.push('-P1D'); }
      return out;
    }

    if (item.dueTime) {
      out.push(item.type === 'task' ? '-PT30M' : '-PT1H');
      return out;
    }

    out.push('-P1D');
    return out;
  }

  /**
   * DTEND для события во времени: ровно через час, с переходом на следую-
   * щие сутки, если событие началось в 23:xx. Считаем локальными частями —
   * toISOString() сдвинул бы дату при смещении относительно UTC.
   * @param {string} iso — 'YYYY-MM-DD'
   * @param {string} hhmm
   * @returns {Array} пара для ['DTEND', 'TZID=…', …]
   */
  function endProp(iso, hhmm) {
    var day = new Date(iso + 'T' + hhmm + ':00');
    day.setHours(day.getHours() + 1);

    var p = function (n) { return String(n).padStart(2, '0'); };
    var value = day.getFullYear() + p(day.getMonth() + 1) + p(day.getDate()) +
      'T' + p(day.getHours()) + p(day.getMinutes()) + '00';

    return ['DTEND', 'TZID=' + TZID, value];
  }

  /**
   * Разворачивает событие в блок VEVENT (массив строк без складки).
   * @param {Object} item
   * @param {Object} prefs
   * @returns {string[]}
   */
  function eventLines(item, prefs) {
    var stamp = icsStamp();
    var neutral = TYPE_LABELS[item.type] || 'Событие';
    var where = item.date.slice(0, 10);

    /* SUMMARY всегда нейтральный: на экране блокировки календаря видно
       только его. Имя записи и сумма — в DESCRIPTION. */
    var summary = neutral;
    if (prefs.showAmounts && item.name) { summary = neutral + ': ' + item.name; }

    var description = [];
    description.push(neutral + ' в приложении «Мой Порядок»');
    if (item.statusLabel) { description.push('Статус: ' + item.statusLabel); }
    if (prefs.showAmounts) {
      if (item.privateLabel) { description.push('Запись: ' + item.privateLabel); }
    } else {
      description.push('Подробности — в приложении');
    }

    var lines = [
      ['BEGIN', '', 'VEVENT'],
      ['UID', '', escText(item.uid)],
      ['DTSTAMP', '', stamp],
      item.dueTime ? dateTimeProp(where, item.dueTime) : dateProp(where),
      ['SUMMARY', '', escText(summary)],
      ['DESCRIPTION', '', escText(description.join('\n'))],
      ['CATEGORIES', '', escText('Мой Порядок,' + neutral)],
      ['STATUS', '', 'CONFIRMED']
    ];

    if (item.dueTime) { lines.push(endProp(where, item.dueTime)); }

    triggersFor(item, prefs).forEach(function (trigger) {
      lines = lines.concat([
        ['BEGIN', '', 'VALARM'],
        ['ACTION', '', 'DISPLAY'],
        ['TRIGGER', '', trigger],
        ['DESCRIPTION', '', escText(neutral + ': напоминание «Моего Порядка»')],
        ['END', '', 'VALARM']
      ]);
    });

    lines.push(['END', '', 'VEVENT']);
    return lines;
  }

  /* ================================================================
     5. СБОРКА ФАЙЛА
     ================================================================ */

  /**
   * Строит текстовое содержимое .ics.
   * @param {Array} events — результат collectEvents
   * @param {Object} [options]
   * @param {Object} [options.prefs]
   * @param {boolean} [options.withTimezone=true]
   * @returns {string}
   */
  function buildICS(events, options) {
    options = options || {};
    var prefs = options.prefs || (window.NotifPrefs ? window.NotifPrefs.get() : {
      showAmounts: false, eventTime: 'morning', leadDays: 7, calendarHorizon: 'month'
    });

    var from = (events && events.from) || (window.NotifPrefs ? window.NotifPrefs.localDay() : '');
    var horizon = normalizeHorizon((events && events.horizon) || prefs.calendarHorizon);

    var head = [
      ['BEGIN', '', 'VCALENDAR'],
      ['VERSION', '', '2.0'],
      ['PRODID', '', '-//МОЙ ПОРЯДОК//MyOrder VK Mini App 12.6//RU'],
      ['CALSCALE', '', 'GREGORIAN'],
      ['METHOD', '', 'PUBLISH'],
      ['X-WR-CALNAME', '', escText('Мой Порядок')],
      ['X-WR-TIMEZONE', '', TZID],
      ['X-WR-CALDESC', '', escText('Платежи, дела и сроки документов: ' +
        HORIZONS[horizon].label.toLowerCase() + (from ? ', с ' + from : ''))]
    ];

    if (options.withTimezone !== false) {
      // Москва с 2014 года живёт без перехода на летнее время: один STANDARD
      // блок со фиксированным смещением +03:00 — и календарь не сдвинет события
      head = head.concat([
        ['BEGIN', '', 'VTIMEZONE'],
        ['TZID', '', TZID],
        ['BEGIN', '', 'STANDARD'],
        ['DTSTART', '', '19700101T000000'],
        ['TZOFFSETFROM', '', '+0300'],
        ['TZOFFSETTO', '', '+0300'],
        ['TZNAME', '', 'MSK'],
        ['END', '', 'STANDARD'],
        ['END', '', 'VTIMEZONE']
      ]);
    }

    var body = [];
    (events || []).forEach(function (item) { body = body.concat(eventLines(item, prefs)); });

    var all = head.concat(body).concat([['END', '', 'VCALENDAR']]);
    var flat = fold(all).join('\r\n') + '\r\n';

    // BOM: Windows-клиенты (Outlook) и часть Android-прошивок
    // без него читают кириллицу в кодировке страницы, а не UTF-8
    return '\uFEFF' + flat;
  }

  /**
   * Имя файла с датой, чтобы повторы не перезаписывали старый экспорт
   * в папке облака: my_order_calendar_2026-11-10.ics.
   * @param {Date} [now]
   * @returns {string}
   */
  function fileName(now) {
    var iso = window.NotifPrefs ? window.NotifPrefs.localDay(now) : new Date().toISOString().slice(0, 10);
    return 'my_order_calendar_' + iso + '.ics';
  }

  /**
   * Полный цикл: собрать события и вернуть текст файла со статистикой.
   * @param {Object} [options] — { horizon }
   * @returns {Promise<{text: string, fileName: string, events: Array, counts: Object}>}
   */
  function generateICS(options) {
    options = options || {};

    if (!proActive()) {
      return Promise.reject(new Error('Экспорт в календарь доступен только в PRO.'));
    }

    return collectEvents(options).then(function (events) {
      var counts = { payment: 0, task: 0, document: 0 };
      events.forEach(function (e) { counts[e.type] += 1; });

      return {
        text: buildICS(events, { prefs: window.NotifPrefs ? window.NotifPrefs.get() : {} }),
        fileName: fileName(),
        events: events,
        counts: counts
      };
    });
  }

  /** @returns {boolean} активен ли PRO */
  function proActive() {
    return Boolean(window.ProManager && window.ProManager.isPro && window.ProManager.isPro());
  }

  /**
   * Скачивает .ics через <a download>. Возвращает имя файла или null.
   * @param {string} text
   * @param {string} name
   * @returns {Promise<?string>}
   */
  function downloadICS(text, name) {
    return new Promise(function (resolve) {
      try {
        var blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
        var url = URL.createObjectURL(blob);

        var a = document.createElement('a');
        a.href = url;
        a.download = name || FILE_NAME;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();

        setTimeout(function () {
          if (a.parentNode) { a.parentNode.removeChild(a); }
          URL.revokeObjectURL(url);
        }, 1500);

        resolve(a.download);
      } catch (err) {
        console.info('[Calendar] Скачивание не удалось:', err && err.message || err);
        resolve(null);
      }
    });
  }

  /* ================================================================
     6. МЕТКА ПОВТОРНОГО ЭКСПОРТА
     ================================================================ */

  /** @const {string} localStorage: когда последний раз выгружали календарь */
  var KEY_EXPORTED = 'myorder_calendar_exported';

  /** @const {string} localStorage: когда в данных была последняя правка */
  var KEY_CHANGED = 'myorder_calendar_changed_at';

  /**
   * Была ли правка записей в ТЕКУЩЕЙ сессии после выгрузки. Держим в памяти
   * как быстрый путь, но то же самое есть в localStorage под временем: без
   * метки времени перезагрузка страницы «забывала» бы, что календарь отстал.
   * @type {boolean}
   */
  var changedSinceExport = false;

  window.addEventListener('db:change', function (e) {
    var store = e && e.detail && e.detail.store;
    // Правки самих настроек уведомлений не меняют набор событий календаря,
    // поэтому на них пересобирать экспорт не просим
    if (store === 'settings') { return; }
    markChanged();
  });

  /** Пикирует момент последней правки данных. */
  function markChanged() {
    changedSinceExport = true;
    try { localStorage.setItem(KEY_CHANGED, new Date().toISOString()); } catch (err) { /* ignore */ }
  }

  /**
   * Отмечает, что календарь обновлён. Нужна именно метка в localStorage,
   * а не поле в базе: дата экспорта — это технический факт синхронизации,
   * он не должен попадать в резервные копии данных пользователя.
   */
  function markExported() {
    changedSinceExport = false;
    try {
      localStorage.setItem(KEY_EXPORTED, new Date().toISOString());
      // Флаг правки снимаем: он уже учтён в свежем файле
      localStorage.removeItem(KEY_CHANGED);
    } catch (err) { /* ignore */ }
  }

  /** @returns {?string} ISO-время последнего экспорта */
  function lastExportedAt() {
    try {
      var raw = localStorage.getItem(KEY_EXPORTED);
      return raw && !isNaN(new Date(raw).getTime()) ? raw : null;
    } catch (err) { return null; }
  }

  /** @returns {?string} ISO-время последней правки данных */
  function lastChangedAt() {
    try {
      var raw = localStorage.getItem(KEY_CHANGED);
      return raw && !isNaN(new Date(raw).getTime()) ? raw : null;
    } catch (err) { return null; }
  }

  /**
   * Устарел ли экспорт относительно ДАННЫХ.
   *
   * Раньше сюда был примешан флаг dirty облачного бэкапа — и это была ошибка
   * на пол-лица: dirty означает «правки не доехали в облако» и снимается
   * только кнопкой «Сохранить в облако». Получалось, что выгруженный
   * вчерашний .ics числился устаревшим, пока человек не сделает резервную
   * копию, то есть приложение звало бы пересобирать файл, который свежий.
   * Сроки в календаре и резервная копия — два разных события, сравниваем
   * именно их времена.
   * @returns {boolean}
   */
  function isStale() {
    var exported = lastExportedAt();
    if (!exported) { return true; }
    if (changedSinceExport) { return true; }

    var changed = lastChangedAt();
    // Обе метки — ISO в UTC, сравнение строк тут корректно
    return Boolean(changed && changed > exported);
  }

  /**
   * Скачивает свежий файл и ставит метку. Точка входа для кнопки.
   * @param {Object} [options]
   * @returns {Promise<{fileName: string, counts: Object, events: Array}>}
   */
  function exportNow(options) {
    return generateICS(options).then(function (res) {
      markExported();
      return downloadICS(res.text, res.fileName).then(function (name) {
        return { fileName: name || res.fileName, counts: res.counts, events: res.events, text: res.text };
      });
    });
  }

  /* ================================================================
     7. ПУБЛИЧНЫЙ API
     ================================================================ */

  window.CalendarExport = {
    collectEvents: collectEvents,
    buildICS: buildICS,
    generateICS: generateICS,
    downloadICS: downloadICS,
    exportNow: exportNow,

    isStale: isStale,
    lastExportedAt: lastExportedAt,
    lastChangedAt: lastChangedAt,
    markExported: markExported,

    fileName: fileName,
    triggersFor: triggersFor,
    escText: escText,
    foldLine: foldLine,

    FILE_NAME: FILE_NAME,
    TZID: TZID,
    HORIZONS: HORIZONS,
    EVENT_TIMES: EVENT_TIMES,
    TYPE_LABELS: TYPE_LABELS,
    KEY_EXPORTED: KEY_EXPORTED,
    KEY_CHANGED: KEY_CHANGED
  };

  console.info('[Calendar] Модуль загружен. API: window.CalendarExport');
})();
