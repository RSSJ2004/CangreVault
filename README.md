# CangreVault — Gestión financiera personal (Fase 1: Web)

Sistema de finanzas personales para registrar, comprender, organizar, analizar y proyectar
movimientos económicos. Inicialmente orientado a **Banreservas (RD$)**, diseñado para crecer a
otros bancos, usuarios y a una app nativa **Android (Kotlin + Jetpack Compose)** que compartirá
exactamente el mismo backend Supabase.

> Regla principal: la exactitud financiera y la integridad de los datos tienen prioridad sobre
> la velocidad y la apariencia. Nada se simula: sin un proyecto Supabase real la app muestra una
> pantalla de configuración.

## Funcionalidades

| Área | Estado | Notas |
|---|---|---|
| Autenticación (correo + contraseña, enlace mágico) | ✅ | Supabase Auth |
| Onboarding con valores de referencia editables | ✅ | RPC atómica e idempotente `complete_onboarding` |
| Modo Simple (Entró / Salió dinero, texto natural, dictado web) | ✅ | Intérprete determinístico + IA opcional |
| Modo Normal: dashboard, diario, estado de resultados | ✅ | Mismos datos, sin duplicar registros |
| Motor contable (9 tipos, saldos, patrimonio, devoluciones, ajustes) | ✅ | Probado en TS **y** en SQL |
| Tarjeta de crédito (ciclos, utilización, alertas, intereses estimados) | ✅ | Fechas reales del estado prevalecen |
| Gastos recurrentes (pausar, reactivar, cancelar, eliminar, registrar pago) | ✅ | No alteran el histórico |
| Metas de ahorro y simulador 3/6/12 meses | ✅ | |
| Conciliación con ajuste auditable | ✅ | Saldo calculado por el servidor |
| Importación PDF Banreservas con vista previa y deduplicación | ⚠️ | Funciona con textos sintéticos; **no validado con un estado real** |
| OCR para PDF escaneados | 🔜 | Estrategia definida (`docs/OCR_STRATEGY.md`) |
| Exportación XLSX con fórmulas | ✅ | Fórmulas verificadas recalculando con LibreOffice |
| Asesor IA (Groq) con base de conocimiento citada | ✅* | *Requiere `GROQ_API_KEY`; sin ella, biblioteca + reglas |
| Sincronización: cola offline idempotente + Realtime | ✅ | Solo creación de movimientos funciona offline |
| Recordatorios (pago de tarjeta, recurrentes, utilización) | ✅ | Notificaciones del navegador con la app abierta |
| Conexión bancaria automática (Bridge) | ⚠️ | Código listo y probado; **Banreservas sin verificar**, falta cuenta de Bridge (`docs/BANK_INTEGRATION_REPORT.md`) |

## Stack

React 19 · TypeScript estricto · Vite · Tailwind CSS v4 · TanStack Query · Supabase (Auth,
PostgreSQL, Realtime, Edge Functions) · Groq · ExcelJS · pdf.js · Vitest.

## Estructura

```
src/
  domain/            Motor financiero PURO (sin React): dinero en centavos, fechas ISO, saldos,
                     estado de resultados, tarjeta, recurrentes, simulador, metas, deduplicación,
                     intérprete de notas, recordatorios. + __tests__/
  repositories/      Acceso a Supabase y mapeo fila <-> dominio (contrato de datos)
  sync/              Cola offline (outbox) y suscripción Realtime
  hooks/             React Query + instantánea financiera calculada
  integrations/      pdf/ (pdf.js + intérprete Banreservas), excel/ (ExcelJS), ai/, voz, notificaciones
  auth/ state/       Sesión y estado global (modo, sincronización)
  components/ pages/ Interfaz (ui/, layout/, simple/, normal/)
supabase/
  migrations/        SQL versionado (esquema, RLS, funciones, semilla de conocimiento)
  functions/         Edge Functions (Deno) + _shared/ (reglas compartidas con la web)
  tests/             Pruebas SQL de migraciones, reglas contables y RLS
docs/                Esquema, Edge Functions, contrato Android, decisiones, OCR
scripts/             test-db.sh, verify-excel.sh
```

## Puesta en marcha

### 1. Proyecto Supabase

```bash
npm install
npx supabase login
npx supabase link --project-ref <tu-project-ref>
npx supabase db push          # aplica supabase/migrations en orden
```

En el panel de Supabase: **Authentication → URL Configuration** agrega la URL de tu app
(p. ej. `http://localhost:5173`) como Site URL / Redirect URL.

### 2. Variables del frontend

```bash
cp .env.example .env.local    # completa VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY
```

Solo la clave **pública** (anon/publishable). La `service_role` nunca va al cliente; las Edge
Functions tampoco la usan.

### 3. Edge Functions e IA

```bash
npx supabase secrets set GROQ_API_KEY=gsk_... GROQ_MODEL=llama-3.3-70b-versatile
npx supabase functions deploy normalize-simple-entry
npx supabase functions deploy financial-advisor
```

Sin `GROQ_API_KEY` la app funciona: la normalización usa reglas por palabras clave y el asesor
devuelve un aviso + la biblioteca de conocimiento.

### 4. Ejecutar

```bash
npm run dev        # http://localhost:5173
npm run build      # typecheck + build de producción en dist/
```

## Pruebas

```bash
npm test              # 111 pruebas unitarias (motor, parser PDF, Excel, outbox, reglas compartidas)
npm run typecheck
npm run test:db       # aplica TODAS las migraciones en un Postgres local efímero y prueba
                      # reglas contables, RLS entre usuarios, anon, conciliación y auditoría
bash scripts/verify-excel.sh   # recalcula el XLSX con LibreOffice y compara con el motor
npx deno check supabase/functions/*/index.ts   # 3 funciones
```

`test:db` necesita binarios de PostgreSQL 15+ (no Docker). Usa un *stub* mínimo de lo que
Supabase provee (`auth.uid()`, roles, publicación Realtime) definido en
`supabase/tests/supabase_stub.sql`.

## Decisiones clave (resumen)

Detalle y alternativas en [`docs/DECISIONS.md`](docs/DECISIONS.md).

- **Una fila por hecho económico** con cuenta origen y destino; `amount` siempre positivo; el
  tipo define el efecto. Un pago de tarjeta es un movimiento entre cuentas: nunca un segundo gasto.
- **Dinero exacto**: `numeric(14,2)` en PostgreSQL; centavos enteros en TypeScript; cadenas
  decimales en la API.
- **Saldo = saldo inicial + movimientos** desde la fecha del saldo inicial. La vista
  `account_balances` lo calcula en el servidor con la misma regla que el motor TS.
- **IA solo propone**: nunca cambia importes, fechas, cuentas ni crea transacciones.
- **Soft-delete** en todo; sin permiso `DELETE` para usuarios; auditoría de cambios.

## Limitaciones conocidas y pendientes

- El intérprete de PDF de Banreservas se construyó con heurísticas y **textos sintéticos**; hay
  que validarlo con un estado de cuenta real anonimizado y añadirlo como fixture.
- OCR no implementado (estrategia documentada).
- Editar, importar, conciliar y la IA requieren conexión; solo la **creación** de movimientos
  funciona offline.
- Transferencias entre monedas distintas no soportadas (una cuenta por moneda).
- Edge Functions sin límite de peticiones propio (usar límites de Supabase/Groq).
- La base de conocimiento tiene `verification_date = NULL`: el contenido debe revisarse contra
  las fuentes antes de marcarlo como verificado.
- Notificaciones push con la app cerrada: se harán en Android.

## Documentación

- [`docs/SCHEMA.md`](docs/SCHEMA.md) — tablas, reglas contables, RLS, funciones.
- [`docs/EDGE_FUNCTIONS.md`](docs/EDGE_FUNCTIONS.md) — contratos HTTP.
- [`docs/ANDROID_CONTRACT.md`](docs/ANDROID_CONTRACT.md) — sincronización y contratos para Kotlin.
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — decisiones de diseño y consecuencias.
- [`docs/OCR_STRATEGY.md`](docs/OCR_STRATEGY.md) — plan para PDF escaneados.
- [`docs/BANK_INTEGRATION_REPORT.md`](docs/BANK_INTEGRATION_REPORT.md) — conexión bancaria (Bridge), estado y pasos.
