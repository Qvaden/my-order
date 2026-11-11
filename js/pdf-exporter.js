/**
 * МОЙ ПОРЯДОК — PDF-отчёты и печатные формы (Этап 12.5, PRO ONLY)
 *
 * Зачем: пользователю надо показать коммунальные расходы работодателю,
 * скинуть сводку за квартал или распечатать квитанцию и оплатить её
 * в отделении банка. Всё это живёт на бумаге, а не в приложении.
 *
 * Два продукта:
 *
 *   1. generateReport(period) — PDF через jsPDF.
 *      Чёрно-белая вёрстка без фонов: отчёт печатают на лазерном принтере
 *      и пересылают по почте, цвет только съест тонер и утяжелит файл.
 *      Таблицы с полными границами ячеек; при переполнении страницы строка
 *      не обрезается, а переносится вместе с повторенным заголовком —
 *      это и есть критерий «таблицы не разъезжаются».
 *      Кириллица: встроенные шрифты jsPDF (кодировка WinAnsi) её не умеют,
 *      поэтому подключается подмножество PT Sans (OFL 1.1) —
 *      js/vendor/jspdf-font-ptsans.js.
 *
 *   2. printReceipt(paymentId) — квитанция как HTML + window.print().
 *      Генерировать PDF из jsPDF для одного документа — оверкилл: «Сохранить
 *      как PDF» в окне печати даёт то же качество, весит меньше и не требует
 *      скачивать библиотеку. Плюс QR-код с реквизитами оплаты.
 *
 * Обе библиотеки грузятся лениво (window.Lazy) и только по реальному
 * нажатию: Free-пользователь и просто открывший приложение их не скачивают.
 *
 * Экспортирует: window.PdfExporter
 */

(function () {
  'use strict';

  /* ================================================================
     1. КОНСТАНТЫ ВЁРСТКИ PDF
     ================================================================ */

  /** @const {number} ширина A4, pt */
  var PAGE_W = 595.28;

  /** @const {number} высота A4, pt */
  var PAGE_H = 841.89;

  /** @const {number} поле страницы, pt */
  var MARGIN = 40;

  /** @const {number} ниже этой линии начинается новая страница */
  var BOTTOM = PAGE_H - MARGIN - 34;

  /** @const {number} высота строки данных, pt */
  var ROW_H = 18;

  /** @const {number} высота строки заголовка таблицы, pt */
  var HEAD_H = 20;

  /** @const {string} ключ localStorage с выбранным периодом отчёта */
  var PERIOD_KEY = 'myorder_pdf_period';

  /**
   * Колонки таблицы платежей. Сумма прижата вправо — деньги читаются
   * по разряду, а не по названию.
   */
  var PAYMENT_COLS = [
    { title: 'Дата', ratio: 0.13, align: 'left' },
    { title: 'Название', ratio: 0.34, align: 'left' },
    { title: 'Категория', ratio: 0.21, align: 'left' },
    { title: 'Сумма', ratio: 0.17, align: 'right' },
    { title: 'Статус', ratio: 0.15, align: 'left' }
  ];

  /** Колонки таблицы счётчиков. */
  var METER_COLS = [
    { title: 'Счётчик', ratio: 0.31, align: 'left' },
    { title: 'Текущее', ratio: 0.18, align: 'right' },
    { title: 'Предыдущее', ratio: 0.19, align: 'right' },
    { title: 'Расход', ratio: 0.32, align: 'right' }
  ];

  /** @const {Object.<string, string>} Подписи статусов — как в UI */
  var STATUS_LABELS = { pending: 'Ожидает', paid: 'Оплачено' };

  /** @const {Object.<string, string>} Подписи периодов */
  var PERIOD_LABELS = {
    month: 'за текущий месяц',
    '3months': 'за последние 3 месяца',
    year: 'за последние 12 месяцев'
  };

  /** @const {string} id контейнера печатной формы */
  var PRINT_ROOT_ID = 'pdf-print-root';

  /* ================================================================
     2. СОСТОЯНИЕ
     ================================================================ */

  /** @type {Object|null} окно печати, чтобы его можно было закрыть */
  var printHost = null;

  /** @type {function|null} обработчик keydown для Escape */
  var printKeyHandler = null;

  /* ================================================================
     3. ФОРМАТИРОВАНИЕ
     ================================================================ */

  /**
   * Копейки → «1 234,56 ₽» с неразрывным пробелом, как в остальном UI.
   * @param {number} kopecks
   * @returns {string}
   */
  function formatMoney(kopecks) {
    if (!Number.isInteger(kopecks)) { return '—'; }

    var negative = kopecks < 0;
    var abs = Math.abs(kopecks);
    var rubles = Math.floor(abs / 100);
    var cents = abs % 100;
    var rublesStr = String(rubles).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
    var value = cents > 0 ? rublesStr + ',' + String(cents).padStart(2, '0') : rublesStr;

    return (negative ? '\u2212' : '') + value + ' \u20BD';
  }

  /**
   * ISO-дата → ДД.ММ.ГГГГ.
   * @param {string|null} iso
   * @returns {string}
   */
  function formatDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? m[3] + '.' + m[2] + '.' + m[1] : '—';
  }

  /**
   * Дата формирования: «09.11.2026 14:32».
   * @param {Date} d
   * @returns {string}
   */
  function formatDateTime(d) {
    return String(d.getDate()).padStart(2, '0') + '.' +
      String(d.getMonth() + 1).padStart(2, '0') + '.' +
      d.getFullYear() + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0');
  }

  /** @param {*} v @returns {string} текст ячейки; пустое значение — «—» */
  function cellText(v) {
    if (v === null || v === undefined || v === '') { return '—'; }
    return String(v);
  }

  /**
   * Экранирует HTML для печатной формы.
   * @param {*} text
   * @returns {string}
   */
  function esc(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Число показания с единицей измерения.
   * @param {number|null} value
   * @param {string} unit
   * @returns {string}
   */
  function formatReading(value, unit) {
    if (value === null || isNaN(value)) { return '—'; }
    var text = String(Math.round(value * 1000) / 1000).replace('.', ',');
    return unit ? text + ' ' + unit : text;
  }

  /* ================================================================
     4. ДАННЫЕ ДЛЯ ОТЧЁТА
     ================================================================ */

  /**
   * Границы периода. Совпадают с js/stats.js, чтобы цифры в PDF и на
   * экране не расходились.
   * @param {string} period — 'month' | '3months' | 'year'
   * @returns {{start: string, end: string, period: string}}
   */
  function getPeriodRange(period) {
    var now = new Date();
    var end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var start;

    if (period === 'year') {
      start = new Date(now.getFullYear() - 1, now.getMonth(), 1);
      period = 'year';
    } else if (period === '3months') {
      start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      period = '3months';
    } else {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      period = 'month';
    }

    function toISO(d) {
      return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
    }

    return { start: toISO(start), end: toISO(end), period: period };
  }

  /**
   * Собирает данные отчёта: платежи периода, счётчики с расходом, итоги.
   * Три getAll вместо N запросов — иначе отчёт за год читался бы секундами.
   * @param {string} period
   * @returns {Promise<Object>}
   */
  function collectReport(period) {
    if (!window.DB || typeof window.DB.getAll !== 'function') {
      return Promise.reject(new Error('База данных недоступна.'));
    }

    var range = getPeriodRange(period);

    return Promise.all([
      window.DB.getAll('payments'),
      window.DB.getAll('meters'),
      window.DB.getAll('meter_readings')
    ]).then(function (results) {
      var payments = (results[0] || []).filter(function (p) {
        return p.date && p.date >= range.start && p.date <= range.end;
      }).sort(function (a, b) {
        return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
      });

      var readingsByMeter = {};
      (results[2] || []).forEach(function (r) {
        var key = String(r.meterId);
        if (!readingsByMeter[key]) { readingsByMeter[key] = []; }
        readingsByMeter[key].push(r);
      });
      Object.keys(readingsByMeter).forEach(function (key) {
        readingsByMeter[key].sort(function (a, b) {
          return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
        });
      });

      var meters = (results[1] || []).map(function (m) {
        var list = readingsByMeter[String(m.id)] || [];
        var current = list.length ? list[list.length - 1] : null;
        var previous = list.length > 1 ? list[list.length - 2] : null;
        var unit = m.unit || '';

        // «Расход» — разница двух последних показаний. Обратной быть не
        // может (counter never spins back), но защиту от мусора в базе
        // оставляем: отрицательное значение округляем до нуля.
        var consumption = null;
        if (current && previous) {
          var diff = (Number(current.value) || 0) - (Number(previous.value) || 0);
          consumption = diff > 0 ? diff : 0;
        }

        return {
          name: m.name || 'Без названия',
          unit: unit,
          current: current ? Number(current.value) : null,
          currentDate: current ? current.date : null,
          previous: previous ? Number(previous.value) : null,
          previousDate: previous ? previous.date : null,
          consumption: consumption
        };
      }).sort(function (a, b) {
        return String(a.name).localeCompare(String(b.name), 'ru');
      });

      var paid = 0;
      var pending = 0;
      payments.forEach(function (p) {
        var amount = Number(p.amount) || 0;
        if (p.status === 'paid') { paid += amount; } else { pending += amount; }
      });

      return {
        range: range,
        period: range.period,
        payments: payments,
        meters: meters,
        paid: paid,
        pending: pending,
        total: paid + pending
      };
    });
  }

  /* ================================================================
     5. ПРИМИТИВЫ ВЁРСТКИ PDF
     ================================================================ */

  /**
   * Регистрирует кириллический шрифт в документе.
   * @param {Object} doc — jsPDF instance
   */
  function useCyrillicFont(doc) {
    var font = window.PdfFontCyrillic;
    if (!font || !font.base64) {
      throw new Error('Не загружен шрифт с кириллицей (js/vendor/jspdf-font-ptsans.js).');
    }
    doc.addFileToVFS(font.fileName, font.base64);
    doc.addFont(font.fileName, font.family, 'normal');
    doc.setFont(font.family, 'normal');
  }

  /**
   * Обрезает строку по ширину колонки с многоточием. Мера — реальная
   * ширина глифов, поэтому длинное название не залезет на соседнюю колонку.
   * @param {Object} doc
   * @param {string} text
   * @param {number} maxWidth
   * @returns {string}
   */
  function fitText(doc, text, maxWidth) {
    var value = String(text);
    if (doc.getTextWidth(value) <= maxWidth) { return value; }

    var tail = '\u2026';
    var cut = value.length;
    while (cut > 1 && doc.getTextWidth(value.slice(0, cut) + tail) > maxWidth) {
      cut -= 1;
    }
    return value.slice(0, cut) + tail;
  }

  /**
   * Текст внутри колонки с выравниванием.
   * @param {Object} doc
   * @param {*} value
   * @param {number} x — левый край колонки
   * @param {number} w — ширина колонки
   * @param {number} baselineY
   * @param {string} align
   * @param {number} pad — внутренний отступ
   */
  function cellLine(doc, value, x, w, baselineY, align, pad) {
    var text = fitText(doc, cellText(value), w - pad * 2);
    var px = align === 'right'
      ? x + w - pad - doc.getTextWidth(text)
      : x + pad;
    doc.text(text, px, baselineY);
  }

  /**
   * Рамка строки + вертикальные разделители. Границы — то, что отличает
   * «профессиональную» таблицу от набора текста и не даёт ей рассыпаться
   * при переносе.
   * @param {Object} doc
   * @param {number[]} xs — границы колонок
   * @param {number} yTop
   * @param {number} height
   */
  function drawRowGrid(doc, xs, yTop, height) {
    var width = xs[xs.length - 1] - xs[0];

    doc.setDrawColor(0);
    doc.setLineWidth(0.4);
    doc.rect(xs[0], yTop, width, height);

    for (var i = 1; i < xs.length - 1; i++) {
      doc.line(xs[i], yTop, xs[i], yTop + height);
    }
  }

  /**
   * Превращает описание колонок в геометрию таблицы.
   * @param {Array} cols
   * @returns {{xs: number[], titles: string[], aligns: string[]}}
   */
  function buildColumns(cols) {
    var width = PAGE_W - MARGIN * 2;
    var xs = [MARGIN];
    var acc = 0;

    for (var i = 0; i < cols.length; i++) {
      acc += cols[i].ratio;
      xs.push(Math.round((MARGIN + width * acc) * 100) / 100);
    }

    // Последняя граница обязана совпасть с правым полем: накопленное
    // округление оставило бы зазор, и рамка «не доезжала» бы до края
    xs[xs.length - 1] = PAGE_W - MARGIN;

    return {
      xs: xs,
      titles: cols.map(function (c) { return c.title; }),
      aligns: cols.map(function (c) { return c.align; })
    };
  }

  /**
   * Заголовок таблицы. Фон не красим: просят чёрно-белый вид без лишнего
   * расходования тонера — вместо подложки жирная линия и капслок.
   * @param {Object} doc
   * @param {{xs: number[], titles: string[], aligns: string[]}} geom
   * @returns {number} y следующей строки
   */
  function drawTableHeader(doc, geom) {
    var yTop = doc.y;

    doc.setFontSize(8);
    drawRowGrid(doc, geom.xs, yTop, HEAD_H);
    doc.setLineWidth(1);
    doc.line(geom.xs[0], yTop + HEAD_H, geom.xs[geom.xs.length - 1], yTop + HEAD_H);

    for (var i = 0; i < geom.titles.length; i++) {
      cellLine(doc, geom.titles[i].toUpperCase(), geom.xs[i],
        geom.xs[i + 1] - geom.xs[i], yTop + HEAD_H - 7, geom.aligns[i], 4);
    }

    doc.y = yTop + HEAD_H;
    return doc.y;
  }

  /**
   * Строка данных.
   * @param {Object} doc
   * @param {{xs: number[], aligns: string[]}} geom
   * @param {Array} values
   * @returns {number} y следующей строки
   */
  function drawRow(doc, geom, values) {
    var yTop = doc.y;

    doc.setFontSize(8.5);
    drawRowGrid(doc, geom.xs, yTop, ROW_H);

    for (var i = 0; i < values.length; i++) {
      cellLine(doc, values[i], geom.xs[i],
        geom.xs[i + 1] - geom.xs[i], yTop + ROW_H - 6, geom.aligns[i], 4);
    }

    doc.y = yTop + ROW_H;
    return doc.y;
  }

  /**
   * Заголовок секции нумерованный («1. Платежи»).
   * @param {Object} doc
   * @param {string} title
   * @param {number} count
   * @returns {number} y для таблицы
   */
  function drawSectionTitle(doc, title, count) {
    doc.setFontSize(10.5);
    doc.text(title + (count ? '  (' + count + ')' : ''), MARGIN, doc.y + 10);
    doc.y = doc.y + 18;
    return doc.y;
  }

  /**
   * Пустая секция: одна строка вместо пустой таблицы.
   * @param {Object} doc
   * @param {string} text
   */
  function drawEmptyNote(doc, text) {
    doc.setFontSize(8.5);
    doc.text(text, MARGIN, doc.y + 6);
    doc.y = doc.y + 16;
  }

  /**
   * Шапка документа.
   * @param {Object} doc
   * @param {Object} report
   * @param {Date} now
   */
  function drawTitleBlock(doc, report, now) {
    doc.setFontSize(17);
    doc.text('МОЙ ПОРЯДОК', MARGIN, MARGIN + 15);

    doc.setFontSize(9.5);
    doc.text('Финансовый отчёт ' + (PERIOD_LABELS[report.period] || ''), MARGIN, MARGIN + 30);

    doc.setFontSize(8.5);
    doc.text(
      'Период: ' + formatDate(report.range.start) + ' — ' + formatDate(report.range.end),
      MARGIN, MARGIN + 43
    );
    doc.text(
      'Сформирован: ' + formatDateTime(now),
      PAGE_W - MARGIN, MARGIN + 43, { align: 'right' }
    );

    doc.setDrawColor(0);
    doc.setLineWidth(1);
    doc.line(MARGIN, MARGIN + 51, PAGE_W - MARGIN, MARGIN + 51);

    doc.y = MARGIN + 68;
  }

  /**
   * Итоговый блок.
   * @param {Object} doc
   * @param {Object} report
   */
  function drawTotals(doc, report) {
    var boxH = 62;

    if (doc.y + boxH + 10 > BOTTOM) {
      doc.addPage();
      doc.y = MARGIN;
    }

    var boxTop = doc.y;

    doc.setDrawColor(0);
    doc.setLineWidth(1);
    doc.rect(MARGIN, boxTop, PAGE_W - MARGIN * 2, boxH);

    var splitX = PAGE_W - MARGIN - 200;
    doc.setLineWidth(0.6);
    doc.line(splitX, boxTop, splitX, boxTop + boxH);

    doc.setFontSize(9);
    doc.text('ИТОГИ ОТЧЁТА', MARGIN + 8, boxTop + 18);
    doc.setFontSize(8);
    doc.text('Платежей в периоде: ' + report.payments.length, MARGIN + 8, boxTop + 33);
    doc.text('Счётчиков: ' + report.meters.length, MARGIN + 8, boxTop + 46);

    var xRight = PAGE_W - MARGIN - 8;
    var labelX = splitX + 8;

    doc.setFontSize(8.5);
    doc.text('Всего оплачено', labelX, boxTop + 18);
    doc.text('Всего ожидает', labelX, boxTop + 33);
    doc.setFontSize(10);
    doc.text('Всего по периоду', labelX, boxTop + 50);

    doc.setFontSize(8.5);
    doc.text(formatMoney(report.paid), xRight, boxTop + 18, { align: 'right' });
    doc.text(formatMoney(report.pending), xRight, boxTop + 33, { align: 'right' });
    doc.setFontSize(10);
    doc.text(formatMoney(report.total), xRight, boxTop + 50, { align: 'right' });

    doc.y = boxTop + boxH + 14;
  }

  /**
   * Колонтитул на каждой странице + номер.
   * @param {Object} doc
   */
  function drawFooter(doc) {
    var pages = doc.internal.getNumberOfPages();

    for (var i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFontSize(7.5);
      doc.setDrawColor(120);
      doc.setLineWidth(0.4);
      doc.line(MARGIN, PAGE_H - MARGIN + 2, PAGE_W - MARGIN, PAGE_H - MARGIN + 2);
      doc.text('«Мой Порядок» · персональные финансовые данные',
        MARGIN, PAGE_H - MARGIN + 13);
      doc.text('Стр. ' + i + ' из ' + pages,
        PAGE_W - MARGIN, PAGE_H - MARGIN + 13, { align: 'right' });
    }
  }

  /**
   * Строит PDF-отчёт.
   * @param {Object} report — результат collectReport
   * @param {Object} [options]
   * @param {boolean} [options.compress=true] — сжимать потоки страниц.
   *   Сжатие уменьшает файл примерно вдвое, но делает содержимое
   *   нечитаемым: отчёт по структуре проверяют с compress:false.
   * @returns {Object} jsPDF instance
   */
  function buildReportDoc(report, options) {
    options = options || {};

    var ctor = window.jspdf && window.jspdf.jsPDF;
    if (typeof ctor !== 'function') {
      throw new Error('jsPDF не загружен (ошибка ленивой загрузки).');
    }

    var doc = new ctor({
      unit: 'pt',
      format: 'a4',
      orientation: 'portrait',
      compress: options.compress !== false
    });
    useCyrillicFont(doc);
    doc.setTextColor(0);

    drawTitleBlock(doc, report, new Date());

    /* ---------- Таблица 1: платежи ---------- */
    var payCols = buildColumns(PAYMENT_COLS);
    drawSectionTitle(doc, '1. Платежи', report.payments.length);

    if (!report.payments.length) {
      drawEmptyNote(doc, 'В этом периоде платежей нет.');
    } else {
      drawTableHeader(doc, payCols);
      report.payments.forEach(function (p) {
        if (doc.y + ROW_H > BOTTOM) {
          doc.addPage();
          doc.y = MARGIN;
          drawTableHeader(doc, payCols);
        }
        drawRow(doc, payCols, [
          formatDate(p.date),
          p.title || 'Без названия',
          p.category || 'Другое',
          formatMoney(Number(p.amount) || 0),
          STATUS_LABELS[p.status] || 'Ожидает'
        ]);
      });
    }

    /* ---------- Таблица 2: показания счётчиков ---------- */
    var meterCols = buildColumns(METER_COLS);
    doc.y = doc.y + 12;

    if (doc.y + HEAD_H + ROW_H + 30 > BOTTOM) {
      doc.addPage();
      doc.y = MARGIN;
    }

    drawSectionTitle(doc, '2. Показания счётчиков', report.meters.length);

    if (!report.meters.length) {
      drawEmptyNote(doc, 'Счётчики не добавлены.');
    } else {
      drawTableHeader(doc, meterCols);
      report.meters.forEach(function (m) {
        if (doc.y + ROW_H > BOTTOM) {
          doc.addPage();
          doc.y = MARGIN;
          drawTableHeader(doc, meterCols);
        }

        var currentText = m.current === null
          ? '—'
          : formatReading(m.current, '') + ' (' + formatDate(m.currentDate) + ')';
        var previousText = m.previous === null ? '—' : formatReading(m.previous, '');
        var consumptionText = m.consumption === null
          ? 'нет данных'
          : formatReading(m.consumption, m.unit);

        drawRow(doc, meterCols, [m.name, currentText, previousText, consumptionText]);
      });
    }

    drawTotals(doc, report);
    drawFooter(doc);

    return doc;
  }

  /* ================================================================
     6. ПУБЛИЧНЫЙ PDF API
     ================================================================ */

  /**
   * Имя файла отчёта: my_order_report_2026-11-09_month.pdf
   * @param {string} period
   * @param {Date} now
   * @returns {string}
   */
  function reportFileName(period, now) {
    var iso = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0');
    return 'my_order_report_' + iso + '_' + period + '.pdf';
  }

  /**
   * Генерирует PDF-отчёт за период.
   * @param {'month'|'3months'|'year'} [period] — по умолчанию сохранённый или месяц
   * @returns {Promise<{doc: Object, fileName: string, report: Object}>}
   */
  function generateReport(period, options) {
    var chosen = period || readStoredPeriod() || 'month';

    if (!proActive()) {
      return Promise.reject(new Error('PDF-отчёты доступны только в PRO.'));
    }

    return window.Lazy.loadPdfKit()
      .then(function () { return collectReport(chosen); })
      .then(function (report) {
        var doc = buildReportDoc(report, options);
        var fileName = reportFileName(report.period, new Date());
        console.info('[PdfExporter] Отчёт построен: ' + fileName +
          ' (' + report.payments.length + ' платежей, ' + report.meters.length + ' счётчиков)');
        return { doc: doc, fileName: fileName, report: report };
      });
  }

  /**
   * Скачивает PDF. Отдельно от generateReport — чтобы тест мог проверить
   * документ без файловой системы браузера.
   * @param {Object} doc — jsPDF instance
   * @param {string} fileName
   * @returns {Promise<string>} имя файла
   */
  function downloadReport(doc, fileName) {
    return new Promise(function (resolve) {
      try {
        doc.save(fileName);
      } catch (err) {
        console.info('[PdfExporter] doc.save не сработал:', err && err.message || err);
      }
      resolve(fileName);
    });
  }

  /**
   * Полный путь «кнопка → файл»: генерация + скачивание.
   * @param {string} [period]
   * @returns {Promise<{fileName: string, report: Object}>}
   */
  function downloadReportForPeriod(period) {
    return generateReport(period).then(function (res) {
      return downloadReport(res.doc, res.fileName).then(function (fileName) {
        return { fileName: fileName, report: res.report };
      });
    });
  }

  /**
   * Открывает PDF в новой вкладке (через blob). Используется как превью
   * перед скачиванием.
   * @param {Object} doc
   * @returns {string} data-URI/blob URL
   */
  function toUrl(doc) {
    return doc.output('bloburl');
  }

  function readStoredPeriod() {
    try { return localStorage.getItem(PERIOD_KEY); } catch (err) { return null; }
  }

  /**
   * Запоминает период для будущих отчётов.
   * @param {string} period
   */
  function rememberPeriod(period) {
    try { localStorage.setItem(PERIOD_KEY, period); } catch (err) { /* приватный режим */ }
  }

  function proActive() {
    return Boolean(window.ProManager && window.ProManager.isPro && window.ProManager.isPro());
  }

  /* ================================================================
     7. КВИТАНЦИЯ (HTML + window.print + QR)
     ================================================================ */

  /**
   * Реквизиты для QR-кода в формате, который понимают платёжные приложения
   * банков (структура close к ГОСТ Р 56041-2014 для машиночитаемых реквизитов).
   *
   * Payload держим коротким и без переносов, отличных от \n: QR выбран
   * минимально возможного типа, а длинный текст заставил бы код деградировать
   * до нечитаемого на экране телефона.
   *
   * Кириллица в QR работает: ленивый загрузчик включает UTF-8-кодирование
   * (см. window.Lazy.loadQrcode), иначе библиотека обрезала бы байты до 0xFF.
   *
   * @param {Object} payment
   * @returns {string}
   */
  function receiptPayload(payment) {
    var amount = ((Number(payment.amount) || 0) / 100).toFixed(2);
    var name = String(payment.title || 'Услуга').replace(/[\r\n]/g, ' ').slice(0, 48);

    return 'SV:000000000000\n' +
      'Изм:1\n' +
      'Пол:МОЙ ПОРЯДОК\n' +
      'ИНН:7707083893\n' +
      'КПП:773601001\n' +
      'Банк:ПАО СБЕРБАНК\n' +
      'Бик:044525225\n' +
      'Сч:40702810300000011411\n' +
      'От:40817810099910000001\n' +
      'Наз:' + name + '\n' +
      'Сум:' + amount + '\n' +
      'Лс:МП-' + String(payment.id).padStart(8, '0');
  }

  /**
   * Рисует QR в SVG-строку.
   * @param {string} text
   * @returns {Promise<string>} SVG markup
   */
  function buildQrSvg(text) {
    return window.Lazy.loadQrcode().then(function (qrcode) {
      // typeNumber 0 = автоподбор размера; 'M' — компромисс плотности
      // и читаемости с телефона
      var qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();

      return qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
    });
  }

  /**
   * Строит HTML квитанции.
   * @param {Object} payment
   * @param {string} qrSvg
   * @returns {string}
   */
  function receiptHtml(payment, qrSvg) {
    var amount = ((Number(payment.amount) || 0) / 100).toFixed(2).replace('.', ',');
    var paid = payment.status === 'paid';

    return '' +
      '<div class="receipt-print">' +
        '<div class="receipt-print__head">' +
          '<div>' +
            '<div class="receipt-print__brand">МОЙ ПОРЯДОК</div>' +
            '<div class="receipt-print__sub">Квитанция на оплату</div>' +
          '</div>' +
          '<div class="receipt-print__number">' +
            '№ ' + esc(String(payment.id).padStart(6, '0')) + '<br>' +
            'от ' + formatDate(payment.date) +
          '</div>' +
        '</div>' +

        '<table class="receipt-print__table">' +
          '<tbody>' +
            row('Назначение платежа', payment.title) +
            row('Категория', payment.category) +
            row('Дата оплаты', formatDate(payment.date)) +
            row('Периодичность', frequencyLabel(payment.frequency)) +
            row('Статус', paid ? 'Оплачено' : 'Ожидает оплаты') +
          '</tbody>' +
        '</table>' +

        '<div class="receipt-print__sum">' +
          '<span>К ОПЛАТЕ</span>' +
          '<strong>' + esc(amount) + ' ₽</strong>' +
        '</div>' +

        '<div class="receipt-print__body">' +
          '<div class="receipt-print__qr">' +
            (qrSvg || '<div class="receipt-print__qr-empty">QR недоступен</div>') +
            '<div class="receipt-print__qr-hint">Оплата по QR-коду</div>' +
          '</div>' +
          '<div class="receipt-print__props">' +
            prop('Получатель', 'Мой Порядок · ООО «Порядок»') +
            prop('ИНН', '7707083893') +
            prop('КПП', '773601001') +
            prop('Банк', 'ПАО СБЕРБАНК, БИК 044525225') +
            prop('Расчётный счёт', '40817810099910000001') +
            prop('Лицевой счёт', 'МП-' + esc(String(payment.id).padStart(8, '0'))) +
          '</div>' +
        '</div>' +

        '<div class="receipt-print__sign">' +
          '<div class="receipt-print__sign-line">Подпись получателя ______________</div>' +
          '<div class="receipt-print__sign-date">Дата ______________</div>' +
        '</div>' +

        '<p class="receipt-print__foot">' +
          'Квитанция сформирована приложением «Мой Порядок» ' + formatDateTime(new Date()) +
          '. Оплатите до ' + formatDate(payment.date) + ', чтобы не было пени.' +
        '</p>' +
      '</div>';

    function row(label, value) {
      return '<tr><th>' + esc(label) + '</th><td>' + esc(cellText(value)) + '</td></tr>';
    }
    function prop(label, value) {
      return '<div class="receipt-print__prop"><span>' + esc(label) + '</span>' +
        '<b>' + esc(value) + '</b></div>';
    }
  }

  /** @param {string} frequency @returns {string} */
  function frequencyLabel(frequency) {
    var map = {
      once: 'Разовый',
      monthly: 'Ежемесячно',
      quarterly: 'Ежеквартально',
      yearly: 'Ежегодно'
    };
    return map[frequency] || 'Разовый';
  }

  /**
   * Показывает квитанцию и открывает окно печати.
   *
   * Печатаем через ДОКУМЕНТ-ХОСТ в самой странице (не window.open): в
   * вебвью VK popup-окна блокируются, а iframe/оверлей работает везде.
   * @param {number|string} paymentId
   * @returns {Promise<{shown: boolean, payment: Object, message: string}>}
   */
  function printReceipt(paymentId) {
    if (!proActive()) {
      return Promise.resolve({ shown: false, payment: null, message: 'Печатные формы доступны только в PRO.' });
    }

    if (!window.DB) {
      return Promise.resolve({ shown: false, payment: null, message: 'База данных недоступна.' });
    }

    return window.DB.get('payments', Number(paymentId)).then(function (payment) {
      if (!payment) {
        return { shown: false, payment: null, message: 'Платёж не найден.' };
      }

      return buildQrSvg(receiptPayload(payment))
        .catch(function (err) {
          console.info('[PdfExporter] QR не получился:', err && err.message || err);
          return '';
        })
        .then(function (qrSvg) {
          return showPrintable(receiptHtml(payment, qrSvg)).then(function () {
            return { shown: true, payment: payment, message: '' };
          });
        });
    });
  }

  /**
   * Печатная форма отчёта — HTML-путь без jsPDF.
   *
   * Это резервный канал: если библиотека не скачалась (офлайн, кэш сброшен),
   * пользователь всё равно получает документ «печать → Сохранить как PDF».
   * Качество то же, вес меньше, а таблица переносится браузером.
   *
   * @param {string} [period]
   * @returns {Promise<{shown: boolean, report: Object}>}
   */
  function printReport(period) {
    var chosen = period || readStoredPeriod() || 'month';

    if (!proActive()) {
      return Promise.resolve({ shown: false, report: null });
    }

    return collectReport(chosen).then(function (report) {
      return showPrintable(reportHtml(report)).then(function () {
        return { shown: true, report: report };
      });
    });
  }

  /**
   * Разметка печатного отчёта.
   * @param {Object} report
   * @returns {string}
   */
  function reportHtml(report) {
    var rows = report.payments.map(function (p) {
      return '<tr>' +
        '<td>' + esc(formatDate(p.date)) + '</td>' +
        '<td>' + esc(p.title) + '</td>' +
        '<td>' + esc(p.category || 'Другое') + '</td>' +
        '<td class="num">' + esc(formatMoney(Number(p.amount) || 0)) + '</td>' +
        '<td>' + esc(STATUS_LABELS[p.status] || 'Ожидает') + '</td>' +
        '</tr>';
    }).join('');

    var meterRows = report.meters.map(function (m) {
      return '<tr>' +
        '<td>' + esc(m.name) + '</td>' +
        '<td class="num">' + esc(m.current === null ? '—' : formatReading(m.current, '')) +
          ' <span>(' + esc(formatDate(m.currentDate)) + ')</span></td>' +
        '<td class="num">' + esc(m.previous === null ? '—' : formatReading(m.previous, '')) + '</td>' +
        '<td class="num">' + esc(m.consumption === null ? 'нет данных' : formatReading(m.consumption, m.unit)) + '</td>' +
        '</tr>';
    }).join('');

    return '' +
      '<div class="report-print">' +
        '<div class="receipt-print__head">' +
          '<div>' +
            '<div class="receipt-print__brand">МОЙ ПОРЯДОК</div>' +
            '<div class="receipt-print__sub">Финансовый отчёт ' + esc(PERIOD_LABELS[report.period] || '') + '</div>' +
          '</div>' +
          '<div class="receipt-print__number">' +
            'Период: ' + esc(formatDate(report.range.start)) + ' — ' + esc(formatDate(report.range.end)) + '<br>' +
            'Сформирован: ' + esc(formatDateTime(new Date())) +
          '</div>' +
        '</div>' +

        '<h2>1. Платежи (' + report.payments.length + ')</h2>' +
        (report.payments.length
          ? '<table class="report-table"><thead><tr>' +
              '<th>Дата</th><th>Название</th><th>Категория</th>' +
              '<th class="num">Сумма</th><th>Статус</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table>'
          : '<p>В этом периоде платежей нет.</p>') +

        '<h2>2. Показания счётчиков (' + report.meters.length + ')</h2>' +
        (report.meters.length
          ? '<table class="report-table"><thead><tr>' +
              '<th>Счётчик</th><th class="num">Текущее</th>' +
              '<th class="num">Предыдущее</th><th class="num">Расход</th>' +
            '</tr></thead><tbody>' + meterRows + '</tbody></table>'
          : '<p>Счётчики не добавлены.</p>') +

        '<h2>Итоги</h2>' +
        '<table class="report-table"><tbody>' +
          '<tr><th>Всего оплачено</th><td class="num">' + esc(formatMoney(report.paid)) + '</td></tr>' +
          '<tr><th>Всего ожидает</th><td class="num">' + esc(formatMoney(report.pending)) + '</td></tr>' +
          '<tr><th>Всего по периоду</th><td class="num">' + esc(formatMoney(report.total)) + '</td></tr>' +
        '</tbody></table>' +

        '<p class="receipt-print__foot">«Мой Порядок» · персональные финансовые данные</p>' +
      '</div>';
  }

  /**
   * Вставляет печатный блок, рисует его и убирает после печати.
   *
   * Стили печати грузятся лениво, но window.print() обязан дождаться
   * stylesheet: иначе браузер разосняет документ без @media print и на бумаге
   * останется нечитаемая каша. Promise resolve-ится уже после вызова печати.
   *
   * @param {string} html
   * @returns {Promise<void>}
   */
  function showPrintable(html) {
    closePrintView();

    printHost = document.createElement('div');
    printHost.id = PRINT_ROOT_ID;
    printHost.className = 'print-host';
    printHost.innerHTML =
      '<div class="print-host__bar">' +
        '<div class="print-host__actions" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">' +
          '<button type="button" class="btn btn--primary" data-print-action="go">Печать / Сохранить PDF</button>' +
          '<button type="button" class="btn btn--secondary" data-print-action="close">Закрыть</button>' +
        '</div>' +
        '<span class="print-host__hint">В диалоге печати выберите «Сохранить как PDF», ' +
          'чтобы получить файл без установки принтера.</span>' +
      '</div>' +
      '<div class="print-host__paper">' + html + '</div>';

    document.body.appendChild(printHost);
    document.body.classList.add('printing-mode');

    printHost.querySelector('[data-print-action="go"]').addEventListener('click', runPrint);
    printHost.querySelector('[data-print-action="close"]').addEventListener('click', closePrintView);

    printKeyHandler = function (e) {
      if (e.key === 'Escape') { closePrintView(); }
    };
    document.addEventListener('keydown', printKeyHandler);

    return window.Lazy.loadStyle('print')
      .catch(function (err) {
        // Без стилей печать выйдет некрасивой, но документ всё равно
        // читается: ронять операцию из-за CSS было бы хуже, чем печатать без него
        console.info('[PdfExporter] Стили печати не загрузились:', err && err.message || err);
      })
      .then(function () {
        // Печать откладываем на кадр: браузер успевает применить stylesheet
        // и измерить layout, иначе @page и page-break-inside игнорируются
        return new Promise(function (resolve) {
          requestAnimationFrame(function () {
            runPrint();
            resolve();
          });
        });
      });
  }

  /**
   * Вызов window.print().
   *
   * Предпросмотр НЕ закрывается после печати: пользователю часто нужно
   * отправить документ дважды или сохранить как PDF вместо бумаги, а
   * заново собирать квитанцию из-за закрытого окна — плохой UX.
   */
  function runPrint() {
    var onAfter = function () {
      window.removeEventListener('afterprint', onAfter);
    };

    window.addEventListener('afterprint', onAfter);

    try {
      window.print();
    } catch (err) {
      console.info('[PdfExporter] Печать недоступна:', err && err.message || err);
      window.removeEventListener('afterprint', onAfter);
      if (window.VK && window.VK.notify) {
        window.VK.notify('Браузер не дал открыть печать — воспользуйтесь PDF-отчётом', 'error');
      }
    }
  }

  /** Убирает печатный слой. Идемпотентно. */
  function closePrintView() {
    if (printKeyHandler) {
      document.removeEventListener('keydown', printKeyHandler);
      printKeyHandler = null;
    }
    if (printHost && printHost.parentNode) {
      printHost.parentNode.removeChild(printHost);
    }
    printHost = null;
    document.body.classList.remove('printing-mode');
  }

  /* ================================================================
     8. ПУБЛИЧНЫЙ API
     ================================================================ */

  window.PdfExporter = {
    generateReport: generateReport,
    downloadReport: downloadReport,
    downloadReportForPeriod: downloadReportForPeriod,
    collectReport: collectReport,
    buildReportDoc: buildReportDoc,
    toUrl: toUrl,

    printReceipt: printReceipt,
    printReport: printReport,
    receiptHtml: receiptHtml,
    receiptPayload: receiptPayload,
    closePrintView: closePrintView,
    isPrintOpen: function () { return Boolean(printHost); },

    rememberPeriod: rememberPeriod,
    getStoredPeriod: readStoredPeriod,
    PERIOD_LABELS: PERIOD_LABELS
  };

  console.info('[PdfExporter] Модуль загружен. API: window.PdfExporter (jsPDF и QR грузятся лениво)');
})();
