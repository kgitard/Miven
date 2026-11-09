// Capa de acceso a datos de Ma8ko (bitácora del bebé).
//
// Usa PostgreSQL cuando existe DATABASE_URL (lo normal en Railway).
// Si no hay DATABASE_URL, cae a un almacén en memoria para poder probar
// localmente sin instalar nada. OJO: la memoria se borra al reiniciar,
// así que en producción SIEMPRE usa PostgreSQL.
//
// Modelo:
//   settings  (key, value)                  nombre del bebé, nacimiento, moneda
//   entries   (id, kind, at, ended_at, data JSONB, notes, added_by, ...)
//             kind: feeding | diaper | sleep | growth | med | temp | note
//   photos    (id, entry_id, mime, data, thumb, added_by, created_at)
//   comments  (id, entry_id, author, text, created_at)
//   expenses  (id, amount, category, description, spent_on, paid_by, created_at)

import pg from 'pg';

const { Pool } = pg;

// Las columnas DATE (1082) llegan como texto 'YYYY-MM-DD' (sin líos de zona horaria).
pg.types.setTypeParser(1082, (v) => v);

const usingPostgres = Boolean(process.env.DATABASE_URL);

let pool = null;
const mem = {
  settings: {},
  entries: [],
  photos: [],
  comments: [],
  expenses: [],
  seq: 1,
};

if (usingPostgres) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
}

export function isUsingPostgres() {
  return usingPostgres;
}

export async function init() {
  if (!usingPostgres) {
    console.warn(
      '[Ma8ko] No DATABASE_URL: using IN-MEMORY storage (data is lost ' +
        'on restart). Add PostgreSQL in Railway to keep data.'
    );
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS entries (
      id         SERIAL PRIMARY KEY,
      kind       TEXT NOT NULL,
      at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at   TIMESTAMPTZ,
      data       JSONB NOT NULL DEFAULT '{}'::jsonb,
      notes      TEXT,
      added_by   TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS entries_at_idx ON entries (at DESC);
    CREATE TABLE IF NOT EXISTS photos (
      id         SERIAL PRIMARY KEY,
      entry_id   INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      mime       TEXT NOT NULL,
      data       BYTEA NOT NULL,
      thumb      BYTEA,
      added_by   TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS photos_entry_idx ON photos (entry_id);
    CREATE TABLE IF NOT EXISTS comments (
      id         SERIAL PRIMARY KEY,
      entry_id   INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      author     TEXT,
      text       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS comments_entry_idx ON comments (entry_id);
    CREATE TABLE IF NOT EXISTS expenses (
      id          SERIAL PRIMARY KEY,
      amount      NUMERIC(12, 2) NOT NULL,
      category    TEXT NOT NULL,
      description TEXT,
      spent_on    DATE NOT NULL DEFAULT CURRENT_DATE,
      paid_by     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

const now = () => new Date().toISOString();

// ---------------- Ajustes ----------------

export async function getSettings() {
  if (!usingPostgres) return { ...mem.settings };
  const { rows } = await pool.query('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function saveSettings(obj) {
  if (!usingPostgres) {
    Object.assign(mem.settings, obj);
    return getSettings();
  }
  for (const [key, value] of Object.entries(obj)) {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  }
  return getSettings();
}

// ---------------- Registros (entries) ----------------

function memDecorate(e) {
  return {
    ...e,
    photos: mem.photos.filter((p) => p.entry_id === e.id).map((p) => p.id),
    comment_count: mem.comments.filter((c) => c.entry_id === e.id).length,
  };
}

const ENTRY_SELECT = `
  SELECT e.*,
    COALESCE((SELECT json_agg(p.id ORDER BY p.id) FROM photos p WHERE p.entry_id = e.id), '[]'::json) AS photos,
    (SELECT count(*)::int FROM comments c WHERE c.entry_id = e.id) AS comment_count
  FROM entries e`;

// filtros: { from, to, kind, ask, running, limit }
export async function listEntries(f = {}) {
  const limit = Math.min(Number(f.limit) || 500, 2000);
  if (!usingPostgres) {
    let list = mem.entries.filter((e) => {
      if (f.from && e.at < f.from) return false;
      if (f.to && e.at >= f.to) return false;
      if (f.kind && e.kind !== f.kind) return false;
      if (f.ask && !e.data.ask) return false;
      if (f.running && !(e.data.timer && !e.ended_at)) return false;
      return true;
    });
    list.sort((a, b) => (a.at < b.at ? 1 : -1));
    return list.slice(0, limit).map(memDecorate);
  }
  const where = [];
  const values = [];
  const add = (sql, v) => {
    values.push(v);
    where.push(sql.replace('?', `$${values.length}`));
  };
  if (f.from) add('e.at >= ?', f.from);
  if (f.to) add('e.at < ?', f.to);
  if (f.kind) add('e.kind = ?', f.kind);
  if (f.ask) where.push(`(e.data->>'ask') = 'true'`);
  if (f.running) where.push(`(e.data->>'timer') = 'true' AND e.ended_at IS NULL`);
  values.push(limit);
  const { rows } = await pool.query(
    `${ENTRY_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY e.at DESC LIMIT $${values.length}`,
    values
  );
  return rows;
}

export async function getEntry(id) {
  if (!usingPostgres) {
    const e = mem.entries.find((x) => x.id === Number(id));
    if (!e) return null;
    return { ...memDecorate(e), comments: await listComments(id) };
  }
  const { rows } = await pool.query(`${ENTRY_SELECT} WHERE e.id = $1`, [id]);
  if (!rows[0]) return null;
  return { ...rows[0], comments: await listComments(id) };
}

export async function addEntry({ kind, at, endedAt, data, notes, addedBy }) {
  if (!usingPostgres) {
    const e = {
      id: mem.seq++,
      kind,
      at: at || now(),
      ended_at: endedAt || null,
      data: data || {},
      notes: notes || null,
      added_by: addedBy || null,
      created_at: now(),
      updated_at: now(),
    };
    mem.entries.push(e);
    return memDecorate(e);
  }
  const { rows } = await pool.query(
    `INSERT INTO entries (kind, at, ended_at, data, notes, added_by)
     VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4, $5, $6) RETURNING id`,
    [kind, at || null, endedAt || null, data || {}, notes || null, addedBy || null]
  );
  return getEntry(rows[0].id);
}

// fields: { at?, ended_at?, data?, notes? }  (data reemplaza completo)
export async function updateEntry(id, fields) {
  if (!usingPostgres) {
    const e = mem.entries.find((x) => x.id === Number(id));
    if (!e) return null;
    for (const k of ['at', 'ended_at', 'data', 'notes']) {
      if (fields[k] !== undefined) e[k] = fields[k];
    }
    e.updated_at = now();
    return getEntry(id);
  }
  const sets = [];
  const values = [];
  for (const k of ['at', 'ended_at', 'data', 'notes']) {
    if (fields[k] !== undefined) {
      values.push(fields[k]);
      sets.push(`${k} = $${values.length}`);
    }
  }
  sets.push('updated_at = now()');
  values.push(id);
  const { rowCount } = await pool.query(
    `UPDATE entries SET ${sets.join(', ')} WHERE id = $${values.length}`,
    values
  );
  return rowCount ? getEntry(id) : null;
}

export async function deleteEntry(id) {
  if (!usingPostgres) {
    const idx = mem.entries.findIndex((x) => x.id === Number(id));
    if (idx === -1) return false;
    mem.entries.splice(idx, 1);
    mem.photos = mem.photos.filter((p) => p.entry_id !== Number(id));
    mem.comments = mem.comments.filter((c) => c.entry_id !== Number(id));
    return true;
  }
  const { rowCount } = await pool.query('DELETE FROM entries WHERE id = $1', [id]);
  return rowCount > 0;
}

// ---------------- Fotos ----------------

export async function addPhoto(entryId, { mime, data, thumb, addedBy }) {
  if (!usingPostgres) {
    if (!mem.entries.some((e) => e.id === Number(entryId))) return null;
    const p = {
      id: mem.seq++,
      entry_id: Number(entryId),
      mime,
      data,
      thumb: thumb || null,
      added_by: addedBy || null,
      created_at: now(),
    };
    mem.photos.push(p);
    return { id: p.id };
  }
  const { rows } = await pool.query(
    `INSERT INTO photos (entry_id, mime, data, thumb, added_by)
     SELECT $1, $2, $3, $4, $5 WHERE EXISTS (SELECT 1 FROM entries WHERE id = $1)
     RETURNING id`,
    [entryId, mime, data, thumb || null, addedBy || null]
  );
  return rows[0] || null;
}

export async function getPhoto(id, thumb) {
  if (!usingPostgres) {
    const p = mem.photos.find((x) => x.id === Number(id));
    if (!p) return null;
    return thumb && p.thumb ? { mime: 'image/jpeg', data: p.thumb } : p;
  }
  const { rows } = await pool.query(
    thumb
      ? `SELECT CASE WHEN thumb IS NULL THEN mime ELSE 'image/jpeg' END AS mime,
                COALESCE(thumb, data) AS data FROM photos WHERE id = $1`
      : 'SELECT mime, data FROM photos WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

export async function deletePhoto(id) {
  if (!usingPostgres) {
    const idx = mem.photos.findIndex((x) => x.id === Number(id));
    if (idx === -1) return false;
    mem.photos.splice(idx, 1);
    return true;
  }
  const { rowCount } = await pool.query('DELETE FROM photos WHERE id = $1', [id]);
  return rowCount > 0;
}

// ---------------- Comentarios ----------------

export async function listComments(entryId) {
  if (!usingPostgres) {
    return mem.comments.filter((c) => c.entry_id === Number(entryId));
  }
  const { rows } = await pool.query(
    'SELECT * FROM comments WHERE entry_id = $1 ORDER BY created_at ASC',
    [entryId]
  );
  return rows;
}

export async function addComment(entryId, { author, text }) {
  if (!usingPostgres) {
    if (!mem.entries.some((e) => e.id === Number(entryId))) return null;
    const c = {
      id: mem.seq++,
      entry_id: Number(entryId),
      author: author || null,
      text,
      created_at: now(),
    };
    mem.comments.push(c);
    return c;
  }
  const { rows } = await pool.query(
    `INSERT INTO comments (entry_id, author, text)
     SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM entries WHERE id = $1)
     RETURNING *`,
    [entryId, author || null, text]
  );
  return rows[0] || null;
}

export async function deleteComment(id) {
  if (!usingPostgres) {
    const idx = mem.comments.findIndex((x) => x.id === Number(id));
    if (idx === -1) return false;
    mem.comments.splice(idx, 1);
    return true;
  }
  const { rowCount } = await pool.query('DELETE FROM comments WHERE id = $1', [id]);
  return rowCount > 0;
}

// ---------------- Gastos ----------------

// NUMERIC llega como texto desde pg: lo pasamos a número.
const fixExpense = (r) => ({ ...r, amount: Number(r.amount) });

export async function listExpenses() {
  if (!usingPostgres) {
    return [...mem.expenses].sort((a, b) =>
      a.spent_on === b.spent_on ? b.id - a.id : a.spent_on < b.spent_on ? 1 : -1
    );
  }
  const { rows } = await pool.query('SELECT * FROM expenses ORDER BY spent_on DESC, id DESC');
  return rows.map(fixExpense);
}

export async function addExpense({ amount, category, description, spentOn, paidBy }) {
  if (!usingPostgres) {
    const x = {
      id: mem.seq++,
      amount,
      category,
      description: description || null,
      spent_on: spentOn || now().slice(0, 10),
      paid_by: paidBy || null,
      created_at: now(),
    };
    mem.expenses.push(x);
    return x;
  }
  const { rows } = await pool.query(
    `INSERT INTO expenses (amount, category, description, spent_on, paid_by)
     VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5) RETURNING *`,
    [amount, category, description || null, spentOn || null, paidBy || null]
  );
  return fixExpense(rows[0]);
}

export async function updateExpense(id, f) {
  if (!usingPostgres) {
    const x = mem.expenses.find((e) => e.id === Number(id));
    if (!x) return null;
    for (const k of ['amount', 'category', 'description', 'spent_on', 'paid_by']) {
      if (f[k] !== undefined) x[k] = f[k];
    }
    return x;
  }
  const sets = [];
  const values = [];
  for (const k of ['amount', 'category', 'description', 'spent_on', 'paid_by']) {
    if (f[k] !== undefined) {
      values.push(f[k]);
      sets.push(`${k} = $${values.length}`);
    }
  }
  if (!sets.length) return null;
  values.push(id);
  const { rows } = await pool.query(
    `UPDATE expenses SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  return rows[0] ? fixExpense(rows[0]) : null;
}

export async function deleteExpense(id) {
  if (!usingPostgres) {
    const idx = mem.expenses.findIndex((x) => x.id === Number(id));
    if (idx === -1) return false;
    mem.expenses.splice(idx, 1);
    return true;
  }
  const { rowCount } = await pool.query('DELETE FROM expenses WHERE id = $1', [id]);
  return rowCount > 0;
}

// ---------------- Respaldo ----------------
// Todo menos los bytes de las fotos (esas siguen en PostgreSQL).

export async function exportAll() {
  if (!usingPostgres) {
    return {
      settings: { ...mem.settings },
      entries: mem.entries,
      comments: mem.comments,
      photos: mem.photos.map(({ id, entry_id, mime, added_by, created_at }) => ({ id, entry_id, mime, added_by, created_at })),
      expenses: mem.expenses,
    };
  }
  const q = async (sql) => (await pool.query(sql)).rows;
  return {
    settings: await getSettings(),
    entries: await q('SELECT * FROM entries ORDER BY id'),
    comments: await q('SELECT * FROM comments ORDER BY id'),
    photos: await q('SELECT id, entry_id, mime, added_by, created_at FROM photos ORDER BY id'),
    expenses: (await q('SELECT * FROM expenses ORDER BY id')).map(fixExpense),
  };
}
