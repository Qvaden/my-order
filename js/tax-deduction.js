/**
 * МОЙ ПОРЯДОК — Налоговый вычет и Годовой архив платежей (PRO)
 *
 * Формирует официальную справку-реестр оплат ЖКУ и налогов за год
 * для подачи декларации 3-НДФЛ на налоговый вычет или отчёта перед арендодателем.
 *
 * Экспортирует window.TaxDeduction
 */

(function () {
  'use strict';

  function isPro() {
    return Boolean(window.ProManager && window.ProManager.isPro && window.ProManager.isPro());
  }

  function generateTaxReportHtml(year) {
    if (!window.DB) return Promise.reject(new Error('База данных не готова'));

    var targetYear = year || new Date().getFullYear();

    return window.DB.getAll('payments').then(function (all) {
      var paidYear = (all || []).filter(function (p) {
        return p.status === 'paid' && p.date && p.date.indexOf(String(targetYear)) === 0;
      });

      var totalKopecks = 0;
      for (var i = 0; i < paidYear.length; i++) {
        totalKopecks += (paidYear[i].amount || 0);
      }

      var totalRubles = (totalKopecks / 100);
      var taxReturn13 = Math.round(totalRubles * 0.13);

      var rowsHtml = paidYear.map(function (p, idx) {
        var rub = ((p.amount || 0) / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2 });
        return '<tr>' +
          '<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">' + (idx + 1) + '</td>' +
          '<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">' + (p.date || '—') + '</td>' +
          '<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;"><strong>' + (p.title || 'Платёж') + '</strong></td>' +
          '<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">' + (p.category || 'ЖКУ') + '</td>' +
          '<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:bold;">' + rub + ' ₽</td>' +
        '</tr>';
      }).join('');

      var html = '<!DOCTYPE html>' +
        '<html lang="ru">' +
        '<head>' +
          '<meta charset="UTF-8">' +
          '<title>Справка о расходах на ЖКУ за ' + targetYear + ' год</title>' +
          '<style>' +
            'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 40px; color: #1e293b; line-height: 1.5; }' +
            '.header { border-bottom: 2px solid #0f172a; padding-bottom: 16px; margin-bottom: 24px; }' +
            '.title { font-size: 20px; font-weight: bold; text-transform: uppercase; margin: 0 0 8px 0; }' +
            '.meta { font-size: 13px; color: #64748b; }' +
            'table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 13px; }' +
            'th { background: #f8fafc; padding: 10px 12px; border-bottom: 2px solid #cbd5e1; text-align: left; }' +
            '.summary-box { margin-top: 32px; padding: 20px; background: #f1f5f9; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; }' +
            '.summary-total { font-size: 18px; font-weight: bold; color: #0f172a; }' +
            '.tax-hint { font-size: 14px; font-weight: 600; color: #16a34a; }' +
            '.stamp { margin-top: 40px; border-top: 1px dashed #94a3b8; padding-top: 16px; font-size: 12px; color: #64748b; text-align: center; }' +
          '</style>' +
        '</head>' +
        '<body>' +
          '<div class="header">' +
            '<h1 class="title">Справка-реестр расходов на оплату жилья и ЖКУ</h1>' +
            '<div class="meta">Отчётный период: 01.01.' + targetYear + ' — 31.12.' + targetYear + ' · Сформировано в сервисе «Мой Порядок»</div>' +
          '</div>' +
          '<table>' +
            '<thead>' +
              '<tr>' +
                '<th style="width:40px;text-align:center;">№</th>' +
                '<th style="width:110px;">Дата</th>' +
                '<th>Назначение платежа</th>' +
                '<th style="width:140px;">Категория</th>' +
                '<th style="width:130px;text-align:right;">Сумма</th>' +
              '</tr>' +
            '</thead>' +
            '<tbody>' +
              (rowsHtml || '<tr><td colspan="5" style="text-align:center;padding:24px;color:#94a3b8;">Нет оплаченных счетов за этот год</td></tr>') +
            '</tbody>' +
          '</table>' +
          '<div class="summary-box">' +
            '<div class="summary-total">ИТОГО ОПЛАЧЕНО ЗА ' + targetYear + ' Г.: ' + totalRubles.toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' ₽</div>' +
            '<div class="tax-hint">Потенциальный налоговый вычет (13%): ' + taxReturn13.toLocaleString('ru-RU') + ' ₽</div>' +
          '</div>' +
          '<div class="stamp">✓ Электронный реестр подтверждённых транзакций · МОЙ ПОРЯДОК: ПЛАТЕЖИ И ДЕЛА</div>' +
          '<script>window.onload = function() { window.print(); };</script>' +
        '</body>' +
        '</html>';

      return html;
    });
  }

  function openTaxReport(year) {
    if (!isPro()) {
      if (window.Backup && window.Backup.openBuyProModal) {
        window.Backup.openBuyProModal('Формирование годовых отчётов и справок для налогового вычета доступно в тарифе PRO.');
      } else if (window.VK && window.VK.notify) {
        window.VK.notify('Справка для налогового вычета доступна в PRO', 'info');
      }
      return;
    }

    generateTaxReportHtml(year).then(function (html) {
      var w = window.open('', '_blank');
      if (w) {
        w.document.write(html);
        w.document.close();
      } else {
        if (window.VK && window.VK.notify) {
          window.VK.notify('Разрешите всплывающие окна для печати отчёта', 'error');
        }
      }
    });
  }

  window.TaxDeduction = {
    generateHtml: generateTaxReportHtml,
    openReport: openTaxReport
  };
})();
