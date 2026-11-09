// Servidor de Ma8ko (bitácora del bebé): sirve la app web y expone la API.
// Sin contraseña: cualquiera con el link entra directo.

import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Tipos de registro válidos y categorías de gasto.
// psleep = sueño de los papás (data.who = nombre de quien durmió).
const KINDS = ['feeding', 'diaper', 'sleep', 'growth', 'med', 'temp', 'note', 'psleep'];
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

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------- App ----------------

const app = express();
app.disable('x-powered-by');

app.get('/health', (req, res) => {
  res.json({ status: 'ok', storage: db.isUsingPostgres() ? 'postgres' : 'memory' });
});

// Las fotos llegan en base64 dentro de JSON, por eso el límite es más alto ahí.
app.use('/api/entries/:id/photos', express.json({ limit: '20mb' }));
app.use(express.json({ limit: '200kb' }));

// --- Info del servidor (la app avisa si no hay base de datos) ---
app.get('/api/info', (req, res) => {
  res.json({ storage: db.isUsingPostgres() ? 'postgres' : 'memory' });
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
    if (!e) return res.status(404).json({ error: 'Not found' });
    res.json(e);
  })
);

app.post(
  '/api/entries',
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!KINDS.includes(b.kind)) return res.status(400).json({ error: 'Invalid type' });
    const at = isoOrNull(b.at);
    const endedAt = isoOrNull(b.endedAt);
    if (at === undefined || endedAt === undefined) {
      return res.status(400).json({ error: 'Invalid date' });
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
      if (!at) return res.status(400).json({ error: 'Invalid date' });
      f.at = at;
    }
    if (b.endedAt !== undefined) {
      const endedAt = isoOrNull(b.endedAt);
      if (endedAt === undefined) return res.status(400).json({ error: 'Invalid date' });
      f.ended_at = endedAt;
    }
    if (b.data !== undefined) f.data = cleanData(b.data);
    if (b.notes !== undefined) f.notes = str(b.notes, 4000) || null;
    const e = await db.updateEntry(Number(req.params.id), f);
    if (!e) return res.status(404).json({ error: 'Not found' });
    res.json(e);
  })
);

app.delete(
  '/api/entries/:id',
  wrap(async (req, res) => {
    const ok = await db.deleteEntry(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Not found' });
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
      return res.status(400).json({ error: 'Invalid image' });
    }
    const data = Buffer.from(b.data, 'base64');
    const thumb = typeof b.thumb === 'string' ? Buffer.from(b.thumb, 'base64') : null;
    if (!data.length) return res.status(400).json({ error: 'Empty image' });
    const photo = await db.addPhoto(Number(req.params.id), {
      mime,
      data,
      thumb,
      addedBy: str(b.addedBy, 40) || null,
    });
    if (!photo) return res.status(404).json({ error: 'Entry not found' });
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
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  })
);

// --- Comentarios ---
app.post(
  '/api/entries/:id/comments',
  wrap(async (req, res) => {
    const text = str(req.body?.text, 2000);
    if (!text) return res.status(400).json({ error: 'The comment is empty' });
    const c = await db.addComment(Number(req.params.id), {
      author: str(req.body?.author, 40) || null,
      text,
    });
    if (!c) return res.status(404).json({ error: 'Entry not found' });
    res.status(201).json(c);
  })
);

app.delete(
  '/api/comments/:id',
  wrap(async (req, res) => {
    const ok = await db.deleteComment(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  })
);

// --- Gastos ---
function parseExpense(b, partial) {
  const f = {};
  if (!partial || b.amount !== undefined) {
    const amount = Math.round(Number(b.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) return { error: 'Invalid amount' };
    f.amount = amount;
  }
  if (!partial || b.category !== undefined) {
    f.category = EXPENSE_CATEGORIES.includes(b.category) ? b.category : 'otros';
  }
  if (b.description !== undefined) f.description = str(b.description, 200) || null;
  if (b.spentOn !== undefined && b.spentOn !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.spentOn)) return { error: 'Invalid date' };
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
    if (!x) return res.status(404).json({ error: 'Not found' });
    res.json(x);
  })
);

app.delete(
  '/api/expenses/:id',
  wrap(async (req, res) => {
    const ok = await db.deleteExpense(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  })
);

// --- Respaldo (descarga JSON con todos los datos, sin las fotos) ---
app.get(
  '/api/backup',
  wrap(async (req, res) => {
    const data = await db.exportAll();
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="ma8ko-backup-${day}.json"`);
    res.json({ app: 'ma8ko', exportedAt: new Date().toISOString(), ...data });
  })
);

app.use('/api', (req, res) => res.status(404).json({ error: 'Route not found' }));

// --- Archivos estáticos (la app web) ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Errores ---
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'The photo is too large' });
  }
  console.error('[Ma8ko] Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

db.init()
  .then(() => {
    app.listen(PORT, () => console.log(`[Ma8ko] Listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('[Ma8ko] Could not initialize the database:', err);
    process.exit(1);
  });
