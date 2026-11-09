# Ma8ko — guía para Claude

Ma8ko es la bitácora del bebé de Kevin y Micaela (tomas, pañales, sueño,
fotos para el pediatra, comentarios y gastos). **No tiene relación con Miven**
(la lista de compras en la raíz del repo): solo comparten repositorio.
Se despliega en Railway como servicio propio con Root Directory = `ma8ko`.

## Regla nº 1: NUNCA perder los datos existentes

La familia ya tiene datos reales en PostgreSQL. Cualquier cambio debe
conservarlos:

- Solo cambios **aditivos** en el esquema: `CREATE TABLE IF NOT EXISTS`,
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (con DEFAULT o nullable),
  `CREATE INDEX IF NOT EXISTS`. Van en `init()` de `db.js`.
- **Prohibido** en `init()` o en cualquier código: `DROP TABLE`, `DROP COLUMN`,
  `TRUNCATE`, `DELETE` masivo, renombrar tablas/columnas, cambiar tipos.
  Si hace falta renombrar algo, se agrega lo nuevo y se copia; lo viejo se queda.
- Los campos de cada registro van en `entries.data` (JSONB): para nuevos
  campos de un registro, agrégalos ahí en vez de crear columnas. El código
  debe tolerar registros viejos que no tengan el campo nuevo.
- No cambies el significado de valores ya guardados (p. ej. `kind`, claves
  de `data`, categorías de gasto, unidades: todo se guarda en métrico).
- No cambies las claves de `localStorage` (`ma8ko_me`, `ma8ko_view`).
- Prueba contra un PostgreSQL con datos existentes antes de commitear.

## Mapa

```
server.js          Express: API REST (sin contraseña), /health, /api/backup
db.js              PostgreSQL (DATABASE_URL) o memoria para dev
public/index.html  Estructura (bienvenida + app con 4 pestañas)
public/app.js      Cliente: vistas Hoy/Historial/Pediatra/Gastos, formularios,
                   fotos (se comprimen en el navegador), polling a /api/version
public/styles.css  Estilos (modo oscuro automático, impresión del reporte)
public/icon.svg    Icono (tortuguita azul); los PNG se generan a partir de él
```

## Convenciones

- Código y UI en **español**. Sin frameworks en el frontend.
- Tipos de registro (`entries.kind`): feeding, diaper, sleep, growth, med,
  temp, note. Cualquier registro puede tener `data.ask` (preguntar al
  pediatra) y `data.resolved`.
