# Ma8ko 🐢

Bitácora del bebé.

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

Ma8ko **no tiene nada que ver con Miven** (la lista de compras): solo comparte
el repositorio. Vive en la carpeta `ma8ko/` y se despliega como su propio
servicio con su propia base de datos.

1. En tu proyecto de Railway: **New → GitHub Repo →** este repo.
2. En el servicio nuevo: **Settings → Root Directory = `ma8ko`**.
3. Agrega una base de datos: **New → Database → PostgreSQL**, y en las
   variables del servicio pon `DATABASE_URL = ${{Postgres.DATABASE_URL}}`.
   Usa un PostgreSQL **propio para Ma8ko** (no el de Miven).
4. **Settings → Networking → Generate Domain** y comparte el link con tu
   pareja. No hay contraseña: cualquiera con el link entra.

Las fotos se guardan en PostgreSQL (≈150–300 KB cada una después de
comprimir), así que no hace falta configurar almacenamiento aparte.

## Tus datos están a salvo al modificar la app

- Todo se guarda en PostgreSQL, que es un servicio aparte en Railway. Volver a
  desplegar o cambiar el código **no toca la base de datos**.
- Al arrancar, el servidor solo hace `CREATE TABLE IF NOT EXISTS`: nunca borra
  ni recrea tablas. Los cambios futuros deben ser solo aditivos (ver
  `CLAUDE.md` en esta carpeta).
- Lo único que borra los datos es **eliminar el servicio de PostgreSQL** en
  Railway. No lo hagan.
- Extra: en **Ajustes → Descargar respaldo** bajan un archivo JSON con todo
  (registros, comentarios, gastos). Railway también ofrece respaldos
  automáticos del PostgreSQL en la pestaña *Backups* del servicio.
- Si la app no tiene base de datos conectada, muestra un aviso amarillo en la
  pantalla de inicio (en ese modo los datos se perderían al reiniciar).

## Desarrollo local

```bash
cd ma8ko
npm install
npm start          # http://localhost:3000 (sin DATABASE_URL usa memoria)
```

## API

| Método | Ruta                          | Descripción                                   |
| ------ | ----------------------------- | --------------------------------------------- |
| GET    | `/api/info`                   | `{ storage: 'postgres' | 'memory' }`         |
| GET    | `/api/backup`                 | respaldo JSON de todo (sin fotos)             |
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
