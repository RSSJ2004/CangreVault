-- Pruebas de la migración 0900 (conexiones bancarias): aislamiento por usuario,
-- credenciales inaccesibles, escritura solo por service_role, validación de vínculos
-- e idempotencia por identificador del proveedor.
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
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- Usuarios A y B existen (01). Datos creados como service_role (la Edge Function).
set role service_role;
create temp table ids as
select
  (select id from public.accounts where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' and kind = 'checking' and deleted_at is null order by created_at limit 1) as a_debit,
  (select id from public.accounts where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' and kind = 'credit_card' and deleted_at is null order by created_at limit 1) as a_card,
  gen_random_uuid() as conn, gen_random_uuid() as ext_dep, gen_random_uuid() as ext_card;
grant select on ids to authenticated, anon;

do $$ begin
  assert (select a_debit is not null and a_card is not null from ids), 'faltan cuentas de A creadas en 01';
end $$;

insert into public.bank_connections (id, user_id, provider, provider_connection_id, environment, institution_name)
  select conn, 'aaaaaaaa-0000-0000-0000-000000000001', 'bridge', 'con_test_1', 'sandbox', 'Banco de prueba' from ids;
insert into public.bank_provider_credentials (user_id, provider, environment, token_ciphertext, token_iv)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'bridge', 'sandbox', 'cifrado', 'iv');
insert into public.bank_external_accounts (id, user_id, connection_id, provider_account_id, provider_type, name, currency)
  select ext_dep, 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, conn, 'acc_dep', 'depository', 'Ahorros', 'DOP' from ids
  union all
  select ext_card, 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, conn, 'acc_card', 'credit', 'Visa', 'DOP' from ids;
insert into public.bank_provider_transactions (user_id, external_account_id, provider_transaction_id, amount, currency, occurred_on, description, provider_status, raw)
  select 'aaaaaaaa-0000-0000-0000-000000000001', ext_dep, 'txn_1', -150.25, 'DOP', current_date, 'Compra', 'posted', '{}'::jsonb from ids;

-- Idempotencia: el mismo identificador del proveedor no se duplica.
select pg_temp.expect_error($q$insert into public.bank_provider_transactions (user_id, external_account_id, provider_transaction_id, amount, currency, occurred_on, description, provider_status, raw)
  select 'aaaaaaaa-0000-0000-0000-000000000001', ext_dep, 'txn_1', -150.25, 'DOP', current_date, 'Compra', 'posted', '{}'::jsonb from ids$q$, 'transacción del proveedor duplicada');
select pg_temp.expect_error($q$insert into public.bank_connections (user_id, provider, provider_connection_id, environment)
  values ('bbbbbbbb-0000-0000-0000-000000000002', 'bridge', 'con_test_1', 'sandbox')$q$, 'conexión del proveedor duplicada');
-- Vínculos inválidos: tarjeta del banco → cuenta de débito.
select pg_temp.expect_error($q$update public.bank_external_accounts set account_id = (select a_debit from ids) where id = (select ext_card from ids)$q$,
  'tarjeta externa vinculada a cuenta de débito');
reset role;

-- ===================== Usuario A =====================
select pg_temp.act_as('aaaaaaaa-0000-0000-0000-000000000001');
do $$ begin
  assert (select count(*) from public.bank_connections) = 1, 'A no ve su conexión';
  assert (select count(*) from public.bank_provider_transactions) = 1, 'A no ve sus movimientos originales';
end $$;
-- A vincula sus cuentas (única escritura permitida).
update public.bank_external_accounts set account_id = (select a_debit from ids) where id = (select ext_dep from ids);
update public.bank_external_accounts set account_id = (select a_card from ids) where id = (select ext_card from ids);
do $$ begin
  assert (select count(*) from public.bank_external_accounts where account_id is not null) = 2, 'vínculo no guardado';
end $$;
select pg_temp.expect_error('select * from public.bank_provider_credentials', 'A lee credenciales cifradas');
select pg_temp.expect_error($q$update public.bank_external_accounts set balance_current = 1$q$, 'A altera balance del proveedor');
select pg_temp.expect_error($q$update public.bank_provider_transactions set amount = 1$q$, 'A altera importe original del proveedor');
select pg_temp.expect_error($q$update public.bank_connections set status = 'active'$q$, 'A marca su conexión como activa');
select pg_temp.expect_error($q$insert into public.bank_connections (user_id, provider, provider_connection_id, environment)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'bridge', 'con_falsa', 'production')$q$, 'A inventa una conexión');
select pg_temp.expect_error($q$delete from public.bank_provider_transactions$q$, 'A borra movimientos originales');
reset role;

-- ===================== Usuario B =====================
select pg_temp.act_as('bbbbbbbb-0000-0000-0000-000000000002');
do $$ begin
  assert (select count(*) from public.bank_connections) = 0, 'B ve la conexión de A';
  assert (select count(*) from public.bank_external_accounts) = 0, 'B ve cuentas externas de A';
  assert (select count(*) from public.bank_provider_transactions) = 0, 'B ve movimientos de A';
  assert (select count(*) from public.bank_sync_runs) = 0, 'B ve sincronizaciones de A';
end $$;
-- B no puede vincular cuentas de A (RLS: 0 filas afectadas).
update public.bank_external_accounts set account_id = null;
reset role;
do $$ begin
  assert (select count(*) from public.bank_external_accounts where account_id is not null) = 2, 'B modificó vínculos de A';
end $$;

-- ===================== anon =====================
set role anon;
select pg_temp.expect_error('select * from public.bank_connections', 'anon lee conexiones');
select pg_temp.expect_error('select * from public.bank_provider_credentials', 'anon lee credenciales');
reset role;

-- Origen nuevo de movimientos aceptado por el CHECK.
do $$ begin
  assert exists (select 1 from pg_constraint where conname = 'transactions_source_check'
                 and pg_get_constraintdef(oid) like '%bank_sync%'), 'source bank_sync no permitido';
end $$;

\echo '✔ 02_bank_connections: todas las aserciones pasaron'
