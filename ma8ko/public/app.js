// Ma8ko (bitácora del bebé) — lógica del cliente (sin frameworks).
//
// Vistas: Hoy · Historial · Pediatra (+ reporte imprimible) · Gastos.
// Todo se guarda en el servidor; el cliente consulta /api/version cada
// pocos segundos y recarga solo si algo cambió (así los dos celulares
// ven lo mismo casi al instante).
'use strict';

// ======================= Utilidades =======================

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ym = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const toLocalInput = (d) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
const fmtDate = (d, opts = { weekday: 'long', day: 'numeric', month: 'short' }) =>
  new Date(d).toLocaleDateString('en-US', opts);

function fmtDay(d) {
  const diff = Math.round((startOfDay(new Date()) - startOfDay(d)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return fmtDate(d);
}

function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ' ' + pad(m % 60) + ' min' : ''}`;
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function fmtAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < MIN) return 'just now';
  return fmtDur(ms) + ' ago';
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

// ======================= Estado =======================

const S = {
  ready: false,
  info: {},
  settings: {},
  me: store.get('ma8ko_me') || '',
  view: store.get('ma8ko_view') || 'hoy',
  version: null,
  running: [],
  recent: [],
  hist: { day: startOfDay(new Date()), filter: 'all', entries: [] },
  ped: { ask: [], growth: [], showResolved: false },
  exp: { list: [], month: ym(new Date()) },
  report: { days: 7, entries: [], details: [] },
  sheet: null, // 'form' | 'detail' | 'settings' | 'expense'
  detail: null,
  viewer: { ids: [], idx: 0 },
};
if (!['hoy', 'historial', 'pediatra', 'gastos'].includes(S.view)) S.view = 'hoy';

// ======================= Unidades =======================
// Internamente todo es métrico (ml, kg, cm, °C). Si eligen "EE. UU."
// solo se convierte al mostrar y al capturar.

const US = () => S.settings.units === 'us';
const UNITS = {
  vol: { unit: () => (US() ? 'oz' : 'ml'), show: (v) => (US() ? r1(v / 29.5735) : Math.round(v)), parse: (v) => (US() ? v * 29.5735 : v) },
  wt: { unit: () => (US() ? 'lb' : 'kg'), show: (v) => (US() ? r2(v * 2.20462) : r2(v)), parse: (v) => (US() ? v / 2.20462 : v) },
  len: { unit: () => (US() ? 'in' : 'cm'), show: (v) => (US() ? r1(v / 2.54) : r1(v)), parse: (v) => (US() ? v * 2.54 : v) },
  temp: { unit: () => (US() ? '°F' : '°C'), show: (v) => (US() ? r1((v * 9) / 5 + 32) : r1(v)), parse: (v) => (US() ? ((v - 32) * 5) / 9 : v) },
};
const fmtU = (kind, v) => `${UNITS[kind].show(v)} ${UNITS[kind].unit()}`;

// ======================= Catálogos =======================

const KIND = {
  feeding: { label: 'Feeding', icon: '🍼' },
  diaper: { label: 'Diaper', icon: '🧷' },
  sleep: { label: 'Sleep', icon: '😴' },
  growth: { label: 'Growth', icon: '📏' },
  med: { label: 'Medicine', icon: '💊' },
  temp: { label: 'Temperature', icon: '🌡️' },
  note: { label: 'Note / photo', icon: '📷' },
  psleep: { label: 'Our sleep', icon: '🛌' },
};

// Las claves (izq, der, pecho, popo…) son los valores guardados en la base: no cambiarlas.
const SIDE = { izq: 'Left', der: 'Right', ambos: 'Both sides' };
const MILK = { materna: 'breast milk', formula: 'formula' };
const DIAPER = { pipi: 'Pee', popo: 'Poop', ambos: 'Pee + poop', seco: 'Dry' };
const POOP_COLORS = [
  ['amarillo', 'Yellow', '#e6b800'],
  ['verde', 'Green', '#6b8e23'],
  ['cafe', 'Brown', '#8b5a2b'],
  ['negro', 'Black', '#222222'],
  ['rojo', 'Red / blood', '#c0392b'],
  ['blanco', 'White / gray', '#cfcfcf'],
];
const TEXTURE = { liquida: 'watery', blanda: 'soft', pastosa: 'pasty', dura: 'hard' };
const TOPIC = {
  popo: 'Poop',
  piel: 'Skin / rash',
  vomito: 'Vomit / spit-up',
  respira: 'Breathing / cough',
  ojos: 'Eyes / ears',
  momento: 'Special moment',
  otro: 'Other',
};
const TEMP_METHOD = { axilar: 'armpit', rectal: 'rectal', oido: 'ear', frente: 'forehead' };

const CATS = {
  panales: ['Diapers & hygiene', '🧻'],
  leche: ['Milk / formula', '🍼'],
  comida: ['Food', '🥣'],
  ropa: ['Clothes', '👕'],
  salud: ['Doctor / pharmacy', '💊'],
  equipo: ['Gear (stroller, crib…)', '🛏️'],
  juguetes: ['Toys & books', '🧸'],
  cuidado: ['Daycare / babysitter', '🧑‍🍼'],
  otros: ['Other', '📦'],
};

const opts = (obj) => Object.entries(obj).map(([k, v]) => [k, v[0].toUpperCase() + v.slice(1)]);
const isPoop = (d) => d.type === 'popo' || d.type === 'ambos';

// Campos de cada formulario. `show` decide si el campo aplica según los datos.
const FORMS = {
  feeding: [
    { key: 'method', type: 'seg', label: 'Type', options: [['pecho', 'Breast'], ['biberon', 'Bottle'], ['solidos', 'Solids']] },
    { key: 'side', type: 'seg', label: 'Side', options: [['izq', 'Left'], ['der', 'Right'], ['ambos', 'Both']], show: (d) => d.method === 'pecho' },
    { key: 'milk', type: 'seg', label: 'Milk', options: [['materna', 'Breast milk'], ['formula', 'Formula']], show: (d) => d.method === 'biberon' },
    { key: 'ml', type: 'num', label: 'Amount', unit: 'vol', show: (d) => d.method === 'biberon', quick: () => (US() ? [1, 2, 3, 4, 5, 6] : [30, 60, 90, 120, 150, 180]) },
    { key: 'food', type: 'text', label: 'What did the baby eat?', placeholder: 'e.g. carrot purée', show: (d) => d.method === 'solidos' },
    { type: 'duration', show: (d) => d.method === 'pecho', quick: [5, 10, 15, 20, 30] },
  ],
  diaper: [
    { key: 'type', type: 'seg', label: 'Type', options: Object.entries(DIAPER) },
    { key: 'color', type: 'color', label: 'Color', show: isPoop },
    { key: 'texture', type: 'seg', label: 'Texture', options: opts(TEXTURE), show: isPoop },
  ],
  sleep: [{ type: 'duration', quick: [30, 60, 90, 120, 180] }],
  psleep: [
    { key: 'who', type: 'who', label: 'Who slept?' },
    { type: 'duration', quick: [60, 120, 180, 240, 360, 480] },
  ],
  growth: [
    { key: 'kg', type: 'num', label: 'Weight', unit: 'wt', step: '0.01' },
    { key: 'cm', type: 'num', label: 'Length', unit: 'len', step: '0.1' },
    { key: 'head', type: 'num', label: 'Head circumference', unit: 'len', step: '0.1' },
  ],
  med: [
    { key: 'name', type: 'text', label: 'Medicine / vitamin', placeholder: 'e.g. Vitamin D', list: 'med-names' },
    { key: 'dose', type: 'text', label: 'Dose', placeholder: 'e.g. 1 drop, 2.5 ml' },
  ],
  temp: [
    { key: 'c', type: 'num', label: 'Temperature', unit: 'temp', step: '0.1' },
    { key: 'method', type: 'seg', label: 'How it was measured', options: opts(TEMP_METHOD) },
  ],
  note: [{ key: 'topic', type: 'seg', label: 'Topic', options: Object.entries(TOPIC) }],
};

// ======================= API =======================

async function api(method, url, body) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(url, opt);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

const qs = (o) =>
  '?' +
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v instanceof Date ? v.toISOString() : v)}`)
    .join('&');

let toastTimer;
function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', Boolean(isError));
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}
const fail = (err) => toast(err.message || String(err), true);

// ======================= Descripciones =======================

const durOf = (e) => (e.ended_at ? new Date(e.ended_at) - new Date(e.at) : null);
const isRunning = (e) => e.data?.timer && !e.ended_at;

function describe(e) {
  const d = e.data || {};
  const dur = durOf(e);
  switch (e.kind) {
    case 'feeding':
      if (d.method === 'pecho') {
        const label = SIDE[d.side] ? `${SIDE[d.side]} breast` : 'Breastfeeding';
        if (isRunning(e)) return `${label} (in progress)`;
        return `${label}${dur ? ' · ' + fmtDur(dur) : ''}`;
      }
      if (d.method === 'biberon') {
        return `Bottle${MILK[d.milk] ? ' of ' + MILK[d.milk] : ''}${d.ml ? ' · ' + fmtU('vol', d.ml) : ''}`;
      }
      return `Solids${d.food ? ': ' + d.food : ''}`;
    case 'diaper': {
      let s = DIAPER[d.type] || 'Diaper';
      if (isPoop(d)) {
        const c = POOP_COLORS.find((x) => x[0] === d.color);
        const parts = [c && c[1].toLowerCase(), TEXTURE[d.texture]].filter(Boolean);
        if (parts.length) s += ' · ' + parts.join(', ');
      }
      return s;
    }
    case 'psleep':
      if (isRunning(e)) return `${d.who || 'Parent'} sleeping…`;
      return dur ? `${d.who || 'Parent'} slept ${fmtDur(dur)}` : `${d.who || 'Parent'} slept`;
    case 'sleep':
      if (isRunning(e)) return 'Sleeping…';
      return dur ? `Slept ${fmtDur(dur)}` : 'Sleep';
    case 'growth': {
      const p = [];
      if (d.kg) p.push(fmtU('wt', d.kg));
      if (d.cm) p.push('length ' + fmtU('len', d.cm));
      if (d.head) p.push('head ' + fmtU('len', d.head));
      return p.join(' · ') || 'Growth';
    }
    case 'med':
      return `${d.name || 'Medicine'}${d.dose ? ' · ' + d.dose : ''}`;
    case 'temp':
      return `${d.c ? fmtU('temp', d.c) : '—'}${TEMP_METHOD[d.method] ? ' (' + TEMP_METHOD[d.method] + ')' : ''}${d.c >= 38 ? ' · fever' : ''}`;
    case 'note':
      return TOPIC[d.topic] || 'Note';
    default:
      return e.kind;
  }
}

function warningFor(kind, d) {
  if (kind === 'diaper' && isPoop(d)) {
    if (d.color === 'rojo' || d.color === 'blanco')
      return '⚠️ Bloody or white/gray poop: check with the pediatrician.';
    if (d.color === 'negro')
      return 'Black is normal in the first few days (meconium). After that, mention it to the pediatrician.';
  }
  if (kind === 'temp' && d.c >= 38) {
    return '⚠️ 100.4 °F (38 °C) or higher is a fever. For babies under 3 months, call the pediatrician right away.';
  }
  return '';
}

function babyAge(birth) {
  if (!birth) return { text: '', milestone: false };
  const b = new Date(birth + 'T00:00:00');
  const t = startOfDay(new Date());
  const days = Math.round((t - b) / DAY);
  if (Number.isNaN(days) || days < 0) return { text: '', milestone: false };
  if (days === 0) return { text: 'Born today!', milestone: true };
  const pl = (n, s, p) => `${n} ${n === 1 ? s : p}`;
  if (days < 14) return { text: pl(days, 'day', 'days'), milestone: days === 7 };
  if (days < 84) {
    const w = Math.floor(days / 7);
    const d = days % 7;
    return { text: pl(w, 'week', 'weeks') + (d ? ' and ' + pl(d, 'day', 'days') : ''), milestone: d === 0 };
  }
  let m = (t.getFullYear() - b.getFullYear()) * 12 + t.getMonth() - b.getMonth();
  let anchor = new Date(b);
  anchor.setMonth(b.getMonth() + m);
  if (anchor > t) {
    m -= 1;
    anchor = new Date(b);
    anchor.setMonth(b.getMonth() + m);
  }
  const d = Math.round((t - anchor) / DAY);
  if (m >= 24) {
    const y = Math.floor(m / 12);
    return { text: pl(y, 'year', 'years') + (m % 12 ? ' and ' + pl(m % 12, 'month', 'months') : ''), milestone: d === 0 && m % 12 === 0 };
  }
  return { text: pl(m, 'month', 'months') + (d ? ' and ' + pl(d, 'day', 'days') : ''), milestone: d === 0 };
}

// ======================= Componentes =======================

function thumbs(ids, big) {
  if (!ids || !ids.length) return '';
  return `<div class="thumbs ${big ? 'big' : ''}">${ids
    .map((id, i) => `<img src="/api/photos/${id}?thumb=1" loading="lazy" alt="Photo" data-act="view-photo" data-ids="${ids.join(',')}" data-idx="${i}" />`)
    .join('')}</div>`;
}

function entryCard(e, opts = {}) {
  const k = KIND[e.kind] || { icon: '•', label: e.kind };
  const d = e.data || {};
  const meta = [];
  meta.push(opts.withDay ? `${fmtDay(new Date(e.at))}, ${fmtTime(e.at)}` : fmtTime(e.at));
  if (e.added_by) meta.push(esc(e.added_by));
  if (e.comment_count) meta.push(`💬 ${e.comment_count}`);
  if (d.ask && !d.resolved) meta.push('<span class="pill ask">🩺 Pediatrician</span>');
  if (d.ask && d.resolved) meta.push('<span class="pill ok">✓ Reviewed</span>');
  const warn = (e.kind === 'temp' && d.c >= 38) || (e.kind === 'diaper' && ['rojo', 'blanco'].includes(d.color));
  return `
    <div class="entry k-${e.kind} ${isRunning(e) ? 'running' : ''} ${warn ? 'warn' : ''}" data-act="open-entry" data-id="${e.id}">
      <div class="entry-icon">${k.icon}</div>
      <div class="entry-main">
        <div class="entry-title">${esc(describe(e))}</div>
        <div class="entry-sub">${meta.join(' · ')}</div>
        ${e.notes ? `<div class="entry-notes">${esc(e.notes)}</div>` : ''}
        ${thumbs(e.photos, opts.bigThumbs)}
      </div>
    </div>`;
}

const emptyState = (icon, text) => `<div class="empty"><div>${icon}</div><p>${text}</p></div>`;

// ======================= Pantallas =======================

function showScreen(name) {
  for (const id of ['welcome', 'app']) $('#' + id).classList.toggle('hidden', id !== name);
}

function setView(view) {
  S.view = view;
  if (view !== 'reporte') store.set('ma8ko_view', view);
  for (const v of ['hoy', 'historial', 'pediatra', 'gastos', 'reporte']) {
    $('#view-' + v).classList.toggle('hidden', v !== view);
  }
  $$('.tabbar button').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view || (view === 'reporte' && b.dataset.view === 'pediatra'))
  );
  $('#content').scrollTop = 0;
  loadView().catch(fail);
}

function renderHeader() {
  const name = S.settings.babyName || 'Ma8ko';
  $('#baby-name').textContent = name;
  $('#baby-age').textContent = babyAge(S.settings.birthDate).text;
  document.title = S.settings.babyName ? `${name} · Ma8ko` : 'Ma8ko';
}

// ---------- Cronómetros activos ----------

function renderTimers() {
  const el = $('#timers');
  if (!S.running.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = S.running
    .map((e) => {
      const isFeed = e.kind === 'feeding';
      const label = isFeed
        ? SIDE[e.data.side] ? `${SIDE[e.data.side]} breast` : 'Breastfeeding'
        : e.kind === 'psleep' ? `${e.data.who || 'Parent'} sleeping` : 'Baby sleeping';
      return `
      <div class="timer k-${e.kind}">
        <span class="timer-icon">${KIND[e.kind].icon}</span>
        <div class="timer-main" data-act="open-entry" data-id="${e.id}">
          <div class="timer-label">${esc(label)}</div>
          <div class="timer-clock" data-since="${e.at}">${fmtClock(Date.now() - new Date(e.at))}</div>
        </div>
        ${isFeed && e.data.side !== 'ambos' ? `<button class="btn small ghost light" data-act="switch-side" data-id="${e.id}">Switch side</button>` : ''}
        <button class="btn small light" data-act="stop-timer" data-id="${e.id}">${isFeed ? 'Done' : 'Woke up'}</button>
      </div>`;
    })
    .join('');
}

// ---------- Hoy ----------

// Suma el sueño dentro de [from, to). `match` elige qué registros cuentan
// (por defecto, el sueño del bebé).
function sleepMsInRange(entries, from, to, match = (e) => e.kind === 'sleep') {
  let total = 0;
  for (const e of entries) {
    if (!match(e)) continue;
    const a = Math.max(new Date(e.at).getTime(), from.getTime());
    const end = e.ended_at ? new Date(e.ended_at).getTime() : isRunning(e) ? Date.now() : null;
    if (end === null) continue;
    const b = Math.min(end, to.getTime());
    if (b > a) total += b - a;
  }
  return total;
}

function dayStats(entries, from, to) {
  const inDay = entries.filter((e) => {
    const t = new Date(e.at);
    return t >= from && t < to;
  });
  const feeds = inDay.filter((e) => e.kind === 'feeding');
  const diapers = inDay.filter((e) => e.kind === 'diaper');
  return {
    feeds: feeds.length,
    ml: feeds.reduce((s, e) => s + (e.data.method === 'biberon' ? Number(e.data.ml) || 0 : 0), 0),
    breastMin: feeds.reduce((s, e) => s + (e.data.method === 'pecho' && durOf(e) ? durOf(e) / MIN : 0), 0),
    diapers: diapers.length,
    pee: diapers.filter((e) => e.data.type === 'pipi' || e.data.type === 'ambos').length,
    poop: diapers.filter((e) => isPoop(e.data)).length,
    sleepMs: sleepMsInRange(entries, from, to),
    entries: inDay,
  };
}

function suggestedSide() {
  const last = S.recent.find((e) => e.kind === 'feeding' && e.data.method === 'pecho');
  if (!last) return 'izq';
  if (last.data.side === 'izq') return 'der';
  if (last.data.side === 'der') return 'izq';
  return 'izq';
}

// Personas conocidas: tú, quien haya registrado algo y quien haya dormido.
function parentNames() {
  const names = [S.me, ...S.recent.map((e) => e.added_by), ...S.recent.filter((e) => e.kind === 'psleep').map((e) => e.data.who)];
  return [...new Set(names.filter(Boolean))];
}

// Tarjeta "Our sleep": botón de un toque para quien usa este celular y
// cuánto durmió cada uno en las últimas 24 h.
function parentsSleepCard() {
  const now = new Date();
  const from = new Date(now.getTime() - DAY);
  const mine = S.running.find((e) => e.kind === 'psleep' && e.data.who === S.me);
  const rows = parentNames().map((who) => {
    const list = S.recent.filter((e) => e.kind === 'psleep' && e.data.who === who);
    const total = sleepMsInRange(list, from, now, () => true);
    let longest = 0;
    for (const e of list) {
      const end = e.ended_at ? new Date(e.ended_at) : isRunning(e) ? now : null;
      if (end && end > from) longest = Math.max(longest, end - Math.max(new Date(e.at), from));
    }
    const asleep = S.running.some((e) => e.kind === 'psleep' && e.data.who === who);
    return { who, total, longest, asleep };
  });
  return `
    <div class="card-box">
      <div class="card-box-head">
        <h2 class="section">🛌 Our sleep <small class="muted">last 24 h</small></h2>
        <button class="link" data-act="new" data-kind="psleep">+ log past sleep</button>
      </div>
      <div class="stats compact">${rows
        .map(
          (r) => `<div class="stat"><div class="stat-value small">${r.asleep ? '😴 asleep' : fmtDur(r.total)}</div>
            <div class="stat-label">${esc(r.who)}${!r.asleep && r.longest >= MIN ? ` · longest ${fmtDur(r.longest)}` : ''}</div></div>`
        )
        .join('')}</div>
      ${
        mine
          ? `<button class="btn primary block sun" data-act="stop-timer" data-id="${mine.id}">☀️ I woke up</button>`
          : `<button class="btn primary block night" data-act="quick-psleep">🌙 I'm going to sleep</button>`
      }
    </div>`;
}

function renderHoy() {
  const today = startOfDay(new Date());
  const st = dayStats(S.recent, today, addDays(today, 1));
  const lastFeed = S.recent.find((e) => e.kind === 'feeding');
  const lastDiaper = S.recent.find((e) => e.kind === 'diaper');
  const lastPoop = S.recent.find((e) => e.kind === 'diaper' && isPoop(e.data));
  const side = suggestedSide();
  const age = babyAge(S.settings.birthDate);
  const runningFeed = S.running.some((e) => e.kind === 'feeding');
  const runningSleep = S.running.some((e) => e.kind === 'sleep');

  // Intervalo promedio entre tomas de las últimas 24 h.
  const feeds24 = S.recent
    .filter((e) => e.kind === 'feeding' && Date.now() - new Date(e.at) < DAY)
    .map((e) => new Date(e.at).getTime())
    .sort((a, b) => a - b);
  let avgGap = null;
  if (feeds24.length >= 3) avgGap = (feeds24[feeds24.length - 1] - feeds24[0]) / (feeds24.length - 1);

  $('#view-hoy').innerHTML = `
    ${S.info.storage === 'memory' ? '<div class="banner warn">⚠️ The server has no database (PostgreSQL): anything you log will be erased when it restarts. Add PostgreSQL in Railway.</div>' : ''}
    ${age.milestone && S.settings.babyName ? `<div class="banner party">🎉 ${esc(S.settings.babyName)} is ${esc(age.text)} old today!</div>` : ''}

    <div class="hero">
      <div class="hero-main">
        <div class="hero-label">Last feeding</div>
        <div class="hero-value" ${lastFeed ? `data-ago="${lastFeed.at}"` : ''}>${lastFeed ? fmtAgo(lastFeed.at) : 'Nothing logged yet'}</div>
        <div class="hero-sub">${lastFeed ? `${fmtTime(lastFeed.at)} · ${esc(describe(lastFeed))}` : 'Tap a button below to start'}</div>
        ${avgGap ? `<div class="hero-sub">Last 24 h: every ~${fmtDur(avgGap)}</div>` : ''}
      </div>
    </div>

    <div class="quick-start">
      <button class="btn primary" data-act="quick-breast" data-side="${side}" ${runningFeed ? 'disabled' : ''}>
        ▶ ${SIDE[side]} breast
      </button>
      <button class="btn primary alt" data-act="quick-sleep" ${runningSleep ? 'disabled' : ''}>▶ Fell asleep</button>
    </div>

    <div class="actions">
      <button data-act="new" data-kind="feeding" data-preset="biberon"><span>🍼</span>Bottle</button>
      <button data-act="new" data-kind="feeding"><span>🤱</span>Feeding</button>
      <button data-act="new" data-kind="diaper"><span>🧷</span>Diaper</button>
      <button data-act="new" data-kind="sleep"><span>😴</span>Sleep</button>
      <button data-act="new" data-kind="note"><span>📷</span>Photo / note</button>
      <button data-act="new" data-kind="med"><span>💊</span>Medicine</button>
      <button data-act="new" data-kind="temp"><span>🌡️</span>Temp.</button>
      <button data-act="new" data-kind="growth"><span>📏</span>Weight / length</button>
    </div>

    ${parentsSleepCard()}

    <h2 class="section">Today</h2>
    <div class="stats">
      <div class="stat"><div class="stat-value">${st.feeds}</div><div class="stat-label">feedings${st.ml ? ` · ${fmtU('vol', st.ml)}` : ''}${Math.round(st.breastMin) ? ` · ${Math.round(st.breastMin)} min breast` : ''}</div></div>
      <div class="stat"><div class="stat-value">${st.diapers}</div><div class="stat-label">diapers · ${st.pee} 💧 ${st.poop} 💩</div></div>
      <div class="stat"><div class="stat-value">${fmtDur(st.sleepMs)}</div><div class="stat-label">of sleep</div></div>
      <div class="stat"><div class="stat-value small" ${lastPoop ? `data-ago="${lastPoop.at}"` : ''}>${lastPoop ? fmtAgo(lastPoop.at) : '—'}</div><div class="stat-label">last poop${lastDiaper && lastDiaper !== lastPoop ? ` · last diaper ${fmtTime(lastDiaper.at)}` : ''}</div></div>
    </div>

    <div class="list">
      ${st.entries.length ? st.entries.map((e) => entryCard(e)).join('') : emptyState('🌙', 'Nothing logged today yet.')}
    </div>`;
}

async function loadRunning() {
  S.running = await api('GET', '/api/entries?running=1');
  renderTimers();
}

// Últimas ~48 h: alimenta la vista Hoy y los valores sugeridos de los formularios.
async function loadRecent() {
  const from = addDays(startOfDay(new Date()), -1);
  S.recent = await api('GET', '/api/entries' + qs({ from, limit: 1000 }));
  if (S.view === 'hoy') renderHoy();
}

// ---------- Historial ----------

async function loadHistorial() {
  const from = S.hist.day;
  S.hist.entries = await api('GET', '/api/entries' + qs({ from, to: addDays(from, 1), limit: 1000 }));
  renderHistorial();
}

function renderHistorial() {
  const day = S.hist.day;
  const isToday = +day === +startOfDay(new Date());
  const st = dayStats(S.hist.entries, day, addDays(day, 1));
  const f = S.hist.filter;
  const list = S.hist.entries.filter((e) => (f === 'all' ? true : f === 'photos' ? e.photos.length : e.kind === f));
  const chips = [['all', 'All'], ...Object.entries(KIND).map(([k, v]) => [k, v.icon + ' ' + v.label]), ['photos', '🖼️ With photos']];
  $('#view-historial').innerHTML = `
    <div class="daynav">
      <button class="icon-btn" data-act="hist-day" data-delta="-1">‹</button>
      <label class="daynav-label">
        <span>${esc(cap(fmtDay(day)))}</span>
        <small>${esc(fmtDate(day, { day: 'numeric', month: 'long', year: 'numeric' }))}</small>
        <input type="date" id="hist-date" value="${ymd(day)}" max="${ymd(new Date())}" />
      </label>
      <button class="icon-btn" data-act="hist-day" data-delta="1" ${isToday ? 'disabled' : ''}>›</button>
    </div>
    <div class="stats compact">
      <div class="stat"><div class="stat-value">${st.feeds}</div><div class="stat-label">feedings${st.ml ? ` · ${fmtU('vol', st.ml)}` : ''}</div></div>
      <div class="stat"><div class="stat-value">${st.diapers}</div><div class="stat-label">${st.pee} 💧 ${st.poop} 💩</div></div>
      <div class="stat"><div class="stat-value">${fmtDur(st.sleepMs)}</div><div class="stat-label">sleep</div></div>
    </div>
    <div class="chips">${chips
      .map(([k, l]) => `<button class="chip ${f === k ? 'active' : ''}" data-act="hist-filter" data-f="${k}">${l}</button>`)
      .join('')}</div>
    <div class="list">${list.length ? list.map((e) => entryCard(e)).join('') : emptyState('📭', 'Nothing logged on this day.')}</div>`;
}

// ---------- Pediatra ----------

async function loadPediatra() {
  const [ask, growth] = await Promise.all([
    api('GET', '/api/entries?ask=1&limit=500'),
    api('GET', '/api/entries?kind=growth&limit=500'),
  ]);
  S.ped.ask = ask;
  S.ped.growth = growth;
  renderPediatra();
}

function growthChart(growth, key, unitKind) {
  const pts = growth
    .filter((g) => Number(g.data[key]))
    .map((g) => ({ t: new Date(g.at).getTime(), v: UNITS[unitKind].show(Number(g.data[key])) }))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return '';
  const W = 320;
  const H = 120;
  const P = 24;
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t || t0 + 1;
  let v0 = Math.min(...pts.map((p) => p.v));
  let v1 = Math.max(...pts.map((p) => p.v));
  if (v0 === v1) {
    v0 -= 1;
    v1 += 1;
  }
  const x = (t) => P + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - v0) / (v1 - v0)) * (H - 2 * P);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Chart">
      <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" class="axis" />
      <path d="${path}" class="line" />
      ${pts.map((p) => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3.5" class="dot" />`).join('')}
      <text x="${P}" y="${y(v1) - 6}" class="lbl">${v1} ${UNITS[unitKind].unit()}</text>
      <text x="${P}" y="${H - 6}" class="lbl">${fmtDate(t0, { day: 'numeric', month: 'short' })}</text>
      <text x="${W - P}" y="${H - 6}" class="lbl" text-anchor="end">${fmtDate(t1, { day: 'numeric', month: 'short' })}</text>
    </svg>`;
}

function renderPediatra() {
  const pending = S.ped.ask.filter((e) => !e.data.resolved);
  const resolved = S.ped.ask.filter((e) => e.data.resolved);
  const g = S.ped.growth;
  const latest = (key) => g.find((x) => Number(x.data[key]));
  const lw = latest('kg');
  const lc = latest('cm');
  const lh = latest('head');

  $('#view-pediatra').innerHTML = `
    <div class="row gap">
      <button class="btn primary grow" data-act="new" data-kind="note">＋ Question or photo</button>
      <button class="btn grow" data-act="open-report">📄 Report for the visit</button>
    </div>

    <h2 class="section">To ask (${pending.length})</h2>
    <p class="muted small">Anything marked “🩺 Ask the pediatrician” shows up here. After the visit, mark it as reviewed.</p>
    <div class="list">${pending.length ? pending.map((e) => entryCard(e, { withDay: true, bigThumbs: true })).join('') : emptyState('✅', 'Nothing pending right now.')}</div>

    <h2 class="section">Growth</h2>
    <div class="stats compact">
      <div class="stat"><div class="stat-value">${lw ? fmtU('wt', lw.data.kg) : '—'}</div><div class="stat-label">weight${lw ? ' · ' + fmtDate(lw.at, { day: 'numeric', month: 'short' }) : ''}</div></div>
      <div class="stat"><div class="stat-value">${lc ? fmtU('len', lc.data.cm) : '—'}</div><div class="stat-label">length</div></div>
      <div class="stat"><div class="stat-value">${lh ? fmtU('len', lh.data.head) : '—'}</div><div class="stat-label">head circumference</div></div>
    </div>
    ${growthChart(g, 'kg', 'wt')}
    <button class="btn block" data-act="new" data-kind="growth">＋ Log weight / length</button>
    ${g.length ? `<div class="list">${g.map((e) => entryCard(e, { withDay: true })).join('')}</div>` : ''}

    ${
      resolved.length
        ? `<h2 class="section clickable" data-act="toggle-resolved">${S.ped.showResolved ? '▾' : '▸'} Already reviewed (${resolved.length})</h2>
           ${S.ped.showResolved ? `<div class="list">${resolved.map((e) => entryCard(e, { withDay: true })).join('')}</div>` : ''}`
        : ''
    }`;
}

// ---------- Reporte para el pediatra (imprimible) ----------

async function loadReporte() {
  const to = addDays(startOfDay(new Date()), 1);
  const from = addDays(to, -S.report.days);
  const [entries, ask, growth] = await Promise.all([
    api('GET', '/api/entries' + qs({ from, to, limit: 2000 })),
    api('GET', '/api/entries?ask=1&limit=200'),
    api('GET', '/api/entries?kind=growth&limit=500'),
  ]);
  const pending = ask.filter((e) => !e.data.resolved);
  // Detalle (con comentarios) de cada pendiente.
  S.report.details = await Promise.all(pending.map((e) => api('GET', '/api/entries/' + e.id)));
  S.report.entries = entries;
  S.report.growth = growth;
  S.report.from = from;
  S.report.to = to;
  renderReporte();
}

function renderReporte() {
  const R = S.report;
  const days = [];
  for (let d = addDays(R.to, -1); d >= R.from; d = addDays(d, -1)) {
    days.push({ day: d, ...dayStats(R.entries, d, addDays(d, 1)) });
  }
  // Los promedios ignoran los días anteriores al primer registro (aún no usaban la app).
  while (days.length > 1 && !days[days.length - 1].entries.length) days.pop();
  const n = days.length || 1;
  const sum = (k) => days.reduce((s, x) => s + x[k], 0);
  const temps = R.entries.filter((e) => e.kind === 'temp');
  const meds = {};
  for (const e of R.entries.filter((x) => x.kind === 'med')) {
    const k = e.data.name || 'Medicine';
    meds[k] = (meds[k] || 0) + 1;
  }
  const solids = R.entries.filter((e) => e.kind === 'feeding' && e.data.method === 'solidos' && e.data.food);
  const age = babyAge(S.settings.birthDate).text;
  const latest = (key) => R.growth.find((x) => Number(x.data[key]));
  const lw = latest('kg');
  const lc = latest('cm');
  const lh = latest('head');

  $('#view-reporte').innerHTML = `
    <div class="row gap no-print">
      <button class="btn" data-act="back-pediatra">‹ Back</button>
      <button class="btn primary grow" data-act="print">🖨️ Print / PDF</button>
    </div>
    <select id="report-days" class="no-print">
      ${[3, 7, 14, 30].map((d) => `<option value="${d}" ${d === R.days ? 'selected' : ''}>Last ${d} days</option>`).join('')}
    </select>

    <article class="report">
      <h1>${esc(S.settings.babyName || 'Baby')}</h1>
      <p class="muted">${age ? esc(age) + ' · ' : ''}${S.settings.birthDate ? 'Born ' + esc(fmtDate(S.settings.birthDate + 'T00:00:00', { day: 'numeric', month: 'long', year: 'numeric' })) + ' · ' : ''}
        ${esc(fmtDate(R.from, { day: 'numeric', month: 'short' }))} – ${esc(fmtDate(addDays(R.to, -1), { day: 'numeric', month: 'short', year: 'numeric' }))}</p>

      <h2>Daily average</h2>
      <div class="stats compact">
        <div class="stat"><div class="stat-value">${r1(sum('feeds') / n)}</div><div class="stat-label">feedings</div></div>
        <div class="stat"><div class="stat-value">${sum('ml') ? fmtU('vol', sum('ml') / n) : '—'}</div><div class="stat-label">bottle</div></div>
        <div class="stat"><div class="stat-value">${sum('breastMin') ? Math.round(sum('breastMin') / n) + ' min' : '—'}</div><div class="stat-label">breast</div></div>
        <div class="stat"><div class="stat-value">${r1(sum('pee') / n)}</div><div class="stat-label">wet diapers</div></div>
        <div class="stat"><div class="stat-value">${r1(sum('poop') / n)}</div><div class="stat-label">poops</div></div>
        <div class="stat"><div class="stat-value">${fmtDur(sum('sleepMs') / n)}</div><div class="stat-label">sleep</div></div>
      </div>

      <h2>Day by day</h2>
      <table class="table">
        <thead><tr><th>Day</th><th>Feeds</th><th>Bottle</th><th>Breast</th><th>💧</th><th>💩</th><th>Sleep</th></tr></thead>
        <tbody>${days
          .map(
            (d) => `<tr><td>${esc(fmtDate(d.day, { weekday: 'short', day: 'numeric', month: 'short' }))}</td><td>${d.feeds}</td>
              <td>${d.ml ? fmtU('vol', d.ml) : '—'}</td><td>${Math.round(d.breastMin) ? Math.round(d.breastMin) + ' min' : '—'}</td>
              <td>${d.pee}</td><td>${d.poop}</td><td>${d.sleepMs ? fmtDur(d.sleepMs) : '—'}</td></tr>`
          )
          .join('')}</tbody>
      </table>

      <h2>Growth (latest)</h2>
      <p>${lw ? 'Weight: <b>' + fmtU('wt', lw.data.kg) + '</b> (' + fmtDate(lw.at, { day: 'numeric', month: 'short' }) + ')' : 'Weight: —'} ·
         ${lc ? 'Length: <b>' + fmtU('len', lc.data.cm) + '</b>' : 'Length: —'} ·
         ${lh ? 'Head: <b>' + fmtU('len', lh.data.head) + '</b>' : 'Head: —'}</p>
      ${growthChart(R.growth, 'kg', 'wt')}

      ${temps.length ? `<h2>Temperatures</h2><ul>${temps.map((e) => `<li class="${e.data.c >= 38 ? 'danger' : ''}">${esc(fmtDate(e.at, { day: 'numeric', month: 'short' }))} ${fmtTime(e.at)} — ${esc(describe(e))}</li>`).join('')}</ul>` : ''}
      ${Object.keys(meds).length ? `<h2>Medicines / vitamins</h2><ul>${Object.entries(meds).map(([k, v]) => `<li>${esc(k)}: ${v} ${v === 1 ? 'time' : 'times'}</li>`).join('')}</ul>` : ''}
      ${solids.length ? `<h2>Solid foods</h2><p>${esc([...new Set(solids.map((e) => e.data.food))].join(', '))}</p>` : ''}

      <h2>Questions & observations (${R.details.length})</h2>
      ${
        R.details.length
          ? R.details
              .map(
                (e) => `
        <div class="report-item">
          <div class="report-item-title">${KIND[e.kind].icon} ${esc(describe(e))} <span class="muted">— ${esc(fmtDate(e.at, { day: 'numeric', month: 'short' }))} ${fmtTime(e.at)}${e.added_by ? ' · ' + esc(e.added_by) : ''}</span></div>
          ${e.notes ? `<p>${esc(e.notes)}</p>` : ''}
          ${e.photos.length ? `<div class="report-photos">${e.photos.map((id) => `<img src="/api/photos/${id}" alt="Photo" />`).join('')}</div>` : ''}
          ${e.comments.length ? `<ul class="report-comments">${e.comments.map((c) => `<li><b>${esc(c.author || '—')}:</b> ${esc(c.text)}</li>`).join('')}</ul>` : ''}
        </div>`
              )
              .join('')
          : '<p class="muted">No pending questions.</p>'
      }
    </article>`;
}

// ---------- Gastos ----------

const money = (n) =>
  `${S.settings.currency || '$'}${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function loadGastos() {
  S.exp.list = await api('GET', '/api/expenses');
  renderGastos();
}

function renderGastos() {
  const [y, m] = S.exp.month.split('-').map(Number);
  const monthDate = new Date(y, m - 1, 1);
  const list = S.exp.list.filter((x) => x.spent_on.startsWith(S.exp.month));
  const total = list.reduce((s, x) => s + x.amount, 0);
  const all = S.exp.list.reduce((s, x) => s + x.amount, 0);
  const byCat = {};
  const byWho = {};
  for (const x of list) {
    byCat[x.category] = (byCat[x.category] || 0) + x.amount;
    const who = x.paid_by || '—';
    byWho[who] = (byWho[who] || 0) + x.amount;
  }
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const max = cats.length ? cats[0][1] : 1;
  const isThisMonth = S.exp.month === ym(new Date());
  const months = new Set(S.exp.list.map((x) => x.spent_on.slice(0, 7)));
  const avg = months.size ? all / months.size : 0;

  $('#view-gastos').innerHTML = `
    <div class="daynav">
      <button class="icon-btn" data-act="exp-month" data-delta="-1">‹</button>
      <div class="daynav-label"><span>${esc(cap(fmtDate(monthDate, { month: 'long', year: 'numeric' })))}</span></div>
      <button class="icon-btn" data-act="exp-month" data-delta="1" ${isThisMonth ? 'disabled' : ''}>›</button>
    </div>

    <div class="hero money">
      <div class="hero-main">
        <div class="hero-label">Spent this month</div>
        <div class="hero-value">${money(total)}</div>
        <div class="hero-sub">All-time total: ${money(all)}${months.size > 1 ? ` · average ${money(avg)}/month` : ''}</div>
      </div>
    </div>

    <button class="btn primary block" data-act="new-expense">＋ Add expense</button>

    ${
      cats.length
        ? `<h2 class="section">By category</h2>
      <div class="bars">${cats
        .map(
          ([c, v]) => `<div class="bar-row">
            <div class="bar-label">${CATS[c]?.[1] || '📦'} ${esc(CATS[c]?.[0] || c)}</div>
            <div class="bar"><div class="bar-fill" style="width:${Math.max(4, (v / max) * 100)}%"></div></div>
            <div class="bar-value">${money(v)}</div>
          </div>`
        )
        .join('')}</div>
      <h2 class="section">Who paid</h2>
      <div class="stats compact">${Object.entries(byWho)
        .map(([w, v]) => `<div class="stat"><div class="stat-value small">${money(v)}</div><div class="stat-label">${esc(w)}</div></div>`)
        .join('')}</div>`
        : ''
    }

    <h2 class="section">Transactions</h2>
    <div class="list">${
      list.length
        ? list
            .map(
              (x) => `<div class="entry expense" data-act="edit-expense" data-id="${x.id}">
            <div class="entry-icon">${CATS[x.category]?.[1] || '📦'}</div>
            <div class="entry-main">
              <div class="entry-title">${esc(x.description || CATS[x.category]?.[0] || 'Expense')}</div>
              <div class="entry-sub">${esc(fmtDate(x.spent_on + 'T00:00:00', { weekday: 'short', day: 'numeric', month: 'short' }))}${x.paid_by ? ' · ' + esc(x.paid_by) : ''}</div>
            </div>
            <div class="entry-amount">${money(x.amount)}</div>
          </div>`
            )
            .join('')
        : emptyState('🧾', 'No expenses this month.')
    }</div>
    ${S.exp.list.length ? '<button class="btn ghost block" data-act="export-expenses">⬇️ Export all expenses (CSV)</button>' : ''}`;
}

function exportExpenses() {
  const rows = [['Date', 'Category', 'Description', 'Amount', 'Paid by']];
  for (const x of [...S.exp.list].reverse()) {
    rows.push([x.spent_on, CATS[x.category]?.[0] || x.category, x.description || '', x.amount.toFixed(2), x.paid_by || '']);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = `ma8ko-expenses-${ymd(new Date())}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ======================= Carga / sincronización =======================

async function loadView() {
  if (S.view === 'hoy') return loadRecent();
  if (S.view === 'historial') return loadHistorial();
  if (S.view === 'pediatra') return loadPediatra();
  if (S.view === 'gastos') return loadGastos();
  if (S.view === 'reporte') return loadReporte();
}

async function loadSettings() {
  S.settings = await api('GET', '/api/settings');
  renderHeader();
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    await Promise.all([
      loadSettings(),
      loadRunning(),
      S.view === 'hoy' ? null : loadRecent(),
      S.view === 'reporte' ? null : loadView(),
    ]);
    // Si hay un detalle abierto y no estás escribiendo, también se actualiza.
    if (S.sheet === 'detail' && S.detail && !$('#comment-text')?.value) {
      try {
        renderDetail(await api('GET', '/api/entries/' + S.detail.id));
      } catch {
        closeSheet();
      }
    }
  } finally {
    refreshing = false;
  }
}

async function poll() {
  if (!S.ready || document.hidden) return;
  try {
    const { version } = await api('GET', '/api/version');
    if (version !== S.version) {
      S.version = version;
      await refresh();
    }
  } catch {}
}

// Reloj de los cronómetros y textos "hace X".
setInterval(() => {
  $$('[data-since]').forEach((el) => (el.textContent = fmtClock(Date.now() - new Date(el.dataset.since))));
  $$('[data-ago]').forEach((el) => (el.textContent = fmtAgo(el.dataset.ago)));
}, 1000);

// ======================= Hoja inferior =======================

function openSheet(kind, html) {
  S.sheet = kind;
  $('#sheet-body').innerHTML = html;
  $('#sheet').classList.remove('hidden');
  $('#sheet-backdrop').classList.remove('hidden');
  $('#sheet').scrollTop = 0;
}

function closeSheet() {
  S.sheet = null;
  S.detail = null;
  F = null;
  $('#sheet').classList.add('hidden');
  $('#sheet-backdrop').classList.add('hidden');
  $('#sheet-body').innerHTML = '';
}

// ======================= Formulario de registro =======================

let F = null; // estado del formulario abierto

function defaultsFor(kind, preset) {
  const last = (k, pred = () => true) => S.recent.find((e) => e.kind === k && pred(e));
  switch (kind) {
    case 'feeding': {
      const lf = last('feeding');
      const method = preset || (lf ? lf.data.method : 'pecho');
      const lb = last('feeding', (e) => e.data.method === 'biberon');
      return { method, side: suggestedSide(), milk: lb?.data.milk || 'formula', ml: lb?.data.ml || '' };
    }
    case 'diaper':
      return { type: 'pipi' };
    case 'temp':
      return { method: 'axilar' };
    case 'note':
      return { topic: 'otro', ask: true };
    case 'psleep':
      return { who: S.me };
    case 'med': {
      const lm = last('med');
      return lm ? { name: lm.data.name, dose: lm.data.dose } : {};
    }
    default:
      return {};
  }
}

function hasDuration(kind, data) {
  return FORMS[kind].some((f) => f.type === 'duration' && (!f.show || f.show(data)));
}

function openForm(kind, entry, preset) {
  const data = entry ? { ...entry.data } : defaultsFor(kind, preset);
  // Convierte números métricos a las unidades que se muestran.
  for (const f of FORMS[kind]) {
    if (f.type === 'num' && f.unit && data[f.key] !== undefined && data[f.key] !== '') {
      data[f.key] = UNITS[f.unit].show(Number(data[f.key]));
    }
  }
  F = {
    kind,
    entry,
    data,
    at: entry ? new Date(entry.at) : new Date(),
    running: entry ? isRunning(entry) : false,
    minutes: entry && entry.ended_at ? Math.round(durOf(entry) / MIN) : '',
    mode: entry ? 'manual' : kind === 'sleep' || (kind === 'feeding' && data.method === 'pecho') ? 'timer' : 'manual',
    notes: entry?.notes || '',
    newPhotos: [],
    saving: false,
  };
  S.sheet = 'form';
  renderForm();
}

function fieldHtml(f) {
  const d = F.data;
  if (f.type === 'seg') {
    return `<div class="field"><span>${f.label}</span><div class="seg">${f.options
      .map(([v, l]) => `<button type="button" class="${d[f.key] === v ? 'active' : ''}" data-act="seg" data-key="${f.key}" data-val="${v}">${esc(l)}</button>`)
      .join('')}</div></div>`;
  }
  if (f.type === 'color') {
    return `<div class="field"><span>${f.label}</span><div class="swatches">${POOP_COLORS.map(
      ([v, l, c]) => `<button type="button" class="swatch ${d.color === v ? 'active' : ''}" data-act="seg" data-key="color" data-val="${v}">
          <i style="background:${c}"></i>${esc(l)}</button>`
    ).join('')}</div></div>`;
  }
  if (f.type === 'num') {
    const quick = f.quick ? f.quick() : [];
    return `<label class="field"><span>${f.label} (${UNITS[f.unit].unit()})</span>
      <input type="number" inputmode="decimal" step="${f.step || 'any'}" min="0" data-k="${f.key}" value="${esc(d[f.key] ?? '')}" />
      ${quick.length ? `<div class="quick">${quick.map((q) => `<button type="button" class="chip" data-act="quick-val" data-key="${f.key}" data-val="${q}">${q}</button>`).join('')}</div>` : ''}
    </label>`;
  }
  if (f.type === 'who') {
    return `<div class="field"><span>${f.label}</span><div class="seg">${parentNames()
      .map((n) => `<button type="button" class="${d.who === n ? 'active' : ''}" data-act="seg" data-key="who" data-val="${esc(n)}">${esc(n)}</button>`)
      .join('')}</div></div>`;
  }
  if (f.type === 'text') {
    return `<label class="field"><span>${f.label}</span>
      <input data-k="${f.key}" value="${esc(d[f.key] ?? '')}" placeholder="${esc(f.placeholder || '')}" maxlength="200" ${f.list ? `list="${f.list}"` : ''} /></label>`;
  }
  if (f.type === 'duration') {
    if (F.running) {
      return `<div class="field"><span>Duration</span><div class="banner">⏱️ In progress since ${fmtTime(F.at.toISOString())}. Stop it from the bar at the top.</div></div>`;
    }
    const seg = !F.entry
      ? `<div class="seg"><button type="button" class="${F.mode === 'timer' ? 'active' : ''}" data-act="mode" data-val="timer">⏱️ Timer (starts now)</button>
         <button type="button" class="${F.mode === 'manual' ? 'active' : ''}" data-act="mode" data-val="manual">✍️ Already happened</button></div>`
      : '';
    if (F.mode === 'timer') return `<div class="field"><span>Duration</span>${seg}</div>`;
    return `<div class="field"><span>Duration</span>${seg}
      <label class="inline"><input type="number" inputmode="numeric" min="0" step="1" data-k="__minutes" value="${esc(F.minutes)}" /> minutes</label>
      <div class="quick">${f.quick.map((q) => `<button type="button" class="chip" data-act="quick-min" data-val="${q}">${q < 60 ? q + ' min' : fmtDur(q * MIN)}</button>`).join('')}</div>
    </div>`;
  }
  return '';
}

function renderForm() {
  const k = KIND[F.kind];
  const fields = FORMS[F.kind].filter((f) => !f.show || f.show(F.data));
  const timerNew = !F.entry && F.mode === 'timer' && hasDuration(F.kind, F.data);
  const warn = warningFor(F.kind, { ...F.data, c: F.kind === 'temp' && F.data.c ? UNITS.temp.parse(Number(F.data.c)) : F.data.c });
  const medNames = [...new Set(S.recent.filter((e) => e.kind === 'med').map((e) => e.data.name).filter(Boolean))];
  const existing = F.entry?.photos || [];

  $('#sheet-body').innerHTML = `
    <div class="sheet-head">
      <h2>${k.icon} ${F.entry ? 'Edit' : 'New'}: ${k.label}</h2>
      <button class="icon-btn" data-act="close-sheet" aria-label="Close">✕</button>
    </div>
    <form id="entry-form" class="form">
      ${fields.map(fieldHtml).join('')}
      ${warn ? `<div class="banner warn">${esc(warn)}</div>` : ''}
      ${
        timerNew
          ? ''
          : `<label class="field"><span>${hasDuration(F.kind, F.data) ? 'Started' : 'Date & time'}</span>
              <input type="datetime-local" data-k="__at" value="${toLocalInput(F.at)}" max="${toLocalInput(new Date(Date.now() + DAY))}" /></label>`
      }
      <label class="field"><span>Notes${F.kind === 'note' ? ' (what do you want to ask or remember?)' : ''}</span>
        <textarea data-k="__notes" rows="${F.kind === 'note' ? 4 : 2}" maxlength="4000" placeholder="Optional">${esc(F.notes)}</textarea></label>

      <div class="field"><span>Photos</span>
        <div class="thumbs edit">
          ${existing.map((id) => `<img src="/api/photos/${id}?thumb=1" alt="Photo" />`).join('')}
          ${F.newPhotos.map((p, i) => `<div class="new-photo">${p.preview ? `<img src="${p.preview}" alt="New photo" />` : '<div class="no-preview">📷</div>'}<button type="button" data-act="remove-new-photo" data-idx="${i}">✕</button></div>`).join('')}
          <button type="button" class="add-photo" data-act="pick-photos">＋<small>Photo</small></button>
        </div>
      </div>

      <label class="check"><input type="checkbox" data-k="__ask" ${F.data.ask ? 'checked' : ''} /> 🩺 Ask the pediatrician</label>

      <button class="btn primary block" type="submit" ${F.saving ? 'disabled' : ''}>
        ${F.saving ? esc(F.saving) : timerNew ? '▶ Start' : 'Save'}
      </button>
      <datalist id="med-names">${medNames.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    </form>`;
  if (!$('#sheet').classList.contains('hidden')) return;
  $('#sheet').classList.remove('hidden');
  $('#sheet-backdrop').classList.remove('hidden');
  $('#sheet').scrollTop = 0;
}

function onFormInput(el) {
  const k = el.dataset.k;
  if (!F || !k) return;
  if (k === '__at') {
    const d = new Date(el.value);
    if (!Number.isNaN(d.getTime())) F.at = d;
  } else if (k === '__notes') F.notes = el.value;
  else if (k === '__minutes') F.minutes = el.value;
  else if (k === '__ask') F.data.ask = el.checked;
  else {
    F.data[k] = el.value;
    if (F.kind === 'temp' && k === 'c') {
      // Re-render ligero solo del aviso de fiebre.
      const c = UNITS.temp.parse(Number(el.value));
      const w = warningFor('temp', { c });
      let b = $('#entry-form .banner.warn');
      if (w && !b) {
        b = document.createElement('div');
        b.className = 'banner warn';
        el.closest('.field').after(b);
      }
      if (b) w ? (b.textContent = w) : b.remove();
    }
  }
}

async function saveForm() {
  if (!F || F.saving) return;
  const kind = F.kind;
  const visible = FORMS[kind].filter((f) => !f.show || f.show(F.data));
  const data = {};
  for (const f of visible) {
    if (!f.key) continue;
    let v = F.data[f.key];
    if (f.type === 'num') {
      if (v === '' || v === undefined || v === null) continue;
      v = Number(v);
      if (!Number.isFinite(v) || v < 0) return toast(`Check “${f.label}”`, true);
      v = r2(UNITS[f.unit].parse(v));
    } else if (typeof v === 'string') {
      v = v.trim();
      if (!v) continue;
    }
    if (v !== undefined) data[f.key] = v;
  }
  // Conserva marcas especiales.
  if (F.data.ask) data.ask = true;
  if (F.data.ask && F.data.resolved) data.resolved = true;
  if (F.data.timer) data.timer = true;

  // Validaciones mínimas.
  if (kind === 'growth' && !data.kg && !data.cm && !data.head) return toast('Enter at least the weight or length', true);
  if (kind === 'med' && !data.name) return toast('Which medicine?', true);
  if (kind === 'temp' && !data.c) return toast('Enter the temperature', true);
  if (kind === 'note' && !F.notes.trim() && !F.newPhotos.length && !F.entry?.photos.length) {
    return toast('Add a photo or write a note', true);
  }

  const withDur = hasDuration(kind, data);
  const body = { data, notes: F.notes };
  if (!F.entry && withDur && F.mode === 'timer') {
    body.at = new Date().toISOString();
    body.endedAt = null;
    body.data.timer = true;
  } else {
    body.at = F.at.toISOString();
    if (!withDur) {
      body.endedAt = null;
      delete body.data.timer;
    } else if (!F.running) {
      const mins = Number(F.minutes);
      body.endedAt = mins > 0 ? new Date(F.at.getTime() + mins * MIN).toISOString() : null;
      delete body.data.timer;
    }
  }
  const doneMsg = !F.entry && body.data.timer ? '⏱️ Timer started' : '✓ Saved';

  F.saving = 'Saving…';
  renderForm();
  try {
    let entry;
    if (F.entry) entry = await api('PATCH', '/api/entries/' + F.entry.id, body);
    else entry = await api('POST', '/api/entries', { ...body, kind, addedBy: S.me });
    await uploadPhotos(entry.id, F.newPhotos, (i, n) => {
      if (F) {
        F.saving = `Uploading photo ${i}/${n}…`;
        renderForm();
      }
    });
    closeSheet();
    toast(doneMsg);
    await refresh();
  } catch (err) {
    if (F) {
      F.saving = false;
      renderForm();
    }
    fail(err);
  }
}

// ======================= Fotos =======================

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function drawScaled(img, max, quality) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

// Reduce la foto en el celular (máx. 1600 px) y crea una miniatura, para
// que suba rápido y no llene la base de datos.
async function processImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const full = drawScaled(img, 1600, 0.85);
    const thumb = drawScaled(img, 360, 0.7);
    return { mime: 'image/jpeg', data: full.split(',')[1], thumb: thumb.split(',')[1], preview: thumb };
  } catch {
    // El navegador no puede leerla (p. ej. HEIC fuera de Safari): se sube tal cual.
    if (file.size > 14 * 1024 * 1024) throw new Error('The photo is too large');
    return { mime: file.type || 'image/jpeg', data: await blobToBase64(file), thumb: null, preview: null };
  } finally {
    URL.revokeObjectURL(url);
  }
}

let onPhotosPicked = null;
function pickPhotos(cb) {
  onPhotosPicked = cb;
  const input = $('#file-input');
  input.value = '';
  input.click();
}

$('#file-input').addEventListener('change', async (ev) => {
  const files = [...ev.target.files];
  if (!files.length || !onPhotosPicked) return;
  const cb = onPhotosPicked;
  onPhotosPicked = null;
  try {
    const out = [];
    for (const f of files.slice(0, 10)) out.push(await processImage(f));
    await cb(out);
  } catch (err) {
    fail(err);
  }
});

async function uploadPhotos(entryId, photos, progress) {
  for (let i = 0; i < photos.length; i++) {
    progress?.(i + 1, photos.length);
    const p = photos[i];
    await api('POST', `/api/entries/${entryId}/photos`, { mime: p.mime, data: p.data, thumb: p.thumb, addedBy: S.me });
  }
}

function openViewer(ids, idx) {
  S.viewer = { ids, idx };
  showViewerPhoto();
  $('#viewer').classList.remove('hidden');
}
function showViewerPhoto() {
  const { ids, idx } = S.viewer;
  const src = `/api/photos/${ids[idx]}`;
  $('#viewer-img').src = src;
  $('#viewer-download').href = src;
  $('#viewer-download').setAttribute('download', `ma8ko-photo-${ids[idx]}.jpg`);
  $('#viewer-prev').classList.toggle('invisible', idx === 0);
  $('#viewer-next').classList.toggle('invisible', idx >= ids.length - 1);
}

// ======================= Detalle de un registro =======================

async function openDetail(id) {
  try {
    const e = await api('GET', '/api/entries/' + id);
    S.sheet = 'detail';
    renderDetail(e);
  } catch (err) {
    fail(err);
  }
}

function renderDetail(e) {
  S.detail = e;
  const k = KIND[e.kind];
  const d = e.data || {};
  const dur = durOf(e);
  const warn = warningFor(e.kind, d);
  const html = `
    <div class="sheet-head">
      <h2>${k.icon} ${k.label}</h2>
      <button class="icon-btn" data-act="close-sheet" aria-label="Close">✕</button>
    </div>
    <div class="detail">
      <div class="detail-title">${esc(describe(e))}</div>
      <div class="muted">${esc(fmtDay(new Date(e.at)))}, ${fmtTime(e.at)}${e.ended_at ? ' – ' + fmtTime(e.ended_at) : ''}${dur ? ' (' + fmtDur(dur) + ')' : ''}${e.added_by ? ' · by ' + esc(e.added_by) : ''}</div>
      ${isRunning(e) ? `<div class="banner">⏱️ In progress: <b data-since="${e.at}">${fmtClock(Date.now() - new Date(e.at))}</b> <button class="btn small" data-act="stop-timer" data-id="${e.id}">Stop now</button></div>` : ''}
      ${warn ? `<div class="banner warn">${esc(warn)}</div>` : ''}
      ${e.notes ? `<p class="detail-notes">${esc(e.notes)}</p>` : ''}

      ${thumbs(e.photos, true)}
      <button class="btn ghost small" data-act="detail-add-photo">📷 Add photo</button>

      <div class="row gap wrap">
        ${
          d.ask
            ? d.resolved
              ? `<button class="btn small" data-act="ask" data-v="reopen">↺ Back to pending</button>`
              : `<button class="btn small primary" data-act="ask" data-v="resolve">✓ Reviewed with the pediatrician</button>
                 <button class="btn small ghost" data-act="ask" data-v="off">Remove from pediatrician list</button>`
            : `<button class="btn small" data-act="ask" data-v="on">🩺 Ask the pediatrician</button>`
        }
      </div>

      <h3>Comments</h3>
      <div class="comments">
        ${
          e.comments.length
            ? e.comments
                .map(
                  (c) => `<div class="comment ${c.author === S.me ? 'mine' : ''}">
              <div class="comment-meta"><b>${esc(c.author || '—')}</b> · ${esc(fmtDay(new Date(c.created_at)))} ${fmtTime(c.created_at)}${
                c.author === S.me ? ` <button class="link danger" data-act="del-comment" data-id="${c.id}">delete</button>` : ''}</div><div class="comment-text">${esc(c.text)}</div></div>`
                )
                .join('')
            : '<p class="muted small">No comments yet.</p>'
        }
      </div>
      <form id="comment-form" class="row gap">
        <input id="comment-text" class="grow" placeholder="Write a comment…" maxlength="2000" autocomplete="off" />
        <button class="btn primary" type="submit">Send</button>
      </form>

      <div class="row gap sheet-foot">
        <button class="btn grow" data-act="edit-entry">✏️ Edit</button>
        <button class="btn danger grow" data-act="delete-entry">🗑️ Delete</button>
      </div>
    </div>`;
  const wasOpen = !$('#sheet').classList.contains('hidden');
  if (wasOpen && S.sheet === 'detail') $('#sheet-body').innerHTML = html;
  else openSheet('detail', html);
}

async function setAsk(v) {
  const e = S.detail;
  const data = { ...e.data };
  if (v === 'on') {
    data.ask = true;
    delete data.resolved;
  } else if (v === 'off') {
    delete data.ask;
    delete data.resolved;
  } else if (v === 'resolve') data.resolved = true;
  else if (v === 'reopen') delete data.resolved;
  renderDetail(await api('PATCH', '/api/entries/' + e.id, { data }));
  toast(v === 'resolve' ? '✓ Marked as reviewed' : '✓ Done');
  refresh();
}

// ======================= Cronómetros =======================

async function startTimer(kind, data) {
  if (!S.me) return;
  await api('POST', '/api/entries', {
    kind,
    at: new Date().toISOString(),
    endedAt: null,
    data: { ...data, timer: true },
    addedBy: S.me,
  });
  toast('⏱️ Timer started');
  await refresh();
}

async function stopTimer(id) {
  await api('PATCH', '/api/entries/' + id, { endedAt: new Date().toISOString() });
  toast('✓ Stopped');
  await refresh();
}

async function switchSide(id) {
  const e = S.running.find((x) => x.id === Number(id));
  if (!e) return;
  await api('PATCH', '/api/entries/' + id, { endedAt: new Date().toISOString() });
  await startTimer('feeding', { method: 'pecho', side: e.data.side === 'izq' ? 'der' : 'izq' });
}

// ======================= Gastos: formulario =======================

let X = null; // gasto en edición

function openExpense(x) {
  X = x
    ? { id: x.id, amount: x.amount, category: x.category, description: x.description || '', spentOn: x.spent_on, paidBy: x.paid_by || '' }
    : { amount: '', category: 'panales', description: '', spentOn: ymd(new Date()), paidBy: S.me };
  renderExpenseForm();
}

function renderExpenseForm() {
  const payers = [...new Set([S.me, ...S.exp.list.map((x) => x.paid_by)].filter(Boolean))];
  const html = `
    <div class="sheet-head">
      <h2>💰 ${X.id ? 'Edit expense' : 'New expense'}</h2>
      <button class="icon-btn" data-act="close-sheet" aria-label="Close">✕</button>
    </div>
    <form id="expense-form" class="form">
      <label class="field"><span>Amount (${esc(S.settings.currency || '$')})</span>
        <input type="number" inputmode="decimal" step="0.01" min="0" data-x="amount" value="${esc(X.amount)}" required /></label>
      <div class="field"><span>Category</span><div class="cats">${Object.entries(CATS)
        .map(([k, [l, i]]) => `<button type="button" class="chip ${X.category === k ? 'active' : ''}" data-act="exp-cat" data-val="${k}">${i} ${esc(l)}</button>`)
        .join('')}</div></div>
      <label class="field"><span>Description</span>
        <input data-x="description" maxlength="200" value="${esc(X.description)}" placeholder="e.g. Size 1 diapers (box)" /></label>
      <label class="field"><span>Date</span><input type="date" data-x="spentOn" value="${esc(X.spentOn)}" /></label>
      <label class="field"><span>Who paid?</span>
        <input data-x="paidBy" maxlength="40" value="${esc(X.paidBy)}" />
        ${payers.length > 1 ? `<div class="quick">${payers.map((p) => `<button type="button" class="chip" data-act="exp-payer" data-val="${esc(p)}">${esc(p)}</button>`).join('')}</div>` : ''}
      </label>
      <button class="btn primary block" type="submit">Save</button>
      ${X.id ? '<button type="button" class="btn danger block" data-act="delete-expense">🗑️ Delete expense</button>' : ''}
    </form>`;
  if (S.sheet === 'expense') $('#sheet-body').innerHTML = html;
  else openSheet('expense', html);
}

async function saveExpense() {
  const amount = Number(X.amount);
  if (!(amount > 0)) return toast('Enter the amount', true);
  const body = { amount, category: X.category, description: X.description, spentOn: X.spentOn, paidBy: X.paidBy };
  try {
    if (X.id) await api('PATCH', '/api/expenses/' + X.id, body);
    else await api('POST', '/api/expenses', body);
    S.exp.month = (X.spentOn || ymd(new Date())).slice(0, 7);
    closeSheet();
    toast('✓ Expense saved');
    await refresh();
  } catch (err) {
    fail(err);
  }
}

// ======================= Ajustes =======================

function openSettings() {
  const s = S.settings;
  openSheet(
    'settings',
    `
    <div class="sheet-head">
      <h2>⚙️ Settings</h2>
      <button class="icon-btn" data-act="close-sheet" aria-label="Close">✕</button>
    </div>
    <form id="settings-form" class="form">
      <label class="field"><span>Your name (on this phone)</span><input id="set-me" maxlength="40" value="${esc(S.me)}" required /></label>
      <label class="field"><span>Baby's name</span><input id="set-baby" maxlength="60" value="${esc(s.babyName || '')}" /></label>
      <label class="field"><span>Date of birth</span><input id="set-birth" type="date" value="${esc(s.birthDate || '')}" /></label>
      <div class="field"><span>Units</span>
        <div class="seg">
          <button type="button" class="${!US() ? 'active' : ''}" data-act="set-units" data-val="metric">ml · kg · cm · °C</button>
          <button type="button" class="${US() ? 'active' : ''}" data-act="set-units" data-val="us">oz · lb · in · °F</button>
        </div></div>
      <label class="field"><span>Currency symbol</span><input id="set-currency" maxlength="6" value="${esc(s.currency || '$')}" /></label>
      <button class="btn primary block" type="submit">Save</button>
    </form>
    <div class="settings-info">
      ${S.info.storage === 'memory' ? '<div class="banner warn">⚠️ The server has no database (PostgreSQL): data is erased when it restarts.</div>' : ''}
      <p class="muted small">📱 Tip: open it in Safari/Chrome and choose “Add to Home Screen” to use it like an app.</p>
      <p class="muted small">Share the link with your partner: you both see and edit the same data.</p>
      <a class="btn ghost block" href="/api/backup" download>💾 Download a backup of the data</a>
    </div>`
  );
  S.pendingUnits = s.units === 'us' ? 'us' : 'metric';
}

async function saveSettingsForm() {
  const me = $('#set-me').value.trim();
  if (!me) return toast('Enter your name', true);
  S.me = me;
  store.set('ma8ko_me', me);
  try {
    S.settings = await api('PUT', '/api/settings', {
      babyName: $('#set-baby').value,
      birthDate: $('#set-birth').value,
      currency: $('#set-currency').value,
      units: S.pendingUnits,
    });
    closeSheet();
    toast('✓ Settings saved');
    await refresh();
  } catch (err) {
    fail(err);
  }
}

// ======================= Eventos =======================

const ACTIONS = {
  'close-sheet': closeSheet,
  'open-entry': (el) => openDetail(el.dataset.id),
  'view-photo': (el, ev) => {
    ev.stopPropagation();
    openViewer(el.dataset.ids.split(',').map(Number), Number(el.dataset.idx));
  },
  new: (el) => openForm(el.dataset.kind, null, el.dataset.preset),
  'quick-breast': (el) => startTimer('feeding', { method: 'pecho', side: el.dataset.side }).catch(fail),
  'quick-sleep': () => startTimer('sleep', {}).catch(fail),
  'quick-psleep': () => startTimer('psleep', { who: S.me }).catch(fail),
  'stop-timer': (el, ev) => {
    ev.stopPropagation();
    stopTimer(el.dataset.id).catch(fail);
  },
  'switch-side': (el, ev) => {
    ev.stopPropagation();
    switchSide(el.dataset.id).catch(fail);
  },
  seg: (el) => {
    F.data[el.dataset.key] = el.dataset.val;
    if (F.kind === 'feeding' && el.dataset.key === 'method' && !F.entry) F.mode = el.dataset.val === 'pecho' ? 'timer' : 'manual';
    if (F.kind === 'diaper' && el.dataset.key === 'color' && ['rojo', 'blanco'].includes(el.dataset.val)) F.data.ask = true;
    if (F.kind === 'note' && el.dataset.key === 'topic') F.data.ask = el.dataset.val !== 'momento';
    renderForm();
  },
  mode: (el) => {
    F.mode = el.dataset.val;
    renderForm();
  },
  'quick-val': (el) => {
    F.data[el.dataset.key] = el.dataset.val;
    $(`[data-k="${el.dataset.key}"]`).value = el.dataset.val;
  },
  'quick-min': (el) => {
    F.minutes = el.dataset.val;
    $('[data-k="__minutes"]').value = el.dataset.val;
  },
  'pick-photos': () =>
    pickPhotos((list) => {
      if (!F) return;
      F.newPhotos.push(...list);
      renderForm();
    }),
  'remove-new-photo': (el) => {
    F.newPhotos.splice(Number(el.dataset.idx), 1);
    renderForm();
  },
  'detail-add-photo': () => {
    const id = S.detail.id;
    pickPhotos(async (list) => {
      toast('Uploading…');
      await uploadPhotos(id, list);
      toast('✓ Photo added');
      await refresh();
      if (S.sheet === 'detail' && S.detail?.id === id) renderDetail(await api('GET', '/api/entries/' + id));
    });
  },
  'edit-entry': () => {
    const e = S.detail;
    closeSheet();
    openForm(e.kind, e);
  },
  'delete-entry': async () => {
    if (!confirm('Delete this entry along with its photos and comments?')) return;
    try {
      await api('DELETE', '/api/entries/' + S.detail.id);
      closeSheet();
      toast('Deleted');
      await refresh();
    } catch (err) {
      fail(err);
    }
  },
  ask: (el) => setAsk(el.dataset.v).catch(fail),
  'del-comment': async (el) => {
    if (!confirm('Delete this comment?')) return;
    try {
      await api('DELETE', '/api/comments/' + el.dataset.id);
      renderDetail(await api('GET', '/api/entries/' + S.detail.id));
      refresh();
    } catch (err) {
      fail(err);
    }
  },
  'hist-day': (el) => {
    const next = addDays(S.hist.day, Number(el.dataset.delta));
    if (next > new Date()) return;
    S.hist.day = next;
    loadHistorial().catch(fail);
  },
  'hist-filter': (el) => {
    S.hist.filter = el.dataset.f;
    renderHistorial();
  },
  'toggle-resolved': () => {
    S.ped.showResolved = !S.ped.showResolved;
    renderPediatra();
  },
  'open-report': () => setView('reporte'),
  'back-pediatra': () => setView('pediatra'),
  print: () => window.print(),
  'exp-month': (el) => {
    const [y, m] = S.exp.month.split('-').map(Number);
    S.exp.month = ym(new Date(y, m - 1 + Number(el.dataset.delta), 1));
    renderGastos();
  },
  'new-expense': () => openExpense(null),
  'edit-expense': (el) => openExpense(S.exp.list.find((x) => x.id === Number(el.dataset.id))),
  'exp-cat': (el) => {
    X.category = el.dataset.val;
    $$('#expense-form .cats .chip').forEach((c) => c.classList.toggle('active', c === el));
  },
  'exp-payer': (el) => {
    X.paidBy = el.dataset.val;
    $('[data-x="paidBy"]').value = el.dataset.val;
  },
  'delete-expense': async () => {
    if (!confirm('Delete this expense?')) return;
    try {
      await api('DELETE', '/api/expenses/' + X.id);
      closeSheet();
      toast('Deleted');
      await refresh();
    } catch (err) {
      fail(err);
    }
  },
  'export-expenses': exportExpenses,
  'set-units': (el) => {
    S.pendingUnits = el.dataset.val;
    $$('[data-act="set-units"]').forEach((b) => b.classList.toggle('active', b === el));
  },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) {
    ev.preventDefault();
    fn(el, ev);
  }
});

document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.dataset.k) onFormInput(el);
  if (el.dataset.x && X) X[el.dataset.x] = el.value;
});
document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset.k) onFormInput(el);
  if (el.id === 'hist-date' && el.value) {
    S.hist.day = startOfDay(new Date(el.value + 'T00:00:00'));
    loadHistorial().catch(fail);
  }
  if (el.id === 'report-days') {
    S.report.days = Number(el.value);
    loadReporte().catch(fail);
  }
});

document.addEventListener('submit', async (ev) => {
  const form = ev.target;
  ev.preventDefault();
  if (form.id === 'entry-form') return saveForm();
  if (form.id === 'expense-form') return saveExpense();
  if (form.id === 'settings-form') return saveSettingsForm();
  if (form.id === 'comment-form') {
    const input = $('#comment-text');
    const text = input.value.trim();
    if (!text) return;
    try {
      await api('POST', `/api/entries/${S.detail.id}/comments`, { text, author: S.me });
      input.value = '';
      renderDetail(await api('GET', '/api/entries/' + S.detail.id));
      refresh();
    } catch (err) {
      fail(err);
    }
  }
});

$('#sheet-backdrop').addEventListener('click', closeSheet);
$('#btn-settings').addEventListener('click', openSettings);
$$('.tabbar button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

$('#viewer-close').addEventListener('click', () => $('#viewer').classList.add('hidden'));
$('#viewer-img').addEventListener('click', () => $('#viewer').classList.add('hidden'));
$('#viewer-prev').addEventListener('click', () => {
  if (S.viewer.idx > 0) {
    S.viewer.idx--;
    showViewerPhoto();
  }
});
$('#viewer-next').addEventListener('click', () => {
  if (S.viewer.idx < S.viewer.ids.length - 1) {
    S.viewer.idx++;
    showViewerPhoto();
  }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (!$('#viewer').classList.contains('hidden')) $('#viewer').classList.add('hidden');
    else if (S.sheet) closeSheet();
  }
});

// ---------- Bienvenida ----------

$('#welcome-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  const me = $('#welcome-me').value.trim();
  if (!me) return;
  S.me = me;
  store.set('ma8ko_me', me);
  const babyName = $('#welcome-baby-name').value.trim();
  const birthDate = $('#welcome-baby-birth').value;
  try {
    if (!S.settings.babyName && (babyName || birthDate)) {
      S.settings = await api('PUT', '/api/settings', { babyName, birthDate });
    }
    enterApp();
  } catch (e) {
    fail(e);
  }
});

function enterApp() {
  showScreen('app');
  S.ready = true;
  renderHeader();
  setView(S.view);
  loadRunning().catch(fail);
  if (S.view !== 'hoy') loadRecent().catch(() => {});
  api('GET', '/api/version').then((v) => (S.version = v.version)).catch(() => {});
}

async function start() {
  try {
    S.info = await api('GET', '/api/info');
    S.settings = await api('GET', '/api/settings');
    if (!S.me) {
      $('#welcome-baby').classList.toggle('hidden', Boolean(S.settings.babyName));
      showScreen('welcome');
      setTimeout(() => $('#welcome-me').focus(), 50);
      return;
    }
    enterApp();
  } catch (err) {
    fail(err);
  }
}

setInterval(poll, 4000);
document.addEventListener('visibilitychange', poll);
start();
