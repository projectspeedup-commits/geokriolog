const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

class Node {
  constructor(tag = 'div', attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.value = attrs.value || '';
    this.defaultValue = this.value;
    this.checked = Boolean(attrs.checked);
    this.defaultChecked = this.checked;
    this.type = attrs.type || '';
    this.required = Boolean(attrs.required);
    this.disabled = false;
    this.hidden = false;
    this.children = [];
    this.listeners = {};
    this._text = '';
    const classes = new Set();
    this.classList = { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(x => x.textContent).join(''); }
  set href(value) { this.attrs.href = value; }
  get href() { return this.attrs.href; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  removeAttribute(name) { delete this.attrs[name]; }
  appendChild(node) { this.children.push(node); return node; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, target = this) { for (const fn of this.listeners[type] || []) fn({ target, preventDefault() {} }); }
  closest(selector) { return selector === 'a[href]' && this.tagName === 'A' && this.attrs.href ? this : null; }
  focus() { this.focused = true; }
}

class Form extends Node {
  constructor(values = {}, home = false) {
    super('form', { id: 'leadForm' });
    this.fields = {};
    const initial = { name: '', phone: '', consent: 'yes', _honey: '', direction: '', product: '', type: '', region: '', message: '', page: 'Проверка', _subject: 'Заявка с сайта', ...values };
    for (const [name, value] of Object.entries(initial)) {
      const attrs = { name, value, type: name === 'consent' ? 'checkbox' : 'text' };
      this.fields[name] = new Node('input', attrs);
    }
    this.ok = new Node('div', { id: home ? 'formMsg' : 'lfOk' });
    this.error = new Node('div', { id: home ? 'formErr' : 'lfErr' });
    this.button = new Node('button', { id: home ? 'lfSubmit' : 'lfBtn', type: 'submit' });
    this.button.textContent = 'Отправить заявку';
  }
  querySelector(selector) {
    const name = selector.match(/^\[name="(.+)"\]$/);
    if (name) return this.fields[name[1]] || null;
    if (selector === '#formMsg, #lfOk') return this.ok;
    if (selector === '#formErr, #lfErr') return this.error;
    if (selector === '#lfSubmit, #lfBtn, button[type="submit"]') return this.button;
    return null;
  }
  reset() {
    this.resets = (this.resets || 0) + 1;
    for (const field of Object.values(this.fields)) { field.value = field.defaultValue; field.checked = field.defaultChecked; }
  }
}

class MockFormData {
  constructor(form) {
    this.data = new Map();
    if (form) for (const [key, field] of Object.entries(form.fields)) {
      if (field.type === 'checkbox' && !field.checked) continue;
      this.append(key, field.value);
    }
  }
  append(key, value) { this.data.set(key, [...(this.data.get(key) || []), String(value)]); }
  set(key, value) { this.data.set(key, [String(value)]); }
  get(key) { return this.data.get(key)?.[0] ?? null; }
  forEach(fn) { for (const [key, values] of this.data) for (const value of values) fn(value, key); }
}

function response(data, ok = true) { return { ok, json: async () => data }; }
function config(url = 'https://script.google.com/macros/s/test/exec') {
  return response({ content: Buffer.from(JSON.stringify({ url })).toString('base64') });
}
function harness({ href = 'https://geokriolog.ru/', referrer = '', forms = [], fetch: handler = async () => response({ ok: true }), storage = new Map(), fastTimeout = false } = {}) {
  const listeners = {};
  const calls = [];
  const goals = [];
  let uuid = 0;
  const document = {
    referrer, readyState: 'complete',
    querySelectorAll: () => forms,
    querySelector: () => forms[0] || null,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    createElement: tag => new Node(tag),
    createTextNode: text => { const node = new Node('#text'); node.textContent = text; return node; },
    dispatch(type, target) { for (const fn of listeners[type] || []) fn({ target }); }
  };
  const location = new URL(href);
  const context = {
    document, location, URL, URLSearchParams, WeakMap, WeakSet, Uint8Array, Array,
    FormData: MockFormData, AbortController,
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-' + String(++uuid).padStart(12, '0') },
    atob: text => Buffer.from(text, 'base64').toString('binary'),
    setTimeout: (fn, ms) => setTimeout(fn, fastTimeout && ms === 12000 ? 2 : ms),
    clearTimeout,
    fetch: (url, options) => { calls.push({ url, options }); return handler(url, options, calls); },
    ym: (...args) => goals.push(args)
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/lead.js'), 'utf8'), context);
  return {
    context, calls, goals, storage, document,
    loadForm() { vm.runInContext(fs.readFileSync(path.join(root, 'assets/lead-form.js'), 'utf8'), context); },
    postCalls() { return calls.filter(x => x.options.method === 'POST'); }
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
module.exports = { Node, Form, MockFormData, response, config, harness, tick };
