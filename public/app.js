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
const tabButtons = document.querySelectorAll('.tab');
const countEls = {
  frecuente: $('#count-frecuente'),
  costco: $('#count-costco'),
};

let items = [];
let pollTimer = null;

// Lista activa (pestaña). Se recuerda en el dispositivo.
function getActiveList() {
  return localStorage.getItem('miven_list') || 'frecuente';
}
function setActiveList(list) {
  localStorage.setItem('miven_list', list);
  tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.list === list));
  itemInput.placeholder =
    list === 'costco' ? '¿Qué compramos en Costco?' : '¿Qué necesitamos comprar?';
  render();
}

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
function itemList(item) {
  return item.list_name || 'frecuente';
}

function render() {
  const activeList = getActiveList();

  // Contador de pendientes en cada pestaña.
  for (const key of ['frecuente', 'costco']) {
    const pend = items.filter((i) => itemList(i) === key && !i.done).length;
    if (countEls[key]) countEls[key].textContent = pend ? String(pend) : '';
  }

  const visibles = items.filter((i) => itemList(i) === activeList);

  list.innerHTML = '';
  emptyMsg.classList.toggle('hidden', visibles.length !== 0);

  for (const item of visibles) {
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

    const target = itemList(item) === 'costco' ? 'frecuente' : 'costco';
    const move = document.createElement('button');
    move.className = 'move-btn';
    move.textContent = target === 'costco' ? '📦' : '🛒';
    move.title = target === 'costco' ? 'Mover a Costco' : 'Mover a Frecuentes';
    move.setAttribute('aria-label', move.title);
    move.addEventListener('click', () => moveItem(item));

    const del = document.createElement('button');
    del.className = 'del-btn';
    del.innerHTML = '🗑';
    del.setAttribute('aria-label', 'Borrar');
    del.addEventListener('click', () => removeItem(item));

    li.append(check, body, move, del);
    list.appendChild(li);
  }

  const pending = visibles.filter((i) => !i.done).length;
  const done = visibles.length - pending;
  counter.textContent =
    visibles.length === 0
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
  const activeList = getActiveList();
  const optimisticId = 'tmp-' + Date.now();
  items.push({
    id: optimisticId,
    name,
    done: false,
    added_by: getName() || null,
    list_name: activeList,
  });
  render();
  try {
    await api('/api/items', {
      method: 'POST',
      body: JSON.stringify({ name, addedBy: getName(), list: activeList }),
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

async function moveItem(item) {
  const target = itemList(item) === 'costco' ? 'frecuente' : 'costco';
  // Si el item aún no se guardó en el servidor, solo esperamos al refresh.
  if (typeof item.id === 'string' && item.id.startsWith('tmp')) return;
  item.list_name = target; // desaparece de la vista actual al cambiar de lista
  render();
  try {
    await api('/api/items/' + item.id, {
      method: 'PATCH',
      body: JSON.stringify({ list: target }),
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
  const activeList = getActiveList();
  items = items.filter((i) => !(i.done && itemList(i) === activeList));
  render();
  try {
    await api('/api/items/clear-completed', {
      method: 'POST',
      body: JSON.stringify({ list: activeList }),
    });
    await refresh();
  } catch (err) {
    refresh();
  }
}

// ---------- Aviso de almacenamiento temporal ----------
async function checkStorage() {
  try {
    const health = await api('/health');
    const warn = $('#storage-warning');
    warn.classList.toggle('hidden', health?.storage !== 'memory');
  } catch {
    /* si falla, no mostramos nada */
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

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => setActiveList(btn.dataset.list));
});

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
setActiveList(getActiveList());
refresh();
checkStorage();
startPolling();
