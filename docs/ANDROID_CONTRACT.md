# Contrato para la app Android (Fase 2: Kotlin + Jetpack Compose)

La app Android usará **el mismo proyecto Supabase**. No se crea una segunda base de datos financiera.

## Autenticación
- Supabase Auth (supabase-kt `auth-kt`), mismo proyecto y usuarios.
- Todas las peticiones con el JWT del usuario; RLS limita los datos. Nunca incluir `service_role` en el APK.

## Tipos y serialización

| Dato | PostgreSQL | JSON (PostgREST) | Kotlin recomendado |
|---|---|---|---|
| Identificadores | `uuid` | string | `UUID` / `String` |
| Dinero | `numeric(14,2)` | **string decimal** al escribir (`"1530.00"`); al leer puede llegar como número JSON | `BigDecimal` (scale 2) o `Long` centavos. Nunca `Double` |
| Fecha contable | `date` | `"2026-11-25"` | `LocalDate` |
| Marca temporal | `timestamptz` | ISO 8601 con zona | `Instant` / `OffsetDateTime` |
| Enumeraciones | `text` + CHECK | string | `enum class` con valor desconocido de respaldo |

Para leer importes exactos se puede pedir el cast en la selección: `select=*,amount_text:amount::text`.

## Sincronización bidireccional

Realtime **no** sustituye a la sincronización: solo avisa de cambios. El protocolo es:

### Subida (push) — idempotente
1. Crear la entidad localmente (Room) con `client_id = UUID.randomUUID()` y estado `pending_sync`.
2. Enviar `POST /rest/v1/<tabla>?on_conflict=client_id` con `Prefer: resolution=merge-duplicates,return=representation`.
3. Guardar el `id`, `version` y `updated_at` devueltos; marcar `synced`.
4. Reintentar con el **mismo** `client_id` ante fallos de red (no se duplicará).
5. Errores 4xx de reglas (`23514`, `23503`, `42501`…) → marcar `failed` y mostrar el mensaje; no reintentar en bucle.
6. Enviar `source = 'android'`.

### Bajada (pull) — por cursor
- Por cada tabla: `GET /rest/v1/<tabla>?updated_at=gt.<cursor>&order=updated_at.asc&limit=1000`
  (sin filtrar `deleted_at`: las filas con `deleted_at` son **tombstones** que deben borrarse/ocultarse localmente).
- Guardar como cursor el mayor `updated_at` recibido. Paginar hasta recibir < 1000 filas.
- `updated_at` lo fija el servidor en inserciones y actualizaciones (no depende del reloj del dispositivo).

### Conflictos
- Cada actualización incrementa `transactions.version` en el servidor.
- Estrategia recomendada: *last-write-wins* por servidor, con comprobación optimista al editar:
  `PATCH /rest/v1/transactions?id=eq.<id>&version=eq.<versionLocal>` → si afecta 0 filas, hubo un cambio
  remoto: releer y pedir a la persona que resuelva.
- `transaction_audit` conserva la versión anterior de cada cambio.

### Realtime
- Canal `postgres_changes` filtrado por `user_id=eq.<uid>` en las tablas del usuario.
- Al recibir un evento: ejecutar un *pull* incremental (no aplicar el payload a ciegas).

## Reglas de negocio compartidas
- Efecto contable por tipo: ver tabla en `docs/SCHEMA.md` (portar `src/domain/ledger.ts`).
- Fechas de tarjeta, recurrentes, simulador, metas: portar `src/domain/*.ts` con sus pruebas
  (los casos de `src/domain/__tests__` sirven como especificación ejecutable).
- Intérprete de notas del Modo Simple y categorías por palabras clave:
  `supabase/functions/_shared/keywordRules.ts` + `src/domain/naturalLanguage.ts`.
- Dictado: `SpeechRecognizer` nativo → mismo intérprete (interfaz `SpeechInput`).

## Flujo Modo Simple (idéntico a la web)
1. Guardar la transacción (`entry_mode = 'simple'`, `ai_status = 'pending'`, `original_note`, `client_id`).
2. Tras sincronizar, llamar a `normalize-simple-entry` con `transaction_id`.
3. Sin conexión: queda `pending`; reintentar al reconectar. La IA nunca crea otra transacción.

## Edge Functions
Contratos en `docs/EDGE_FUNCTIONS.md` (`functions-kt`: `supabase.functions.invoke(...)`).

## Pendientes para Fase 2
- Notificaciones push (FCM) para fechas límite y recurrentes.
- OCR on-device (ML Kit) para estados escaneados.
- Cola de ediciones offline (la web solo encola creaciones).
