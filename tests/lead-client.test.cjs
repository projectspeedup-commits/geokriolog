const test = require('node:test');
const assert = require('node:assert/strict');
const { Node, Form, MockFormData, response, config, harness, tick } = require('./lead-client-fixtures.cjs');

function working(options = {}) {
  return harness({ ...options, fetch: options.fetch || ((url, opts) => opts.method === 'POST' ? response({ ok: true }) : config()) });
}

test('normalizes Russian 10/11 digit phones and rejects incomplete/foreign/text values', () => {
  const h = working();
  for (const phone of ['9119245467', '+7 (911) 924-54-67', '8 911 924 54 67']) {
    assert.equal(h.context.GeokriologLead.normalizePhone(phone), '79119245467');
  }
  for (const phone of ['', '911924546', '49119245467', '791192454670', 'call 9119245467']) {
    assert.equal(h.context.GeokriologLead.normalizePhone(phone), '');
  }
});

test('API endpoint resolves to one Apps Script POST with existing fields, normalized phone and legacy context', async () => {
  const form = new Form({ phone: '+7 (911) 924-54-67', product: 'TYSIM KR300M', message: 'Нужна колонна' });
  const h = working({ href: 'https://geokriolog.ru/tysim-kr300m/' });
  await h.context.sendLead(form);
  const posts = h.postCalls();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://script.google.com/macros/s/test/exec');
  const body = posts[0].options.body;
  assert.equal(body.get('direction'), 'equipment');
  assert.equal(body.get('product'), 'TYSIM KR300M');
  assert.equal(body.get('phone_digits'), '79119245467');
  assert.equal(body.get('_subject'), 'Заявка с сайта');
  assert.match(body.get('message'), /^Нужна колонна\n\n\[Контекст заявки\]/);
  assert.match(body.get('message'), /Товар или услуга: TYSIM KR300M/);
});

test('endpoint reads fall through API → raw → site before sending, without POST retry', async () => {
  const h = working({ fetch: (url, opts) => {
    if (opts.method === 'POST') return response({ ok: true });
    if (url.startsWith('/form-endpoint.json')) return response({ url: 'https://example.com/receiver' });
    throw new Error('read unavailable');
  } });
  await h.context.sendLead(new Form());
  assert.equal(h.calls.length, 4);
  assert.match(h.calls[0].url, /^https:\/\/api.github.com/);
  assert.match(h.calls[1].url, /^https:\/\/raw.githubusercontent.com/);
  assert.match(h.calls[2].url, /^\/form-endpoint.json/);
  assert.equal(h.postCalls()[0].url, 'https://example.com/receiver/lead');
});

test('failed POST never rereads endpoint or retries and error does not contain external details', async () => {
  const h = working({ fetch: (_, opts) => {
    if (opts.method === 'POST') throw new Error('sensitive response');
    return config();
  } });
  await assert.rejects(h.context.sendLead(new Form()), error => error.code === 'network' && error.ambiguous && !error.message.includes('sensitive'));
  assert.equal(h.calls.length, 2);
  assert.equal(h.postCalls().length, 1);
});

test('same request ID survives failure and manual retry; success gives the next lead a new ID', async () => {
  let count = 0;
  const h = working({ fetch: (_, opts) => {
    if (opts.method !== 'POST') return config();
    if (++count === 1) throw new Error('lost answer');
    return response({ ok: true });
  } });
  const form = new Form({ message: 'Подбор' });
  await assert.rejects(h.context.sendLead(form));
  await h.context.sendLead(form);
  await h.context.sendLead(form);
  const ids = h.postCalls().map(x => x.options.body.get('request_id'));
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[1], ids[2]);
  assert.equal(h.calls.filter(x => x.options.method !== 'POST').length, 1);
});

test('concurrent sendLead calls share one pending operation and POST', async () => {
  let release;
  const h = working({ fetch: (_, opts) => opts.method === 'POST' ? new Promise(resolve => { release = resolve; }) : config() });
  const form = new Form();
  const first = h.context.sendLead(form);
  const second = h.context.sendLead(form);
  assert.equal(first, second);
  await tick();
  assert.equal(h.postCalls().length, 1);
  release(response({ ok: true }));
  await first;
});

test('POST timeout includes stalled body parsing and causes no second POST', async () => {
  const h = working({ fastTimeout: true, fetch: (_, opts) => opts.method === 'POST' ? { ok: true, json: () => new Promise(() => {}) } : config() });
  await assert.rejects(h.context.sendLead(new Form()), error => error.code === 'timeout' && error.ambiguous);
  assert.equal(h.postCalls().length, 1);
});

test('invalid JSON, rejected HTTP, missing ok and pending responses never report success or retry', async t => {
  const cases = [
    ['invalid JSON', { ok: true, json: async () => { throw new SyntaxError('bad'); } }, 'network'],
    ['HTTP error', response({ ok: true }, false), 'rejected'],
    ['missing ok', response({}), 'rejected'],
    ['pending', response({ ok: false, error: 'pending' }), 'pending']
  ];
  for (const [name, answer, code] of cases) await t.test(name, async () => {
    const h = working({ fetch: (_, opts) => opts.method === 'POST' ? answer : config() });
    await assert.rejects(h.context.sendLead(new Form()), error => error.code === code && error.ambiguous);
    assert.equal(h.postCalls().length, 1);
  });
});

test('configuration failures perform no POST and leave the request ID stable', async () => {
  const h = working({ fetch: async () => response({ url: 'http://insecure.example' }) });
  const form = new Form();
  const before = h.context.GeokriologLead.prepare(form).get('request_id');
  await assert.rejects(h.context.sendLead(form), error => error.code === 'configuration' && !error.ambiguous);
  assert.equal(h.context.GeokriologLead.prepare(form).get('request_id'), before);
  assert.equal(h.postCalls().length, 0);
});

test('first touch keeps only path, referrer hostname and bounded whitelisted UTM; later pages keep it', async () => {
  const long = 'x'.repeat(200);
  const h = working({
    href: 'https://geokriolog.ru/blog/termosvai/?utm_source=dzen&utm_campaign=' + long + '%0Ahidden&phone=secret#private',
    referrer: 'https://dzen.ru/a/private?token=secret'
  });
  const form = new Form();
  const first = h.context.GeokriologLead.prepare(form);
  assert.equal(first.get('first_landing_path'), '/blog/termosvai/');
  assert.equal(first.get('first_referrer_host'), 'dzen.ru');
  assert.equal(first.get('first_utm_source'), 'dzen');
  assert.equal(first.get('first_utm_campaign').length, 160);
  assert.doesNotMatch(first.get('source'), /secret|private|phone/);
  assert.doesNotMatch(JSON.stringify([...h.storage.values()]), /secret|private|phone|token/);
  const next = working({ href: 'https://geokriolog.ru/termostabilizaciya-sou/?utm_source=internal&token=secret', storage: h.storage });
  const second = next.context.GeokriologLead.prepare(form);
  assert.equal(second.get('first_utm_source'), 'dzen');
  assert.equal(second.get('first_landing_path'), '/blog/termosvai/');
  assert.match(second.get('source'), /utm_source=internal$/);
});

test('extra FormData stays untouched and reused prepared data has one legacy block', () => {
  const h = working();
  const form = new Form({ direction: 'audit', product: 'Услуга\nподбор', message: 'Нужен разбор' });
  const extra = new MockFormData(form);
  const once = h.context.GeokriologLead.prepare(form, extra);
  const twice = h.context.GeokriologLead.prepare(form, once);
  assert.equal(extra.get('message'), 'Нужен разбор');
  assert.equal(once.get('message'), twice.get('message'));
  assert.equal((twice.get('message').match(/\[Контекст заявки\]/g) || []).length, 1);
  assert.equal(twice.get('product'), 'Услуга подбор');
});

test('minimal valid form sends without name/type; double click is blocked; success emits one safe goal and resets', async () => {
  const form = new Form({ phone: '9119245467' }, true);
  form.fields.consent.checked = true;
  let release;
  const h = working({ forms: [form], fetch: (_, opts) => opts.method === 'POST' ? new Promise(resolve => { release = resolve; }) : config() });
  h.loadForm();
  form.dispatch('submit');
  form.dispatch('submit');
  assert.equal(form.button.disabled, true);
  await tick();
  assert.equal(h.postCalls().length, 1);
  release(response({ ok: true }));
  await tick();
  assert.equal(form.button.disabled, false);
  assert.equal(form.resets, 1);
  assert.match(form.ok.textContent, /Заявка отправлена/);
  assert.equal(h.goals.filter(x => x[2] === 'form_lead').length, 1);
  assert.ok(h.goals.every(x => x.length === 3));
});

test('invalid phone, missing consent and honeypot each block POST and preserve values', async () => {
  const form = new Form({ phone: '123', message: 'Сохранить' });
  const h = working({ forms: [form] });
  h.loadForm();
  form.dispatch('submit');
  assert.match(form.error.textContent, /Укажите телефон/);
  form.fields.phone.value = '+7 911 924 54 67';
  form.dispatch('submit');
  assert.match(form.error.textContent, /Подтвердите согласие/);
  form.fields.consent.checked = true;
  form.fields._honey.value = 'spam';
  form.dispatch('submit');
  await tick();
  assert.equal(h.postCalls().length, 0);
  assert.equal(form.fields.message.value, 'Сохранить');
  assert.equal(h.goals.filter(x => x[2] === 'form_start').length, 1);
});

test('transport error preserves fields/ID, renders safe fallback and tracks dynamically created mailto/tel', async () => {
  const form = new Form({ phone: '9119245467', message: '<script>alert(1)</script>' });
  form.fields.consent.checked = true;
  const h = working({ forms: [form], fetch: (_, opts) => opts.method === 'POST' ? Promise.reject(new Error('external private')) : config() });
  h.loadForm();
  form.dispatch('submit');
  await tick();
  assert.equal(form.resets, undefined);
  assert.equal(form.fields.message.value, '<script>alert(1)</script>');
  assert.equal(form.button.disabled, false);
  assert.match(form.error.textContent, /Заявка могла поступить/);
  assert.doesNotMatch(form.error.textContent, /external private|<script>/);
  const email = form.error.children.find(x => x.href?.startsWith('mailto:'));
  const phone = form.error.children.find(x => x.href?.startsWith('tel:'));
  assert.ok(email);
  assert.ok(phone);
  const body = new URL(email.href).searchParams.get('body');
  const id = h.postCalls()[0].options.body.get('request_id');
  assert.ok(body.includes(id));
  assert.ok(body.includes('<script>alert(1)</script>'));
  h.document.dispatch('click', email);
  h.document.dispatch('click', phone);
  assert.equal(h.goals.filter(x => x[2] === 'email_click').length, 1);
  assert.equal(h.goals.filter(x => x[2] === 'call_click').length, 1);
});

test('product CTA preselects direction/product and gets persisted into submission metadata', async () => {
  const form = new Form({ phone: '9119245467' });
  form.fields.consent.checked = true;
  const h = working({ forms: [form] });
  h.loadForm();
  const link = new Node('a', { href: '#cta', 'data-lead-direction': 'equipment', 'data-lead-product': 'TYSIM KR300M', 'data-lead-cta': 'catalog_kr300m' });
  h.document.dispatch('click', link);
  assert.equal(form.fields.direction.value, 'equipment');
  assert.equal(form.fields.product.value, 'TYSIM KR300M');
  form.dispatch('submit');
  await tick();
  const payload = h.postCalls()[0].options.body;
  assert.equal(payload.get('direction'), 'equipment');
  assert.equal(payload.get('product'), 'TYSIM KR300M');
  assert.equal(payload.get('cta'), 'catalog_kr300m');
});

test('new service direction clears stale product while a generic CTA preserves manual input', () => {
  const form = new Form({ direction: 'equipment', product: 'TYSIM KR300M' });
  const h = working({ forms: [form] });
  h.loadForm();
  h.document.dispatch('click', new Node('a', { href: '#cta', 'data-lead-direction': 'audit' }));
  assert.equal(form.fields.direction.value, 'audit');
  assert.equal(form.fields.product.value, '');
  form.fields.product.value = 'Проверка проекта';
  h.document.dispatch('click', new Node('a', { href: '#cta' }));
  assert.equal(form.fields.direction.value, 'audit');
  assert.equal(form.fields.product.value, 'Проверка проекта');
});

test('explicit empty product survives preparation on a product URL after direction change or clearing', () => {
  const h = working({ href: 'https://geokriolog.ru/tysim-kr300m/' });
  const form = new Form({ direction: 'audit', product: '' });
  assert.equal(h.context.GeokriologLead.prepare(form).get('product'), '');
  form.fields.direction.value = 'equipment';
  assert.equal(h.context.GeokriologLead.prepare(form).get('product'), '');
  delete form.fields.product;
  assert.equal(h.context.GeokriologLead.prepare(form).get('product'), 'TYSIM KR300M');
  form.fields.direction.value = 'audit';
  assert.equal(h.context.GeokriologLead.prepare(form).get('product'), '');
});

test('manual direction change clears automatic model but preserves a manually edited product', () => {
  const form = new Form();
  const h = working({ href: 'https://geokriolog.ru/tysim-kr300m/', forms: [form] });
  h.loadForm();
  assert.equal(form.fields.product.value, 'TYSIM KR300M');
  form.fields.direction.value = 'audit';
  form.dispatch('change', form.fields.direction);
  assert.equal(form.fields.product.value, '');
  h.document.dispatch('click', new Node('a', { href: '#cta', 'data-lead-direction': 'equipment', 'data-lead-product': 'TYSIM KR300M' }));
  form.fields.product.value = 'Нужны характеристики модели';
  form.dispatch('input', form.fields.product);
  form.fields.direction.value = 'audit';
  form.dispatch('change', form.fields.direction);
  assert.equal(form.fields.product.value, 'Нужны характеристики модели');
  assert.equal(h.context.GeokriologLead.prepare(form).get('product'), 'Нужны характеристики модели');
});

test('BNS construction and estimate articles default to equipment without selecting a model', () => {
  for (const slug of ['ustrojstvo-buronabivnyh-svaj', 'smeta-na-ustrojstvo-buronabivnyh-svaj']) {
    const form = new Form();
    const h = working({ href: 'https://geokriolog.ru/blog/' + slug + '/', forms: [form] });
    h.loadForm();
    assert.equal(form.fields.direction.value, 'equipment');
    assert.equal(form.fields.product.value, '');
    const payload = h.context.GeokriologLead.prepare(form);
    assert.equal(payload.get('direction'), 'equipment');
    assert.equal(payload.get('product'), '');
  }
});

test('article offer clicks track only internal whitelisted paths with three safe parameters', () => {
  const h = working({ href: 'https://geokriolog.ru/blog/ustrojstvo-buronabivnyh-svaj/?phone=private#secret' });
  h.loadForm();
  assert.equal(h.goals.length, 0, 'loading does not count as a click');
  const offers = {
    tehnika: 'equipment', 'tysim-kr300m': 'equipment', 'obshadnoj-stol-rco1500': 'equipment',
    'obsadnye-truby': 'equipment', 'kelli-shtangi': 'equipment', 'burovoj-instrument': 'equipment',
    'demontazh-ogolovkov-bns': 'pile_heads', 'audit-kriolitozony': 'audit',
    'termostabilizaciya-sou': 'thermal', 'termostabilizatory-grunta': 'thermal'
  };
  for (const [slug, direction] of Object.entries(offers)) {
    h.document.dispatch('click', new Node('a', { href: '/' + slug + '/?email=private&utm_source=private#contact' }));
    const goal = h.goals.at(-1);
    assert.equal(goal[0], 110604818);
    assert.equal(goal[2], 'article_offer_click');
    assert.equal(goal.length, 4);
    assert.deepEqual(JSON.parse(JSON.stringify(goal[3])), {
      direction, article_path: '/blog/ustrojstvo-buronabivnyh-svaj/', offer_path: '/' + slug + '/'
    });
  }
  assert.equal(h.goals.length, 10);
  for (const href of ['https://external.example/tehnika/', 'https://geokriolog.ru.external.example/tehnika/', '/o-kompanii/', '/blog/', '/blog/termosvai/', '#cta', '/tehnika/nested/']) {
    h.document.dispatch('click', new Node('a', { href }));
  }
  assert.equal(h.goals.length, 10, 'external, nonoffer and CTA links do not count');
  for (const pathname of ['/blog/', '/', '/tysim-kr300m/']) {
    h.context.location.pathname = pathname;
    h.document.dispatch('click', new Node('a', { href: '/tehnika/' }));
  }
  assert.equal(h.goals.length, 10, 'only an article can be the source');
  assert.doesNotMatch(JSON.stringify(h.goals), /private|secret|email|phone|utm_/);
});
