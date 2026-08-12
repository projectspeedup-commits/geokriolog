/* Отправка заявок с форм сайта.
   Адрес приёмника лежит в /form-endpoint.json и меняется при переподключении
   туннеля, поэтому он читается перед отправкой, а не зашит в страницы.
   Если приёмник недоступен — форма честно показывает ошибку и предлагает
   письмо на info@ (фолбэк в самих страницах). */
(function () {
  var CFG = '/form-endpoint.json';
  var cached = null;

  function base() {
    if (cached) { return Promise.resolve(cached); }
    return fetch(CFG + '?v=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var u = j && j.url ? String(j.url).replace(/\/+$/, '') : '';
        if (!u) { throw new Error('нет адреса приёмника'); }
        cached = u;
        return u;
      });
  }

  /* form → Promise. Резолвится только когда письмо принято приёмником. */
  window.sendLead = function (form, extraFd) {
    var fd = extraFd || new FormData(form);
    try { fd.set('source', location.href); } catch (e) {}
    var params = new URLSearchParams();
    fd.forEach(function (v, k) { params.append(k, v); });
    return base().then(function (u) {
      return fetch(u + '/lead', { method: 'POST', body: params });
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (d) {
        if (!res.ok || !d || d.ok !== true) {
          throw new Error((d && d.error) || ('Ошибка отправки: ' + res.status));
        }
        return d;
      });
    });
  };
})();
