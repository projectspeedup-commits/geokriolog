const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.resolve(__dirname, '../backend/form-receiver.gs'), 'utf8');

const ID = 'gk-00000000-0000-4000-8000-000000000001';
function lead(extra = {}) {
  return { parameter: { request_id: ID, phone: '9119245467', consent: 'yes', direction: 'equipment', product: 'TYSIM KR300M', name: 'ТЕСТОВОЕ ИМЯ', message: 'ТЕСТОВАЯ ЗАДАЧА', ...extra } };
}
function receiver({ mail, write, acquire, initial } = {}) {
  const storage = new Map(initial || []);
  const messages = [];
  let held = false, writes = 0, uuid = 0;
  const lock = {
    waitLock() { if (acquire) acquire(); if (held) throw new Error('lock busy'); held = true; },
    hasLock() { return held; },
    releaseLock() { held = false; }
  };
  const ctx = {
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
    LockService: { getScriptLock: () => lock },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => storage.get(key) || null,
      setProperty(key, value) {
        writes++;
        if (write) write({ key, value, writes, storage });
        else storage.set(key, value);
      }
    }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_, value) => Array.from(crypto.createHash('sha256').update(value).digest(), x => x > 127 ? x - 256 : x),
      getUuid: () => 'legacy-' + (++uuid), formatDate: () => '18.10.2026 12:00'
    },
    MailApp: { sendEmail(message) { messages.push(message); if (mail) mail(ctx, message); } }
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  const call = event => JSON.parse(ctx.doPost(event).text);
  return { ctx, call, storage, messages, state: () => JSON.parse(storage.get('lead.v2.' + ID) || 'null') };
}

test('minimal modern lead accepts phone and consent, preserves subject and stores sent without contact data', () => {
  const h = receiver();
  const reply = h.call(lead({ name: '', type: '', region: '', message: '' }));
  assert.equal(reply.ok, true);
  assert.equal(reply.request_id, ID);
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].subject, /^Заявка/);
  assert.match(h.messages[0].body, /Товар или услуга: TYSIM KR300M/);
  assert.equal(h.state().status, 'sent');
  assert.equal(h.state().direction, 'equipment');
  assert.match(h.state().hash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify([...h.storage]), /9119245467|ТЕСТОВОЕ|info@|KR300M|Телефон/);
});

test('duplicate after success returns ok duplicate and sends exactly one email', () => {
  const h = receiver();
  assert.equal(h.call(lead()).ok, true);
  const duplicate = h.call(lead());
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(h.messages.length, 1);
  assert.equal(h.storage.size, 1);
});

test('changed payload with the same request ID returns conflict and never sends another email', () => {
  const h = receiver();
  h.call(lead());
  const previous = h.storage.get('lead.v2.' + ID);
  const conflict = h.call(lead({ product: 'RCO1500' }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, 'request_conflict');
  assert.equal(h.messages.length, 1);
  assert.equal(h.storage.get('lead.v2.' + ID), previous);
});

test('concurrent retry sees pending and cannot enter MailApp a second time', () => {
  let concurrent;
  const h = receiver({ mail(ctx) { concurrent = JSON.parse(ctx.doPost(lead()).text); } });
  const first = h.call(lead());
  assert.equal(first.ok, true);
  assert.equal(concurrent.ok, false);
  assert.equal(concurrent.error, 'delivery_unknown');
  assert.equal(h.messages.length, 1);
  assert.equal(h.state().status, 'sent');
});

test('MailApp exception preserves pending even if email might have been sent; retry never resends', () => {
  const h = receiver({ mail() { throw new Error('ambiguous mail error with sensitive text'); } });
  const first = h.call(lead());
  assert.equal(first.ok, false);
  assert.equal(first.error, 'delivery_unknown');
  assert.doesNotMatch(JSON.stringify(first), /sensitive/);
  assert.equal(h.state().status, 'pending');
  assert.equal(h.call(lead()).error, 'delivery_unknown');
  assert.equal(h.messages.length, 1);
});

test('failed persistence before MailApp sends nothing; a later safe retry can deliver', () => {
  const h = receiver({ write({ key, value, writes, storage }) {
    if (writes === 1) throw new Error('quota');
    storage.set(key, value);
  } });
  assert.equal(h.call(lead()).error, 'receiver_busy');
  assert.equal(h.messages.length, 0);
  assert.equal(h.storage.size, 0);
  assert.equal(h.call(lead()).ok, true);
  assert.equal(h.messages.length, 1);
});

test('pending write that committed then threw stays closed: no email on original or repeat', () => {
  const h = receiver({ write({ key, value, writes, storage }) {
    storage.set(key, value);
    if (writes === 1) throw new Error('write confirmation lost');
  } });
  assert.equal(h.call(lead()).error, 'receiver_busy');
  assert.equal(h.state().status, 'pending');
  assert.equal(h.call(lead()).error, 'delivery_unknown');
  assert.equal(h.messages.length, 0);
});

test('sent persistence failure after MailApp leaves pending and prevents a second email', () => {
  const h = receiver({ write({ key, value, writes, storage }) {
    if (writes === 2) throw new Error('sent write failed');
    storage.set(key, value);
  } });
  assert.equal(h.call(lead()).error, 'delivery_unknown');
  assert.equal(h.messages.length, 1);
  assert.equal(h.state().status, 'pending');
  assert.equal(h.call(lead()).error, 'delivery_unknown');
  assert.equal(h.messages.length, 1);
});

test('sent write that committed then threw is recognized as sent on retry', () => {
  const h = receiver({ write({ key, value, writes, storage }) {
    storage.set(key, value);
    if (writes === 2) throw new Error('sent confirmation lost');
  } });
  assert.equal(h.call(lead()).error, 'delivery_unknown');
  assert.equal(h.state().status, 'sent');
  const retry = h.call(lead());
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicate, true);
  assert.equal(h.messages.length, 1);
});

test('modern lead requires consent and a Russian 10/11 digit phone before persistence or mail', () => {
  const h = receiver();
  for (const phone of ['', '123', '49119245467', '791192454670', 'abc9119245467']) {
    assert.equal(h.call(lead({ phone })).error, 'phone', phone);
  }
  for (const consent of ['', 'false', 'no']) assert.equal(h.call(lead({ consent })).error, 'consent');
  assert.equal(h.messages.length, 0);
  assert.equal(h.storage.size, 0);
});

test('invalid modern ID, honeypot, busy lock and corrupt state all avoid mail', () => {
  assert.equal(receiver().call(lead({ request_id: 'bad' })).error, 'request_id');
  const honey = receiver();
  assert.equal(honey.call(lead({ _honey: 'bot' })).ok, true);
  assert.equal(honey.messages.length, 0);
  const busy = receiver({ acquire() { throw new Error('busy'); } });
  assert.equal(busy.call(lead()).error, 'receiver_busy');
  assert.equal(busy.messages.length, 0);
  const corrupt = receiver({ initial: [['lead.v2.' + ID, '{malformed']] });
  assert.equal(corrupt.call(lead()).error, 'receiver_busy');
  assert.equal(corrupt.messages.length, 0);
});

test('legacy payload is still accepted, retains its fields, and does not claim idempotence', () => {
  const h = receiver();
  const legacy = lead({ request_id: '', consent: '', _subject: 'Заявка с сайта: старая страница' });
  assert.equal(h.call(legacy).ok, true);
  assert.equal(h.call(legacy).ok, true);
  assert.equal(h.messages.length, 2, 'legacy without stable ID cannot be deduplicated');
  assert.match(h.messages[0].body, /Имя: ТЕСТОВОЕ ИМЯ/);
  assert.match(h.messages[0].body, /Телефон: 9119245467/);
  assert.match(h.messages[0].body, /Задача: ТЕСТОВАЯ ЗАДАЧА/);
});

test('GET exposes only version/health and no stored state or contact information', () => {
  const h = receiver();
  h.call(lead());
  const reply = JSON.parse(h.ctx.doGet().text);
  assert.equal(reply.ok, true);
  assert.equal(reply.version, '2026-10-18-idempotent-v2');
  assert.doesNotMatch(JSON.stringify(reply), /9119245467|ТЕСТОВОЕ|pending|sent|request_id|hash/);
});
