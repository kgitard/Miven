// Servidor de la bitácora del bebé: sirve la app web y expone la API.
//
// Acceso: si existe APP_PASSWORD, se pide una contraseña compartida una vez
// por dispositivo (cookie firmada con HMAC que dura 1 año). Las fotos del
// bebé son privadas, por eso es muy recomendable ponerla.

import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('bebe:' + APP_PASSWORD).digest('hex');
const COOKIE = 'bebe_session';
const ONE_YEAR = 365 * 24 * 60 * 60;

// Tipos de registro válidos y categorías de gasto.
const KINDS = ['feeding', 'diaper', 'sleep', 'growth', 'med', 'temp', 'note'];
const EXPENSE_CATEGORIES = [
  'panales',
  'leche',
  'comida',
  'ropa',
  'salud',
  'equipo',
  'juguetes',
  'cuidado',
  'otros',
];
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];

// Versión de los datos: cambia con cada escritura. Los clientes la consultan
// cada pocos segundos y solo recargan cuando cambia (sincroniza los 2 celulares).
let version = crypto.randomBytes(4).toString('hex') + '-0';
let writes = 0;
const bump = () => {
  writes += 1;
  version = version.split('-')[0] + '-' + writes;
};

// ---------------- Utilidades ----------------

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isoOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

// Limpia el objeto `data` de un registro: solo valores simples y cortos.
function cleanData(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [k, v] of Object.entries(input).slice(0, 30)) {
    if (!/^[a-z_]{1,30}$/i.test(k)) continue;
    if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 300);
  }
  return out;
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function isAuthed(req) {
  if (!APP_PASSWORD) return true;
  const raw = readCookie(req, COOKIE);
  if (!raw) return false;
  const [payload, mac] = raw.split('.');
  if (!payload || !mac) return false;
  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------- App ----------------

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Railway está detrás de un proxy (para req.secure)

app.get('/health', (req, res) => {
  res.json({ status: 'ok', storage: db.isUsingPostgres() ? 'postgres' : 'memory' });
});

// Las fotos llegan en base64 dentro de JSON, por eso el límite es más alto ahí.
app.use('/api/entries/:id/photos', express.json({ limit: '20mb' }));
app.use(express.json({ limit: '200kb' }));

// --- Sesión ---
app.get('/api/session', (req, res) => {
  res.json({
    authRequired: Boolean(APP_PASSWORD),
    authed: isAuthed(req),
    storage: db.isUsingPostgres() ? 'postgres' : 'memory',
  });
});

app.post('/api/login', async (req, res) => {
  const given = String(req.body?.password || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  if (!APP_PASSWORD || crypto.timingSafeEqual(a, b)) {
    const payload = Date.now().toString(36);
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${payload}.${sign(payload)}; Max-Age=${ONE_YEAR}; Path=/; HttpOnly; SameSite=Lax` +
        (req.secure ? '; Secure' : '')
    );
    return res.json({ ok: true });
  }
  // Pequeña pausa para frenar intentos a lo bruto.
  await new Promise((r) => setTimeout(r, 800));
  res.status(401).json({ error: 'Contraseña incorrecta' });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
});

// Todo lo demás de /api requiere sesión.
app.use('/api', (req, res, next) => {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'No autorizado' });
});

// Todas las escrituras cambian la versión de datos.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET') res.on('finish', () => res.statusCode < 400 && bump());
  next();
});

app.get('/api/version', (req, res) => res.json({ version }));

// --- Ajustes ---
app.get('/api/settings', wrap(async (req, res) => res.json(await db.getSettings())));

app.put(
  '/api/settings',
  wrap(async (req, res) => {
    const out = {};
    if (req.body?.babyName !== undefined) out.babyName = str(req.body.babyName, 60);
    if (req.body?.birthDate !== undefined) {
      out.birthDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body.birthDate) ? req.body.birthDate : '';
    }
    if (req.body?.currency !== undefined) out.currency = str(req.body.currency, 6) || '$';
    if (req.body?.units !== undefined) out.units = req.body.units === 'us' ? 'us' : 'metric';
    res.json(await db.saveSettings(out));
  })
);

// --- Registros ---
app.get(
  '/api/entries',
  wrap(async (req, res) => {
    const q = req.query;
    res.json(
      await db.listEntries({
        from: isoOrNull(q.from) || null,
        to: isoOrNull(q.to) || null,
        kind: KINDS.includes(q.kind) ? q.kind : null,
        ask: q.ask === '1',
        running: q.running === '1',
        limit: q.limit,
      })
    );
  })
);

app.get(
  '/api/entries/:id',
  wrap(async (req, res) => {
    const e = await db.getEntry(Number(req.params.id));
    if (!e) return res.status(404).json({ error: 'No encontrado' });
    res.json(e);
  })
);

app.post(
  '/api/entries',
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!KINDS.includes(b.kind)) return res.status(400).json({ error: 'Tipo inválido' });
    const at = isoOrNull(b.at);
    const endedAt = isoOrNull(b.endedAt);
    if (at === undefined || endedAt === undefined) {
      return res.status(400).json({ error: 'Fecha inválida' });
    }
    const entry = await db.addEntry({
      kind: b.kind,
      at,
      endedAt,
      data: cleanData(b.data),
      notes: str(b.notes, 4000) || null,
      addedBy: str(b.addedBy, 40) || null,
    });
    res.status(201).json(entry);
  })
);

app.patch(
  '/api/entries/:id',
  wrap(async (req, res) => {
    const b = req.body || {};
    const f = {};
    if (b.at !== undefined) {
      const at = isoOrNull(b.at);
      if (!at) return res.status(400).json({ error: 'Fecha inválida' });
      f.at = at;
    }
    if (b.endedAt !== undefined) {
      const endedAt = isoOrNull(b.endedAt);
      if (endedAt === undefined) return res.status(400).json({ error: 'Fecha inválida' });
      f.ended_at = endedAt;
    }
    if (b.data !== undefined) f.data = cleanData(b.data);
    if (b.notes !== undefined) f.notes = str(b.notes, 4000) || null;
    const e = await db.updateEntry(Number(req.params.id), f);
    if (!e) return res.status(404).json({ error: 'No encontrado' });
    res.json(e);
  })
);

app.delete(
  '/api/entries/:id',
  wrap(async (req, res) => {
    const ok = await db.deleteEntry(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  })
);

// --- Fotos ---
// Cuerpo: { mime, data: base64, thumb?: base64 (jpeg), addedBy }
// El navegador ya comprime la foto (máx ~1600px) y genera la miniatura.
app.post(
  '/api/entries/:id/photos',
  wrap(async (req, res) => {
    const b = req.body || {};
    const mime = IMAGE_MIMES.includes(b.mime) ? b.mime : null;
    if (!mime || typeof b.data !== 'string') {
      return res.status(400).json({ error: 'Imagen inválida' });
    }
    const data = Buffer.from(b.data, 'base64');
    const thumb = typeof b.thumb === 'string' ? Buffer.from(b.thumb, 'base64') : null;
    if (!data.length) return res.status(400).json({ error: 'Imagen vacía' });
    const photo = await db.addPhoto(Number(req.params.id), {
      mime,
      data,
      thumb,
      addedBy: str(b.addedBy, 40) || null,
    });
    if (!photo) return res.status(404).json({ error: 'Registro no encontrado' });
    res.status(201).json(photo);
  })
);

app.get(
  '/api/photos/:id',
  wrap(async (req, res) => {
    const p = await db.getPhoto(Number(req.params.id), req.query.thumb === '1');
    if (!p) return res.status(404).end();
    res.setHeader('Content-Type', p.mime);
    // Las fotos no cambian nunca: caché privada larga en el celular.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(p.data);
  })
);

app.delete(
  '/api/photos/:id',
  wrap(async (req, res) => {
    const ok = await db.deletePhoto(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  })
);

// --- Comentarios ---
app.post(
  '/api/entries/:id/comments',
  wrap(async (req, res) => {
    const text = str(req.body?.text, 2000);
    if (!text) return res.status(400).json({ error: 'El comentario está vacío' });
    const c = await db.addComment(Number(req.params.id), {
      author: str(req.body?.author, 40) || null,
      text,
    });
    if (!c) return res.status(404).json({ error: 'Registro no encontrado' });
    res.status(201).json(c);
  })
);

app.delete(
  '/api/comments/:id',
  wrap(async (req, res) => {
    const ok = await db.deleteComment(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  })
);

// --- Gastos ---
function parseExpense(b, partial) {
  const f = {};
  if (!partial || b.amount !== undefined) {
    const amount = Math.round(Number(b.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) return { error: 'Monto inválido' };
    f.amount = amount;
  }
  if (!partial || b.category !== undefined) {
    f.category = EXPENSE_CATEGORIES.includes(b.category) ? b.category : 'otros';
  }
  if (b.description !== undefined) f.description = str(b.description, 200) || null;
  if (b.spentOn !== undefined && b.spentOn !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.spentOn)) return { error: 'Fecha inválida' };
    f.spent_on = b.spentOn;
  }
  if (b.paidBy !== undefined) f.paid_by = str(b.paidBy, 40) || null;
  return { f };
}

app.get('/api/expenses', wrap(async (req, res) => res.json(await db.listExpenses())));

app.post(
  '/api/expenses',
  wrap(async (req, res) => {
    const { f, error } = parseExpense(req.body || {}, false);
    if (error) return res.status(400).json({ error });
    res.status(201).json(
      await db.addExpense({
        amount: f.amount,
        category: f.category,
        description: f.description,
        spentOn: f.spent_on,
        paidBy: f.paid_by,
      })
    );
  })
);

app.patch(
  '/api/expenses/:id',
  wrap(async (req, res) => {
    const { f, error } = parseExpense(req.body || {}, true);
    if (error) return res.status(400).json({ error });
    const x = await db.updateExpense(Number(req.params.id), f);
    if (!x) return res.status(404).json({ error: 'No encontrado' });
    res.json(x);
  })
);

app.delete(
  '/api/expenses/:id',
  wrap(async (req, res) => {
    const ok = await db.deleteExpense(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  })
);

app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// --- Archivos estáticos (la app web) ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Errores ---
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'La foto es demasiado grande' });
  }
  console.error('[Bebé] Error:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

db.init()
  .then(() => {
    if (!APP_PASSWORD) {
      console.warn('[Bebé] Sin APP_PASSWORD: cualquiera con el link puede entrar.');
    }
    app.listen(PORT, () => console.log(`[Bebé] Escuchando en el puerto ${PORT}`));
  })
  .catch((err) => {
    console.error('[Bebé] No se pudo inicializar la base de datos:', err);
    process.exit(1);
  });
