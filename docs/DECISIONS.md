# Decisiones de diseño

Cada decisión indica la alternativa considerada y sus consecuencias.

## 1. Modelo de transacciones: una fila por hecho económico
**Decisión:** una fila con `account_id` (origen) y `to_account_id` (destino) para movimientos entre
cuentas propias; `amount` siempre positivo; `type` define el efecto.
**Alternativa:** partida doble con dos filas (débito/crédito) unidas por `transfer_group_id`.
**Por qué:** imposible "perder" una pata de una transferencia, `client_id` idempotente por hecho,
consultas más simples y sincronización Android más segura. `transfer_group_id` existe para agrupar
operaciones compuestas cuando haga falta.
**Consecuencia:** cambiar a doble partida en el futuro requiere una migración de datos (mecánica).

## 2. Dinero
**Decisión:** `numeric(14,2)` en PostgreSQL; centavos enteros (`Cents`) en TypeScript; cadenas
decimales en la API. Redondeo "half away from zero" al centavo en porcentajes/intereses.
**Alternativa:** librería de decimales arbitrarios en el cliente. Innecesaria para importes de 2
decimales hasta ~90 billones de centavos (rango seguro de enteros JS).

## 3. Saldos calculados, no almacenados
**Decisión:** saldo = saldo inicial + movimientos desde `opening_balance_date`. Los movimientos
anteriores a esa fecha (p. ej. importados de estados viejos) **no** alteran el saldo, porque el
saldo inicial ya los incluye.
**Consecuencia:** si la persona escribe mal el saldo inicial, se corrige editándolo o con una
conciliación (ajuste auditado), nunca editando saldos a mano.

## 4. Sueldo como parámetro
El sueldo vive en `profiles` y no genera transacciones automáticas (evita ingresos "fantasma").
Cada cambio queda en `profile_income_history`. La entrada real se registra cuando ocurre.

## 5. Fechas de tarjeta
Los días de corte/límite de la cuenta son **referencias** para estimar. Si existe un ciclo
registrado (`credit_card_cycles`), sus fechas reales prevalecen. Días 29–31 se ajustan al último
día de meses cortos. Pago mínimo y de contado nunca se estiman: solo se muestran si se registraron.

## 6. Multimoneda
Una cuenta por moneda (la tarjeta "Multimonedas" = una cuenta DOP y otra USD). Transferencias
entre monedas se rechazan en la base de datos hasta implementar tasas de cambio explícitas.

## 7. IA: solo sugiere
La IA nunca escribe importes, fechas, cuentas ni categorías confirmadas, y no crea filas. Las
sugerencias viven en `ai_suggestion` con `ai_status = 'suggested'` y se aceptan o descartan.
El importe en Modo Simple lo extrae un intérprete determinístico y la persona lo confirma antes de guardar.

## 8. Base de conocimiento sin verificar
Las entradas semilla son resúmenes educativos con fuente citada y `verification_date = NULL`.
No se marcaron como verificadas porque nadie las ha contrastado todavía con el texto original de
la fuente; el asesor lo comunica. Verificar = revisar y actualizar `verification_date`.

## 9. Importador PDF
Procesa el PDF en el navegador (no se sube), guarda solo la huella SHA-256 y metadatos del lote.
El intérprete se construyó con heurísticas y textos sintéticos: **no** se presenta como validado
contra Banreservas. La vista previa editable y la deduplicación con revisión manual son obligatorias.
Duplicados "exactos" o "probables" se desmarcan por defecto pero nunca se descartan automáticamente.

## 10. Sincronización web
Solo la creación de movimientos funciona sin conexión (cola local idempotente). Ediciones y
operaciones complejas requieren conexión para no generar conflictos silenciosos. Android tendrá
cola completa (ver `docs/ANDROID_CONTRACT.md`).

## 11. Borrado
Soft-delete en todas las tablas y sin privilegio `DELETE` para usuarios. Solo al eliminar la
cuenta de Auth se borran físicamente los datos (cascade).
