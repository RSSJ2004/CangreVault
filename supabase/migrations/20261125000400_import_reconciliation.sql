-- =============================================================================
-- CangreVault · 0400 · Importación de estados de cuenta y conciliación
-- =============================================================================

create table public.import_batches (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id               uuid not null default gen_random_uuid() unique,
  account_id              uuid not null,
  file_name               text not null check (char_length(file_name) between 1 and 255),
  file_sha256             text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_size_bytes         integer check (file_size_bytes is null or file_size_bytes >= 0),
  page_count              integer check (page_count is null or page_count >= 0),
  detected_account_type   text check (detected_account_type is null or detected_account_type in
                            ('checking', 'savings', 'credit_card', 'unknown')),
  statement_period_start  date,
  statement_period_end    date,
  parser_name             text not null,
  parser_version          text not null,
  status                  text not null default 'confirmed' check (status in ('confirmed', 'cancelled', 'failed')),
  rows_total              integer not null default 0 check (rows_total >= 0),
  rows_imported           integer not null default 0 check (rows_imported >= 0),
  rows_skipped            integer not null default 0 check (rows_skipped >= 0),
  warnings                jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz,
  constraint import_batches_id_user_unique unique (id, user_id),
  constraint import_batches_account_fk foreign key (account_id, user_id) references public.accounts (id, user_id),
  constraint import_batches_rows check (rows_imported + rows_skipped <= rows_total)
);

create index idx_import_batches_hash on public.import_batches (user_id, file_sha256);
create index idx_import_batches_sync on public.import_batches (user_id, updated_at);

create trigger trg_import_batches_updated_at
  before update on public.import_batches
  for each row execute function public.set_updated_at();

alter table public.transactions
  add constraint transactions_import_batch_fk
  foreign key (import_batch_id, user_id) references public.import_batches (id, user_id);

alter table public.credit_card_cycles
  add constraint cycles_import_batch_fk
  foreign key (import_batch_id, user_id) references public.import_batches (id, user_id);

-- ---------------------------------------------------------------------------
-- Conciliación: saldo calculado (servidor) vs saldo declarado por el banco.
-- ---------------------------------------------------------------------------
create table public.reconciliation_records (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id                  uuid not null default gen_random_uuid() unique,
  account_id                 uuid not null,
  reconciled_on              date not null,
  statement_balance          numeric(14, 2) not null,
  -- Lo calcula el trigger a partir del diario; el cliente no puede fijarlo.
  calculated_balance         numeric(14, 2) not null default 0,
  difference                 numeric(14, 2) generated always as (statement_balance - calculated_balance) stored,
  status                     text not null default 'pending' check (status in ('matched', 'adjusted', 'pending')),
  adjustment_transaction_id  uuid,
  notes                      text check (notes is null or char_length(notes) <= 500),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  deleted_at                 timestamptz,
  constraint reconciliation_account_fk foreign key (account_id, user_id) references public.accounts (id, user_id),
  constraint reconciliation_adjustment_fk foreign key (adjustment_transaction_id, user_id)
    references public.transactions (id, user_id)
);

create index idx_reconciliation_account on public.reconciliation_records (account_id, reconciled_on desc);
create index idx_reconciliation_sync on public.reconciliation_records (user_id, updated_at);

create trigger trg_reconciliation_updated_at
  before update on public.reconciliation_records
  for each row execute function public.set_updated_at();
