// Capa de acceso a datos de Miven.
//
// Usa PostgreSQL cuando existe DATABASE_URL (lo normal en Railway).
// Si no hay DATABASE_URL, cae a un almacen en memoria para poder probar
// localmente sin instalar nada. OJO: el almacen en memoria se borra al
// reiniciar el servidor, asi que en produccion SIEMPRE usa PostgreSQL.

import pg from 'pg';

const { Pool } = pg;

const usingPostgres = Boolean(process.env.DATABASE_URL);

let pool = null;
const memory = { items: [], seq: 1 };

if (usingPostgres) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Railway por red privada no usa SSL. Actívalo con DATABASE_SSL=true
    // si te conectas por el proxy público de Railway.
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
}

export function isUsingPostgres() {
  return usingPostgres;
}

export async function init() {
  if (!usingPostgres) {
    console.warn(
      '[Miven] Sin DATABASE_URL: usando almacen EN MEMORIA (los datos se ' +
        'pierden al reiniciar). Agrega PostgreSQL en Railway para persistir.'
    );
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      quantity   TEXT,
      done       BOOLEAN NOT NULL DEFAULT false,
      added_by   TEXT,
      list_name  TEXT NOT NULL DEFAULT 'frecuente',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Para bases de datos que ya existían antes de agregar las listas.
  await pool.query(
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS list_name TEXT NOT NULL DEFAULT 'frecuente';`
  );
}

export async function listItems() {
  if (!usingPostgres) {
    return [...memory.items].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return a.created_at < b.created_at ? -1 : 1;
    });
  }
  const { rows } = await pool.query(
    'SELECT * FROM items ORDER BY done ASC, created_at ASC'
  );
  return rows;
}

export async function addItem({ name, quantity, addedBy, list }) {
  const listName = list || 'frecuente';
  if (!usingPostgres) {
    const item = {
      id: memory.seq++,
      name,
      quantity: quantity || null,
      done: false,
      added_by: addedBy || null,
      list_name: listName,
      created_at: new Date().toISOString(),
    };
    memory.items.push(item);
    return item;
  }
  const { rows } = await pool.query(
    'INSERT INTO items (name, quantity, added_by, list_name) VALUES ($1, $2, $3, $4) RETURNING *',
    [name, quantity || null, addedBy || null, listName]
  );
  return rows[0];
}

export async function updateItem(id, fields) {
  if (!usingPostgres) {
    const item = memory.items.find((i) => i.id === Number(id));
    if (!item) return null;
    if (fields.name !== undefined) item.name = fields.name;
    if (fields.quantity !== undefined) item.quantity = fields.quantity;
    if (fields.done !== undefined) item.done = fields.done;
    if (fields.list_name !== undefined) item.list_name = fields.list_name;
    return item;
  }

  const sets = [];
  const values = [];
  let n = 1;
  for (const key of ['name', 'quantity', 'done', 'list_name']) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = $${n++}`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) {
    const { rows } = await pool.query('SELECT * FROM items WHERE id = $1', [id]);
    return rows[0] || null;
  }
  values.push(id);
  const { rows } = await pool.query(
    `UPDATE items SET ${sets.join(', ')} WHERE id = $${n} RETURNING *`,
    values
  );
  return rows[0] || null;
}

export async function deleteItem(id) {
  if (!usingPostgres) {
    const idx = memory.items.findIndex((i) => i.id === Number(id));
    if (idx === -1) return false;
    memory.items.splice(idx, 1);
    return true;
  }
  const { rowCount } = await pool.query('DELETE FROM items WHERE id = $1', [id]);
  return rowCount > 0;
}

export async function clearCompleted(list) {
  if (!usingPostgres) {
    const before = memory.items.length;
    memory.items = memory.items.filter(
      (i) => !(i.done && (!list || i.list_name === list))
    );
    return before - memory.items.length;
  }
  if (list) {
    const { rowCount } = await pool.query(
      'DELETE FROM items WHERE done = true AND list_name = $1',
      [list]
    );
    return rowCount;
  }
  const { rowCount } = await pool.query('DELETE FROM items WHERE done = true');
  return rowCount;
}
