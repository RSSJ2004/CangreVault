-- =============================================================================
-- CangreVault · 0300 · Planificación: gastos recurrentes, metas de ahorro,
-- ciclos de tarjeta de crédito.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Gastos recurrentes. Son PLANTILLAS de proyección: modificarlos nunca altera
-- transacciones históricas (cada transacción guarda su propio importe).
-- ---------------------------------------------------------------------------
create table public.recurring_expenses (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id          uuid not null default gen_random_uuid() unique,
  name               text not null check (char_length(name) between 1 and 80),
  amount             numeric(14, 2) not null check (amount > 0),
  currency           text not null default 'DOP' check (currency ~ '^[A-Z]{3}$'),
  account_id         uuid not null,
  category_id        uuid,
  transaction_type   text not null default 'EXPENSE' check (transaction_type in ('EXPENSE', 'CARD_PURCHASE')),
  frequency          text not null default 'monthly'
                       check (frequency in ('weekly', 'biweekly', 'monthly', 'bimonthly', 'quarterly', 'yearly')),
  day_from           smallint check (day_from is null or day_from between 1 and 31),
  day_to             smallint check (day_to is null or day_to between 1 and 31),
  weekday            smallint check (weekday is null or weekday between 0 and 6),
  month_of_year      smallint check (month_of_year is null or month_of_year between 1 and 12),
  start_date         date not null default current_date,
  end_date           date,
  status             text not null default 'active' check (status in ('active', 'paused', 'cancelled')),
  remind_days_before smallint not null default 3 check (remind_days_before between 0 and 30),
  notes              text check (notes is null or char_length(notes) <= 500),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  constraint recurring_id_user_unique unique (id, user_id),
  constraint recurring_account_fk  foreign key (account_id, user_id)  references public.accounts (id, user_id),
  constraint recurring_category_fk foreign key (category_id, user_id) references public.categories (id, user_id),
  constraint recurring_dates check (end_date is null or end_date >= start_date),
  constraint recurring_day_range check (day_from is null or day_to is null or day_to >= day_from),
  constraint recurring_schedule check (
    case
      when frequency in ('weekly', 'biweekly') then weekday is not null
      when frequency = 'yearly' then day_from is not null and month_of_year is not null
      else day_from is not null
    end
  )
);

create index idx_recurring_user on public.recurring_expenses (user_id) where deleted_at is null;
create index idx_recurring_sync on public.recurring_expenses (user_id, updated_at);

create trigger trg_recurring_updated_at
  before update on public.recurring_expenses
  for each row execute function public.set_updated_at();

create or replace function public.validate_recurring_expense()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_kind text;
  v_currency text;
begin
  select kind, currency into v_kind, v_currency from public.accounts
    where id = new.account_id and user_id = new.user_id;
  if new.transaction_type = 'CARD_PURCHASE' and v_kind <> 'credit_card' then
    raise exception 'Un cargo recurrente con tarjeta debe asociarse a una tarjeta de crédito' using errcode = '23514';
  end if;
  if new.currency <> v_currency then
    raise exception 'La moneda del gasto recurrente no coincide con la de la cuenta' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger trg_recurring_validate
  before insert or update on public.recurring_expenses
  for each row execute function public.validate_recurring_expense();

alter table public.transactions
  add constraint transactions_recurring_fk
  foreign key (recurring_expense_id, user_id) references public.recurring_expenses (id, user_id);

-- ---------------------------------------------------------------------------
-- Metas de ahorro
-- ---------------------------------------------------------------------------
create table public.savings_goals (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id          uuid not null default gen_random_uuid() unique,
  name               text not null check (char_length(name) between 1 and 80),
  target_amount      numeric(14, 2) not null check (target_amount > 0),
  currency           text not null default 'DOP' check (currency ~ '^[A-Z]{3}$'),
  target_date        date,
  account_id         uuid,
  is_emergency_fund  boolean not null default false,
  status             text not null default 'active' check (status in ('active', 'completed', 'archived')),
  notes              text check (notes is null or char_length(notes) <= 500),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  constraint goals_id_user_unique unique (id, user_id),
  constraint goals_account_fk foreign key (account_id, user_id) references public.accounts (id, user_id)
);

create index idx_goals_sync on public.savings_goals (user_id, updated_at);

create trigger trg_goals_updated_at
  before update on public.savings_goals
  for each row execute function public.set_updated_at();

alter table public.transactions
  add constraint transactions_goal_fk
  foreign key (savings_goal_id, user_id) references public.savings_goals (id, user_id);

create table public.savings_contributions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id       uuid not null default gen_random_uuid() unique,
  goal_id         uuid not null,
  kind            text not null default 'contribution' check (kind in ('contribution', 'withdrawal')),
  amount          numeric(14, 2) not null check (amount > 0),
  contributed_on  date not null default current_date,
  transaction_id  uuid,
  notes           text check (notes is null or char_length(notes) <= 500),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint contributions_goal_fk foreign key (goal_id, user_id) references public.savings_goals (id, user_id),
  constraint contributions_tx_fk   foreign key (transaction_id, user_id) references public.transactions (id, user_id)
);

create index idx_contributions_goal on public.savings_contributions (goal_id) where deleted_at is null;
create index idx_contributions_sync on public.savings_contributions (user_id, updated_at);
create unique index uq_contributions_tx on public.savings_contributions (transaction_id)
  where transaction_id is not null and deleted_at is null;

create trigger trg_contributions_updated_at
  before update on public.savings_contributions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Ciclos de tarjeta de crédito (datos del estado de cuenta)
-- Las fechas de corte/límite NO se asumen fijas: cada ciclo guarda las suyas.
-- ---------------------------------------------------------------------------
create table public.credit_card_cycles (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id           uuid not null default gen_random_uuid() unique,
  account_id          uuid not null,
  period_start        date not null,
  statement_date      date not null,
  due_date            date not null,
  previous_balance    numeric(14, 2),
  statement_balance   numeric(14, 2) not null check (statement_balance >= 0),
  minimum_payment     numeric(14, 2) not null check (minimum_payment >= 0),
  full_payment        numeric(14, 2) not null check (full_payment >= 0),
  interest_charged    numeric(14, 2) check (interest_charged is null or interest_charged >= 0),
  fees_charged        numeric(14, 2) check (fees_charged is null or fees_charged >= 0),
  annual_rate_pct     numeric(7, 4) check (annual_rate_pct is null or annual_rate_pct between 0 and 1000),
  source              text not null default 'manual' check (source in ('manual', 'pdf_import')),
  import_batch_id     uuid,
  notes               text check (notes is null or char_length(notes) <= 500),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  constraint cycles_account_fk foreign key (account_id, user_id) references public.accounts (id, user_id),
  constraint cycles_dates check (period_start <= statement_date and due_date > statement_date),
  constraint cycles_minimum_le_full check (minimum_payment <= greatest(full_payment, statement_balance))
);

create unique index uq_cycles_account_statement on public.credit_card_cycles (account_id, statement_date)
  where deleted_at is null;
create index idx_cycles_sync on public.credit_card_cycles (user_id, updated_at);

create trigger trg_cycles_updated_at
  before update on public.credit_card_cycles
  for each row execute function public.set_updated_at();

create or replace function public.validate_credit_card_cycle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.accounts
                 where id = new.account_id and user_id = new.user_id and kind = 'credit_card') then
    raise exception 'Los ciclos solo aplican a cuentas de tarjeta de crédito' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger trg_cycles_validate
  before insert or update on public.credit_card_cycles
  for each row execute function public.validate_credit_card_cycle();
