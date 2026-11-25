# Integración bancaria automática (Banreservas vía Bridge)

**Estado: LISTA PARA PRODUCCIÓN (código terminado) — compatibilidad con Banreservas SIN VERIFICAR.**
Falta que la persona titular cree su cuenta de desarrollador en Bridge (acepta términos y entrega
identificación fiscal), pruebe en sandbox y compruebe si Banreservas aparece en Bridge Connect.

Fecha de la investigación: 2026-11-25.

## 1. Compatibilidad real de Banreservas

| Nivel | Resultado | Evidencia |
|---|---|---|
| Anunciada como compatible | **No verificable.** El sitio dice "todas las instituciones financieras soportadas en República Dominicana" sin publicar la lista. Los ejemplos usan bancos ficticios ("Banco Azul", "Banco Verde", "Banco Rojo"). | bridge.com.do (portada), docs.bridge.com.do |
| Disponible en sandbox | **No verificable sin cuenta.** La API no tiene un endpoint público de instituciones. | OpenAPI oficial (`/api-reference/openapi.json`): no existe `/institutions` |
| Comprobada con una conexión real | **No.** Requiere tu autorización y tus credenciales en Bridge Connect. | — |
| Solo con aprobación comercial | **Parcialmente.** Los Términos de la API (actualizados el 16-04-2026) exigen registro con razón social, RNC o identificación fiscal y contacto técnico, y dicen "Una vez aprobado el registro". | bridge.com.do/terminos-uso-api §3 |

**Cómo verificarlo** (5 minutos, una vez registrada la cuenta): en sandbox, pulsa "Conectar banco"
en `/bancos` y mira si Banreservas aparece en la lista de Bridge Connect. Para confirmar la
cobertura en producción, escribe a support@bridge.com.do (ver §8).

**APIs que NO sirven para esto:** el portal de APIs de la Superintendencia de Bancos
(desarrollador.sb.gob.do) publica estadísticas del sistema, no movimientos personales. No encontré
ninguna API pública de Banreservas para clientes personales. Tampoco se evaluaron agregadores
alternativos con documentación pública verificable: la red de esta sesión solo permitió Bridge.

## 2. Productos y datos (según la documentación oficial)

| Dato | Bridge lo ofrece | Implementado |
|---|---|---|
| Cuentas `depository` (ahorro, corriente/débito) | Sí | Sí |
| Cuentas `credit` (tarjeta de crédito) con límite | Sí (`balance.limit`) | Sí |
| Balance actual y disponible | Sí, solo si la conexión otorgó el permiso | Sí (se muestra junto al saldo calculado) |
| Transacciones `pending` / `posted` / `void` | Sí | Sí: solo `posted` se contabiliza |
| Paginación por cursor (`cursor`, `limit` 1-1000, `pagination.hasMore/nextCursor`) | Sí | Sí |
| Incremental (`refreshedSince` = `lastTransactionRefresh`) | Sí | Sí |
| Fecha de corte, fecha límite, pago mínimo | **No documentado** | No: siguen saliendo del estado de cuenta (PDF o manual) |
| Webhooks | **No documentados** (los Términos los mencionan, la API no) | No: se usa sincronización programada |
| Límites de peticiones | **No publicados** | Reintento con espera exponencial y `Retry-After` |
| Revocación (`DELETE /connections/{id}`) | Sí; los datos se conservan 30 días | Sí |
| Reconexión (Bridge Connect con `connectionId`) | Sí | Sí ("Reautorizar") |
| Tarjeta de débito como producto aparte | No: es la cuenta `depository` a la que está asociada | Se vincula esa cuenta |

**Supuesto pendiente de verificar en sandbox:** el signo de las transacciones de tarjeta. La
documentación muestra el balance de crédito negativo (deuda) y las transacciones de depósito
negativas como salidas. Se asumió que en tarjeta un importe negativo es un cargo y uno positivo un
pago o abono. Si el sandbox muestra lo contrario, hay que ajustar `classify.ts` (una línea por
caso) y sus pruebas.

## 3. Documentación y evidencias oficiales consultadas

- https://docs.bridge.com.do/intro, `/guides/connect.md`, `/guides/authentication.md`, `/guides/accounts-transactions.md`
- https://docs.bridge.com.do/api-reference/openapi.json (versión 2024-01-01): endpoints, esquemas y códigos
- https://bridge.com.do/planes, `/terminos-uso-api`, portada

## 4. Componentes implementados

| Capa | Archivo | Qué hace |
|---|---|---|
| Esquema | `supabase/migrations/20261125000900_bank_connections.sql` | `bank_connections`, `bank_external_accounts`, `bank_provider_transactions` (dato original, no editable), `bank_sync_runs`, `bank_provider_credentials` (token cifrado, sin acceso para usuarios). RLS de solo lectura. El usuario solo puede vincular cuentas (permiso por columna). Añade `source = 'bank_sync'`. |
| Abstracción | `supabase/functions/_shared/bank/provider.ts` | Interfaz `BankProvider`; CangreVault no depende de Bridge. |
| Proveedor | `.../bank/bridge.ts` | Cliente según la OpenAPI: auth doble, paginación, reintentos, errores 401/403/404/429. |
| Reglas contables | `.../bank/classify.ts` | Una fila por hecho, pago de tarjeta sin duplicar gasto, transferencias propias, devoluciones, pendientes, anulados, duplicados de manual/PDF y revisión manual de lo ambiguo. |
| Orquestación | `.../bank/sync.ts`, `.../bank/supabaseStore.ts` | Sincronización inicial e incremental, idempotente (`client_id` determinista), bitácora y estados de error o reautorización. |
| Cifrado | `.../bank/crypto.ts` | AES-256-GCM ligado al usuario (AAD). |
| Edge Function | `supabase/functions/bank-sync/index.ts` | `config`, `register` (confirma con Bridge antes de marcar activa), `sync`, `reclassify`, `resolve`, `revoke`, `scheduled`. |
| Web | `src/pages/normal/BankConnectionsPage.tsx`, `src/integrations/bank/bankClient.ts` | Conectar, vincular cuentas, saldo del banco frente al calculado, revisión, sincronizar, reautorizar, desconectar e historial. Insignia "Del banco" en las listas. |

**Android:** lee las mismas tablas por PostgREST y RLS (ver `docs/ANDROID_CONTRACT.md`). Los
movimientos sincronizados son filas normales de `transactions` con `source = 'bank_sync'`.

## 5. Pruebas ejecutadas

| Prueba | Resultado |
|---|---|
| Vitest (proyecto completo) | **111/111** (71 previas + 40 nuevas: cliente Bridge, paginación, reintentos, errores, reglas contables, idempotencia, cursor incremental, revocación, reautorización, cifrado) |
| `npm run test:db` (PostgreSQL 16, 9 migraciones) | **OK**: 16 rechazos previos + 11 nuevos (aislamiento A/B, anon, credenciales inaccesibles, el usuario no altera importes ni estados del proveedor, idempotencia por id del proveedor, vínculo de tipo incorrecto) |
| `tsc -b` y `vite build` | OK |
| `deno check` de las 3 Edge Functions | OK |
| Revisión visual de `/bancos` en Chromium (escritorio y móvil, backend simulado) | Sin desbordes ni errores |
| **Llamadas reales a Bridge (sandbox o producción)** | **NO ejecutadas**: no hay cuenta ni clave de API |

Las pruebas con proveedor y almacenamiento simulados están marcadas como dobles de prueba en sus
archivos. No sustituyen la prueba en sandbox.

## 6. Variables y credenciales

| Nombre | Dónde | Secreto |
|---|---|---|
| `VITE_BRIDGE_APPLICATION_ID` | Cloudflare Pages → Variables (build) | No (ID público de la app) |
| `BRIDGE_API_KEY` | `npx supabase secrets set` | **Sí** |
| `BANK_TOKEN_ENCRYPTION_KEY` | Secretos de Supabase. Generar con `openssl rand -base64 32` | **Sí**. Si se pierde, hay que reconectar. |
| `BANK_SYNC_CRON_SECRET` | Secretos de Supabase y Vault (para pg_cron) | **Sí** |
| `BRIDGE_API_BASE` | Opcional (por defecto `https://api.bridge.com.do`) | No |

El entorno (sandbox o producción) lo determina la clave de API: cada app de Bridge pertenece a uno.

## 7. Costos y requisitos comerciales conocidos

- **Developer (gratis):** sandbox ilimitado y **3 conexiones activas a cuentas personales**. Para
  uso personal de un solo usuario parece suficiente, pero los Términos exigen aprobación del registro.
- Estándar y Empresarial: 50 conexiones personales; los precios no se publican ("Comenzar gratis" o contacto).
- Facturación por suscripción, por adelantado (Términos §11). No se contrató nada.
- Registro con razón social, RNC o identificación fiscal y contacto técnico (Términos §3).

## 8. Bloqueos concretos

1. Sin cuenta de Bridge no se puede verificar Banreservas ni probar el sandbox.
2. Webhooks no documentados: la automatización usa sincronización programada.
3. Fechas de corte y pago mínimo no están en la API: siguen viniendo del estado de cuenta.
4. El signo de las transacciones de tarjeta está pendiente de verificar en sandbox (§2).

## 9. Pasos que requieren tu intervención (en orden)

1. Crear la cuenta en https://dash.bridge.com.do (plan Developer). Tú aceptas los términos.
2. Crear una app **Sandbox**. Copiar su *Application ID* y crear una *llave de acceso*.
3. En la carpeta del proyecto (cada comando por separado):
   ```bash
   npx supabase db push
   ```
   ```bash
   npx supabase secrets set BRIDGE_API_KEY=<llave_sandbox> BANK_TOKEN_ENCRYPTION_KEY=<openssl rand -base64 32> BANK_SYNC_CRON_SECRET=<texto_aleatorio_largo>
   ```
   ```bash
   npx supabase functions deploy bank-sync
   ```
4. En Cloudflare Pages: `VITE_BRIDGE_APPLICATION_ID=<app_id>` y volver a desplegar.
5. Abrir `/bancos` → "Conectar banco" → **¿aparece Banreservas?** Probar con las credenciales de
   prueba del sandbox, vincular cuentas y revisar los movimientos.
6. Si todo cuadra: app de **Producción**, cambiar las dos claves y conectar tus cuentas reales
   (**solo tú**, en la ventana de Bridge).
7. Sincronización programada: ejecuta este SQL en Supabase. Requiere las extensiones pg_cron y
   pg_net. Pon el secreto en Vault y no en el texto del job.
   ```sql
   select vault.create_secret('<BANK_SYNC_CRON_SECRET>', 'bank_sync_cron_secret');
   select cron.schedule('bank-sync-6h', '17 */6 * * *', $$
     select net.http_post(
       url := 'https://<project-ref>.supabase.co/functions/v1/bank-sync',
       headers := jsonb_build_object('Content-Type', 'application/json',
         'x-bank-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'bank_sync_cron_secret')),
       body := '{"action":"scheduled"}'::jsonb);
   $$);
   ```

Preguntas para support@bridge.com.do: ¿Banreservas está disponible para cuentas personales
(ahorro, corriente y tarjeta de crédito)? ¿El plan Developer admite uso personal de un solo usuario?
¿Ofrecen webhooks y con qué firma? ¿Qué límites de peticiones aplican? ¿Qué signo usan las
transacciones de tarjeta?
