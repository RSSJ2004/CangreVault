-- =============================================================================
-- CangreVault · 0600 · Saldos calculados, conciliación, onboarding y alta de
-- usuario. Las funciones internas viven en el esquema `private` (no expuesto
-- por la API REST).
-- =============================================================================

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------------
-- Efecto con signo (convención: activo positivo, pasivo negativo)
-- ---------------------------------------------------------------------------
create or replace function public.transaction_signed_effect(
  p_type text,
  p_amount numeric,
  p_is_source boolean,
  p_account_is_liability boolean,
  p_adjustment_direction text
) returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when not p_is_source then p_amount                           -- destino de transferencia/pago/ahorro
    when p_type in ('INCOME', 'REFUND') then p_amount
    when p_type in ('EXPENSE', 'CARD_PURCHASE', 'TRANSFER', 'CARD_PAYMENT',
                    'SAVINGS_CONTRIBUTION', 'INVESTMENT') then -p_amount
    when p_type = 'ADJUSTMENT' then
      case when (p_adjustment_direction = 'increase') <> p_account_is_liability then p_amount else -p_amount end
    else null
  end;
$$;

comment on function public.transaction_signed_effect is
  'Regla contable única del servidor. Debe coincidir con src/domain/ledger.ts (probado en ambos lados).';

-- Suma de movimientos con signo de una cuenta en [p_from, p_to].
create or replace function public.account_signed_movements(p_account_id uuid, p_from date, p_to date)
returns numeric
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum(
           public.transaction_signed_effect(t.type, t.amount, t.account_id = a.id, a.is_liability, t.adjustment_direction)
         ), 0)
  from public.accounts a
  join public.transactions t
    on (t.account_id = a.id or t.to_account_id = a.id)
   and t.deleted_at is null
   and t.occurred_on >= greatest(a.opening_balance_date, coalesce(p_from, a.opening_balance_date))
   and (p_to is null or t.occurred_on <= p_to)
  where a.id = p_account_id;
$$;

-- Saldo natural (dinero en activos, deuda en pasivos) al cierre de p_as_of.
create or replace function public.account_balance_at(p_account_id uuid, p_as_of date default null)
returns numeric
language sql
stable
security invoker
set search_path = ''
as $$
  select a.opening_balance
         + case when a.is_liability then -1 else 1 end
           * public.account_signed_movements(a.id, null, p_as_of)
  from public.accounts a
  where a.id = p_account_id;
$$;

-- Vista de saldos (RLS del invocador).
create or replace view public.account_balances
with (security_invoker = true)
as
select
  a.id                    as account_id,
  a.user_id,
  a.name,
  a.kind,
  a.is_liability,
  a.currency,
  a.opening_balance,
  a.opening_balance_date,
  a.credit_limit,
  coalesce(m.signed_movements, 0) as signed_movements,
  a.opening_balance + case when a.is_liability then -1 else 1 end * coalesce(m.signed_movements, 0) as balance,
  m.last_movement_on
from public.accounts a
left join lateral (
  select sum(public.transaction_signed_effect(t.type, t.amount, t.account_id = a.id, a.is_liability, t.adjustment_direction))
           as signed_movements,
         max(t.occurred_on) as last_movement_on
  from public.transactions t
  where (t.account_id = a.id or t.to_account_id = a.id)
    and t.deleted_at is null
    and t.occurred_on >= a.opening_balance_date
) m on true
where a.deleted_at is null;

comment on view public.account_balances is
  'Saldo calculado = saldo inicial + movimientos posteriores. balance en términos naturales (deuda positiva en pasivos).';

-- ---------------------------------------------------------------------------
-- Conciliación
-- ---------------------------------------------------------------------------
create or replace function public.reconciliation_compute()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.calculated_balance := coalesce(public.account_balance_at(new.account_id, new.reconciled_on), 0);
  else
    -- La foto del saldo calculado es inmutable.
    new.calculated_balance := old.calculated_balance;
    new.account_id := old.account_id;
    new.reconciled_on := old.reconciled_on;
  end if;
  new.status := case
    when new.statement_balance = new.calculated_balance then 'matched'
    when new.adjustment_transaction_id is not null then 'adjusted'
    else 'pending'
  end;
  return new;
end;
$$;

create trigger trg_reconciliation_compute
  before insert or update on public.reconciliation_records
  for each row execute function public.reconciliation_compute();

-- Concilia una cuenta y, opcionalmente, crea un ADJUSTMENT auditable por la diferencia.
-- Idempotente por p_client_id.
create or replace function public.reconcile_account(
  p_account_id uuid,
  p_reconciled_on date,
  p_statement_balance numeric,
  p_create_adjustment boolean default false,
  p_mark_transactions boolean default false,
  p_notes text default null,
  p_client_id uuid default gen_random_uuid()
) returns public.reconciliation_records
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rec public.reconciliation_records;
  v_acc public.accounts;
  v_diff numeric(14, 2);
  v_tx_id uuid;
begin
  select * into v_rec from public.reconciliation_records where client_id = p_client_id;
  if found then
    return v_rec;
  end if;

  select * into v_acc from public.accounts where id = p_account_id and deleted_at is null;
  if not found then
    raise exception 'Cuenta no encontrada' using errcode = '23503';
  end if;
  if p_reconciled_on > current_date then
    raise exception 'La fecha de conciliación no puede ser futura' using errcode = '22007';
  end if;

  insert into public.reconciliation_records (user_id, client_id, account_id, reconciled_on, statement_balance, notes)
  values (v_acc.user_id, p_client_id, p_account_id, p_reconciled_on, p_statement_balance, p_notes)
  returning * into v_rec;

  v_diff := v_rec.difference;

  if p_create_adjustment and v_diff <> 0 then
    insert into public.transactions (
      user_id, type, account_id, amount, currency, occurred_on, description,
      adjustment_direction, entry_mode, source, reconciliation_status)
    values (
      v_acc.user_id, 'ADJUSTMENT', p_account_id, abs(v_diff), v_acc.currency, p_reconciled_on,
      'Ajuste de conciliación (' || to_char(p_reconciled_on, 'YYYY-MM-DD') || ')',
      case when v_diff > 0 then 'increase' else 'decrease' end, 'system', 'reconciliation', 'reconciled')
    returning id into v_tx_id;

    update public.reconciliation_records
       set adjustment_transaction_id = v_tx_id
     where id = v_rec.id
    returning * into v_rec;
  end if;

  if p_mark_transactions then
    update public.transactions
       set reconciliation_status = 'reconciled'
     where (account_id = p_account_id or to_account_id = p_account_id)
       and occurred_on <= p_reconciled_on
       and deleted_at is null
       and reconciliation_status = 'unreconciled';
  end if;

  return v_rec;
end;
$$;

-- ---------------------------------------------------------------------------
-- Alta de usuario: perfil + categorías por defecto (sin datos financieros).
-- ---------------------------------------------------------------------------
create or replace function private.seed_default_categories(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.categories (user_id, name, kind, slug, is_system)
  select p_user_id, c.name, c.kind, c.slug, true
  from (values
    ('Salario', 'income', 'salary'),
    ('Ingreso extra', 'income', 'extra_income'),
    ('Intereses ganados', 'income', 'interest_income'),
    ('Alimentación', 'expense', 'food'),
    ('Supermercado', 'expense', 'groceries'),
    ('Restaurantes', 'expense', 'restaurants'),
    ('Transporte', 'expense', 'transport'),
    ('Combustible', 'expense', 'fuel'),
    ('Electricidad', 'expense', 'electricity'),
    ('Agua', 'expense', 'water'),
    ('Internet y telefonía', 'expense', 'telecom'),
    ('Vivienda', 'expense', 'housing'),
    ('Salud', 'expense', 'health'),
    ('Educación', 'expense', 'education'),
    ('Entretenimiento', 'expense', 'entertainment'),
    ('Ropa y cuidado personal', 'expense', 'personal'),
    ('Suscripciones', 'expense', 'subscriptions'),
    ('Comisiones bancarias', 'expense', 'bank_fees'),
    ('Intereses de tarjeta', 'expense', 'card_interest'),
    ('Seguros', 'expense', 'insurance'),
    ('Otros gastos', 'expense', 'other_expense'),
    ('Ahorro', 'savings', 'savings'),
    ('Fondo de emergencia', 'savings', 'emergency_fund'),
    ('Inversión', 'savings', 'investment')
  ) as c(name, kind, slug)
  on conflict do nothing;
end;
$$;

revoke all on function private.seed_default_categories(uuid) from public;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (user_id) do nothing;
  perform private.seed_default_categories(new.id);
  return new;
end;
$$;

revoke all on function private.handle_new_user() from public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------------
-- Onboarding atómico e idempotente (todo o nada). SECURITY INVOKER: aplica RLS.
-- Payload documentado en docs/SCHEMA.md#complete_onboarding
-- ---------------------------------------------------------------------------
create or replace function public.complete_onboarding(p_payload jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_acc jsonb;
  v_rec jsonb;
  v_salary_account uuid;
  v_account_id uuid;
begin
  if v_uid is null then
    raise exception 'No autenticado' using errcode = '42501';
  end if;

  for v_acc in select * from jsonb_array_elements(coalesce(p_payload -> 'accounts', '[]'::jsonb)) loop
    insert into public.accounts (
      user_id, client_id, name, institution, kind, currency, opening_balance, opening_balance_date,
      credit_limit, annual_interest_rate_pct, statement_day, payment_due_day, utilization_alert_pct, sort_order)
    values (
      v_uid,
      (v_acc ->> 'client_id')::uuid,
      v_acc ->> 'name',
      v_acc ->> 'institution',
      v_acc ->> 'kind',
      coalesce(v_acc ->> 'currency', 'DOP'),
      coalesce((v_acc ->> 'opening_balance')::numeric, 0),
      coalesce((v_acc ->> 'opening_balance_date')::date, current_date),
      (v_acc ->> 'credit_limit')::numeric,
      (v_acc ->> 'annual_interest_rate_pct')::numeric,
      (v_acc ->> 'statement_day')::smallint,
      (v_acc ->> 'payment_due_day')::smallint,
      coalesce((v_acc ->> 'utilization_alert_pct')::numeric, 30),
      coalesce((v_acc ->> 'sort_order')::integer, 0))
    on conflict (client_id) do nothing;

    if coalesce((v_acc ->> 'is_salary_account')::boolean, false) then
      select id into v_salary_account from public.accounts where client_id = (v_acc ->> 'client_id')::uuid;
    end if;
  end loop;

  for v_rec in select * from jsonb_array_elements(coalesce(p_payload -> 'recurring_expenses', '[]'::jsonb)) loop
    select id into v_account_id from public.accounts
      where client_id = (v_rec ->> 'account_client_id')::uuid and user_id = v_uid;
    if v_account_id is null then
      raise exception 'Gasto recurrente "%" referencia una cuenta inexistente', v_rec ->> 'name' using errcode = '23503';
    end if;
    insert into public.recurring_expenses (
      user_id, client_id, name, amount, account_id, category_id, transaction_type, frequency,
      day_from, day_to, start_date, status)
    values (
      v_uid,
      (v_rec ->> 'client_id')::uuid,
      v_rec ->> 'name',
      (v_rec ->> 'amount')::numeric,
      v_account_id,
      (select id from public.categories where user_id = v_uid and slug = v_rec ->> 'category_slug' and deleted_at is null),
      coalesce(v_rec ->> 'transaction_type', 'EXPENSE'),
      'monthly',
      (v_rec ->> 'day_from')::smallint,
      (v_rec ->> 'day_to')::smallint,
      coalesce((v_rec ->> 'start_date')::date, current_date),
      'active')
    on conflict (client_id) do nothing;
  end loop;

  update public.profiles
     set salary_amount = coalesce((p_payload ->> 'salary_amount')::numeric, salary_amount),
         salary_frequency = coalesce(p_payload ->> 'salary_frequency', salary_frequency),
         salary_pay_days = coalesce(
           (select array_agg(value::smallint) from jsonb_array_elements_text(p_payload -> 'salary_pay_days')),
           salary_pay_days),
         salary_account_id = coalesce(v_salary_account, salary_account_id),
         salary_effective_from = coalesce((p_payload ->> 'salary_effective_from')::date, current_date),
         preferred_mode = coalesce(p_payload ->> 'preferred_mode', preferred_mode),
         onboarding_completed_at = coalesce(onboarding_completed_at, now())
   where user_id = v_uid;
end;
$$;
