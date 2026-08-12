/* Отправка заявок с форм сайта.

   Приёмник живёт за туннелем, адрес которого меняется примерно каждые
   15 минут, поэтому он не зашит в страницы, а читается перед отправкой
   из трёх источников по убыванию свежести:
     1. GitHub API — обновление видно за минуту;
     2. raw ветки endpoint — кэш CDN до 5 минут;
     3. файл на сайте — последний адрес на момент деплоя.

   Каждый запрос ограничен по времени: мёртвый туннель может держать
   соединение молча, а посетитель в это время смотрит на «Отправляем…».
   Если POST не прошёл, адрес перечитывается и попытка повторяется один
   раз. Не помогло — форма честно показывает ошибку и предлагает письмо
   на info@ (фолбэк в самих страницах). */
(function () {
  var API = 'https://api.github.com/repos/projectspeedup-commits/geokriolog/contents/form-endpoint.json?ref=endpoint';
  var RAW = 'https://raw.githubusercontent.com/projectspeedup-commits/geokriolog/endpoint/form-endpoint.json';
  var SITE = '/form-endpoint.json';
  var READ_MS = 5000, POST_MS = 12000;
  var cached = '';

  function timed(url, opts, ms) {
    opts = opts || {};
    if (typeof AbortController === 'function') {
      var c = new AbortController();
      opts.signal = c.signal;
      var t = setTimeout(function () { c.abort(); }, ms);
      return fetch(url, opts).then(
        function (r) { clearTimeout(t); return r; },
        function (e) { clearTimeout(t); throw e; });
    }
    return fetch(url, opts);
  }

  function clean(v) {
    v = v && v.url ? String(v.url).replace(/\/+$/, '') : '';
    if (!v) { throw new Error('адрес не найден'); }
    return v;
  }

  function fromApi() {
    return timed(API, { cache: 'no-store' }, READ_MS)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.content) { throw new Error('пусто'); }
        return clean(JSON.parse(atob(j.content.replace(/\s/g, ''))));
      });
  }

  function fromUrl(u) {
    return timed(u + (u.indexOf('?') < 0 ? '?' : '&') + 'v=' + Date.now(),
                 { cache: 'no-store' }, READ_MS)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(clean);
  }

  function base(force) {
    if (cached && !force) { return Promise.resolve(cached); }
    return fromApi()
      .catch(function () { return fromUrl(RAW); })
      .catch(function () { return fromUrl(SITE); })
      .then(function (u) { cached = u; return u; });
  }

  function post(url, params) {
    return timed(url + '/lead', { method: 'POST', body: params }, POST_MS)
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (d) {
          if (!res.ok || !d || d.ok !== true) {
            throw new Error((d && d.error) || ('Ошибка отправки: ' + res.status));
          }
          return d;
        });
      });
  }

  /* form → Promise. Резолвится только когда приёмник подтвердил письмо. */
  window.sendLead = function (form, extraFd) {
    var fd = extraFd || new FormData(form);
    try { fd.set('source', location.href); } catch (e) {}
    var params = new URLSearchParams();
    fd.forEach(function (v, k) { params.append(k, v); });
    return base(false)
      .then(function (u) { return post(u, params); })
      .catch(function () {
        // адрес мог протухнуть между чтением и отправкой — читаем заново
        return base(true).then(function (u) { return post(u, params); });
      });
  };
})();
