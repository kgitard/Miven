// Lógica del cliente de Miven.

const $ = (sel) => document.querySelector(sel);

const appView = $('#app');
const addForm = $('#add-form');
const itemInput = $('#item-input');
const list = $('#list');
const emptyMsg = $('#empty');
const counter = $('#counter');
const clearBtn = $('#clear-btn');
const nameBtn = $('#name-btn');
const nameLabel = $('#name-label');

let items = [];
let pollTimer = null;

// El nombre se guarda localmente en cada dispositivo.
function getName() {
  return localStorage.getItem('miven_name') || '';
}
function setName(name) {
  if (name) localStorage.setItem('miven_name', name);
  else localStorage.removeItem('miven_name');
  nameLabel.textContent = getName() || 'Tú';
}

// ---------- API ----------
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Error');
  }
  return res.status === 204 ? null : res.json();
}

// ---------- Render ----------
function render() {
  list.innerHTML = '';
  if (items.length === 0) {
    emptyMsg.classList.remove('hidden');
  } else {
    emptyMsg.classList.add('hidden');
  }

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'item' + (item.done ? ' done' : '');

    const check = document.createElement('button');
    check.className = 'check' + (item.done ? ' checked' : '');
    check.innerHTML = item.done ? '✓' : '';
    check.setAttribute('aria-label', item.done ? 'Marcar pendiente' : 'Marcar comprado');
    check.addEventListener('click', () => toggle(item));

    const body = document.createElement('div');
    body.className = 'item-body';

    const name = document.createElement('div');
    name.className = 'item-name';
    name.appendChild(document.createTextNode(item.name));

    body.appendChild(name);

    if (item.added_by) {
      const meta = document.createElement('div');
      meta.className = 'item-meta';
      meta.textContent = 'Agregado por ' + item.added_by;
      body.appendChild(meta);
    }

    const del = document.createElement('button');
    del.className = 'del-btn';
    del.innerHTML = '🗑';
    del.setAttribute('aria-label', 'Borrar');
    del.addEventListener('click', () => removeItem(item));

    li.append(check, body, del);
    list.appendChild(li);
  }

  const pending = items.filter((i) => !i.done).length;
  const done = items.length - pending;
  counter.textContent =
    items.length === 0
      ? ''
      : `${pending} pendiente${pending === 1 ? '' : 's'}` +
        (done ? ` · ${done} comprado${done === 1 ? '' : 's'}` : '');
  clearBtn.classList.toggle('hidden', done === 0);
}

// ---------- Acciones ----------
async function refresh() {
  try {
    items = await api('/api/items');
    render();
  } catch (err) {
    console.error(err);
  }
}

async function addItem(name) {
  const optimisticId = 'tmp-' + Date.now();
  items.push({
    id: optimisticId,
    name,
    done: false,
    added_by: getName() || null,
  });
  render();
  try {
    await api('/api/items', {
      method: 'POST',
      body: JSON.stringify({ name, addedBy: getName() }),
    });
    await refresh();
  } catch (err) {
    items = items.filter((i) => i.id !== optimisticId);
    render();
  }
}

async function toggle(item) {
  item.done = !item.done;
  render();
  try {
    await api('/api/items/' + item.id, {
      method: 'PATCH',
      body: JSON.stringify({ done: item.done }),
    });
    await refresh();
  } catch (err) {
    refresh();
  }
}

async function removeItem(item) {
  items = items.filter((i) => i.id !== item.id);
  render();
  try {
    await api('/api/items/' + item.id, { method: 'DELETE' });
  } catch (err) {
    refresh();
  }
}

async function clearCompleted() {
  items = items.filter((i) => !i.done);
  render();
  try {
    await api('/api/items/clear-completed', { method: 'POST' });
    await refresh();
  } catch (err) {
    refresh();
  }
}

// ---------- Polling (sincroniza entre dispositivos) ----------
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, 3000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ---------- Eventos ----------
addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = itemInput.value.trim();
  if (!name) return;
  addItem(name);
  itemInput.value = '';
  itemInput.focus();
});

clearBtn.addEventListener('click', clearCompleted);

nameBtn.addEventListener('click', () => {
  const actual = getName();
  const nuevo = window.prompt('¿Cómo te llamas? (aparece junto a lo que agregas)', actual);
  if (nuevo !== null) setName(nuevo.trim());
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

// ---------- Arranque ----------
setName(getName());
refresh();
startPolling();
