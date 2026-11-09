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

const fmtTime = (iso) => new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const fmtDate = (d, opts = { weekday: 'long', day: 'numeric', month: 'short' }) =>
  new Date(d).toLocaleDateString('es', opts);

function fmtDay(d) {
  const diff = Math.round((startOfDay(new Date()) - startOfDay(d)) / DAY);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
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
  if (ms < MIN) return 'justo ahora';
  return 'hace ' + fmtDur(ms);
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
  feeding: { label: 'Toma', icon: '🍼' },
  diaper: { label: 'Pañal', icon: '🧷' },
  sleep: { label: 'Sueño', icon: '😴' },
  growth: { label: 'Crecimiento', icon: '📏' },
  med: { label: 'Medicina', icon: '💊' },
  temp: { label: 'Temperatura', icon: '🌡️' },
  note: { label: 'Nota / foto', icon: '📷' },
};

const SIDE = { izq: 'izquierdo', der: 'derecho', ambos: 'ambos lados' };
const MILK = { materna: 'leche materna', formula: 'fórmula' };
const DIAPER = { pipi: 'Pipí', popo: 'Popó', ambos: 'Pipí y popó', seco: 'Seco' };
const POOP_COLORS = [
  ['amarillo', 'Amarillo', '#e6b800'],
  ['verde', 'Verde', '#6b8e23'],
  ['cafe', 'Café', '#8b5a2b'],
  ['negro', 'Negro', '#222222'],
  ['rojo', 'Rojo / sangre', '#c0392b'],
  ['blanco', 'Blanco / gris', '#cfcfcf'],
];
const TEXTURE = { liquida: 'líquida', blanda: 'blanda', pastosa: 'pastosa', dura: 'dura' };
const TOPIC = {
  popo: 'Popó',
  piel: 'Piel / sarpullido',
  vomito: 'Vómito / regurgitación',
  respira: 'Respiración / tos',
  ojos: 'Ojos / oídos',
  momento: 'Momento especial',
  otro: 'Otro',
};
const TEMP_METHOD = { axilar: 'axilar', rectal: 'rectal', oido: 'oído', frente: 'frente' };

const CATS = {
  panales: ['Pañales e higiene', '🧻'],
  leche: ['Leche / fórmula', '🍼'],
  comida: ['Comida', '🥣'],
  ropa: ['Ropa', '👕'],
  salud: ['Médico / farmacia', '💊'],
  equipo: ['Equipo (carriola, cuna…)', '🛏️'],
  juguetes: ['Juguetes y libros', '🧸'],
  cuidado: ['Guardería / niñera', '🧑‍🍼'],
  otros: ['Otros', '📦'],
};

const opts = (obj) => Object.entries(obj).map(([k, v]) => [k, v[0].toUpperCase() + v.slice(1)]);
const isPoop = (d) => d.type === 'popo' || d.type === 'ambos';

// Campos de cada formulario. `show` decide si el campo aplica según los datos.
const FORMS = {
  feeding: [
    { key: 'method', type: 'seg', label: 'Tipo', options: [['pecho', 'Pecho'], ['biberon', 'Biberón'], ['solidos', 'Sólidos']] },
    { key: 'side', type: 'seg', label: 'Lado', options: [['izq', 'Izquierdo'], ['der', 'Derecho'], ['ambos', 'Ambos']], show: (d) => d.method === 'pecho' },
    { key: 'milk', type: 'seg', label: 'Leche', options: [['materna', 'Materna'], ['formula', 'Fórmula']], show: (d) => d.method === 'biberon' },
    { key: 'ml', type: 'num', label: 'Cantidad', unit: 'vol', show: (d) => d.method === 'biberon', quick: () => (US() ? [1, 2, 3, 4, 5, 6] : [30, 60, 90, 120, 150, 180]) },
    { key: 'food', type: 'text', label: '¿Qué comió?', placeholder: 'Ej. puré de zanahoria', show: (d) => d.method === 'solidos' },
    { type: 'duration', show: (d) => d.method === 'pecho', quick: [5, 10, 15, 20, 30] },
  ],
  diaper: [
    { key: 'type', type: 'seg', label: 'Tipo', options: Object.entries(DIAPER) },
    { key: 'color', type: 'color', label: 'Color', show: isPoop },
    { key: 'texture', type: 'seg', label: 'Consistencia', options: opts(TEXTURE), show: isPoop },
  ],
  sleep: [{ type: 'duration', quick: [30, 60, 90, 120, 180] }],
  growth: [
    { key: 'kg', type: 'num', label: 'Peso', unit: 'wt', step: '0.01' },
    { key: 'cm', type: 'num', label: 'Talla', unit: 'len', step: '0.1' },
    { key: 'head', type: 'num', label: 'Perímetro cefálico', unit: 'len', step: '0.1' },
  ],
  med: [
    { key: 'name', type: 'text', label: 'Medicina / vitamina', placeholder: 'Ej. Vitamina D', list: 'med-names' },
    { key: 'dose', type: 'text', label: 'Dosis', placeholder: 'Ej. 1 gota, 2.5 ml' },
  ],
  temp: [
    { key: 'c', type: 'num', label: 'Temperatura', unit: 'temp', step: '0.1' },
    { key: 'method', type: 'seg', label: 'Cómo se midió', options: opts(TEMP_METHOD) },
  ],
  note: [{ key: 'topic', type: 'seg', label: 'Tema', options: Object.entries(TOPIC) }],
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
  if (!res.ok) throw new Error(data.error || 'Algo salió mal');
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
        const side = SIDE[d.side] ? ' ' + SIDE[d.side] : '';
        if (isRunning(e)) return `Pecho${side} (en curso)`;
        return `Pecho${side}${dur ? ' · ' + fmtDur(dur) : ''}`;
      }
      if (d.method === 'biberon') {
        return `Biberón${MILK[d.milk] ? ' de ' + MILK[d.milk] : ''}${d.ml ? ' · ' + fmtU('vol', d.ml) : ''}`;
      }
      return `Sólidos${d.food ? ': ' + d.food : ''}`;
    case 'diaper': {
      let s = DIAPER[d.type] || 'Pañal';
      if (isPoop(d)) {
        const c = POOP_COLORS.find((x) => x[0] === d.color);
        const parts = [c && c[1].toLowerCase(), TEXTURE[d.texture]].filter(Boolean);
        if (parts.length) s += ' · ' + parts.join(', ');
      }
      return s;
    }
    case 'sleep':
      if (isRunning(e)) return 'Durmiendo…';
      return dur ? `Durmió ${fmtDur(dur)}` : 'Sueño';
    case 'growth': {
      const p = [];
      if (d.kg) p.push(fmtU('wt', d.kg));
      if (d.cm) p.push('talla ' + fmtU('len', d.cm));
      if (d.head) p.push('PC ' + fmtU('len', d.head));
      return p.join(' · ') || 'Crecimiento';
    }
    case 'med':
      return `${d.name || 'Medicina'}${d.dose ? ' · ' + d.dose : ''}`;
    case 'temp':
      return `${d.c ? fmtU('temp', d.c) : '—'}${TEMP_METHOD[d.method] ? ' (' + TEMP_METHOD[d.method] + ')' : ''}${d.c >= 38 ? ' · fiebre' : ''}`;
    case 'note':
      return TOPIC[d.topic] || 'Nota';
    default:
      return e.kind;
  }
}

function warningFor(kind, d) {
  if (kind === 'diaper' && isPoop(d)) {
    if (d.color === 'rojo' || d.color === 'blanco')
      return '⚠️ Popó con sangre o blanca/gris: conviene consultarlo con el pediatra.';
    if (d.color === 'negro')
      return 'Negro es normal los primeros días (meconio). Después, coméntalo con el pediatra.';
  }
  if (kind === 'temp' && d.c >= 38) {
    return '⚠️ 38 °C (100.4 °F) o más es fiebre. En bebés menores de 3 meses, llama al pediatra de inmediato.';
  }
  return '';
}

function babyAge(birth) {
  if (!birth) return { text: '', milestone: false };
  const b = new Date(birth + 'T00:00:00');
  const t = startOfDay(new Date());
  const days = Math.round((t - b) / DAY);
  if (Number.isNaN(days) || days < 0) return { text: '', milestone: false };
  if (days === 0) return { text: '¡Nació hoy!', milestone: true };
  const pl = (n, s, p) => `${n} ${n === 1 ? s : p}`;
  if (days < 14) return { text: pl(days, 'día', 'días'), milestone: days === 7 };
  if (days < 84) {
    const w = Math.floor(days / 7);
    const d = days % 7;
    return { text: pl(w, 'semana', 'semanas') + (d ? ' y ' + pl(d, 'día', 'días') : ''), milestone: d === 0 };
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
    return { text: pl(y, 'año', 'años') + (m % 12 ? ' y ' + pl(m % 12, 'mes', 'meses') : ''), milestone: d === 0 && m % 12 === 0 };
  }
  return { text: pl(m, 'mes', 'meses') + (d ? ' y ' + pl(d, 'día', 'días') : ''), milestone: d === 0 };
}

// ======================= Componentes =======================

function thumbs(ids, big) {
  if (!ids || !ids.length) return '';
  return `<div class="thumbs ${big ? 'big' : ''}">${ids
    .map((id, i) => `<img src="/api/photos/${id}?thumb=1" loading="lazy" alt="Foto" data-act="view-photo" data-ids="${ids.join(',')}" data-idx="${i}" />`)
    .join('')}</div>`;
}

function entryCard(e, opts = {}) {
  const k = KIND[e.kind] || { icon: '•', label: e.kind };
  const d = e.data || {};
  const meta = [];
  meta.push(opts.withDay ? `${fmtDay(new Date(e.at))}, ${fmtTime(e.at)}` : fmtTime(e.at));
  if (e.added_by) meta.push(esc(e.added_by));
  if (e.comment_count) meta.push(`💬 ${e.comment_count}`);
  if (d.ask && !d.resolved) meta.push('<span class="pill ask">🩺 Pediatra</span>');
  if (d.ask && d.resolved) meta.push('<span class="pill ok">✓ Revisado</span>');
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
      const label = isFeed ? `Pecho ${SIDE[e.data.side] || ''}` : 'Durmiendo';
      return `
      <div class="timer k-${e.kind}">
        <span class="timer-icon">${KIND[e.kind].icon}</span>
        <div class="timer-main" data-act="open-entry" data-id="${e.id}">
          <div class="timer-label">${esc(label)}</div>
          <div class="timer-clock" data-since="${e.at}">${fmtClock(Date.now() - new Date(e.at))}</div>
        </div>
        ${isFeed && e.data.side !== 'ambos' ? `<button class="btn small ghost light" data-act="switch-side" data-id="${e.id}">Cambiar lado</button>` : ''}
        <button class="btn small light" data-act="stop-timer" data-id="${e.id}">${isFeed ? 'Terminar' : 'Despertó'}</button>
      </div>`;
    })
    .join('');
}

// ---------- Hoy ----------

function sleepMsInRange(entries, from, to) {
  let total = 0;
  for (const e of entries) {
    if (e.kind !== 'sleep') continue;
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
    ${S.info.storage === 'memory' ? '<div class="banner warn">⚠️ El servidor no tiene base de datos (PostgreSQL): lo que registren se borrará al reiniciar. Agreguen PostgreSQL en Railway.</div>' : ''}
    ${age.milestone && S.settings.babyName ? `<div class="banner party">🎉 ¡Hoy ${esc(S.settings.babyName)} cumple ${esc(age.text)}!</div>` : ''}

    <div class="hero">
      <div class="hero-main">
        <div class="hero-label">Última toma</div>
        <div class="hero-value" ${lastFeed ? `data-ago="${lastFeed.at}"` : ''}>${lastFeed ? fmtAgo(lastFeed.at) : 'Sin registros'}</div>
        <div class="hero-sub">${lastFeed ? `${fmtTime(lastFeed.at)} · ${esc(describe(lastFeed))}` : 'Toca un botón abajo para empezar'}</div>
        ${avgGap ? `<div class="hero-sub">Últimas 24 h: cada ~${fmtDur(avgGap)}</div>` : ''}
      </div>
    </div>

    <div class="quick-start">
      <button class="btn primary" data-act="quick-breast" data-side="${side}" ${runningFeed ? 'disabled' : ''}>
        ▶ Pecho ${SIDE[side]}
      </button>
      <button class="btn primary alt" data-act="quick-sleep" ${runningSleep ? 'disabled' : ''}>▶ Se durmió</button>
    </div>

    <div class="actions">
      <button data-act="new" data-kind="feeding" data-preset="biberon"><span>🍼</span>Biberón</button>
      <button data-act="new" data-kind="feeding"><span>🤱</span>Toma</button>
      <button data-act="new" data-kind="diaper"><span>🧷</span>Pañal</button>
      <button data-act="new" data-kind="sleep"><span>😴</span>Sueño</button>
      <button data-act="new" data-kind="note"><span>📷</span>Foto / nota</button>
      <button data-act="new" data-kind="med"><span>💊</span>Medicina</button>
      <button data-act="new" data-kind="temp"><span>🌡️</span>Temp.</button>
      <button data-act="new" data-kind="growth"><span>📏</span>Peso / talla</button>
    </div>

    <h2 class="section">Hoy</h2>
    <div class="stats">
      <div class="stat"><div class="stat-value">${st.feeds}</div><div class="stat-label">tomas${st.ml ? ` · ${fmtU('vol', st.ml)}` : ''}${Math.round(st.breastMin) ? ` · ${Math.round(st.breastMin)} min pecho` : ''}</div></div>
      <div class="stat"><div class="stat-value">${st.diapers}</div><div class="stat-label">pañales · ${st.pee} 💧 ${st.poop} 💩</div></div>
      <div class="stat"><div class="stat-value">${fmtDur(st.sleepMs)}</div><div class="stat-label">de sueño</div></div>
      <div class="stat"><div class="stat-value small" ${lastPoop ? `data-ago="${lastPoop.at}"` : ''}>${lastPoop ? fmtAgo(lastPoop.at) : '—'}</div><div class="stat-label">última popó${lastDiaper && lastDiaper !== lastPoop ? ` · último pañal ${fmtTime(lastDiaper.at)}` : ''}</div></div>
    </div>

    <div class="list">
      ${st.entries.length ? st.entries.map((e) => entryCard(e)).join('') : emptyState('🌙', 'Todavía no hay nada registrado hoy.')}
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
  const chips = [['all', 'Todo'], ...Object.entries(KIND).map(([k, v]) => [k, v.icon + ' ' + v.label]), ['photos', '🖼️ Con fotos']];
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
      <div class="stat"><div class="stat-value">${st.feeds}</div><div class="stat-label">tomas${st.ml ? ` · ${fmtU('vol', st.ml)}` : ''}</div></div>
      <div class="stat"><div class="stat-value">${st.diapers}</div><div class="stat-label">${st.pee} 💧 ${st.poop} 💩</div></div>
      <div class="stat"><div class="stat-value">${fmtDur(st.sleepMs)}</div><div class="stat-label">sueño</div></div>
    </div>
    <div class="chips">${chips
      .map(([k, l]) => `<button class="chip ${f === k ? 'active' : ''}" data-act="hist-filter" data-f="${k}">${l}</button>`)
      .join('')}</div>
    <div class="list">${list.length ? list.map((e) => entryCard(e)).join('') : emptyState('📭', 'No hay registros para este día.')}</div>`;
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
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfica">
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
      <button class="btn primary grow" data-act="new" data-kind="note">＋ Pregunta o foto</button>
      <button class="btn grow" data-act="open-report">📄 Reporte para la cita</button>
    </div>

    <h2 class="section">Para preguntar (${pending.length})</h2>
    <p class="muted small">Cualquier registro marcado con “🩺 Preguntar al pediatra” aparece aquí. Al terminar la cita, márquenlo como revisado.</p>
    <div class="list">${pending.length ? pending.map((e) => entryCard(e, { withDay: true, bigThumbs: true })).join('') : emptyState('✅', 'Nada pendiente por ahora.')}</div>

    <h2 class="section">Crecimiento</h2>
    <div class="stats compact">
      <div class="stat"><div class="stat-value">${lw ? fmtU('wt', lw.data.kg) : '—'}</div><div class="stat-label">peso${lw ? ' · ' + fmtDate(lw.at, { day: 'numeric', month: 'short' }) : ''}</div></div>
      <div class="stat"><div class="stat-value">${lc ? fmtU('len', lc.data.cm) : '—'}</div><div class="stat-label">talla</div></div>
      <div class="stat"><div class="stat-value">${lh ? fmtU('len', lh.data.head) : '—'}</div><div class="stat-label">perímetro cefálico</div></div>
    </div>
    ${growthChart(g, 'kg', 'wt')}
    <button class="btn block" data-act="new" data-kind="growth">＋ Registrar peso / talla</button>
    ${g.length ? `<div class="list">${g.map((e) => entryCard(e, { withDay: true })).join('')}</div>` : ''}

    ${
      resolved.length
        ? `<h2 class="section clickable" data-act="toggle-resolved">${S.ped.showResolved ? '▾' : '▸'} Ya revisadas (${resolved.length})</h2>
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
    const k = e.data.name || 'Medicina';
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
      <button class="btn" data-act="back-pediatra">‹ Volver</button>
      <button class="btn primary grow" data-act="print">🖨️ Imprimir / PDF</button>
    </div>
    <select id="report-days" class="no-print">
      ${[3, 7, 14, 30].map((d) => `<option value="${d}" ${d === R.days ? 'selected' : ''}>Últimos ${d} días</option>`).join('')}
    </select>

    <article class="report">
      <h1>${esc(S.settings.babyName || 'Bebé')}</h1>
      <p class="muted">${age ? esc(age) + ' · ' : ''}${S.settings.birthDate ? 'Nació el ' + esc(fmtDate(S.settings.birthDate + 'T00:00:00', { day: 'numeric', month: 'long', year: 'numeric' })) + ' · ' : ''}
        Del ${esc(fmtDate(R.from, { day: 'numeric', month: 'short' }))} al ${esc(fmtDate(addDays(R.to, -1), { day: 'numeric', month: 'short', year: 'numeric' }))}</p>

      <h2>Promedio por día</h2>
      <div class="stats compact">
        <div class="stat"><div class="stat-value">${r1(sum('feeds') / n)}</div><div class="stat-label">tomas</div></div>
        <div class="stat"><div class="stat-value">${sum('ml') ? fmtU('vol', sum('ml') / n) : '—'}</div><div class="stat-label">biberón</div></div>
        <div class="stat"><div class="stat-value">${sum('breastMin') ? Math.round(sum('breastMin') / n) + ' min' : '—'}</div><div class="stat-label">pecho</div></div>
        <div class="stat"><div class="stat-value">${r1(sum('pee') / n)}</div><div class="stat-label">pañales con pipí</div></div>
        <div class="stat"><div class="stat-value">${r1(sum('poop') / n)}</div><div class="stat-label">popós</div></div>
        <div class="stat"><div class="stat-value">${fmtDur(sum('sleepMs') / n)}</div><div class="stat-label">sueño</div></div>
      </div>

      <h2>Día por día</h2>
      <table class="table">
        <thead><tr><th>Día</th><th>Tomas</th><th>Biberón</th><th>Pecho</th><th>💧</th><th>💩</th><th>Sueño</th></tr></thead>
        <tbody>${days
          .map(
            (d) => `<tr><td>${esc(fmtDate(d.day, { weekday: 'short', day: 'numeric', month: 'short' }))}</td><td>${d.feeds}</td>
              <td>${d.ml ? fmtU('vol', d.ml) : '—'}</td><td>${Math.round(d.breastMin) ? Math.round(d.breastMin) + ' min' : '—'}</td>
              <td>${d.pee}</td><td>${d.poop}</td><td>${d.sleepMs ? fmtDur(d.sleepMs) : '—'}</td></tr>`
          )
          .join('')}</tbody>
      </table>

      <h2>Crecimiento (último registro)</h2>
      <p>${lw ? 'Peso: <b>' + fmtU('wt', lw.data.kg) + '</b> (' + fmtDate(lw.at, { day: 'numeric', month: 'short' }) + ')' : 'Peso: —'} ·
         ${lc ? 'Talla: <b>' + fmtU('len', lc.data.cm) + '</b>' : 'Talla: —'} ·
         ${lh ? 'PC: <b>' + fmtU('len', lh.data.head) + '</b>' : 'PC: —'}</p>
      ${growthChart(R.growth, 'kg', 'wt')}

      ${temps.length ? `<h2>Temperaturas</h2><ul>${temps.map((e) => `<li class="${e.data.c >= 38 ? 'danger' : ''}">${esc(fmtDate(e.at, { day: 'numeric', month: 'short' }))} ${fmtTime(e.at)} — ${esc(describe(e))}</li>`).join('')}</ul>` : ''}
      ${Object.keys(meds).length ? `<h2>Medicinas / vitaminas</h2><ul>${Object.entries(meds).map(([k, v]) => `<li>${esc(k)}: ${v} ${v === 1 ? 'vez' : 'veces'}</li>`).join('')}</ul>` : ''}
      ${solids.length ? `<h2>Alimentos sólidos</h2><p>${esc([...new Set(solids.map((e) => e.data.food))].join(', '))}</p>` : ''}

      <h2>Preguntas y observaciones (${R.details.length})</h2>
      ${
        R.details.length
          ? R.details
              .map(
                (e) => `
        <div class="report-item">
          <div class="report-item-title">${KIND[e.kind].icon} ${esc(describe(e))} <span class="muted">— ${esc(fmtDate(e.at, { day: 'numeric', month: 'short' }))} ${fmtTime(e.at)}${e.added_by ? ' · ' + esc(e.added_by) : ''}</span></div>
          ${e.notes ? `<p>${esc(e.notes)}</p>` : ''}
          ${e.photos.length ? `<div class="report-photos">${e.photos.map((id) => `<img src="/api/photos/${id}" alt="Foto" />`).join('')}</div>` : ''}
          ${e.comments.length ? `<ul class="report-comments">${e.comments.map((c) => `<li><b>${esc(c.author || '—')}:</b> ${esc(c.text)}</li>`).join('')}</ul>` : ''}
        </div>`
              )
              .join('')
          : '<p class="muted">Sin preguntas pendientes.</p>'
      }
    </article>`;
}

// ---------- Gastos ----------

const money = (n) =>
  `${S.settings.currency || '$'}${Number(n).toLocaleString('es', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
        <div class="hero-label">Gastado este mes</div>
        <div class="hero-value">${money(total)}</div>
        <div class="hero-sub">Total desde el inicio: ${money(all)}${months.size > 1 ? ` · promedio ${money(avg)}/mes` : ''}</div>
      </div>
    </div>

    <button class="btn primary block" data-act="new-expense">＋ Agregar gasto</button>

    ${
      cats.length
        ? `<h2 class="section">Por categoría</h2>
      <div class="bars">${cats
        .map(
          ([c, v]) => `<div class="bar-row">
            <div class="bar-label">${CATS[c]?.[1] || '📦'} ${esc(CATS[c]?.[0] || c)}</div>
            <div class="bar"><div class="bar-fill" style="width:${Math.max(4, (v / max) * 100)}%"></div></div>
            <div class="bar-value">${money(v)}</div>
          </div>`
        )
        .join('')}</div>
      <h2 class="section">Quién pagó</h2>
      <div class="stats compact">${Object.entries(byWho)
        .map(([w, v]) => `<div class="stat"><div class="stat-value small">${money(v)}</div><div class="stat-label">${esc(w)}</div></div>`)
        .join('')}</div>`
        : ''
    }

    <h2 class="section">Movimientos</h2>
    <div class="list">${
      list.length
        ? list
            .map(
              (x) => `<div class="entry expense" data-act="edit-expense" data-id="${x.id}">
            <div class="entry-icon">${CATS[x.category]?.[1] || '📦'}</div>
            <div class="entry-main">
              <div class="entry-title">${esc(x.description || CATS[x.category]?.[0] || 'Gasto')}</div>
              <div class="entry-sub">${esc(fmtDate(x.spent_on + 'T00:00:00', { weekday: 'short', day: 'numeric', month: 'short' }))}${x.paid_by ? ' · ' + esc(x.paid_by) : ''}</div>
            </div>
            <div class="entry-amount">${money(x.amount)}</div>
          </div>`
            )
            .join('')
        : emptyState('🧾', 'Sin gastos este mes.')
    }</div>
    ${S.exp.list.length ? '<button class="btn ghost block" data-act="export-expenses">⬇️ Exportar todos los gastos (CSV)</button>' : ''}`;
}

function exportExpenses() {
  const rows = [['Fecha', 'Categoría', 'Descripción', 'Monto', 'Pagó']];
  for (const x of [...S.exp.list].reverse()) {
    rows.push([x.spent_on, CATS[x.category]?.[0] || x.category, x.description || '', x.amount.toFixed(2), x.paid_by || '']);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = `gastos-ma8ko-${ymd(new Date())}.csv`;
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
  if (f.type === 'text') {
    return `<label class="field"><span>${f.label}</span>
      <input data-k="${f.key}" value="${esc(d[f.key] ?? '')}" placeholder="${esc(f.placeholder || '')}" maxlength="200" ${f.list ? `list="${f.list}"` : ''} /></label>`;
  }
  if (f.type === 'duration') {
    if (F.running) {
      return `<div class="field"><span>Duración</span><div class="banner">⏱️ En curso desde las ${fmtTime(F.at.toISOString())}. Termínalo desde la barra de arriba.</div></div>`;
    }
    const seg = !F.entry
      ? `<div class="seg"><button type="button" class="${F.mode === 'timer' ? 'active' : ''}" data-act="mode" data-val="timer">⏱️ Cronómetro (empieza ya)</button>
         <button type="button" class="${F.mode === 'manual' ? 'active' : ''}" data-act="mode" data-val="manual">✍️ Ya pasó</button></div>`
      : '';
    if (F.mode === 'timer') return `<div class="field"><span>Duración</span>${seg}</div>`;
    return `<div class="field"><span>Duración</span>${seg}
      <label class="inline"><input type="number" inputmode="numeric" min="0" step="1" data-k="__minutes" value="${esc(F.minutes)}" /> minutos</label>
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
      <h2>${k.icon} ${F.entry ? 'Editar' : 'Nuevo'}: ${k.label}</h2>
      <button class="icon-btn" data-act="close-sheet" aria-label="Cerrar">✕</button>
    </div>
    <form id="entry-form" class="form">
      ${fields.map(fieldHtml).join('')}
      ${warn ? `<div class="banner warn">${esc(warn)}</div>` : ''}
      ${
        timerNew
          ? ''
          : `<label class="field"><span>${hasDuration(F.kind, F.data) ? 'Empezó' : 'Fecha y hora'}</span>
              <input type="datetime-local" data-k="__at" value="${toLocalInput(F.at)}" max="${toLocalInput(new Date(Date.now() + DAY))}" /></label>`
      }
      <label class="field"><span>Notas${F.kind === 'note' ? ' (¿qué quieres preguntar o recordar?)' : ''}</span>
        <textarea data-k="__notes" rows="${F.kind === 'note' ? 4 : 2}" maxlength="4000" placeholder="Opcional">${esc(F.notes)}</textarea></label>

      <div class="field"><span>Fotos</span>
        <div class="thumbs edit">
          ${existing.map((id) => `<img src="/api/photos/${id}?thumb=1" alt="Foto" />`).join('')}
          ${F.newPhotos.map((p, i) => `<div class="new-photo">${p.preview ? `<img src="${p.preview}" alt="Nueva foto" />` : '<div class="no-preview">📷</div>'}<button type="button" data-act="remove-new-photo" data-idx="${i}">✕</button></div>`).join('')}
          <button type="button" class="add-photo" data-act="pick-photos">＋<small>Foto</small></button>
        </div>
      </div>

      <label class="check"><input type="checkbox" data-k="__ask" ${F.data.ask ? 'checked' : ''} /> 🩺 Preguntar al pediatra</label>

      <button class="btn primary block" type="submit" ${F.saving ? 'disabled' : ''}>
        ${F.saving ? esc(F.saving) : timerNew ? '▶ Iniciar' : 'Guardar'}
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
      if (!Number.isFinite(v) || v < 0) return toast(`Revisa “${f.label}”`, true);
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
  if (kind === 'growth' && !data.kg && !data.cm && !data.head) return toast('Escribe al menos el peso o la talla', true);
  if (kind === 'med' && !data.name) return toast('¿Qué medicina?', true);
  if (kind === 'temp' && !data.c) return toast('Escribe la temperatura', true);
  if (kind === 'note' && !F.notes.trim() && !F.newPhotos.length && !F.entry?.photos.length) {
    return toast('Agrega una foto o escribe una nota', true);
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
  const doneMsg = !F.entry && body.data.timer ? '⏱️ Cronómetro iniciado' : '✓ Guardado';

  F.saving = 'Guardando…';
  renderForm();
  try {
    let entry;
    if (F.entry) entry = await api('PATCH', '/api/entries/' + F.entry.id, body);
    else entry = await api('POST', '/api/entries', { ...body, kind, addedBy: S.me });
    await uploadPhotos(entry.id, F.newPhotos, (i, n) => {
      if (F) {
        F.saving = `Subiendo foto ${i}/${n}…`;
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
    if (file.size > 14 * 1024 * 1024) throw new Error('La foto es demasiado grande');
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
  $('#viewer-download').setAttribute('download', `ma8ko-foto-${ids[idx]}.jpg`);
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
      <button class="icon-btn" data-act="close-sheet" aria-label="Cerrar">✕</button>
    </div>
    <div class="detail">
      <div class="detail-title">${esc(describe(e))}</div>
      <div class="muted">${esc(fmtDay(new Date(e.at)))}, ${fmtTime(e.at)}${e.ended_at ? ' – ' + fmtTime(e.ended_at) : ''}${dur ? ' (' + fmtDur(dur) + ')' : ''}${e.added_by ? ' · por ' + esc(e.added_by) : ''}</div>
      ${isRunning(e) ? `<div class="banner">⏱️ En curso: <b data-since="${e.at}">${fmtClock(Date.now() - new Date(e.at))}</b> <button class="btn small" data-act="stop-timer" data-id="${e.id}">Terminar ahora</button></div>` : ''}
      ${warn ? `<div class="banner warn">${esc(warn)}</div>` : ''}
      ${e.notes ? `<p class="detail-notes">${esc(e.notes)}</p>` : ''}

      ${thumbs(e.photos, true)}
      <button class="btn ghost small" data-act="detail-add-photo">📷 Agregar foto</button>

      <div class="row gap wrap">
        ${
          d.ask
            ? d.resolved
              ? `<button class="btn small" data-act="ask" data-v="reopen">↺ Volver a pendiente</button>`
              : `<button class="btn small primary" data-act="ask" data-v="resolve">✓ Ya lo vimos con el pediatra</button>
                 <button class="btn small ghost" data-act="ask" data-v="off">Quitar de pediatra</button>`
            : `<button class="btn small" data-act="ask" data-v="on">🩺 Preguntar al pediatra</button>`
        }
      </div>

      <h3>Comentarios</h3>
      <div class="comments">
        ${
          e.comments.length
            ? e.comments
                .map(
                  (c) => `<div class="comment ${c.author === S.me ? 'mine' : ''}">
              <div class="comment-meta"><b>${esc(c.author || '—')}</b> · ${esc(fmtDay(new Date(c.created_at)))} ${fmtTime(c.created_at)}${
                c.author === S.me ? ` <button class="link danger" data-act="del-comment" data-id="${c.id}">borrar</button>` : ''}</div><div class="comment-text">${esc(c.text)}</div></div>`
                )
                .join('')
            : '<p class="muted small">Aún no hay comentarios.</p>'
        }
      </div>
      <form id="comment-form" class="row gap">
        <input id="comment-text" class="grow" placeholder="Escribe un comentario…" maxlength="2000" autocomplete="off" />
        <button class="btn primary" type="submit">Enviar</button>
      </form>

      <div class="row gap sheet-foot">
        <button class="btn grow" data-act="edit-entry">✏️ Editar</button>
        <button class="btn danger grow" data-act="delete-entry">🗑️ Borrar</button>
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
  toast(v === 'resolve' ? '✓ Marcado como revisado' : '✓ Listo');
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
  toast('⏱️ Cronómetro iniciado');
  await refresh();
}

async function stopTimer(id) {
  await api('PATCH', '/api/entries/' + id, { endedAt: new Date().toISOString() });
  toast('✓ Terminado');
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
      <h2>💰 ${X.id ? 'Editar gasto' : 'Nuevo gasto'}</h2>
      <button class="icon-btn" data-act="close-sheet" aria-label="Cerrar">✕</button>
    </div>
    <form id="expense-form" class="form">
      <label class="field"><span>Monto (${esc(S.settings.currency || '$')})</span>
        <input type="number" inputmode="decimal" step="0.01" min="0" data-x="amount" value="${esc(X.amount)}" required /></label>
      <div class="field"><span>Categoría</span><div class="cats">${Object.entries(CATS)
        .map(([k, [l, i]]) => `<button type="button" class="chip ${X.category === k ? 'active' : ''}" data-act="exp-cat" data-val="${k}">${i} ${esc(l)}</button>`)
        .join('')}</div></div>
      <label class="field"><span>Descripción</span>
        <input data-x="description" maxlength="200" value="${esc(X.description)}" placeholder="Ej. Pañales talla 1 (caja)" /></label>
      <label class="field"><span>Fecha</span><input type="date" data-x="spentOn" value="${esc(X.spentOn)}" /></label>
      <label class="field"><span>¿Quién pagó?</span>
        <input data-x="paidBy" maxlength="40" value="${esc(X.paidBy)}" />
        ${payers.length > 1 ? `<div class="quick">${payers.map((p) => `<button type="button" class="chip" data-act="exp-payer" data-val="${esc(p)}">${esc(p)}</button>`).join('')}</div>` : ''}
      </label>
      <button class="btn primary block" type="submit">Guardar</button>
      ${X.id ? '<button type="button" class="btn danger block" data-act="delete-expense">🗑️ Borrar gasto</button>' : ''}
    </form>`;
  if (S.sheet === 'expense') $('#sheet-body').innerHTML = html;
  else openSheet('expense', html);
}

async function saveExpense() {
  const amount = Number(X.amount);
  if (!(amount > 0)) return toast('Escribe el monto', true);
  const body = { amount, category: X.category, description: X.description, spentOn: X.spentOn, paidBy: X.paidBy };
  try {
    if (X.id) await api('PATCH', '/api/expenses/' + X.id, body);
    else await api('POST', '/api/expenses', body);
    S.exp.month = (X.spentOn || ymd(new Date())).slice(0, 7);
    closeSheet();
    toast('✓ Gasto guardado');
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
      <h2>⚙️ Ajustes</h2>
      <button class="icon-btn" data-act="close-sheet" aria-label="Cerrar">✕</button>
    </div>
    <form id="settings-form" class="form">
      <label class="field"><span>Tu nombre (en este celular)</span><input id="set-me" maxlength="40" value="${esc(S.me)}" required /></label>
      <label class="field"><span>Nombre del bebé</span><input id="set-baby" maxlength="60" value="${esc(s.babyName || '')}" /></label>
      <label class="field"><span>Fecha de nacimiento</span><input id="set-birth" type="date" value="${esc(s.birthDate || '')}" /></label>
      <div class="field"><span>Unidades</span>
        <div class="seg">
          <button type="button" class="${!US() ? 'active' : ''}" data-act="set-units" data-val="metric">ml · kg · cm · °C</button>
          <button type="button" class="${US() ? 'active' : ''}" data-act="set-units" data-val="us">oz · lb · in · °F</button>
        </div></div>
      <label class="field"><span>Símbolo de moneda</span><input id="set-currency" maxlength="6" value="${esc(s.currency || '$')}" /></label>
      <button class="btn primary block" type="submit">Guardar</button>
    </form>
    <div class="settings-info">
      ${S.info.storage === 'memory' ? '<div class="banner warn">⚠️ El servidor no tiene base de datos (PostgreSQL): los datos se borran al reiniciar.</div>' : ''}
      <p class="muted small">📱 Tip: ábrela en Safari/Chrome y elige “Agregar a pantalla de inicio” para usarla como app.</p>
      <p class="muted small">Comparte el link con tu pareja: ambos ven y editan lo mismo.</p>
      <a class="btn ghost block" href="/api/backup" download>💾 Descargar respaldo de los datos</a>
    </div>`
  );
  S.pendingUnits = s.units === 'us' ? 'us' : 'metric';
}

async function saveSettingsForm() {
  const me = $('#set-me').value.trim();
  if (!me) return toast('Escribe tu nombre', true);
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
    toast('✓ Ajustes guardados');
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
      toast('Subiendo…');
      await uploadPhotos(id, list);
      toast('✓ Foto agregada');
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
    if (!confirm('¿Borrar este registro con sus fotos y comentarios?')) return;
    try {
      await api('DELETE', '/api/entries/' + S.detail.id);
      closeSheet();
      toast('Borrado');
      await refresh();
    } catch (err) {
      fail(err);
    }
  },
  ask: (el) => setAsk(el.dataset.v).catch(fail),
  'del-comment': async (el) => {
    if (!confirm('¿Borrar el comentario?')) return;
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
    if (!confirm('¿Borrar este gasto?')) return;
    try {
      await api('DELETE', '/api/expenses/' + X.id);
      closeSheet();
      toast('Borrado');
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
