/* Доставка заявок. Адрес приёмника читается API → raw → сайт.
   На одну попытку отправки приходится ровно один POST. При потере ответа
   сохраняем request_id: письмо могло уйти до ошибки соединения. */
(function () {
  'use strict';
  var API = 'https://api.github.com/repos/projectspeedup-commits/geokriolog/contents/form-endpoint.json?ref=endpoint';
  var RAW = 'https://raw.githubusercontent.com/projectspeedup-commits/geokriolog/endpoint/form-endpoint.json';
  var SITE = '/form-endpoint.json';
  var READ_MS = 5000, POST_MS = 12000;
  var UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  var STORAGE_KEY = 'geokriolog.lead.first_touch.v1';
  var LABELS = { equipment: 'Техника и инструмент', pile_heads: 'Оголовки свай', audit: 'Геокриологический аудит', thermal: 'Термостабилизация' };
  var states = new WeakMap();
  var cached = '', resolving;

  function compact(value, limit) {
    return String(value || '').replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, limit || 180);
  }

  function stateFor(form) {
    var state = states.get(form);
    if (!state) { state = {}; states.set(form, state); }
    return state;
  }

  function newId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'gk-' + window.crypto.randomUUID();
    }
    var bytes = new Uint8Array(16);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      window.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return 'gk-' + Date.now().toString(36) + '-' + Array.from(bytes, function (n) { return n.toString(16).padStart(2, '0'); }).join('');
  }

  function requestId(form) {
    var state = stateFor(form);
    if (!state.id) state.id = newId();
    return state.id;
  }

  function normalPhone(value) {
    if (/[^0-9+()\s.\-]/.test(String(value || ''))) return '';
    var digits = String(value || '').replace(/\D/g, '');
    if (/^\d{10}$/.test(digits)) return '7' + digits;
    if (/^[78]\d{10}$/.test(digits)) return '7' + digits.slice(1);
    return '';
  }

  function contextForPath(path) {
    if (/\/(tysim-kr300m)(\/|$)/.test(path)) return { direction: 'equipment', product: 'TYSIM KR300M' };
    if (/\/(obshadnoj-stol-rco1500)(\/|$)/.test(path)) return { direction: 'equipment', product: 'RCO1500' };
    if (/\/(obsadnye-truby)(\/|$)/.test(path)) return { direction: 'equipment', product: 'Обсадные трубы' };
    if (/\/(kelli-shtangi)(\/|$)/.test(path)) return { direction: 'equipment', product: 'Келли-штанги' };
    if (/\/(burovoj-instrument)(\/|$)/.test(path)) return { direction: 'equipment', product: 'Буровой инструмент' };
    if (/\/(tehnika|rotornye-burovye-ustanovki-tysim-xcmg-sany|ustrojstvo-buronabivnyh-svaj|smeta-na-ustrojstvo-buronabivnyh-svaj)(\/|$)/.test(path)) return { direction: 'equipment', product: '' };
    if (/\/(demontazh-ogolovkov-bns|chem-zamenit-otbojnyj-molotok|priemka-ogolovkov-svaj|bezudarnyj-demontazh-v-pos-i-ppr|tehnologicheskaya-karta-demontazh-ogolovkov)(\/|$)/.test(path)) return { direction: 'pile_heads', product: '' };
    if (/\/(termostabilizaciya-sou|termostabilizatory-grunta|termosifon-vechnaya-merzlota|termosvai)(\/|$)/.test(path)) return { direction: 'thermal', product: '' };
    if (/\/(audit-kriolitozony|stroitelstvo-na-vechnoj-merzlote|moroznoe-puchenie-svai|buronabivnye-svai-zimoj)(\/|$)/.test(path)) return { direction: 'audit', product: '' };
    return { direction: '', product: '' };
  }

  function currentUrl() { return new URL(window.location.href); }

  function safeSource() {
    var url = currentUrl();
    var params = new URLSearchParams();
    UTM.forEach(function (key) {
      var value = compact(url.searchParams.get(key), 160);
      if (value) params.set(key, value);
    });
    return url.origin + url.pathname + (params.toString() ? '?' + params.toString() : '');
  }

  function readTouch() {
    var stored;
    try { stored = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY)); } catch (_) {}
    var url = currentUrl();
    var touch = {};
    if (stored && typeof stored === 'object' && typeof stored.landing_path === 'string' && /^\/(?!\/)/.test(stored.landing_path)) {
      touch.landing_path = compact(stored.landing_path.split(/[?#]/)[0], 500);
      touch.referrer_host = compact(stored.referrer_host, 253).replace(/[^a-zA-Z0-9.:-]/g, '');
      UTM.forEach(function (key) { touch[key] = compact(stored[key], 160); });
    } else {
      touch.landing_path = compact(url.pathname, 500);
      try { touch.referrer_host = new URL(document.referrer).hostname; } catch (_) { touch.referrer_host = ''; }
      UTM.forEach(function (key) { touch[key] = compact(url.searchParams.get(key), 160); });
      try { window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(touch)); } catch (_) {}
    }
    return touch;
  }

  // Фиксируем при загрузке первой страницы, до переходов к форме.
  var firstTouch = readTouch();

  function failure(code, ambiguous) {
    var error = new Error('Не удалось подтвердить отправку заявки.');
    error.code = code;
    error.ambiguous = Boolean(ambiguous);
    return error;
  }

  function jsonRequest(url, options, ms) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer;
    options = options || {};
    if (controller) options.signal = controller.signal;
    var response = Promise.resolve().then(function () { return fetch(url, options); }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    });
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        if (controller) controller.abort();
        reject(failure('timeout', options.method === 'POST'));
      }, ms);
    });
    return Promise.race([response, timeout]).then(function (value) {
      clearTimeout(timer);
      return value;
    }, function (error) {
      clearTimeout(timer);
      throw error;
    });
  }

  function endpoint(value) {
    var url;
    try { url = new URL(value && value.url); } catch (_) { throw failure('configuration', false); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw failure('configuration', false);
    return url.href.replace(/\/+$/, '');
  }

  function fromApi() {
    return jsonRequest(API, { cache: 'no-store' }, READ_MS).then(function (result) {
      if (!result.ok || !result.data || !result.data.content) throw failure('configuration', false);
      return endpoint(JSON.parse(atob(result.data.content.replace(/\s/g, ''))));
    });
  }

  function fromUrl(url) {
    return jsonRequest(url + '?v=' + Date.now(), { cache: 'no-store' }, READ_MS).then(function (result) {
      if (!result.ok) throw failure('configuration', false);
      return endpoint(result.data);
    });
  }

  function base() {
    if (cached) return Promise.resolve(cached);
    if (resolving) return resolving;
    resolving = fromApi().catch(function () { return fromUrl(RAW); }).catch(function () { return fromUrl(SITE); })
      .then(function (url) { cached = url; resolving = null; return url; }, function () { resolving = null; throw failure('configuration', false); });
    return resolving;
  }

  function prepare(form, extraFd) {
    var source = extraFd || new FormData(form);
    var fd = new FormData();
    source.forEach(function (value, key) { fd.append(key, value); });
    var defaults = contextForPath(window.location.pathname);
    var direction = compact(fd.get('direction'), 30);
    if (!Object.prototype.hasOwnProperty.call(LABELS, direction)) direction = defaults.direction;
    // Явно очищенное поле сохраняем пустым. Подстановка по URL нужна только
    // старым формам без поля товара и при том же направлении заявки.
    var rawProduct = fd.get('product');
    var product = compact(rawProduct !== null ? rawProduct : (direction === defaults.direction ? defaults.product : ''), 180);
    var cta = compact(fd.get('cta') || form.getAttribute('data-lead-cta') || 'form', 100);
    fd.set('request_id', requestId(form));
    fd.set('direction', direction);
    fd.set('product', product);
    fd.set('cta', cta);
    fd.set('source', safeSource());
    fd.set('phone_digits', normalPhone(fd.get('phone')));
    fd.set('first_landing_path', firstTouch.landing_path);
    fd.set('first_referrer_host', firstTouch.referrer_host);
    UTM.forEach(function (key) { fd.set('first_' + key, firstTouch[key]); });
    // Старый приёмник читает только message: сохраняем контекст и там.
    // extraFd не меняем, а ранее подготовленный блок не наращиваем.
    var message = String(fd.get('message') || '').replace(/\n?\[Контекст заявки\][\s\S]*?\[\/Контекст заявки\]/g, '').trim();
    var lines = [
      'ID: ' + fd.get('request_id'),
      'Направление: ' + (LABELS[direction] || 'Не выбрано'),
      product ? 'Товар или услуга: ' + product : '',
      'Кнопка: ' + cta,
      'Первая страница: ' + firstTouch.landing_path,
      firstTouch.referrer_host ? 'Источник: ' + firstTouch.referrer_host : ''
    ];
    UTM.forEach(function (key) { if (firstTouch[key]) lines.push(key + ': ' + firstTouch[key]); });
    fd.set('message', (message ? message + '\n\n' : '') + '[Контекст заявки]\n' + lines.filter(Boolean).join('\n') + '\n[/Контекст заявки]');
    return fd;
  }

  function post(url, params) {
    var target = /\/exec$/.test(url) ? url : url + '/lead';
    return jsonRequest(target, { method: 'POST', body: params }, POST_MS).then(function (result) {
      if (!result.ok || !result.data || result.data.ok !== true) {
        var pending = result.data && result.data.error === 'pending';
        throw failure(pending ? 'pending' : 'rejected', true);
      }
      return result.data;
    }, function (error) {
      // Не передаём в DOM/консоль ответ внешнего сервиса или персональные поля.
      throw failure(error && error.code === 'timeout' ? 'timeout' : 'network', true);
    });
  }

  window.sendLead = function (form, extraFd) {
    var state = stateFor(form);
    if (state.pending) return state.pending;
    var fd = prepare(form, extraFd);
    var params = new URLSearchParams();
    fd.forEach(function (value, key) { params.append(key, value); });
    state.pending = base().then(function (url) { return post(url, params); }).then(function (result) {
      state.pending = null;
      state.id = '';
      return result;
    }, function (error) {
      state.pending = null;
      throw error;
    });
    return state.pending;
  };

  window.GeokriologLead = {
    contextForPath: contextForPath,
    normalizePhone: normalPhone,
    directionLabels: LABELS,
    prepare: prepare
  };
})();
