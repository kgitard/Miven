// Servidor de Miven: sirve la app web y expone la API de la lista de compras.
// Sin contraseña: cualquiera con el link entra directo (más simple).

import express from 'express';
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

const app = express();
app.use(express.json());
app.disable('x-powered-by');

// --- API de la lista ---
app.get('/api/items', async (req, res, next) => {
  try {
    res.json(await listItems());
  } catch (err) {
    next(err);
  }
});

app.post('/api/items', async (req, res, next) => {
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

app.patch('/api/items/:id', async (req, res, next) => {
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

app.delete('/api/items/:id', async (req, res, next) => {
  try {
    const ok = await deleteItem(req.params.id);
    if (!ok) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/items/clear-completed', async (req, res, next) => {
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
