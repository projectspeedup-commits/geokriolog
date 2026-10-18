// geokriolog.ru — совместимый приёмник заявок, версия 2.
// Не публикует контакты или журнал через GET. Состояния хранятся без текста заявки.
var TO = 'info@geokriolog.ru';
var RECEIVER_VERSION = '2026-10-18-idempotent-v2';
var DIRECTIONS = { equipment: 'Техника и инструмент', pile_heads: 'Оголовки свай', audit: 'Геокриологический аудит', thermal: 'Термостабилизация' };

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function clean(p, key, max) {
  return String(p[key] || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

function phoneDigits(value) {
  if (/[^0-9+()\s.\-]/.test(String(value || ''))) return '';
  var s = String(value || '').replace(/\D/g, '');
  if (s.length === 10) s = '7' + s;
  if (s.length === 11 && s[0] === '8') s = '7' + s.slice(1);
  return /^7\d{10}$/.test(s) ? s : '';
}

function digest(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function doPost(e) {
  var p = (e && e.parameter) || {};
  if (p._honey || p._gotcha) return out({ ok: true });
  var id = clean(p, 'request_id', 100);
  var modern = !!id;
  if (modern && !/^gk-[a-zA-Z0-9-]{12,90}$/.test(id)) return out({ ok: false, error: 'request_id' });
  if (!phoneDigits(p.phone)) return out({ ok: false, error: 'phone' });
  if (modern && !/^(on|true|1|yes)$/i.test(String(p.consent || ''))) return out({ ok: false, error: 'consent' });
  // Старые открытые страницы ещё могут присылать заявку без нового идентификатора.
  if (!id) id = 'legacy-' + Utilities.getUuid();
  var direction = clean(p, 'direction', 40);
  if (!Object.prototype.hasOwnProperty.call(DIRECTIONS, direction)) direction = '';
  var rows = [
    ['Имя', clean(p, 'name', 200)], ['Телефон', clean(p, 'phone', 100)],
    ['Тип объекта', clean(p, 'type', 200)], ['Регион', clean(p, 'region', 200)],
    ['Задача', clean(p, 'message', 6000)], ['Страница', clean(p, 'page', 300)],
    ['Направление', DIRECTIONS[direction] || 'Не указано'], ['Товар или услуга', clean(p, 'product', 200)],
    ['Место кнопки', clean(p, 'cta', 100)], ['Адрес страницы', clean(p, 'source', 600)],
    ['Первая страница', clean(p, 'first_landing_path', 300)], ['Первый источник', clean(p, 'first_referrer_host', 200)]
  ];
  ['source', 'medium', 'campaign', 'content', 'term'].forEach(function (key) {
    rows.push(['Первая UTM ' + key, clean(p, 'first_utm_' + key, 180)]);
  });
  var fingerprint = digest(JSON.stringify(rows));
  var key = 'lead.v2.' + id;
  var store, lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
    store = PropertiesService.getScriptProperties();
    var previous = store.getProperty(key);
    if (previous) {
      previous = JSON.parse(previous);
      if (previous.hash !== fingerprint) return out({ ok: false, error: 'request_conflict', request_id: id });
      if (previous.status === 'sent') return out({ ok: true, duplicate: true, request_id: id });
      // MailApp мог отправить письмо до потери ответа. Повторно не отправляем.
      return out({ ok: false, error: 'delivery_unknown', request_id: id });
    }
    var record = { status: 'pending', created: new Date().toISOString(), direction: direction, hash: fingerprint };
    // Если учёт недоступен или исчерпан лимит, письмо не отправляется.
    store.setProperty(key, JSON.stringify(record));
  } catch (err) {
    return out({ ok: false, error: 'receiver_busy', request_id: id });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }

  var lines = rows.filter(function (row) { return !!row[1]; }).map(function (row) { return row[0] + ': ' + row[1]; });
  lines.push('Идентификатор заявки: ' + id);
  lines.push('Время: ' + Utilities.formatDate(new Date(), 'Europe/Moscow', 'dd.MM.yyyy HH:mm'));
  lines.push('Источник: форма на сайте');
  try {
    MailApp.sendEmail({ to: TO, subject: 'Заявка с сайта', body: lines.join('\n'), name: 'Сайт geokriolog.ru' });
    record.status = 'sent';
    record.sent = new Date().toISOString();
    store.setProperty(key, JSON.stringify(record));
    return out({ ok: true, request_id: id });
  } catch (err) {
    // pending сохраняется: даже исключение не доказывает, что письмо не ушло.
    return out({ ok: false, error: 'delivery_unknown', request_id: id });
  }
}

function doGet() {
  return out({ ok: true, ping: 'geokriolog form endpoint', version: RECEIVER_VERSION });
}
