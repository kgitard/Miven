# Miven — guía para Claude

Miven es una **lista de compras compartida** (una app web) para dos personas.
Está pensada para desplegarse en **Railway** con PostgreSQL.

## Mapa del proyecto

```
server.js            Servidor Express: API REST de items (sin auth)
db.js                Acceso a datos. Usa PostgreSQL si hay DATABASE_URL,
                     si no cae a un almacén en memoria (solo para dev).
public/index.html    Estructura de la app (la lista)
public/styles.css    Estilos (teal, responsivo, modo oscuro automático)
public/app.js        Lógica del cliente: fetch a la API, render, polling
railway.json         Config de despliegue en Railway (start + healthcheck)
.env.example         Variables de entorno de ejemplo
ma8ko/               OTRO proyecto sin relación con Miven (bitácora del bebé, UI en inglés).
                     Solo comparte el repo; tiene su propio CLAUDE.md,
                     package.json y servicio de Railway. No lo mezcles.
```

## Cómo funciona

- **Sin contraseña:** cualquiera con el link entra directo (así lo pidió el
  dueño para que sea más simple). El nombre de cada persona se guarda en
  `localStorage` del navegador y se envía al agregar items.
- **Listas (pestañas):** cada item pertenece a una lista (`list_name`).
  Hay dos: `frecuente` (compras del día a día) y `costco` (la compra
  mensual). El frontend muestra una pestaña por lista con el contador de
  pendientes; la pestaña activa se recuerda en `localStorage` (`miven_list`).
  Las listas válidas están definidas en `LISTS` dentro de `server.js`.
- **Datos:** tabla `items` (id, name, quantity, done, added_by, list_name,
  created_at).
- **Sincronización:** el cliente hace polling cada 3 s (`startPolling` en
  `app.js`), por eso los cambios de uno aparecen en el celular del otro.

## API REST

| Método | Ruta                        | Descripción                    |
| ------ | --------------------------- | ------------------------------ |
| GET    | `/api/items`                | lista de items                 |
| POST   | `/api/items`                | `{ name, addedBy, list }`      |
| PATCH  | `/api/items/:id`            | `{ name?, done?, list? }`      |
| DELETE | `/api/items/:id`            | borra un item                  |
| POST   | `/api/items/clear-completed`| `{ list? }` borra comprados    |
| GET    | `/health`                   | healthcheck para Railway       |

## Variables de entorno

- `DATABASE_URL` — PostgreSQL. Sin ella se usa memoria (no persiste).
- `DATABASE_SSL` — `true` solo si te conectas a Postgres por SSL/proxy público.
- `PORT` — lo asigna Railway automáticamente.

## Convenciones

- El código y la UI están en **español**.
- Sin frameworks en el frontend: HTML/CSS/JS a mano para que cargue rápido.
- Si agregas columnas a `items`, actualiza el `CREATE TABLE` en `db.js`
  (usa `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN IF NOT
  EXISTS` para no romper datos existentes) y ajusta las funciones de `db.js`.
- Prueba local con `npm start` antes de commitear.

## Ideas para extender

- Más listas (despensa, farmacia, etc.): agrégalas a `LISTS` en `server.js`
  y añade su pestaña en `public/index.html` + su contador en `app.js`.
- Categorías por producto y agrupado por pasillo.
- Historial de compras / productos frecuentes.
- Notificaciones push.
- Si más adelante quieren privacidad, se puede volver a agregar una
  contraseña compartida (había una versión con login por cookie HMAC).
