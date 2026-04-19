# Auditoría Completa de Código Muerto — `paginacopia`

> **Fecha de auditoría:** 2026-04-19  
> **Rama auditada:** producción (`server.js` como entry point)  
> **Objetivo:** Identificar archivos críticos, muertos, duplicados y legacy para limpiar el proyecto sin romper nada.

---

## 1. Mapa de dependencias REALES desde `server.js`

`server.js` (6645 líneas) es el único entry point. `package.json` tiene `"main": "server.js"` y `"start": "NODE_ENV=production node server.js"`. `vercel.json` también enruta todo a `server.js`.

### Requires directos de `server.js`

| Línea | Require | Destino | ¿Realmente usado? |
|-------|---------|---------|-------------------|
| 8 | `dotenv` | npm | ✅ Config inicial |
| 10 | `./src/config/loadSecrets` | SSM/AWS | ✅ `loadSecretsFromSSM()` en bootstrap |
| 12–28 | express, http, socket.io, cors, bcryptjs, jwt, crypto, uuid, fs, path, mongoose, express-rate-limit, redis, @socket.io/redis-adapter, winston, express-mongo-sanitize, xss-clean | npm | ✅ Todos usados |
| 45–63 | `./config/database` | `config/database.js` | ✅ connectDB, User, Message, Command, Config, RefundClaim, FireStreak, ChatStatus, Transaction, ExternalUser, UserActivity, getConfig, setConfig, getAllCommands, saveCommand, deleteCommand, incrementCommandUsage |
| 66 | `./src/models/ReferralEvent` | src/models/ReferralEvent.js | ✅ usado en registro |
| 67 | `./src/utils/referralCode` | src/utils/referralCode.js | ✅ `generateReferralCode()` |
| 68 | `./src/utils/redisClient` | src/utils/redisClient.js | ✅ `setRedisClient / getRedisClient` |
| 69 | `./src/services/otpService` | src/services/otpService.js | ✅ `generateAndSendOTP / verifyOTP` |
| 70 | `./src/services/smsService` | src/services/smsService.js | ✅ `sendSMS` |
| 71 | `./src/middlewares/security` | src/middlewares/security.js | ✅ `validateInternationalPhone` |
| 251 | `./jugaygana` | jugaygana.js (raíz) | ✅ +30 llamadas: `syncUserToPlatform`, `getUserInfoByName`, `creditUserBalance`, `depositToUser`, `withdrawFromUser`, `ensureSession`, `logProxyIP`, rangos de fecha |
| 252 | `./jugaygana-movements` | jugaygana-movements.js (raíz) | ✅ `getUserBalance`, `getUserMovements`, `makeBonus` |
| 253 | `./src/services/jugayganaService` | src/services/jugayganaService.js | ✅ `loginAsUser`, `changeUserPasswordAsAdmin` |
| 254 | `./models/refunds` | models/refunds.js | ✅ `canClaim*`, `calculateRefundFromNetwin` |
| 255 | `./src/services/referralRevenueService` | src/services/referralRevenueService.js | ✅ en endpoints de referidos |
| 256 | `./src/services/jugayganaUserLinkService` | src/services/jugayganaUserLinkService.js | ✅ `resolveJugayganaUserId` |
| 433 | `compression` | npm | ✅ `app.use(compression(...))` |
| 688 | `./src/routes/notificationRoutes` | src/routes/notificationRoutes.js | ✅ `app.use('/api/notifications', ...)` |
| 692 | `./src/services/notificationService` | src/services/notificationService.js | ✅ `sendNotificationToUser` |
| **2687** | `./jugaygana-sync` | jugaygana-sync.js | ⚠️ **CARGADO PERO NUNCA LLAMADO** — `const jugayganaSync = require(...)` declarado, pero ningún método de `jugayganaSync` se invoca. En línea 2131 hay una variable LOCAL que re-requiere `./jugaygana`, no `./jugaygana-sync`. |
| 1083–1084 | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | npm (optional) | ✅ lazy require dentro de endpoint de upload |
| 6574 | `./src/routes/referralRoutes` | src/routes/referralRoutes.js | ✅ `app.use('/api/referrals', ...)` |
| 6611 | `./src/middlewares/errorHandler` | src/middlewares/errorHandler.js | ✅ error handler global |

**`server.js` NO toca:**
- `src/config/database.js` (solo la usa `server-new.js`)
- `src/config/socket.js` (solo `server-new.js` y `adminController.js`, ambos huérfanos)
- `src/routes/index.js` (solo `server-new.js`)
- `src/routes/auth/chat/admin/userRoutes.js` (solo vía `index.js`)
- Ningún controller excepto `referralController.js`
- `src/services/authService`, `chatService`, `transactionService`, `refundService`, `index.js`

---

## 2. Mapa de dependencias de `server-new.js` y la carpeta `src/`

### ¿`server-new.js` está referenciado desde algún lado?

```
grep "server-new" en todo el proyecto → 0 resultados (excepto comentario en server.js línea 2)
```

**`server-new.js` es completamente huérfano.** Nada lo llama, nada lo importa.

### Grafo `server-new.js` → src/

```
server-new.js
├── src/config/database.js          ← NO usada por server.js
├── src/config/socket.js            ← NO usada por server.js
├── src/utils/logger.js             ← SÍ usada por server.js (indirectamente)
├── src/middlewares/security.js     ← SÍ usada por server.js
├── src/middlewares/errorHandler.js ← SÍ usada por server.js
└── src/routes/index.js             ← NO usada por server.js
    ├── src/routes/authRoutes.js    ← HUÉRFANO
    │   └── src/controllers/authController.js  ← HUÉRFANO
    │       └── src/services/authService.js    ← HUÉRFANO
    ├── src/routes/chatRoutes.js    ← HUÉRFANO
    │   └── src/controllers/chatController.js  ← HUÉRFANO
    │       └── src/services/chatService.js    ← HUÉRFANO
    ├── src/routes/adminRoutes.js   ← HUÉRFANO
    │   ├── src/controllers/adminController.js ← HUÉRFANO
    │   │   ├── src/config/socket.js           ← HUÉRFANO
    │   │   └── src/services/index.js (barrel) ← HUÉRFANO
    │   ├── src/controllers/transactionController.js ← HUÉRFANO
    │   └── src/controllers/refundController.js      ← HUÉRFANO
    │       └── src/services/refundService.js        ← HUÉRFANO
    │           └── ../../models/refunds.js          (real, usado por server.js)
    └── src/routes/userRoutes.js    ← HUÉRFANO
        ├── src/controllers/transactionController.js ← HUÉRFANO
        ├── src/controllers/refundController.js      ← HUÉRFANO
        └── src/controllers/fireController.js        ← HUÉRFANO
```

### Archivos de `src/` que SÍ usa `server.js` directamente

- `src/routes/notificationRoutes.js` (línea 688) → `src/services/notificationService.js`
- `src/routes/referralRoutes.js` (línea 6574) → `src/controllers/referralController.js` → `src/services/referralCalculationService.js`, `src/services/referralPayoutService.js`, `src/middlewares/auth.js`
- Servicios directos: `jugayganaService`, `jugayganaUserLinkService`, `otpService`, `smsService`, `referralRevenueService`, `notificationService`
- Utils directos: `redisClient`, `referralCode`
- Middlewares directos: `security.js`, `errorHandler.js`
- Config directa: `loadSecrets.js`
- Modelos: todos vía `config/database.js → ../src/models/index.js`

### `src/routes/notificationRoutes.js` (ACTIVO)
Tiene un `require('../../config/database')` en línea 19 (usa `User` del config legacy, no del src). ✅ Correcto, ya cargado.

---

## 3. Duplicados raíz vs `src/`

| Par | Estado | Evidencia |
|-----|--------|-----------|
| `jugaygana.js` (raíz, 1204 líneas) vs `src/services/jugayganaService.js` | **AMBOS activos y complementarios** | `server.js` importa los dos (líneas 251 y 253). Funciones distintas: jugaygana.js tiene `syncUserToPlatform`, `creditUserBalance`, rangos de fecha; jugayganaService.js tiene `loginAsUser`, `changeUserPasswordAsAdmin`. NO son duplicados intercambiables. |
| `jugaygana-movements.js` vs `config/jugaygana-movements.js` | jugaygana-movements.js **ACTIVO**; config/jugaygana-movements.js **STUB MUERTO** | `config/jugaygana-movements.js` es un stub de 26 líneas que devuelve arrays vacíos. Nunca importado por nadie. `jugaygana-movements.js` (raíz, 445 líneas) sí se usa (server.js línea 252). |
| `jugaygana-sync.js` vs `scripts/sync-all-users.js` | Ambos para sincronización masiva, ambos dudosos | `jugaygana-sync.js` es requerido por server.js (línea 2687) pero nunca llamado. `scripts/sync-all-users.js` no está en npm scripts. |
| `config/database.js` vs `src/config/database.js` | `config/database.js` **ACTIVO**; `src/config/database.js` **SOLO usada por server-new.js** | `server.js` línea 63: `require('./config/database')`. Las dos son distintas: config/database.js re-exporta src/models + agrega ExternalUser/UserActivity + helpers. |
| `config/jugaygana.js` (stub) vs `jugaygana.js` (real) | `config/jugaygana.js` **MUERTO**. `jugaygana.js` **ACTIVO** | Grep confirma cero imports a `config/jugaygana.js` en todo el proyecto. |
| `config/refunds.js` (stub) vs `models/refunds.js` (real) | `config/refunds.js` **MUERTO**; `models/refunds.js` **ACTIVO** (server.js línea 254) | Grep: nadie importa `config/refunds.js`. |
| `models/refunds.js` (raíz) vs `src/models/RefundClaim.js` | **Coexisten con roles distintos**: `RefundClaim.js` es el Schema Mongoose; `models/refunds.js` es capa de servicio que usa `RefundClaim` | `models/refunds.js` línea 6: `const { RefundClaim } = require('../config/database')`. Ambos activos. |

---

## 4. Carpeta `scripts/`

| Script | Depende de | En npm scripts | Veredicto |
|--------|-----------|----------------|-----------|
| `scripts/sync-all-users.js` | `config/database`, `jugaygana.js`, bcrypt, uuid | ❌ No | Import masivo one-off desde JUGAYGANA. Si ya se importaron los usuarios, archivar. |
| `scripts/send-notification.js` | `firebase-admin` | ❌ No | Utilidad manual de envío de notificaciones via CLI. Archivar si no se usa. |
| `scripts/backfill-jugaygana-userid.js` | `mongoose`, `src/services/jugayganaService.js` | ❌ No | Backfill one-off para llenar `jugayganaUserId`. Si ya corrió, archivar. |

Ninguno de los tres tiene un script npm. Son herramientas de mantenimiento, no parte del servidor.

---

## 5. Carpeta `data/`

| Archivo | Quién lo usa | Contenido actual | Veredicto |
|---------|-------------|------------------|-----------|
| `data/users.json` | Solo `jugaygana-sync.js` (línea 15) | `[]` (vacío) | ❌ ELIMINAR si se elimina jugaygana-sync.js |
| `data/sync-log.json` | Solo `jugaygana-sync.js` (línea 16) | `{"lastSync":null,"totalSynced":0}` | ❌ ELIMINAR si se elimina jugaygana-sync.js |

`jugaygana-sync.js` es requerido por server.js (línea 2687) pero **ninguno de sus métodos es llamado** en producción. Solo corre su código de inicialización de módulo (crea los archivos si no existen).

---

## 6. Frontend `public/`

### `public/index.html` — CSS y JS cargados

**CSS** (todos referenciados, ninguno huérfano):
```
/css/base.css, /css/login.css, /css/header.css, /css/chat.css, /css/modals.css, /css/responsive.css
```

**JS** (todos referenciados, ninguno huérfano):
```
CDN: socket.io/socket.io.js, firebase-app-compat.js, firebase-messaging-compat.js
Local: /js/config.js, /js/auth.js, /js/socket.js, /js/chat.js, /js/refunds.js,
       /js/fire.js, /js/notifications.js, /js/ui.js, /js/app.js
```

**Service Worker registrado:**
```js
// index.html (aprox. línea 939):
navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' })
```
Solo se registra `firebase-messaging-sw.js`. **`user-sw.js` ya no se registra activamente.**

### `public/adminprivado2026/index.html` — CSS y JS cargados

**CSS**: `/adminprivado2026/admin.css`

**JS**:
```
CDN: socket.io/socket.io.js, firebase-app-compat.js, firebase-messaging-compat.js
Local: /adminprivado2026/admin.js
```

**Service Worker registrado:**
```js
// adminprivado2026/index.html (aprox. línea 1390):
navigator.serviceWorker.register('/admin-sw.js', { scope: '/adminprivado2026/', updateViaCache: 'none' })
```

### Estado de los Service Workers

| SW | Quién lo registra | Estado |
|----|------------------|--------|
| `public/firebase-messaging-sw.js` | `public/index.html` (usuario) | ✅ ACTIVO — SW principal con FCM + caché |
| `public/admin-sw.js` | `adminprivado2026/index.html` | ✅ ACTIVO — SW del panel admin con FCM + caché |
| `public/user-sw.js` | **Nadie** (ya no se registra) | 🟡 STUB DE MIGRACIÓN — Se auto-desregistra si un browser antiguo aún lo tiene activo. Una vez que todos los clientes hayan migrado, se puede eliminar con seguridad. |

**Ningún JS ni CSS en `public/` está huérfano.** Todos los archivos en `public/css/` y `public/js/` están referenciados por `public/index.html`.

---

## 7. Documentación

| Archivo | Estado | Nota |
|---------|--------|------|
| `DEPLOYMENT_AWS.md` | 📚 VIGENTE | Describe AWS EB + ElastiCache Redis. Alineado con la arquitectura actual. Conservar. |
| `FLUJO-AUTOMATICO.md` | 📚 PARCIALMENTE OBSOLETO | Menciona `/admin-panel.html`, pero el panel real está en `/adminprivado2026/`. El flujo general de notificaciones sigue siendo correcto. Actualizar esa referencia. |
| `GUIA-FIREBASE-PASO-A-PASO.md` | 📚 REFERENCIAL | Firebase ya está configurado. Guía útil para nuevos desarrolladores. Conservar. |

---

## 8. `vercel.json`

`vercel.json` enruta todo a `server.js` vía `@vercel/node`. Correcto para staging/review apps.  
`DEPLOYMENT_AWS.md` describe AWS EB como plataforma de producción (ambos pueden coexistir).  
**Veredicto: Conservar.**

---

## 9. `.nvmrc` y `.gitignore`

- `.nvmrc`: contiene `20` — ✅ alineado con `package.json engines: "node": ">=20.x"`
- `.gitignore`: cubre `node_modules/`, `.env`, logs. Minimalista pero funcional. ✅

---

## 10. Dependencias de `package.json`

### Paquetes declarados pero NO usados en producción

| Paquete | Sección | Evidencia |
|---------|---------|-----------|
| `body-parser` | `dependencies` | `grep -rn "body-parser\|bodyParser" --include="*.js"` → **0 resultados** en todo el proyecto |
| `morgan` | `dependencies` | Solo usado en `server-new.js` (huérfano). `server.js` usa Winston directamente. |

### Paquetes usados pero declarados como `optionalDependencies`

| Paquete | Observación |
|---------|-------------|
| `@aws-sdk/client-s3` | Usado con `require()` inline en server.js líneas 1083–1084. Si el endpoint S3 de upload es activo, mover a `dependencies`. |
| `@aws-sdk/s3-request-presigner` | Ídem. |

### Todos los demás paquetes están declarados Y usados

| npm package | Usado en |
|------------|---------|
| `@aws-sdk/client-sns` | smsService.js |
| `@aws-sdk/client-ssm` | loadSecrets.js |
| `@socket.io/redis-adapter` | server.js:25 |
| `axios` | jugaygana.js, jugaygana-movements.js, referralRevenueService.js |
| `bcryptjs` | server.js, otpService.js |
| `compression` | server.js:433 |
| `cors` | server.js:15 |
| `dotenv` | server.js:8 |
| `express` | server.js, routes |
| `express-mongo-sanitize` | server.js:27 |
| `express-rate-limit` | server.js:23 |
| `firebase-admin` | notificationService.js |
| `form-data` | jugaygana.js, jugayganaService.js |
| `helmet` | security.js → server.js |
| `hpp` | security.js → server.js |
| `https-proxy-agent` | jugaygana-movements.js, referralRevenueService.js |
| `jsonwebtoken` | server.js:17 |
| `mongoose` | server.js:22, models/ |
| `redis` | server.js:24 |
| `socket.io` | server.js:14 |
| `uuid` | server.js:19, models/refunds.js |
| `winston` | server.js:26 |
| `xss-clean` | server.js:28 |

---

## Tabla Final — Clasificación Completa de Archivos

### Raíz

| Archivo | Clasificación | Razón |
|---------|--------------|-------|
| `server.js` | ✅ CRÍTICO | Entry point producción |
| `server-new.js` | ❌ HUÉRFANO | No referenciado desde ningún lado. Refactor inacabado. |
| `jugaygana.js` | ✅ CRÍTICO | server.js líneas 251, 2131; +30 llamadas activas |
| `jugaygana-movements.js` | ✅ CRÍTICO | server.js línea 252; `getUserBalance`, `getUserMovements`, `makeBonus` |
| `jugaygana-sync.js` | 🟡 DUDOSO | Requerido en server.js línea 2687 pero **ningún método llamado**. Puede eliminarse y luego borrar línea 2687 de server.js. |
| `package.json` | ⚙️ CONFIG | |
| `package-lock.json` | ⚙️ CONFIG | |
| `vercel.json` | ⚙️ CONFIG | |
| `.nvmrc` | ⚙️ CONFIG | |
| `.gitignore` | ⚙️ CONFIG | |
| `DEPLOYMENT_AWS.md` | 📚 DOCS | Vigente |
| `FLUJO-AUTOMATICO.md` | 📚 DOCS | Parcialmente obsoleto (ref a /admin-panel.html) |
| `GUIA-FIREBASE-PASO-A-PASO.md` | 📚 DOCS | Referencial |

### `config/`

| Archivo | Clasificación | Razón |
|---------|--------------|-------|
| `config/database.js` | ✅ CRÍTICO | server.js línea 63; provee modelos + helpers + connectDB |
| `config/jugaygana.js` | ❌ HUÉRFANO | Stub mock. Cero imports en todo el proyecto. |
| `config/jugaygana-movements.js` | ❌ HUÉRFANO | Stub mock. Cero imports. |
| `config/refunds.js` | ❌ HUÉRFANO | Stub mock. Cero imports. |

### `models/`

| Archivo | Clasificación | Razón |
|---------|--------------|-------|
| `models/refunds.js` | ✅ CRÍTICO | server.js línea 254; funciones de reembolso |

### `data/`

| Archivo | Clasificación | Razón |
|---------|--------------|-------|
| `data/users.json` | ❌ HUÉRFANO | Solo escrito/leído por `jugaygana-sync.js` (inactivo). Contenido: `[]` |
| `data/sync-log.json` | ❌ HUÉRFANO | Ídem. Contenido: `{"lastSync":null,"totalSynced":0}` |

### `scripts/`

| Archivo | Clasificación | Razón |
|---------|--------------|-------|
| `scripts/backfill-jugaygana-userid.js` | 🟡 DUDOSO | Migration one-off. Archivar si ya corrió. |
| `scripts/send-notification.js` | 🟡 DUDOSO | Utilidad operacional manual. Archivar si no se usa. |
| `scripts/sync-all-users.js` | 🟡 DUDOSO | Import masivo one-off. Archivar si ya corrió. |

### `src/config/`

| Archivo | Clasificación | Razón |
|---------|--------------|-------|
| `src/config/database.js` | ❌ HUÉRFANO | Solo usada por `server-new.js` (huérfano) |
| `src/config/loadSecrets.js` | ✅ CRÍTICO | server.js línea 10 |
| `src/config/socket.js` | ❌ HUÉRFANO | Solo `server-new.js` y `adminController.js` (ambos huérfanos) |

### `src/controllers/`

| Archivo | Clasificación | Razón |
|---------|--------------|-------|
| `src/controllers/adminController.js` | ❌ HUÉRFANO | Solo vía `adminRoutes.js → index.js → server-new.js` |
| `src/controllers/authController.js` | ❌ HUÉRFANO | Solo vía `authRoutes.js → index.js → server-new.js` |
| `src/controllers/chatController.js` | ❌ HUÉRFANO | Solo vía `chatRoutes.js → index.js → server-new.js` |
| `src/controllers/fireController.js` | ❌ HUÉRFANO | Solo vía `userRoutes.js → index.js → server-new.js` |
| `src/controllers/refundController.js` | ❌ HUÉRFANO | Solo vía `adminRoutes + userRoutes → index.js → server-new.js` |
| `src/controllers/referralController.js` | ✅ CRÍTICO | `src/routes/referralRoutes.js → server.js` línea 6574 |
| `src/controllers/transactionController.js` | ❌ HUÉRFANO | Solo vía `adminRoutes + userRoutes → index.js → server-new.js` |

### `src/middlewares/`

| Archivo | Clasificación | Razón |
|---------|--------------|-------|
| `src/middlewares/auth.js` | ✅ CRÍTICO | `src/routes/referralRoutes.js` (activo) |
| `src/middlewares/errorHandler.js` | ✅ CRÍTICO | server.js línea 6611 |
| `src/middlewares/security.js` | ✅ CRÍTICO | server.js línea 71 (`validateInternationalPhone`) |

### `src/models/` — Todos CRÍTICOS

Todos cargados vía `src/models/index.js → config/database.js → server.js` línea 25.

| Archivo | Clasificación |
|---------|--------------|
| `src/models/ChatStatus.js` | ✅ CRÍTICO |
| `src/models/Command.js` | ✅ CRÍTICO |
| `src/models/Config.js` | ✅ CRÍTICO |
| `src/models/FireStreak.js` | ✅ CRÍTICO |
| `src/models/Message.js` | ✅ CRÍTICO |
| `src/models/OtpCode.js` | ✅ CRÍTICO |
| `src/models/ReferralCommission.js` | ✅ CRÍTICO |
| `src/models/ReferralEvent.js` | ✅ CRÍTICO (también directo server.js línea 66) |
| `src/models/ReferralPayout.js` | ✅ CRÍTICO |
| `src/models/RefundClaim.js` | ✅ CRÍTICO |
| `src/models/Transaction.js` | ✅ CRÍTICO |
| `src/models/User.js` | ✅ CRÍTICO |
| `src/models/index.js` | ✅ CRÍTICO |

### `src/routes/`

| Archivo | Clasificación | Razón |
|---------|--------------|-------|
| `src/routes/index.js` | ❌ HUÉRFANO | Solo `server-new.js` línea 32 |
| `src/routes/adminRoutes.js` | ❌ HUÉRFANO | Solo vía `index.js → server-new.js` |
| `src/routes/authRoutes.js` | ❌ HUÉRFANO | Solo vía `index.js → server-new.js` |
| `src/routes/chatRoutes.js` | ❌ HUÉRFANO | Solo vía `index.js → server-new.js` |
| `src/routes/notificationRoutes.js` | ✅ CRÍTICO | server.js línea 688 |
| `src/routes/referralRoutes.js` | ✅ CRÍTICO | server.js línea 6574 |
| `src/routes/userRoutes.js` | ❌ HUÉRFANO | Solo vía `index.js → server-new.js` |

### `src/services/`

| Archivo | Clasificación | Razón |
|---------|--------------|-------|
| `src/services/authService.js` | ❌ HUÉRFANO | Solo `authController.js` (huérfano) |
| `src/services/chatService.js` | ❌ HUÉRFANO | Solo `chatController.js` (huérfano) |
| `src/services/index.js` | ❌ HUÉRFANO | Solo controllers huérfanos |
| `src/services/jugayganaService.js` | ✅ CRÍTICO | server.js línea 253 |
| `src/services/jugayganaUserLinkService.js` | ✅ CRÍTICO | server.js línea 256 |
| `src/services/notificationService.js` | ✅ CRÍTICO | server.js línea 692; notificationRoutes |
| `src/services/otpService.js` | ✅ CRÍTICO | server.js línea 69 |
| `src/services/referralCalculationService.js` | ✅ CRÍTICO | referralController.js |
| `src/services/referralPayoutService.js` | ✅ CRÍTICO | referralController.js |
| `src/services/referralRevenueService.js` | ✅ CRÍTICO | server.js línea 255 |
| `src/services/refundService.js` | ❌ HUÉRFANO | Solo `refundController.js` (huérfano) y `src/services/index.js` (huérfano). server.js usa directamente `models/refunds.js`. |
| `src/services/smsService.js` | ✅ CRÍTICO | server.js línea 70; otpService.js |
| `src/services/transactionService.js` | ❌ HUÉRFANO | Solo controllers huérfanos |

### `src/utils/`

| Archivo | Clasificación | Razón |
|---------|--------------|-------|
| `src/utils/AppError.js` | ✅ CRÍTICO | errorHandler.js, auth.js, referralController.js |
| `src/utils/asyncHandler.js` | ✅ CRÍTICO | referralController.js |
| `src/utils/logger.js` | ✅ CRÍTICO | security.js, errorHandler.js, referralController.js, jugayganaService.js, etc. |
| `src/utils/periodKey.js` | ✅ CRÍTICO | referralController.js, referralPayoutService.js, referralRevenueService.js |
| `src/utils/redisClient.js` | ✅ CRÍTICO | server.js línea 68 |
| `src/utils/referralCode.js` | ✅ CRÍTICO | server.js línea 67 |
| `src/utils/referralRate.js` | ✅ CRÍTICO | referralCalculationService.js |

### `public/`

| Archivo | Clasificación | Razón |
|---------|--------------|-------|
| `public/index.html` | ✅ CRÍTICO | SPA principal |
| `public/manifest.json` | ✅ CRÍTICO | Referenciado en index.html |
| `public/user-sw.js` | 🟡 DUDOSO | Migration stub. Ya no se registra activamente (index.html registra firebase-messaging-sw.js). Se auto-desregistra en navegadores viejos. Eliminar cuando se confirme migración completa. |
| `public/admin-sw.js` | ✅ CRÍTICO | Registrado por adminprivado2026/index.html |
| `public/firebase-messaging-sw.js` | ✅ CRÍTICO | Registrado por index.html |
| `public/css/base.css` | ✅ CRÍTICO | index.html |
| `public/css/login.css` | ✅ CRÍTICO | index.html |
| `public/css/header.css` | ✅ CRÍTICO | index.html |
| `public/css/chat.css` | ✅ CRÍTICO | index.html |
| `public/css/modals.css` | ✅ CRÍTICO | index.html |
| `public/css/responsive.css` | ✅ CRÍTICO | index.html |
| `public/js/app.js` | ✅ CRÍTICO | index.html |
| `public/js/auth.js` | ✅ CRÍTICO | index.html |
| `public/js/chat.js` | ✅ CRÍTICO | index.html |
| `public/js/config.js` | ✅ CRÍTICO | index.html |
| `public/js/fire.js` | ✅ CRÍTICO | index.html |
| `public/js/notifications.js` | ✅ CRÍTICO | index.html |
| `public/js/refunds.js` | ✅ CRÍTICO | index.html |
| `public/js/socket.js` | ✅ CRÍTICO | index.html |
| `public/js/ui.js` | ✅ CRÍTICO | index.html |
| `public/icons/*.png` (10 archivos) | ✅ CRÍTICO | SWs + manifest |
| `public/adminprivado2026/index.html` | ✅ CRÍTICO | Panel admin |
| `public/adminprivado2026/admin.js` | ✅ CRÍTICO | Panel admin |
| `public/adminprivado2026/admin.css` | ✅ CRÍTICO | Panel admin |
| `public/adminprivado2026/manifest.json` | ✅ CRÍTICO | Panel admin PWA |

---

## Resumen ejecutivo — Acciones recomendadas

### 1. Archivos seguros para eliminar (❌ HUÉRFANO con evidencia de cero referencias activas)

**Root:**
- `server-new.js`

**`config/` (todos stubs mock, cero imports):**
- `config/jugaygana.js`
- `config/jugaygana-movements.js`
- `config/refunds.js`

**`data/` (usados solo por jugaygana-sync que es deadweight):**
- `data/users.json`
- `data/sync-log.json`

**`src/` — rutas huérfanas:**
- `src/routes/index.js`
- `src/routes/adminRoutes.js`
- `src/routes/authRoutes.js`
- `src/routes/chatRoutes.js`
- `src/routes/userRoutes.js`

**`src/` — controllers huérfanos:**
- `src/controllers/adminController.js`
- `src/controllers/authController.js`
- `src/controllers/chatController.js`
- `src/controllers/fireController.js`
- `src/controllers/refundController.js`
- `src/controllers/transactionController.js`

**`src/` — servicios huérfanos:**
- `src/services/authService.js`
- `src/services/chatService.js`
- `src/services/index.js`
- `src/services/refundService.js`
- `src/services/transactionService.js`

**`src/config/` — huérfanos:**
- `src/config/database.js`
- `src/config/socket.js`

### 2. Limpieza en `server.js` (1 línea)

```js
// server.js línea 2687 — eliminar este require (el módulo se carga pero nunca se usa):
const jugayganaSync = require('./jugaygana-sync');
```

Con eso, `jugaygana-sync.js` (raíz, 471 líneas) también puede eliminarse, y con él `data/users.json` y `data/sync-log.json`.

### 3. Scripts de mantenimiento (decidir según si ya corrieron)

- `scripts/backfill-jugaygana-userid.js` — archivar si ya corrió
- `scripts/send-notification.js` — archivar si ya no se usa
- `scripts/sync-all-users.js` — archivar si ya corrió

### 4. Cambios en `package.json`

```bash
# Eliminar paquetes no usados:
npm uninstall body-parser   # nunca requerido en ningún archivo
npm uninstall morgan        # solo server-new.js (huérfano)

# Opcional — si el endpoint S3 upload es activo, mover a dependencies:
# @aws-sdk/client-s3
# @aws-sdk/s3-request-presigner
```

### 5. Documentación

- `FLUJO-AUTOMATICO.md`: actualizar referencia `/admin-panel.html` → `/adminprivado2026/` para precisión.

---

## Leyenda

| Símbolo | Significado |
|---------|-------------|
| ✅ CRÍTICO | Usado por server.js o el frontend cargado. NO borrar. |
| 🟡 DUDOSO | Importado por código aparentemente muerto, o referenciado solo por docs. Revisar manualmente. |
| ❌ HUÉRFANO / DEAD CODE | Nadie lo importa, no se ejecuta en producción. Seguro borrar. |
| 📚 DOCUMENTACIÓN | Markdown. Conservar (revisar vigencia). |
| ⚙️ CONFIG | Necesario para deploy. |
