# Bitácora del bebé 👶

App web (para el celular) para que **los dos papás** registren todo lo del bebé
y lo vean al instante en ambos teléfonos.

## Qué hace

- **Tomas:** pecho (con cronómetro, lado sugerido y botón "Cambiar lado"),
  biberón (ml/oz, materna o fórmula) y sólidos. Muestra "última toma hace…"
  y cada cuánto está comiendo.
- **Pañales:** pipí / popó / ambos, color y consistencia de la popó, con avisos
  cuando un color debe consultarse con el pediatra.
- **Sueño:** cronómetro de un toque ("Se durmió" → "Despertó") o registro manual.
- **Medicinas / vitaminas, temperatura** (aviso de fiebre) y **peso / talla /
  perímetro cefálico** con gráfica.
- **Fotos** en cualquier registro (popó, sarpullidos, lo que sea). Se comprimen
  en el celular antes de subir.
- **Comentarios** en cada registro, para que los dos platiquen sobre lo mismo.
- **Pediatra:** marca cualquier cosa con "🩺 Preguntar al pediatra"; aparece en
  una lista de pendientes. El **Reporte para la cita** resume los últimos
  3/7/14/30 días (promedios, día por día, crecimiento, temperaturas,
  medicinas y las preguntas con sus fotos) y se puede imprimir o guardar en PDF.
- **Gastos:** por mes y categoría, quién pagó, total desde el inicio y
  exportación a CSV.
- Historial por día con filtros, modo oscuro automático y se instala como app
  ("Agregar a pantalla de inicio").

## Desplegar en Railway

Esta app vive en la carpeta `bebe/` del repo y es **independiente de Miven**
(su propio servicio y su propia base de datos).

1. En tu proyecto de Railway: **New → GitHub Repo →** este repo.
2. En el servicio nuevo: **Settings → Root Directory = `bebe`**.
3. Agrega una base de datos: **New → Database → PostgreSQL**, y en las
   variables del servicio pon `DATABASE_URL = ${{Postgres.DATABASE_URL}}`.
   (Usa un Postgres distinto al de Miven, o el mismo: las tablas no chocan.)
4. Variables del servicio:
   - `APP_PASSWORD` — **la contraseña de la familia** (muy recomendable: hay
     fotos del bebé). Se pide una sola vez por celular.
5. **Settings → Networking → Generate Domain** y comparte el link + la
   contraseña con tu pareja.

Las fotos se guardan en PostgreSQL (≈150–300 KB cada una después de
comprimir), así que no hace falta configurar almacenamiento aparte.

## Desarrollo local

```bash
cd bebe
npm install
npm start          # http://localhost:3000 (sin DATABASE_URL usa memoria)
```

## API

| Método | Ruta                          | Descripción                                   |
| ------ | ----------------------------- | --------------------------------------------- |
| GET    | `/api/session`                | ¿pide contraseña? ¿ya entraste?               |
| POST   | `/api/login` / `/api/logout`  | `{ password }`                                |
| GET    | `/api/version`                | cambia con cada escritura (sincronización)    |
| GET/PUT| `/api/settings`               | `{ babyName, birthDate, currency, units }`    |
| GET    | `/api/entries`                | `?from&to&kind&ask=1&running=1&limit`         |
| GET    | `/api/entries/:id`            | registro + fotos + comentarios                |
| POST   | `/api/entries`                | `{ kind, at, endedAt, data, notes, addedBy }` |
| PATCH  | `/api/entries/:id`            | `{ at?, endedAt?, data?, notes? }`            |
| DELETE | `/api/entries/:id`            | borra con sus fotos y comentarios             |
| POST   | `/api/entries/:id/photos`     | `{ mime, data(base64), thumb?, addedBy }`     |
| GET    | `/api/photos/:id`             | `?thumb=1` para la miniatura                  |
| DELETE | `/api/photos/:id`             |                                               |
| POST   | `/api/entries/:id/comments`   | `{ text, author }`                            |
| DELETE | `/api/comments/:id`           |                                               |
| GET/POST | `/api/expenses`             | `{ amount, category, description, spentOn, paidBy }` |
| PATCH/DELETE | `/api/expenses/:id`     |                                               |
| GET    | `/health`                     | healthcheck para Railway                      |

`kind`: `feeding`, `diaper`, `sleep`, `growth`, `med`, `temp`, `note`.
Los valores se guardan siempre en métrico (ml, kg, cm, °C); la app convierte
a oz/lb/in/°F si así lo eligen en Ajustes.
