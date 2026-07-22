# 🛒 Miven

Lista de compras compartida para dos personas (por ejemplo, tú y tu esposa).
Una app web sencilla, rápida en el celular, que se sincroniza en tiempo casi
real entre ambos dispositivos.

## Características

- ✅ Agregar, marcar como comprado y borrar productos
- 🔢 Cantidad opcional por producto
- 👥 Muestra quién agregó cada cosa
- 🚪 Sin contraseña: se entra directo con el link (más simple)
- 🔄 Se sincroniza automáticamente entre celulares (actualiza cada 3 segundos)
- 🌙 Modo claro y oscuro automático
- 🚂 Lista para desplegar en Railway con PostgreSQL

## Tecnología

- **Backend:** Node.js + Express
- **Base de datos:** PostgreSQL (con fallback en memoria para desarrollo local)
- **Frontend:** HTML, CSS y JavaScript sin frameworks (carga instantánea)

---

## 🚂 Desplegar en Railway

1. **Sube este repo a GitHub** (esta rama ya está lista).

2. En [Railway](https://railway.app), crea un proyecto:
   `New Project → Deploy from GitHub repo` y elige este repositorio.

3. **Agrega PostgreSQL** al proyecto:
   `New → Database → Add PostgreSQL`.
   Railway crea la variable `DATABASE_URL` automáticamente.

4. En el **servicio de Miven → Variables**, agrega:

   | Variable          | Valor                                            |
   | ----------------- | ------------------------------------------------ |
   | `DATABASE_URL`    | Referencia: `${{ Postgres.DATABASE_URL }}`       |

   > Usa el botón **Add Reference** y elige la variable `DATABASE_URL` del
   > servicio Postgres. Así se conecta por la red privada de Railway (sin
   > SSL, más rápido y seguro).

5. Railway construye y despliega solo. Cuando termine, en
   **Settings → Networking → Generate Domain** obtienes la URL pública
   (algo como `https://miven-production.up.railway.app`).

6. Abran esa URL en el celular y... ¡a comprar! 🎉
   (En iPhone/Android pueden usar "Agregar a pantalla de inicio" para que
   parezca una app nativa.)

---

## 💻 Correr localmente

```bash
npm install
npm start                 # abre http://localhost:3000
```

Sin `DATABASE_URL` usa un almacén en memoria (los datos se borran al
reiniciar), perfecto para probar. Para persistir localmente, pon una
`DATABASE_URL` de PostgreSQL en el `.env`.

---

## 🤖 Hacer cambios con Claude

Este proyecto está preparado para editarse con Claude Code. Solo pídele lo
que quieras cambiar, por ejemplo:

- "Agrega categorías a los productos (frutas, limpieza, etc.)"
- "Que se pueda tener más de una lista"
- "Cambia el color principal a morado"

Revisa `CLAUDE.md` para el mapa del proyecto.
