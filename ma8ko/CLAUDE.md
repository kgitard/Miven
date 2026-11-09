# Ma8ko — guide for Claude

Ma8ko is the baby log of Kevin and Micaela (feedings, diapers, sleep, photos
for the pediatrician, comments and expenses). **It is unrelated to Miven**
(the shopping list at the repo root): they only share the repository.
It's deployed on Railway as its own service with Root Directory = `ma8ko`.

## Rule #1: NEVER lose existing data

The family has real data in PostgreSQL. Every change must preserve it:

- Only **additive** schema changes: `CREATE TABLE IF NOT EXISTS`,
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (with a DEFAULT or nullable),
  `CREATE INDEX IF NOT EXISTS`. They go in `init()` in `db.js`.
- **Forbidden** in `init()` or anywhere else: `DROP TABLE`, `DROP COLUMN`,
  `TRUNCATE`, mass `DELETE`, renaming tables/columns, changing types.
  If something must be renamed, add the new one and copy; leave the old one.
- Per-entry fields live in `entries.data` (JSONB): add new fields there
  instead of creating columns. Code must tolerate old entries that lack them.
- Don't change the meaning of stored values. **The stored keys are Spanish
  and must stay that way** even though the UI is English: `kind` values,
  `data` keys/values (`method: pecho|biberon|solidos`, `side: izq|der|ambos`,
  `type: pipi|popo|ambos|seco`, poop colors `amarillo|verde|…`, note topics,
  temperature methods) and expense categories (`panales`, `leche`, …).
  Only change the English *labels* in the catalogs at the top of `app.js`.
- Everything is stored in metric; units are converted only for display.
- Don't change the `localStorage` keys (`ma8ko_me`, `ma8ko_view`).
- Test against a PostgreSQL that already has data before committing.

## Map

```
server.js          Express: REST API (no password), /health, /api/backup
db.js              PostgreSQL (DATABASE_URL) or in-memory for dev
public/index.html  Structure (welcome screen + app with 4 tabs)
public/app.js      Client: Today/History/Pediatrician/Expenses views, forms,
                   photos (compressed in the browser), polling /api/version
public/styles.css  Styles (automatic dark mode, report print styles)
public/icon.svg    Icon (little blue turtle); the PNGs are rendered from it
```

## Conventions

- The **UI is in English**. Internal identifiers and code comments may be in
  Spanish (legacy); don't rename identifiers that are stored as data.
- No frontend frameworks: hand-written HTML/CSS/JS.
- Entry kinds (`entries.kind`): feeding, diaper, sleep, growth, med, temp,
  note. Any entry can have `data.ask` (ask the pediatrician) and
  `data.resolved`.
