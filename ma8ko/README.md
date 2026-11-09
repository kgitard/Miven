# Ma8ko 🐢

Baby log. A web app (made for phones) so **both parents** can track everything
about the baby and see it instantly on both phones.

## What it does

- **Feedings:** breastfeeding (timer, suggested side, "Switch side" button),
  bottle (ml/oz, breast milk or formula) and solids. Shows "last feeding … ago"
  and how often the baby is eating.
- **Diapers:** pee / poop / both, poop color and texture, with warnings when a
  color should be checked by the pediatrician.
- **Sleep:** one-tap timer ("Fell asleep" → "Woke up") or log it afterwards.
- **Medicines / vitamins, temperature** (fever warning) and **weight / length /
  head circumference** with a chart.
- **Photos** on any entry (poop, rashes, anything). They're compressed on the
  phone before uploading.
- **Comments** on every entry, so you can both discuss the same thing.
- **Pediatrician:** mark anything with "🩺 Ask the pediatrician" and it goes on
  a to-ask list. **Report for the visit** summarizes the last 3/7/14/30 days
  (averages, day by day, growth, temperatures, medicines and the questions
  with their photos) and can be printed or saved as PDF.
- **Expenses:** by month and category, who paid, all-time total and CSV export.
- Day-by-day history with filters, automatic dark mode, installable as an app
  ("Add to Home Screen"). Metric or US units (Settings).

## Deploy on Railway

Ma8ko **has nothing to do with Miven** (the shopping list): they only share the
repository. It lives in the `ma8ko/` folder and runs as its own service with
its own database.

1. In Railway: **New Project → Deploy from GitHub repo →** this repo.
2. In the new service: **Settings → Root Directory = `ma8ko`**.
3. Add a database: **New → Database → PostgreSQL**, and in the service's
   variables set `DATABASE_URL = ${{Postgres.DATABASE_URL}}`.
   Use a PostgreSQL **just for Ma8ko** (not Miven's).
4. **Settings → Networking → Generate Domain** and share the link with your
   partner. There's no password: anyone with the link can get in.

Photos are stored in PostgreSQL (≈150–300 KB each after compression), so no
separate file storage is needed.

## Your data is safe when the app changes

- Everything is stored in PostgreSQL, which is a separate service in Railway.
  Redeploying or changing the code **doesn't touch the database**.
- On startup the server only runs `CREATE TABLE IF NOT EXISTS`: it never drops
  or recreates tables. Future changes must be additive only (see `CLAUDE.md`
  in this folder).
- The only thing that deletes the data is **deleting the PostgreSQL service**
  in Railway. Don't do that.
- Extra: **Settings → Download a backup of the data** gives you a JSON file
  with everything (entries, comments, expenses). Railway also offers automatic
  PostgreSQL backups in the service's *Backups* tab.
- If the app has no database connected, it shows a yellow warning on the home
  screen (in that mode data would be lost on restart).

## Local development

```bash
cd ma8ko
npm install
npm start          # http://localhost:3000 (without DATABASE_URL it uses memory)
```

## API

| Method | Route                         | Description                                   |
| ------ | ----------------------------- | --------------------------------------------- |
| GET    | `/api/info`                   | `{ storage: 'postgres' | 'memory' }`         |
| GET    | `/api/backup`                 | JSON backup of everything (no photo bytes)    |
| GET    | `/api/version`                | changes on every write (used for syncing)     |
| GET/PUT| `/api/settings`               | `{ babyName, birthDate, currency, units }`    |
| GET    | `/api/entries`                | `?from&to&kind&ask=1&running=1&limit`         |
| GET    | `/api/entries/:id`            | entry + photos + comments                     |
| POST   | `/api/entries`                | `{ kind, at, endedAt, data, notes, addedBy }` |
| PATCH  | `/api/entries/:id`            | `{ at?, endedAt?, data?, notes? }`            |
| DELETE | `/api/entries/:id`            | deletes it with its photos and comments       |
| POST   | `/api/entries/:id/photos`     | `{ mime, data(base64), thumb?, addedBy }`     |
| GET    | `/api/photos/:id`             | `?thumb=1` for the thumbnail                  |
| DELETE | `/api/photos/:id`             |                                               |
| POST   | `/api/entries/:id/comments`   | `{ text, author }`                            |
| DELETE | `/api/comments/:id`           |                                               |
| GET/POST | `/api/expenses`             | `{ amount, category, description, spentOn, paidBy }` |
| PATCH/DELETE | `/api/expenses/:id`     |                                               |
| GET    | `/health`                     | healthcheck for Railway                       |

`kind`: `feeding`, `diaper`, `sleep`, `growth`, `med`, `temp`, `note`.
Values are always stored in metric (ml, kg, cm, °C); the app converts to
oz/lb/in/°F if chosen in Settings.
