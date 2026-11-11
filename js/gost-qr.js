/**
 * МОЙ ПОРЯДОК — Банковский QR-код стандарта ГОСТ Р 56042-2014 (Этап 12.10, PRO)
 *
 * Формирует платёжный QR-код национального стандарта РФ для оплаты услуг ЖКХ,
 * интернета, аренды и любых квитанций через приложения любых банков РФ:
 * СберБанк, Т-Банк, ВТБ, Альфа-Банк, СБП и др.
 *
 * Формат строки:
 * ST00012|Name=...|PersonalAcc=...|BankName=...|BIC=...|CorrespAcc=...|Sum=...|PayeeINN=...|Purpose=...
 *
 * Экспортирует window.GostQr
 */

(function () {
  'use strict';

  var DEFAULT_REQUISITES = {
    name: 'ООО УК «УЮТНЫЙ ДОМ»',
    personalAcc: '40702810338000012345',
    bankName: 'ПАО СБЕРБАНК',
    bic: '044525225',
    correspAcc: '30101810400000000225',
    payeeInn: '7707083893',
    kpp: '773601001'
  };

  var STORAGE_KEY = 'myorder_default_bank_requisites';

  function getSavedRequisites() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) { return Object.assign({}, DEFAULT_REQUISITES, JSON.parse(raw)); }
    } catch (e) { /* ignore */ }
    return Object.assign({}, DEFAULT_REQUISITES);
  }

  function saveRequisites(req) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(req));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Формирует каноническую строку по ГОСТ Р 56042-2014.
   * Сумма в копейках передаётся в копейках как целое число (Sum=150000 = 1500.00 руб).
   * @param {Object} payment
   * @param {Object} [customReq]
   * @returns {string}
   */
  function buildGostPayload(payment, customReq) {
    var req = customReq || getSavedRequisites();
    var sumKopecks = Number(payment.amount) || 0;
    var cleanTitle = String(payment.title || 'Оплата услуг').replace(/[\r\n|]/g, ' ').slice(0, 80);
    var pId = payment.id ? String(payment.id).padStart(6, '0') : '000001';

    // Формат ГОСТ Р 56042-2014 (версия стандарта ST00012)
    var parts = [
      'ST00012',
      'Name=' + (req.name || DEFAULT_REQUISITES.name),
      'PersonalAcc=' + (req.personalAcc || DEFAULT_REQUISITES.personalAcc),
      'BankName=' + (req.bankName || DEFAULT_REQUISITES.bankName),
      'BIC=' + (req.bic || DEFAULT_REQUISITES.bic),
      'CorrespAcc=' + (req.correspAcc || DEFAULT_REQUISITES.correspAcc),
      'PayeeINN=' + (req.payeeInn || DEFAULT_REQUISITES.payeeInn)
    ];

    if (req.kpp) {
      parts.push('KPP=' + req.kpp);
    }

    if (sumKopecks > 0) {
      parts.push('Sum=' + Math.round(sumKopecks));
    }

    parts.push('Purpose=' + cleanTitle + ' (№' + pId + ')');
    parts.push('persAcc=МП-' + pId);

    return parts.join('|');
  }

  /**
   * Генерирует интерактивное модальное окно с отображением банковского QR-кода.
   * @param {Object} payment
   * @returns {Promise<void>}
   */
  function showPaymentQrModal(payment) {
    if (!window.ProManager || !window.ProManager.isPro()) {
      if (window.VK && window.VK.notify) {
        window.VK.notify('Оплата по банковскому QR-коду ГОСТ доступна в тарифе PRO', 'warning');
      }
      return Promise.resolve();
    }

    var payload = buildGostPayload(payment);

    return window.Lazy.loadQrcode().then(function (qrcode) {
      var qr = qrcode(0, 'M');
      qr.addData(payload);
      qr.make();
      var svg = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });

      var modalHtml = '' +
        '<div class="gost-qr-modal">' +
          '<div class="gost-qr-header">' +
            '<div class="gost-qr-title">Оплата через банк (ГОСТ QR)</div>' +
            '<div class="gost-qr-sub">Отсканируйте камерой любого банка (Сбер, Т-Банк, ВТБ, СБП)</div>' +
          '</div>' +
          '<div class="gost-qr-code-wrap">' + svg + '</div>' +
          '<div class="gost-qr-details">' +
            '<div class="gost-qr-row"><span>Назначение:</span><strong>' + (payment.title || 'Платёж') + '</strong></div>' +
            '<div class="gost-qr-row"><span>Сумма к оплате:</span><strong class="gost-qr-sum">' + ((payment.amount || 0) / 100).toFixed(2).replace('.', ',') + ' ₽</strong></div>' +
            '<div class="gost-qr-row"><span>Стандарт:</span><small>ГОСТ Р 56042-2014 (ST00012)</small></div>' +
          '</div>' +
          '<div class="gost-qr-footer">' +
            '<button type="button" class="btn btn--primary" data-gost-action="mark-paid">Отметить как оплаченный</button>' +
            '<button type="button" class="btn btn--secondary" data-gost-action="close">Закрыть</button>' +
          '</div>' +
        '</div>';

      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');

      var content = document.createElement('div');
      content.className = 'modal-content';
      content.innerHTML = modalHtml;
      overlay.appendChild(content);
      document.body.appendChild(overlay);

      function close() {
        if (overlay && overlay.parentNode) {
          overlay.parentNode.removeChild(overlay);
        }
      }

      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) close();
        var act = e.target.closest('[data-gost-action]');
        if (act) {
          var a = act.getAttribute('data-gost-action');
          if (a === 'close') close();
          if (a === 'mark-paid') {
            if (window.Payments && typeof window.Payments.toggleStatus === 'function') {
              window.Payments.toggleStatus(payment.id);
            } else if (window.DB) {
              window.DB.update('payments', payment.id, { status: 'paid' }).then(function () {
                if (window.Payments && window.Payments.render) window.Payments.render();
              });
            }
            if (window.Personalization) {
              window.Personalization.triggerFeedback('task_done');
            }
            close();
          }
        }
      });
    });
  }

  window.GostQr = {
    buildGostPayload: buildGostPayload,
    showPaymentQrModal: showPaymentQrModal,
    getSavedRequisites: getSavedRequisites,
    saveRequisites: saveRequisites,
    DEFAULT_REQUISITES: DEFAULT_REQUISITES
  };

  console.info('[GostQr] Модуль платёжных QR-кодов ГОСТ загружен.');
})();
