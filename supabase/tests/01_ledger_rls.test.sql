-- Pruebas de integración de migraciones: reglas contables, RLS y conciliación.
-- Cada bloque DO falla (y aborta el script) si una aserción no se cumple.
\set ON_ERROR_STOP 1

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, false);
  execute 'set role authenticated';
end $$;

create or replace function pg_temp.expect_error(p_sql text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'OK (rechazado como se esperaba): % → %', p_label, sqlerrm;
    return;
  end;
  raise exception 'FALLO: se esperaba error en "%"', p_label;
end $$;

grant execute on all functions in schema pg_temp to authenticated, anon;

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@test.local'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b@test.local');

-- Alta de usuario: perfil + categorías
do $$ begin
  assert (select count(*) from public.profiles) = 2, 'se esperaban 2 perfiles';
  assert (select count(*) from public.categories where user_id = 'aaaaaaaa-0000-0000-0000-000000000001') >= 20,
    'categorías por defecto no sembradas';
end $$;

-- ===================== Usuario A =====================
select pg_temp.act_as('aaaaaaaa-0000-0000-0000-000000000001');

select public.complete_onboarding(jsonb_build_object(
  'salary_amount', '24240.00', 'salary_frequency', 'monthly', 'salary_pay_days', jsonb_build_array(30),
  'accounts', jsonb_build_array(
    jsonb_build_object('client_id', '11111111-0000-0000-0000-000000000001', 'name', 'Débito Banreservas',
      'institution', 'Banreservas', 'kind', 'checking', 'opening_balance', '10000.00',
      'opening_balance_date', (current_date - 30)::text, 'is_salary_account', true),
    jsonb_build_object('client_id', '11111111-0000-0000-0000-000000000002', 'name', 'Ahorro Visa Banreservas',
      'institution', 'Banreservas', 'kind', 'savings', 'opening_balance', '0',
      'opening_balance_date', (current_date - 30)::text),
    jsonb_build_object('client_id', '11111111-0000-0000-0000-000000000003', 'name', 'Crédito Visa Multimonedas',
      'institution', 'Banreservas', 'kind', 'credit_card', 'opening_balance', '0',
      'opening_balance_date', (current_date - 30)::text, 'credit_limit', '8000', 'annual_interest_rate_pct', '60',
      'statement_day', 30, 'payment_due_day', 21)
  ),
  'recurring_expenses', jsonb_build_array(
    jsonb_build_object('client_id', '22222222-0000-0000-0000-000000000001', 'name', 'Altice', 'amount', '1530.00',
      'account_client_id', '11111111-0000-0000-0000-000000000001', 'day_from', 21, 'day_to', 23, 'category_slug', 'telecom'),
    jsonb_build_object('client_id', '22222222-0000-0000-0000-000000000002', 'name', 'Cargo mensual tarjeta', 'amount', '1250.00',
      'account_client_id', '11111111-0000-0000-0000-000000000003', 'transaction_type', 'CARD_PURCHASE', 'day_from', 15)
  )
));
-- Idempotencia: repetir el onboarding no duplica nada
select public.complete_onboarding(jsonb_build_object(
  'accounts', jsonb_build_array(jsonb_build_object('client_id', '11111111-0000-0000-0000-000000000001',
    'name', 'Débito Banreservas', 'kind', 'checking'))));

do $$ begin
  assert (select count(*) from public.accounts) = 3, 'onboarding no idempotente (cuentas)';
  assert (select count(*) from public.recurring_expenses) = 2, 'recurrentes no creados';
  assert (select salary_account_id is not null from public.profiles), 'cuenta de sueldo no asignada';
  assert (select count(*) from public.profile_income_history) >= 2, 'historial de sueldo no registrado';
end $$;

create temp table ids as
select
  (select id from public.accounts where client_id = '11111111-0000-0000-0000-000000000001') as debit,
  (select id from public.accounts where client_id = '11111111-0000-0000-0000-000000000002') as savings,
  (select id from public.accounts where client_id = '11111111-0000-0000-0000-000000000003') as card;
grant select on ids to authenticated, anon;

insert into public.transactions (client_id, type, account_id, to_account_id, amount, occurred_on, description, adjustment_direction)
select v.client_id::uuid, v.type,
       case v.acc when 'd' then i.debit when 's' then i.savings else i.card end,
       case v.dest when 'd' then i.debit when 's' then i.savings when 'c' then i.card end,
       v.amount::numeric, current_date - v.days_ago, v.descr, v.dir
from ids i, (values
  ('33333333-0000-0000-0000-000000000001', 'INCOME', 'd', null, '24240.00', 5, 'Sueldo', null),
  ('33333333-0000-0000-0000-000000000002', 'EXPENSE', 'd', null, '850.00', 4, 'Luz', null),
  ('33333333-0000-0000-0000-000000000003', 'SAVINGS_CONTRIBUTION', 'd', 's', '1200.00', 4, 'Al ahorro', null),
  ('33333333-0000-0000-0000-000000000004', 'CARD_PURCHASE', 'c', null, '1500.00', 3, 'Supermercado', null),
  ('33333333-0000-0000-0000-000000000005', 'CARD_PAYMENT', 'd', 'c', '1000.00', 2, 'Pago tarjeta', null),
  ('33333333-0000-0000-0000-000000000006', 'ADJUSTMENT', 'c', null, '10.00', 1, 'Ajuste comisión no registrada', 'increase'),
  ('33333333-0000-0000-0000-000000000007', 'EXPENSE', 'd', null, '999.00', 40, 'Anterior al saldo inicial', null)
) as v(client_id, type, acc, dest, amount, days_ago, descr, dir);

-- Saldos: débito 10000+24240-850-1200-1000 = 31190 ; ahorro 1200 ; deuda tarjeta 1500-1000+10 = 510
do $$ declare b record; begin
  for b in select ab.account_id, ab.balance, a.client_id from public.account_balances ab join public.accounts a on a.id = ab.account_id loop
    case b.client_id::text
      when '11111111-0000-0000-0000-000000000001' then assert b.balance = 31190.00, 'saldo débito incorrecto: ' || b.balance;
      when '11111111-0000-0000-0000-000000000002' then assert b.balance = 1200.00, 'saldo ahorro incorrecto: ' || b.balance;
      when '11111111-0000-0000-0000-000000000003' then assert b.balance = 510.00, 'deuda tarjeta incorrecta: ' || b.balance;
    end case;
  end loop;
end $$;

-- Reglas semánticas
select pg_temp.expect_error($q$insert into public.transactions (type, account_id, amount, occurred_on, description)
  select 'CARD_PURCHASE', debit, 10, current_date, 'x' from ids$q$, 'compra con tarjeta en cuenta de débito');
select pg_temp.expect_error($q$insert into public.transactions (type, account_id, to_account_id, amount, occurred_on, description)
  select 'CARD_PAYMENT', debit, savings, 10, current_date, 'x' from ids$q$, 'pago de tarjeta hacia ahorro');
select pg_temp.expect_error($q$insert into public.transactions (type, account_id, amount, occurred_on, description)
  select 'TRANSFER', debit, 10, current_date, 'x' from ids$q$, 'transferencia sin destino');
select pg_temp.expect_error($q$insert into public.transactions (type, account_id, amount, occurred_on, description)
  select 'EXPENSE', debit, -5, current_date, 'x' from ids$q$, 'importe negativo');
select pg_temp.expect_error($q$insert into public.transactions (type, account_id, amount, occurred_on, description, currency)
  select 'EXPENSE', debit, 5, current_date, 'x', 'USD' from ids$q$, 'moneda distinta a la cuenta');
select pg_temp.expect_error($q$insert into public.transactions (type, account_id, amount, occurred_on, description)
  select 'ADJUSTMENT', debit, 5, current_date, 'x' from ids$q$, 'ajuste sin dirección');
select pg_temp.expect_error($q$insert into public.transactions (type, account_id, amount, occurred_on, description, related_transaction_id)
  select 'REFUND', card, 2000, current_date, 'Devolución excesiva',
    (select id from public.transactions where client_id = '33333333-0000-0000-0000-000000000004') from ids$q$,
  'devolución mayor que la compra original');
select pg_temp.expect_error($q$delete from public.transactions$q$, 'borrado físico');

-- Devolución parcial válida vinculada a la compra original: deuda 510 - 500 = 10
insert into public.transactions (type, account_id, amount, occurred_on, description, related_transaction_id)
select 'REFUND', card, 500, current_date, 'Devolución parcial',
  (select id from public.transactions where client_id = '33333333-0000-0000-0000-000000000004') from ids;
do $$ begin
  assert (select balance from public.account_balances ab join ids on ab.account_id = ids.card) = 10.00, 'devolución no aplicada';
end $$;

-- Idempotencia de client_id
select pg_temp.expect_error($q$insert into public.transactions (client_id, type, account_id, amount, occurred_on, description)
  select '33333333-0000-0000-0000-000000000002', 'EXPENSE', debit, 850, current_date, 'Luz' from ids$q$, 'client_id duplicado');

-- Soft-delete: excluido del saldo y auditado
update public.transactions set deleted_at = now() where client_id = '33333333-0000-0000-0000-000000000002';
do $$ begin
  assert (select balance from public.account_balances ab join ids on ab.account_id = ids.debit) = 32040.00,
    'soft-delete no excluido del saldo';
  assert (select count(*) from public.transaction_audit where action = 'soft_delete') = 1, 'soft-delete no auditado';
  assert (select version from public.transactions where client_id = '33333333-0000-0000-0000-000000000002') = 2,
    'versión no incrementada';
end $$;

-- Conciliación: banco dice 32050 → diferencia 10, ajuste auditable
select public.reconcile_account((select debit from ids), current_date, 32050.00, true, true, 'Prueba',
  '44444444-0000-0000-0000-000000000001');
select public.reconcile_account((select debit from ids), current_date, 32050.00, true, true, 'Prueba',
  '44444444-0000-0000-0000-000000000001'); -- idempotente
do $$ declare r record; begin
  select * into r from public.reconciliation_records;
  assert r.calculated_balance = 32040.00, 'saldo calculado incorrecto ' || r.calculated_balance;
  assert r.difference = 10.00, 'diferencia incorrecta';
  assert r.status = 'adjusted', 'estado incorrecto ' || r.status;
  assert (select count(*) from public.reconciliation_records) = 1, 'conciliación no idempotente';
  assert (select balance from public.account_balances ab join ids on ab.account_id = ids.debit) = 32050.00,
    'ajuste de conciliación no aplicado';
  assert (select source from public.transactions where id = r.adjustment_transaction_id) = 'reconciliation',
    'ajuste no identificado';
end $$;

-- Un movimiento conciliado no puede alterarse sin desconciliar
select pg_temp.expect_error($q$update public.transactions set amount = 1 where client_id = '33333333-0000-0000-0000-000000000001'$q$,
  'editar importe de movimiento conciliado');

-- Cambio de sueldo queda en el historial
update public.profiles set salary_amount = 25000;
do $$ begin
  assert (select count(*) from public.profile_income_history where new_amount = 25000 and old_amount = 24240) = 1,
    'historial de sueldo no registró el cambio';
end $$;

reset role;

-- ===================== Usuario B: aislamiento RLS =====================
select pg_temp.act_as('bbbbbbbb-0000-0000-0000-000000000002');
do $$ begin
  assert (select count(*) from public.transactions) = 0, 'RLS: B ve transacciones de A';
  assert (select count(*) from public.accounts) = 0, 'RLS: B ve cuentas de A';
  assert (select count(*) from public.account_balances) = 0, 'RLS: B ve saldos de A';
  assert (select count(*) from public.transaction_audit) = 0, 'RLS: B ve auditoría de A';
  assert (select count(*) from public.ai_knowledge_base) >= 18, 'B no puede leer la base de conocimiento';
end $$;
update public.transactions set amount = 1;  -- no debe afectar filas
reset role;
do $$ begin
  assert not exists (select 1 from public.transactions where amount = 1), 'RLS: B modificó datos de A';
end $$;
select pg_temp.act_as('bbbbbbbb-0000-0000-0000-000000000002');
select pg_temp.expect_error($q$insert into public.transactions (user_id, type, account_id, amount, occurred_on, description)
  select 'aaaaaaaa-0000-0000-0000-000000000001', 'EXPENSE', debit, 1, current_date, 'x' from ids$q$, 'B inserta a nombre de A');
select pg_temp.expect_error($q$insert into public.transactions (type, account_id, amount, occurred_on, description)
  select 'EXPENSE', debit, 1, current_date, 'x' from ids$q$, 'B usa la cuenta de A');
select pg_temp.expect_error($q$select public.reconcile_account((select debit from ids), current_date, 1)$q$,
  'B concilia cuenta de A');
reset role;

-- ===================== anon =====================
set role anon;
select pg_temp.expect_error('select * from public.transactions', 'anon lee transacciones');
select pg_temp.expect_error('select * from public.ai_knowledge_base', 'anon lee base de conocimiento');
select pg_temp.expect_error($q$select public.complete_onboarding('{}'::jsonb)$q$, 'anon ejecuta onboarding');
reset role;

-- Realtime publicado
do $$ begin
  assert (select count(*) from pg_publication_tables where pubname = 'supabase_realtime') = 11,
    'tablas faltantes en supabase_realtime';
end $$;

\echo '✔ 01_ledger_rls: todas las aserciones pasaron'
