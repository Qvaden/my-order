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
          '<td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;text-align:center;color:#1e293b;">' + (idx + 1) + '</td>' +
          '<td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;color:#1e293b;">' + (p.date || '—') + '</td>' +
          '<td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;color:#0f172a;"><strong>' + (p.title || 'Платёж') + '</strong></td>' +
          '<td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;color:#334155;">' + (p.category || 'ЖКУ') + '</td>' +
          '<td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700;color:#0f172a;">' + rub + ' ₽</td>' +
        '</tr>';
      }).join('');

      var contentHtml =
        '<div class="header" style="border-bottom:2px solid #0f172a;padding-bottom:16px;margin-bottom:24px;">' +
          '<h1 class="title" style="font-size:22px;font-weight:800;text-transform:uppercase;margin:0 0 8px 0;color:#0f172a;letter-spacing:0.02em;">Справка-реестр расходов на оплату жилья и ЖКУ</h1>' +
          '<div class="meta" style="font-size:13px;color:#64748b;">Отчётный период: 01.01.' + targetYear + ' — 31.12.' + targetYear + ' · Сформировано в сервисе «Мой Порядок»</div>' +
        '</div>' +
        '<table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:13px;background:transparent;">' +
          '<thead>' +
            '<tr>' +
              '<th style="width:40px;text-align:center;background:#f8fafc;padding:10px 12px;border-bottom:2px solid #cbd5e1;color:#0f172a;font-weight:700;">№</th>' +
              '<th style="width:110px;background:#f8fafc;padding:10px 12px;border-bottom:2px solid #cbd5e1;color:#0f172a;font-weight:700;">Дата</th>' +
              '<th style="background:#f8fafc;padding:10px 12px;border-bottom:2px solid #cbd5e1;color:#0f172a;font-weight:700;">Назначение платежа</th>' +
              '<th style="width:140px;background:#f8fafc;padding:10px 12px;border-bottom:2px solid #cbd5e1;color:#0f172a;font-weight:700;">Категория</th>' +
              '<th style="width:130px;text-align:right;background:#f8fafc;padding:10px 12px;border-bottom:2px solid #cbd5e1;color:#0f172a;font-weight:700;">Сумма</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' +
            (rowsHtml || '<tr><td colspan="5" style="text-align:center;padding:28px 16px;color:#64748b;font-style:italic;">Нет оплаченных счетов за этот год</td></tr>') +
          '</tbody>' +
        '</table>' +
        '<div class="summary-box" style="margin-top:32px;padding:20px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">' +
          '<div class="summary-total" style="font-size:16px;font-weight:800;color:#0f172a;">ИТОГО ОПЛАЧЕНО ЗА ' + targetYear + ' Г.: ' + totalRubles.toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' ₽</div>' +
          '<div class="tax-hint" style="font-size:14px;font-weight:700;color:#16a34a;">Потенциальный налоговый вычет (13%): ' + taxReturn13.toLocaleString('ru-RU') + ' ₽</div>' +
        '</div>' +
        '<div class="stamp" style="margin-top:40px;border-top:1px dashed #94a3b8;padding-top:16px;font-size:12px;color:#64748b;text-align:center;">✓ Электронный реестр подтверждённых транзакций · МОЙ ПОРЯДОК: ПЛАТЕЖИ И ДЕЛА</div>';

      var fullHtml = '<!DOCTYPE html>' +
        '<html lang="ru">' +
        '<head>' +
          '<meta charset="UTF-8">' +
          '<title>Справка о расходах на ЖКУ за ' + targetYear + ' год</title>' +
          '<style>' +
            'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 40px; color: #0f172a; background: #ffffff; line-height: 1.5; }' +
            '.header { border-bottom: 2px solid #0f172a; padding-bottom: 16px; margin-bottom: 24px; }' +
            '.title { font-size: 22px; font-weight: bold; text-transform: uppercase; margin: 0 0 8px 0; color: #0f172a; }' +
            '.meta { font-size: 13px; color: #64748b; }' +
            'table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 13px; }' +
            'th { background: #f8fafc; padding: 10px 12px; border-bottom: 2px solid #cbd5e1; text-align: left; color: #0f172a; }' +
            'td { padding: 8px 12px; border-bottom: 1px solid #e2e8f0; color: #1e293b; }' +
            '.summary-box { margin-top: 32px; padding: 20px; background: #f8fafc; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid #e2e8f0; }' +
            '.summary-total { font-size: 16px; font-weight: bold; color: #0f172a; }' +
            '.tax-hint { font-size: 14px; font-weight: 600; color: #16a34a; }' +
            '.stamp { margin-top: 40px; border-top: 1px dashed #94a3b8; padding-top: 16px; font-size: 12px; color: #64748b; text-align: center; }' +
          '</style>' +
        '</head>' +
        '<body>' +
          contentHtml +
          '<script>window.onload = function() { window.print(); };<\/script>' +
        '</body>' +
        '</html>';

      return fullHtml;
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

    if (window.Lazy && window.Lazy.loadStyle) {
      window.Lazy.loadStyle('print').catch(function () {});
    }

    generateTaxReportHtml(year).then(function (html) {
      var prevHost = document.getElementById('tax-deduction-print-host');
      if (prevHost && prevHost.parentNode) {
        prevHost.parentNode.removeChild(prevHost);
      }

      // Извлекаем тело документа без обрамления <!DOCTYPE html> и <script>
      var bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      var innerBody = bodyMatch ? bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, '') : html;

      var host = document.createElement('div');
      host.id = 'tax-deduction-print-host';
      host.className = 'print-host';
      host.innerHTML =
        '<div class="print-host__bar">' +
          '<button type="button" class="btn btn--primary" data-tax-action="print">Печать / Сохранить в PDF</button>' +
          '<button type="button" class="btn btn--secondary" data-tax-action="close">Закрыть</button>' +
          '<span class="print-host__hint">В диалоге печати выберите «Сохранить как PDF».</span>' +
        '</div>' +
        '<div class="print-host__paper" style="background:#FFFFFF !important;color:#0F172A !important;">' +
          innerBody +
        '</div>';

      document.body.appendChild(host);
      document.body.classList.add('printing-mode');

      function close() {
        window.removeEventListener('keydown', onKeyDown);
        if (host && host.parentNode) host.parentNode.removeChild(host);
        document.body.classList.remove('printing-mode');
      }

      function onKeyDown(e) {
        if (e.key === 'Escape') close();
      }
      window.addEventListener('keydown', onKeyDown);

      host.addEventListener('click', function (e) {
        if (e.target === host) close();
      });

      var printBtn = host.querySelector('[data-tax-action="print"]');
      if (printBtn) {
        printBtn.addEventListener('click', function () {
          try { window.print(); } catch (e) {}
        });
      }

      var closeBtn = host.querySelector('[data-tax-action="close"]');
      if (closeBtn) {
        closeBtn.addEventListener('click', close);
      }
    });
  }

  window.TaxDeduction = {
    generateHtml: generateTaxReportHtml,
    openReport: openTaxReport
  };
})();
