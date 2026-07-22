// Servidor de Miven: sirve la app web y expone la API de la lista de compras.
// Protegido con una contraseña compartida (APP_PASSWORD) para que solo tu y
// tu esposa puedan entrar.

import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  init,
  isUsingPostgres,
  listItems,
  addItem,
  updateItem,
  deleteItem,
  clearCompleted,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'miven'; // cambiala en Railway
const SESSION_SECRET =
  process.env.SESSION_SECRET || `miven-secret-${APP_PASSWORD}`;
const COOKIE_NAME = 'miven_auth';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 60; // 60 dias en segundos

if (!process.env.APP_PASSWORD) {
  console.warn(
    "[Miven] APP_PASSWORD no esta definida: usando 'miven' por defecto. " +
      'Define APP_PASSWORD en Railway para proteger tu lista.'
  );
}

// --- Token de sesion (sin estado, firmado con HMAC) ---
function makeToken() {
  return crypto
    .createHmac('sha256', SESSION_SECRET)
    .update('miven-authenticated')
    .digest('hex');
}
const VALID_TOKEN = makeToken();

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  }
  return out;
}

function isAuthed(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return false;
  // Comparacion en tiempo constante.
  const a = Buffer.from(token);
  const b = Buffer.from(VALID_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const app = express();
app.use(express.json());
app.disable('x-powered-by');

// --- Rutas de autenticacion ---
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || password !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  const secure = req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${VALID_TOKEN}; HttpOnly; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${
      secure ? '; Secure' : ''
    }`
  );
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
  );
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  res.json({ authed: isAuthed(req) });
});

// --- Middleware que protege la API de items ---
function requireAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// --- API de la lista ---
app.get('/api/items', requireAuth, async (req, res, next) => {
  try {
    res.json(await listItems());
  } catch (err) {
    next(err);
  }
});

app.post('/api/items', requireAuth, async (req, res, next) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const quantity = (req.body?.quantity || '').trim() || null;
    const addedBy = (req.body?.addedBy || '').trim().slice(0, 40) || null;
    const item = await addItem({ name: name.slice(0, 200), quantity, addedBy });
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

app.patch('/api/items/:id', requireAuth, async (req, res, next) => {
  try {
    const fields = {};
    if (typeof req.body?.name === 'string') fields.name = req.body.name.trim().slice(0, 200);
    if (typeof req.body?.quantity === 'string')
      fields.quantity = req.body.quantity.trim() || null;
    if (typeof req.body?.done === 'boolean') fields.done = req.body.done;
    const item = await updateItem(req.params.id, fields);
    if (!item) return res.status(404).json({ error: 'No encontrado' });
    res.json(item);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/items/:id', requireAuth, async (req, res, next) => {
  try {
    const ok = await deleteItem(req.params.id);
    if (!ok) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/items/clear-completed', requireAuth, async (req, res, next) => {
  try {
    const removed = await clearCompleted();
    res.json({ removed });
  } catch (err) {
    next(err);
  }
});

// --- Healthcheck para Railway ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', storage: isUsingPostgres() ? 'postgres' : 'memory' });
});

// --- Archivos estaticos (la app web) ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Manejo de errores ---
app.use((err, req, res, next) => {
  console.error('[Miven] Error:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[Miven] Escuchando en el puerto ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[Miven] No se pudo inicializar la base de datos:', err);
    process.exit(1);
  });
