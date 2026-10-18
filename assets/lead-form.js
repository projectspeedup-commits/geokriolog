/* Общий сценарий форм и контактных целей, без персональных данных в Метрике. */
(function () {
  'use strict';
  var COUNTER = 110604818;
  var EMAIL = 'info@geokriolog.ru';
  var PHONE = '+79119245467';
  var initialized = new WeakSet();
  var automaticProducts = new WeakMap();
  var OFFERS = {
    '/tehnika/': 'equipment', '/tysim-kr300m/': 'equipment',
    '/obshadnoj-stol-rco1500/': 'equipment', '/obsadnye-truby/': 'equipment',
    '/kelli-shtangi/': 'equipment', '/burovoj-instrument/': 'equipment',
    '/demontazh-ogolovkov-bns/': 'pile_heads', '/audit-kriolitozony/': 'audit',
    '/termostabilizaciya-sou/': 'thermal', '/termostabilizatory-grunta/': 'thermal'
  };

  function track(goal, parameters) {
    try {
      if (typeof window.ym !== 'function') return;
      if (parameters) window.ym(COUNTER, 'reachGoal', goal, parameters);
      else window.ym(COUNTER, 'reachGoal', goal);
    } catch (_) {}
  }

  function trackArticleOffer(href) {
    var articlePath = window.location.pathname;
    if (!/^\/blog\/[a-z0-9-]+\/?$/.test(articlePath)) return;
    var url;
    try { url = new URL(href, window.location.href); } catch (_) { return; }
    if (url.origin !== window.location.origin) return;
    var offerPath = url.pathname.replace(/\/$/, '') + '/';
    if (!Object.prototype.hasOwnProperty.call(OFFERS, offerPath)) return;
    track('article_offer_click', {
      direction: OFFERS[offerPath],
      article_path: articlePath.replace(/\/$/, '') + '/',
      offer_path: offerPath
    });
  }

  function field(form, name) { return form.querySelector('[name="' + name + '"]'); }

  function show(element, text) {
    if (!element) return;
    element.textContent = text || '';
    element.hidden = false;
    element.classList.add('show');
  }

  function hide(element) {
    if (!element) return;
    element.hidden = true;
    element.classList.remove('show');
    element.textContent = '';
  }

  function applyDefaults(form) {
    var defaults = window.GeokriologLead.contextForPath(window.location.pathname);
    var direction = field(form, 'direction');
    var product = field(form, 'product');
    if (direction && !direction.value) direction.value = defaults.direction;
    if (product && !product.value && direction && direction.value === defaults.direction) {
      product.value = defaults.product;
      if (defaults.product) automaticProducts.set(form, { value: defaults.product, direction: defaults.direction });
    }
  }

  function reserveLink(form) {
    var fd = window.GeokriologLead.prepare(form);
    var labels = { name: 'Имя', phone: 'Телефон', type: 'Тип объекта', region: 'Регион', message: 'Задача', page: 'Страница', source: 'Адрес страницы' };
    var lines = [];
    Object.keys(labels).forEach(function (name) {
      var value = fd.get(name);
      if (value) lines.push(labels[name] + ': ' + value);
    });
    return 'mailto:' + EMAIL + '?subject=' + encodeURIComponent('Заявка с сайта') + '&body=' + encodeURIComponent(lines.join('\n'));
  }

  function appendLink(element, href, text) {
    var link = document.createElement('a');
    link.href = href;
    link.textContent = text;
    element.appendChild(link);
  }

  function deliveryError(element, form, error) {
    var uncertain = error && error.ambiguous;
    show(element, uncertain
      ? 'Не удалось подтвердить отправку. Заявка могла поступить. Данные сохранены. '
      : 'Не удалось отправить заявку. Данные сохранены. ');
    if (!element) return;
    if (uncertain) element.appendChild(document.createTextNode('Уточните по телефону '));
    else element.appendChild(document.createTextNode('Позвоните '));
    appendLink(element, 'tel:' + PHONE, '+7 911 924-54-67');
    element.appendChild(document.createTextNode(' или '));
    appendLink(element, reserveLink(form), 'отправьте письмо');
    element.appendChild(document.createTextNode(uncertain ? ' с тем же номером заявки.' : ' — данные уже подставлены.'));
  }

  function initForm(form) {
    if (initialized.has(form)) return;
    initialized.add(form);
    var ok = form.querySelector('#formMsg, #lfOk');
    var error = form.querySelector('#formErr, #lfErr');
    var button = form.querySelector('#lfSubmit, #lfBtn, button[type="submit"]');
    var pending = false, started = false;
    var originalText = button ? button.textContent : 'Отправить заявку';
    hide(ok);
    hide(error);
    // Обязательны только телефон и согласие; проверка общая для всех страниц.
    ['name', 'type', 'direction', 'product', 'region', 'message'].forEach(function (name) {
      var input = field(form, name);
      if (input) input.required = false;
    });
    applyDefaults(form);

    function start() {
      if (!started) { started = true; track('form_start'); }
    }
    function edit(event) {
      start();
      var product = field(form, 'product');
      var direction = field(form, 'direction');
      if (event.target === product) automaticProducts.delete(form);
      if (event.target === direction) {
        var automatic = automaticProducts.get(form);
        if (automatic && product && product.value === automatic.value && direction.value !== automatic.direction) {
          product.value = '';
          automaticProducts.delete(form);
        }
      }
    }
    form.addEventListener('input', edit);
    form.addEventListener('change', edit);

    function validation(message, input) {
      show(error, message);
      track('form_error');
      if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (pending) return;
      var honey = field(form, '_honey');
      if (honey && honey.value) return;
      start();
      hide(ok);
      hide(error);
      var phone = field(form, 'phone');
      var consent = field(form, 'consent');
      if (phone) phone.removeAttribute('aria-invalid');
      if (consent) consent.removeAttribute('aria-invalid');
      if (!phone || !window.GeokriologLead.normalizePhone(phone.value)) {
        validation('Укажите телефон полностью: 10 цифр или 11 цифр с 7 или 8 в начале.', phone);
        return;
      }
      if (!consent || !consent.checked) {
        validation('Подтвердите согласие на обработку персональных данных, чтобы отправить заявку.', consent);
        return;
      }
      pending = true;
      form.setAttribute('aria-busy', 'true');
      if (button) { button.disabled = true; button.textContent = 'Отправляем…'; }
      Promise.resolve().then(function () { return window.sendLead(form); }).then(function () {
        show(ok, 'Заявка отправлена. Свяжемся по указанному телефону.');
        track('form_lead');
        form.reset();
        automaticProducts.delete(form);
        form.removeAttribute('data-lead-cta');
        started = false;
        applyDefaults(form);
      }, function (failure) {
        deliveryError(error, form, failure);
        track('form_error');
      }).then(function () {
        pending = false;
        form.removeAttribute('aria-busy');
        if (button) { button.disabled = false; button.textContent = originalText; }
      });
    });
  }

  function init() {
    if (!window.GeokriologLead || typeof window.sendLead !== 'function') return;
    document.querySelectorAll('form#leadForm, form[data-lead-form]').forEach(initForm);
    // Делегирование учитывает резервные ссылки, созданные после ошибки.
    document.addEventListener('click', function (event) {
      var target = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!target) return;
      var href = target.getAttribute('href') || '';
      if (/^tel:/i.test(href)) track('call_click');
      if (/^mailto:/i.test(href)) track('email_click');
      trackArticleOffer(href);
      if (href !== '#cta') return;
      var form = document.querySelector('form#leadForm, form[data-lead-form]');
      if (!form) return;
      var direction = target.getAttribute('data-lead-direction');
      var product = target.getAttribute('data-lead-product');
      var directionInput = field(form, 'direction');
      var productInput = field(form, 'product');
      var explicitDirection = Object.prototype.hasOwnProperty.call(window.GeokriologLead.directionLabels, direction);
      var changedDirection = explicitDirection && directionInput && directionInput.value !== direction;
      if (directionInput && explicitDirection) directionInput.value = direction;
      if (productInput && product !== null) {
        productInput.value = product;
        automaticProducts.delete(form);
        if (product) automaticProducts.set(form, { value: product, direction: directionInput ? directionInput.value : '' });
      } else if (productInput && changedDirection) {
        productInput.value = '';
        automaticProducts.delete(form);
      }
      // Пустое значение у новой кнопки сбрасывает предыдущий контекст кнопки.
      form.setAttribute('data-lead-cta', target.getAttribute('data-lead-cta') || 'page_cta');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
