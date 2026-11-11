/**
 * МОЙ ПОРЯДОК — Голосовой ввод дел, платежей и показаний (Voice Input)
 *
 * Распознавание русской речи через SpeechRecognition API:
 * «Свет 340», «Интернет 650 до 25», «Купить фильтр для воды»
 *
 * Экспортирует window.VoiceInput
 */

(function () {
  'use strict';

  var recognition = null;
  var isRecording = false;

  function getSpeechClass() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function isSupported() {
    return Boolean(getSpeechClass());
  }

  function toggleRecord(targetInput, triggerBtn) {
    var Speech = getSpeechClass();
    if (!Speech) {
      if (window.VK && window.VK.notify) {
        window.VK.notify('Голосовой ввод не поддерживается в этом браузере', 'info');
      }
      return;
    }

    if (isRecording && recognition) {
      recognition.stop();
      return;
    }

    try {
      recognition = new Speech();
      recognition.lang = 'ru-RU';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognition.onstart = function () {
        isRecording = true;
        if (triggerBtn) {
          triggerBtn.classList.add('is-listening');
          triggerBtn.innerHTML = '🔴';
          triggerBtn.setAttribute('title', 'Идёт запись... Говорите');
        }
        try {
          if (window.VK && window.VK.taptic) {
            window.VK.taptic('impact', 'medium');
          }
        } catch (e) {}
      };

      recognition.onresult = function (event) {
        if (!event.results || !event.results[0] || !event.results[0][0]) return;
        var text = event.results[0][0].transcript;
        if (text && targetInput) {
          targetInput.value = text;
          targetInput.dispatchEvent(new Event('input', { bubbles: true }));
          targetInput.focus();

          try {
            if (window.VK && window.VK.taptic) {
              window.VK.taptic('notification', 'success');
            }
          } catch (e) {}

          // Если распознано четко — через секунду автоматически сохраняем
          setTimeout(function () {
            var box = targetInput.closest('[data-quick-box]');
            var saveBtn = box ? box.querySelector('[data-quick-btn]') : null;
            if (saveBtn && targetInput.value.trim() === text) {
              saveBtn.click();
            }
          }, 800);
        }
      };

      recognition.onerror = function (event) {
        console.warn('[VoiceInput] Ошибка распознавания:', event.error);
        if (event.error === 'not-allowed') {
          if (window.VK && window.VK.notify) {
            window.VK.notify('Разрешите доступ к микрофону в настройках', 'error');
          }
        }
      };

      recognition.onend = function () {
        isRecording = false;
        if (triggerBtn) {
          triggerBtn.classList.remove('is-listening');
          triggerBtn.innerHTML = '🎙️';
          triggerBtn.setAttribute('title', 'Голосовой ввод');
        }
      };

      recognition.start();
    } catch (err) {
      console.error('[VoiceInput] Старт не удался:', err);
      isRecording = false;
    }
  }

  // Делегированный обработчик для всех кнопок микрофона
  document.addEventListener('click', function (e) {
    var voiceBtn = e.target.closest('[data-voice-btn]');
    if (!voiceBtn) return;

    var box = voiceBtn.closest('[data-quick-box]');
    var input = box ? box.querySelector('[data-quick-input]') : document.querySelector('[data-quick-input]');
    toggleRecord(input, voiceBtn);
  });

  window.VoiceInput = {
    isSupported: isSupported,
    toggle: toggleRecord
  };
})();
