-- =============================================================================
-- CangreVault · 0100 · Esquema base: utilidades, perfiles, cuentas, categorías,
-- ingresos. Dinero SIEMPRE en numeric(14,2). Fechas contables en `date`,
-- marcas temporales en `timestamptz` (ISO 8601 en la API).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Utilidades
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Trigger genérico: actualiza updated_at. updated_at es el cursor de sincronización.';

-- ---------------------------------------------------------------------------
-- Perfiles (1:1 con auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id                 uuid primary key references auth.users (id) on delete cascade,
  display_name            text check (display_name is null or char_length(display_name) <= 120),
  base_currency           text not null default 'DOP' check (base_currency ~ '^[A-Z]{3}$'),
  preferred_mode          text not null default 'simple' check (preferred_mode in ('simple', 'normal')),
  -- Sueldo: parámetro de planificación, NO una transacción.
  salary_amount           numeric(14, 2) not null default 0 check (salary_amount >= 0),
  salary_frequency        text not null default 'monthly'
                            check (salary_frequency in ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  salary_pay_days         smallint[] not null default '{}'
                            check (1 <= all (salary_pay_days) and 31 >= all (salary_pay_days)),
  salary_account_id       uuid,
  salary_effective_from   date,
  emergency_fund_months   smallint not null default 3 check (emergency_fund_months between 1 and 24),
  onboarding_completed_at timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

comment on table public.profiles is 'Perfil financiero del usuario. salary_* son parámetros de planificación.';

-- Historial auditable de cambios del sueldo (solo lo escribe el trigger).
create table public.profile_income_history (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (user_id) on delete cascade,
  changed_at     timestamptz not null default now(),
  old_amount     numeric(14, 2),
  new_amount     numeric(14, 2) not null,
  old_frequency  text,
  new_frequency  text not null,
  old_pay_days   smallint[],
  new_pay_days   smallint[] not null,
  effective_from date
);

create index idx_profile_income_history_user on public.profile_income_history (user_id, changed_at desc);

create or replace function public.log_profile_income_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT'
     or new.salary_amount is distinct from old.salary_amount
     or new.salary_frequency is distinct from old.salary_frequency
     or new.salary_pay_days is distinct from old.salary_pay_days then
    insert into public.profile_income_history
      (user_id, old_amount, new_amount, old_frequency, new_frequency, old_pay_days, new_pay_days, effective_from)
    values
      (new.user_id,
       case when tg_op = 'UPDATE' then old.salary_amount end, new.salary_amount,
       case when tg_op = 'UPDATE' then old.salary_frequency end, new.salary_frequency,
       case when tg_op = 'UPDATE' then old.salary_pay_days end, new.salary_pay_days,
       coalesce(new.salary_effective_from, current_date));
  end if;
  return new;
end;
$$;

create trigger trg_profiles_income_history
  after insert or update on public.profiles
  for each row execute function public.log_profile_income_change();

-- ---------------------------------------------------------------------------
-- Cuentas / productos financieros
-- ---------------------------------------------------------------------------
create table public.accounts (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id               uuid not null default gen_random_uuid() unique,
  name                    text not null check (char_length(name) between 1 and 80),
  institution             text check (institution is null or char_length(institution) <= 80),
  kind                    text not null check (kind in (
                            'checking', 'savings', 'cash', 'investment', 'other_asset',
                            'credit_card', 'loan', 'other_liability')),
  is_liability            boolean generated always as (kind in ('credit_card', 'loan', 'other_liability')) stored,
  currency                text not null default 'DOP' check (currency ~ '^[A-Z]{3}$'),
  -- Saldo inicial en términos naturales: dinero disponible (activos) o deuda (pasivos).
  opening_balance         numeric(14, 2) not null default 0,
  opening_balance_date    date not null default current_date,
  -- Solo tarjetas de crédito (nullable hasta que el usuario los configure).
  credit_limit            numeric(14, 2) check (credit_limit is null or credit_limit >= 0),
  annual_interest_rate_pct numeric(7, 4) check (annual_interest_rate_pct is null or annual_interest_rate_pct between 0 and 1000),
  statement_day           smallint check (statement_day is null or statement_day between 1 and 31),
  payment_due_day         smallint check (payment_due_day is null or payment_due_day between 1 and 31),
  utilization_alert_pct   numeric(5, 2) not null default 30 check (utilization_alert_pct between 1 and 100),
  last4                   text check (last4 is null or last4 ~ '^[0-9]{4}$'),
  color                   text check (color is null or color ~ '^#[0-9A-Fa-f]{6}$'),
  sort_order              integer not null default 0,
  is_archived             boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz,
  constraint accounts_id_user_unique unique (id, user_id),
  constraint accounts_card_fields_only_for_cards check (
    kind = 'credit_card'
    or (credit_limit is null and statement_day is null and payment_due_day is null)
  )
);

create index idx_accounts_user on public.accounts (user_id) where deleted_at is null;
create index idx_accounts_sync on public.accounts (user_id, updated_at);

create trigger trg_accounts_updated_at
  before update on public.accounts
  for each row execute function public.set_updated_at();

comment on column public.accounts.opening_balance is
  'Saldo al inicio de opening_balance_date. Activos: dinero; pasivos: deuda (positiva). '
  'Solo las transacciones con occurred_on >= opening_balance_date alteran el saldo.';

alter table public.profiles
  add constraint profiles_salary_account_fk
  foreign key (salary_account_id, user_id) references public.accounts (id, user_id);

-- ---------------------------------------------------------------------------
-- Categorías
-- ---------------------------------------------------------------------------
create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id   uuid not null default gen_random_uuid() unique,
  name        text not null check (char_length(name) between 1 and 60),
  kind        text not null check (kind in ('income', 'expense', 'savings')),
  slug        text check (slug is null or slug ~ '^[a-z0-9_]+$'),
  icon        text,
  color       text check (color is null or color ~ '^#[0-9A-Fa-f]{6}$'),
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  constraint categories_id_user_unique unique (id, user_id)
);

create unique index uq_categories_user_name_kind
  on public.categories (user_id, lower(name), kind) where deleted_at is null;
create unique index uq_categories_user_slug
  on public.categories (user_id, slug) where deleted_at is null and slug is not null;
create index idx_categories_sync on public.categories (user_id, updated_at);

create trigger trg_categories_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Ingresos adicionales (el sueldo principal vive en profiles)
-- ---------------------------------------------------------------------------
create table public.income_sources (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id   uuid not null default gen_random_uuid() unique,
  name        text not null check (char_length(name) between 1 and 80),
  amount      numeric(14, 2) not null check (amount > 0),
  currency    text not null default 'DOP' check (currency ~ '^[A-Z]{3}$'),
  frequency   text not null check (frequency in ('one_time', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'yearly')),
  pay_day     smallint check (pay_day is null or pay_day between 1 and 31),
  account_id  uuid,
  start_date  date not null default current_date,
  end_date    date,
  is_active   boolean not null default true,
  notes       text check (notes is null or char_length(notes) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  constraint income_sources_dates check (end_date is null or end_date >= start_date),
  constraint income_sources_account_fk foreign key (account_id, user_id) references public.accounts (id, user_id)
);

create index idx_income_sources_sync on public.income_sources (user_id, updated_at);

create trigger trg_income_sources_updated_at
  before update on public.income_sources
  for each row execute function public.set_updated_at();
