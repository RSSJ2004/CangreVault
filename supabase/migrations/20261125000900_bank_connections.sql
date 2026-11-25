-- =============================================================================
-- CangreVault · 0900 · Conexiones bancarias automáticas (agregador: Bridge u otro)
--
-- Flujo: banco → proveedor → Edge Function bank-sync → estas tablas → transactions.
--
-- Principios (ver docs/DECISIONS.md §12 y docs/BANK_INTEGRATION_REPORT.md):
--  * El dato ORIGINAL del proveedor vive en bank_provider_transactions y no se edita.
--    La clasificación editable vive en transactions (una fila por hecho económico).
--  * Solo la Edge Function (service_role) escribe en estas tablas. El usuario solo
--    lee, y puede elegir a qué cuenta interna corresponde cada cuenta externa.
--  * Los tokens del proveedor se guardan CIFRADOS (AES-GCM, clave en secretos de
--    Edge Functions) en una tabla sin ningún privilegio para anon/authenticated.
--  * Nunca se guardan usuarios ni contraseñas bancarias.
-- =============================================================================

-- Origen de movimientos sincronizados desde el banco.
alter table public.transactions drop constraint if exists transactions_source_check;
alter table public.transactions add constraint transactions_source_check
  check (source in ('manual', 'pdf_import', 'recurring', 'reconciliation', 'android', 'api', 'bank_sync'));

-- ---------------------------------------------------------------- conexiones
create table public.bank_connections (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users (id) on delete cascade,
  provider                text not null check (provider in ('bridge')),
  provider_connection_id  text not null check (char_length(provider_connection_id) between 1 and 200),
  environment             text not null check (environment in ('sandbox', 'production')),
  institution_id          text,
  institution_name        text,
  -- active: confirmada por el proveedor · error: la última sincronización falló
  -- reauth_required: el proveedor rechazó el acceso; hay que reconectar · revoked: desconectada
  status                  text not null default 'active' check (status in ('active', 'error', 'reauth_required', 'revoked')),
  last_synced_at          timestamptz,
  last_sync_status        text check (last_sync_status is null or last_sync_status in ('ok', 'partial', 'error')),
  last_error              text check (last_error is null or char_length(last_error) <= 1000),
  consecutive_failures    integer not null default 0 check (consecutive_failures >= 0),
  revoked_at              timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz,
  constraint bank_connections_id_user_unique unique (id, user_id),
  constraint bank_connections_provider_unique unique (provider, provider_connection_id)
);
create index idx_bank_connections_user on public.bank_connections (user_id, updated_at);

-- Credenciales del proveedor por usuario (scoped token de Bridge), CIFRADAS.
-- Sin políticas y sin privilegios para anon/authenticated: solo service_role.
create table public.bank_provider_credentials (
  user_id                 uuid not null references auth.users (id) on delete cascade,
  provider                text not null check (provider in ('bridge')),
  environment             text not null check (environment in ('sandbox', 'production')),
  token_ciphertext        text not null,
  token_iv                text not null,
  key_version             integer not null default 1,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  primary key (user_id, provider, environment)
);

-- ---------------------------------------------------------------- cuentas externas
create table public.bank_external_accounts (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references auth.users (id) on delete cascade,
  connection_id             uuid not null,
  provider_account_id       text not null check (char_length(provider_account_id) between 1 and 200),
  provider_type             text not null check (provider_type in ('depository', 'credit')),
  name                      text not null,
  last_four                 text check (last_four is null or char_length(last_four) <= 8),
  currency                  char(3) not null check (currency ~ '^[A-Z]{3}$'),
  -- Balances tal como los reporta el proveedor (con su signo). Solo informativos:
  -- el saldo de CangreVault sigue siendo saldo inicial + movimientos.
  balance_current           numeric(14, 2),
  balance_available         numeric(14, 2),
  balance_limit             numeric(14, 2),
  balance_updated_at        timestamptz,
  -- Cuenta interna vinculada (la elige el usuario). Sin vínculo no se crean movimientos.
  account_id                uuid,
  sync_enabled              boolean not null default true,
  -- Primer día a importar (por defecto el saldo inicial de la cuenta interna).
  sync_from                 date,
  last_transaction_refresh  text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  deleted_at                timestamptz,
  constraint bank_ext_accounts_id_user_unique unique (id, user_id),
  constraint bank_ext_accounts_provider_unique unique (connection_id, provider_account_id),
  constraint bank_ext_accounts_connection_fk foreign key (connection_id, user_id) references public.bank_connections (id, user_id),
  constraint bank_ext_accounts_account_fk foreign key (account_id, user_id) references public.accounts (id, user_id)
);
create index idx_bank_ext_accounts_user on public.bank_external_accounts (user_id, updated_at);
-- Una cuenta interna solo puede recibir una cuenta externa activa.
create unique index uq_bank_ext_accounts_internal on public.bank_external_accounts (account_id)
  where account_id is not null and deleted_at is null;

-- ---------------------------------------------------------------- movimientos originales
create table public.bank_provider_transactions (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references auth.users (id) on delete cascade,
  external_account_id       uuid not null,
  provider_transaction_id   text not null check (char_length(provider_transaction_id) between 1 and 200),
  -- Importe con el signo del proveedor (negativo = salida/cargo). Nunca se edita a mano.
  amount                    numeric(14, 2) not null,
  currency                  char(3) not null,
  occurred_on               date not null,
  description               text not null,
  reference                 text,
  provider_status           text not null check (provider_status in ('pending', 'posted', 'void')),
  transaction_refresh       text,
  raw                       jsonb not null,
  -- Clasificación del sincronizador:
  --  pending_bank: el banco aún no la contabiliza · linked: ya es un movimiento
  --  needs_review: ambigua, la decide el usuario · ignored: descartada por el usuario
  --  void: anulada por el banco · unlinked_account: la cuenta externa no está vinculada
  review_status             text not null default 'unlinked_account'
                              check (review_status in ('pending_bank', 'linked', 'needs_review', 'ignored', 'void', 'unlinked_account')),
  review_reason             text,
  transaction_id            uuid,
  first_seen_at             timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint bank_provider_tx_unique unique (external_account_id, provider_transaction_id),
  constraint bank_provider_tx_account_fk foreign key (external_account_id, user_id) references public.bank_external_accounts (id, user_id),
  constraint bank_provider_tx_transaction_fk foreign key (transaction_id, user_id) references public.transactions (id, user_id)
);
create index idx_bank_provider_tx_user on public.bank_provider_transactions (user_id, review_status, occurred_on);
create index idx_bank_provider_tx_tx on public.bank_provider_transactions (transaction_id) where transaction_id is not null;

-- ---------------------------------------------------------------- bitácora de sincronización
create table public.bank_sync_runs (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  connection_id       uuid not null,
  trigger             text not null check (trigger in ('connect', 'manual', 'scheduled', 'webhook')),
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  status              text not null default 'running' check (status in ('running', 'ok', 'partial', 'error')),
  accounts_seen       integer not null default 0,
  provider_rows       integer not null default 0,
  transactions_created integer not null default 0,
  needs_review        integer not null default 0,
  error               text check (error is null or char_length(error) <= 1000),
  constraint bank_sync_runs_connection_fk foreign key (connection_id, user_id) references public.bank_connections (id, user_id)
);
create index idx_bank_sync_runs_conn on public.bank_sync_runs (connection_id, started_at desc);

-- ---------------------------------------------------------------- triggers
create trigger trg_bank_connections_updated_at before update on public.bank_connections
  for each row execute function public.set_updated_at();
create trigger trg_bank_credentials_updated_at before update on public.bank_provider_credentials
  for each row execute function public.set_updated_at();
create trigger trg_bank_ext_accounts_updated_at before update on public.bank_external_accounts
  for each row execute function public.set_updated_at();
create trigger trg_bank_provider_tx_updated_at before update on public.bank_provider_transactions
  for each row execute function public.set_updated_at();

-- El vínculo cuenta externa → interna debe respetar tipo y moneda.
create or replace function public.validate_bank_external_account()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_acc public.accounts%rowtype;
begin
  if new.account_id is not null then
    select * into v_acc from public.accounts where id = new.account_id and user_id = new.user_id;
    if not found or v_acc.deleted_at is not null then
      raise exception 'La cuenta interna no existe o no pertenece al usuario' using errcode = '23503';
    end if;
    if v_acc.currency <> new.currency then
      raise exception 'La cuenta bancaria está en % y la cuenta de CangreVault en %', new.currency, v_acc.currency using errcode = '23514';
    end if;
    if new.provider_type = 'credit' and v_acc.kind <> 'credit_card' then
      raise exception 'Una tarjeta de crédito del banco solo puede vincularse a una cuenta de tipo tarjeta de crédito' using errcode = '23514';
    end if;
    if new.provider_type = 'depository' and v_acc.kind not in ('checking', 'savings', 'cash', 'investment', 'other_asset') then
      raise exception 'Una cuenta de depósito del banco debe vincularse a una cuenta de activo' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'UPDATE' and (new.user_id, new.connection_id, new.provider_account_id)
       is distinct from (old.user_id, old.connection_id, old.provider_account_id) then
    raise exception 'La identidad de una cuenta externa no puede cambiar' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger trg_bank_ext_accounts_validate before insert or update on public.bank_external_accounts
  for each row execute function public.validate_bank_external_account();

-- ---------------------------------------------------------------- RLS y privilegios
alter table public.bank_connections enable row level security;
alter table public.bank_external_accounts enable row level security;
alter table public.bank_provider_transactions enable row level security;
alter table public.bank_sync_runs enable row level security;
alter table public.bank_provider_credentials enable row level security;

revoke all on public.bank_connections, public.bank_external_accounts, public.bank_provider_transactions,
  public.bank_sync_runs, public.bank_provider_credentials from anon, authenticated, public;

grant select on public.bank_connections, public.bank_external_accounts, public.bank_provider_transactions,
  public.bank_sync_runs to authenticated;
-- Única escritura del usuario: vincular/desvincular y pausar una cuenta externa.
grant update (account_id, sync_enabled, sync_from) on public.bank_external_accounts to authenticated;

create policy bank_connections_select_own on public.bank_connections for select to authenticated
  using ((select auth.uid()) = user_id);
create policy bank_ext_accounts_select_own on public.bank_external_accounts for select to authenticated
  using ((select auth.uid()) = user_id);
create policy bank_ext_accounts_update_own on public.bank_external_accounts for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy bank_provider_tx_select_own on public.bank_provider_transactions for select to authenticated
  using ((select auth.uid()) = user_id);
create policy bank_sync_runs_select_own on public.bank_sync_runs for select to authenticated
  using ((select auth.uid()) = user_id);
-- bank_provider_credentials: RLS activo y SIN políticas → inaccesible salvo service_role.

grant all on public.bank_connections, public.bank_external_accounts, public.bank_provider_transactions,
  public.bank_sync_runs, public.bank_provider_credentials to service_role;

do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['bank_connections', 'bank_external_accounts', 'bank_provider_transactions', 'bank_sync_runs'] loop
      if not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;
