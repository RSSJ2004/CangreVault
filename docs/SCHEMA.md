# Esquema de datos

Fuente de verdad: `supabase/migrations/*.sql`. Este documento resume el contrato para la web y
para Android. Convenciones comunes:

| Convención | Detalle |
|---|---|
| Identificadores | `id uuid` (servidor) + `client_id uuid UNIQUE` (generado por el dispositivo, idempotencia) |
| Propietario | `user_id uuid` = `auth.uid()` (por defecto); RLS `auth.uid() = user_id` |
| Dinero | `numeric(14,2)`. Enviar y leer como **cadena decimal** (`"1530.00"`) |
| Fechas contables | `date` ISO 8601 `YYYY-MM-DD` (zona de referencia America/Santo_Domingo) |
| Marcas temporales | `timestamptz` ISO 8601 con zona. `updated_at` lo fija el servidor (cursor de sync) |
| Borrado | Lógico: `deleted_at timestamptz`. Los usuarios **no** tienen privilegio `DELETE` |
| Referencias | Claves foráneas compuestas `(id, user_id)`: imposible referenciar filas de otro usuario |
| Enumeraciones | `text` + `CHECK` (fáciles de ampliar sin migraciones de tipos) |

## Tablas

| Tabla | Propósito |
|---|---|
| `profiles` | 1:1 con `auth.users`. Sueldo (parámetro de planificación), modo preferido, meses de fondo de emergencia |
| `profile_income_history` | Historial de cambios del sueldo (solo lo escribe un trigger; solo lectura) |
| `income_sources` | Ingresos adicionales previstos |
| `accounts` | Cuentas/productos: `checking, savings, cash, investment, other_asset, credit_card, loan, other_liability`. `is_liability` generado. Campos de tarjeta: `credit_limit, annual_interest_rate_pct, statement_day, payment_due_day, utilization_alert_pct` |
| `categories` | Categorías por usuario (`income, expense, savings`), sembradas al registrarse |
| `transactions` | Diario. Una fila por hecho económico (ver abajo) |
| `transaction_audit` | Versión anterior de cada edición / borrado lógico / restauración |
| `recurring_expenses` | Plantillas de gastos recurrentes (`active, paused, cancelled`) |
| `savings_goals`, `savings_contributions` | Metas y aportes/retiros (opcionalmente ligados a una transacción) |
| `credit_card_cycles` | Datos de cada estado de cuenta: período, corte, límite de pago, saldo, mínimo, contado |
| `import_batches` | Lotes de importación PDF: archivo, SHA-256, intérprete, contadores, advertencias |
| `reconciliation_records` | Saldo del banco vs saldo calculado (lo calcula el servidor), diferencia, ajuste |
| `ai_knowledge_base` | Conocimiento curado para el asesor (solo lectura para usuarios) |

Vista: `account_balances` (`security_invoker`) → saldo calculado por cuenta.

## Transacciones

`amount > 0` siempre. Efecto sobre saldos **naturales** (dinero en activos, deuda en pasivos):

| `type` | `account_id` | `to_account_id` | Efecto | Estado de resultados |
|---|---|---|---|---|
| `INCOME` | recibe | — | +importe (en tarjeta: −deuda) | Ingreso |
| `EXPENSE` | paga | — | −dinero / +deuda | Gasto (p. ej. comisiones, intereses) |
| `CARD_PURCHASE` | tarjeta (obligatorio) | — | +deuda | Gasto |
| `CARD_PAYMENT` | activo que paga | tarjeta (obligatorio) | −dinero, −deuda | **No** es gasto |
| `TRANSFER` | origen | destino (obligatorio) | −origen, +destino | Excluido |
| `SAVINGS_CONTRIBUTION` | origen | ahorro/inversión (obligatorio) | −origen, +destino | Ahorro (no gasto) |
| `INVESTMENT` | origen | inversión/ahorro/otro activo (opcional) | −origen, +destino | Ahorro/inversión |
| `REFUND` | cuenta que recibe | — | +dinero / −deuda | Reduce el gasto (vincular con `related_transaction_id`) |
| `ADJUSTMENT` | cuenta | — | `adjustment_direction` `increase`/`decrease` del saldo natural | Excluido (auditado aparte) |

Validaciones en base de datos (además de la UI): moneda igual a la cuenta; destino distinto del
origen; tipos de cuenta compatibles; devoluciones ≤ importe original; ajustes con dirección;
cuentas eliminadas no admiten movimientos nuevos; un movimiento `reconciled` no cambia importe,
cuenta, fecha ni tipo sin desconciliarse; `version`, `created_at`, `updated_at` los fija el servidor.

Saldo: `opening_balance` (natural) + Σ efectos de movimientos no eliminados con
`occurred_on >= opening_balance_date`. Implementado idéntico en
`public.transaction_signed_effect` (SQL) y `src/domain/ledger.ts` (TS), con pruebas en ambos lados.

Columnas de procesamiento: `entry_mode (simple|normal|import|recurring|system)`,
`source (manual|pdf_import|recurring|reconciliation|android|api)`,
`reconciliation_status (unreconciled|reconciled|disputed)`,
`ai_status (none|pending|processing|suggested|accepted|rejected|failed|skipped)`,
`ai_suggestion jsonb`, `classification_source (user|rules|ai)`.

## Funciones RPC (solo `authenticated`)

### `complete_onboarding(p_payload jsonb)`
Atómica e idempotente (por `client_id`). Payload:
```json
{
  "salary_amount": "24240.00", "salary_frequency": "monthly", "salary_pay_days": [30], "preferred_mode": "simple",
  "accounts": [{ "client_id": "uuid", "name": "Débito Banreservas", "kind": "checking", "institution": "Banreservas",
                 "opening_balance": "0.00", "opening_balance_date": "2026-11-25", "is_salary_account": true,
                 "credit_limit": null, "annual_interest_rate_pct": null, "statement_day": null, "payment_due_day": null }],
  "recurring_expenses": [{ "client_id": "uuid", "name": "Altice", "amount": "1530.00", "account_client_id": "uuid",
                           "transaction_type": "EXPENSE", "day_from": 21, "day_to": 23, "category_slug": "telecom" }]
}
```

### `reconcile_account(p_account_id, p_reconciled_on, p_statement_balance, p_create_adjustment, p_mark_transactions, p_notes, p_client_id)`
Crea el registro de conciliación (saldo calculado por el servidor), opcionalmente un `ADJUSTMENT`
con `source = 'reconciliation'` y marca movimientos como conciliados. Idempotente por `p_client_id`.

### `account_balance_at(p_account_id, p_as_of)` / `account_signed_movements(...)`
Saldo a una fecha / suma de movimientos con signo.

## Seguridad

- RLS habilitado en todas las tablas; políticas `select/insert/update` con `(select auth.uid()) = user_id`.
- Sin políticas `DELETE`; `delete`/`truncate` revocados a `authenticated`; `anon` sin acceso.
- Funciones internas `SECURITY DEFINER` en el esquema `private` (no expuesto por la API).
- Triggers `SECURITY DEFINER` solo para escribir historial y auditoría.
- Realtime: todas las tablas con `user_id` están en la publicación `supabase_realtime`
  (Postgres Changes respeta RLS).
