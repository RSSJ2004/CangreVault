-- =============================================================================
-- CangreVault · 0200 · Transacciones (una fila = un hecho económico)
--
-- Modelo: cada fila tiene una cuenta de origen/afectada (account_id) y, para
-- movimientos entre cuentas propias, una cuenta destino (to_account_id).
-- `amount` es SIEMPRE positivo; el efecto sobre los saldos lo define `type`.
-- Esto evita duplicar gastos (p. ej. un pago de tarjeta es un movimiento entre
-- cuentas, NUNCA un segundo gasto).
-- =============================================================================

create table public.transactions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id               uuid not null default gen_random_uuid() unique,
  type                    text not null check (type in (
                            'INCOME', 'EXPENSE', 'TRANSFER', 'CARD_PURCHASE', 'CARD_PAYMENT',
                            'SAVINGS_CONTRIBUTION', 'INVESTMENT', 'REFUND', 'ADJUSTMENT')),
  account_id              uuid not null,
  to_account_id           uuid,
  amount                  numeric(14, 2) not null check (amount > 0 and amount <= 999999999999.99),
  currency                text not null default 'DOP' check (currency ~ '^[A-Z]{3}$'),
  occurred_on             date not null,
  posted_on               date,
  description             text not null check (char_length(btrim(description)) between 1 and 300),
  normalized_description  text check (normalized_description is null or char_length(normalized_description) <= 300),
  original_note           text check (original_note is null or char_length(original_note) <= 1000),
  category_id             uuid,
  classification_source   text check (classification_source is null or classification_source in ('user', 'rules', 'ai')),
  adjustment_direction    text check (adjustment_direction is null or adjustment_direction in ('increase', 'decrease')),
  related_transaction_id  uuid,
  transfer_group_id       uuid,
  recurring_expense_id    uuid,
  savings_goal_id         uuid,
  import_batch_id         uuid,
  import_row_ref          text check (import_row_ref is null or char_length(import_row_ref) <= 200),
  bank_reference          text check (bank_reference is null or char_length(bank_reference) <= 120),
  dedupe_key              text check (dedupe_key is null or char_length(dedupe_key) <= 200),
  entry_mode              text not null default 'normal' check (entry_mode in ('simple', 'normal', 'import', 'recurring', 'system')),
  source                  text not null default 'manual' check (source in ('manual', 'pdf_import', 'recurring', 'reconciliation', 'android', 'api')),
  reconciliation_status   text not null default 'unreconciled' check (reconciliation_status in ('unreconciled', 'reconciled', 'disputed')),
  ai_status               text not null default 'none' check (ai_status in (
                            'none', 'pending', 'processing', 'suggested', 'accepted', 'rejected', 'failed', 'skipped')),
  ai_suggestion           jsonb check (ai_suggestion is null or jsonb_typeof(ai_suggestion) = 'object'),
  ai_processed_at         timestamptz,
  ai_error                text check (ai_error is null or char_length(ai_error) <= 500),
  client_updated_at       timestamptz,
  version                 integer not null default 1,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz,

  constraint transactions_id_user_unique unique (id, user_id),
  constraint transactions_account_fk    foreign key (account_id, user_id)    references public.accounts (id, user_id),
  constraint transactions_to_account_fk foreign key (to_account_id, user_id) references public.accounts (id, user_id),
  constraint transactions_category_fk   foreign key (category_id, user_id)   references public.categories (id, user_id),
  constraint transactions_related_fk    foreign key (related_transaction_id, user_id) references public.transactions (id, user_id),

  -- Reglas estructurales por tipo
  constraint transactions_destination_rules check (
    case
      when type in ('TRANSFER', 'CARD_PAYMENT', 'SAVINGS_CONTRIBUTION')
        then to_account_id is not null and to_account_id <> account_id
      when type = 'INVESTMENT'
        then to_account_id is null or to_account_id <> account_id
      else to_account_id is null
    end
  ),
  constraint transactions_adjustment_rules check (
    (type = 'ADJUSTMENT') = (adjustment_direction is not null)
  ),
  constraint transactions_related_rules check (
    related_transaction_id is null or type in ('REFUND', 'ADJUSTMENT')
  ),
  constraint transactions_posted_after check (posted_on is null or posted_on >= occurred_on - 7)
);

create index idx_transactions_user_date   on public.transactions (user_id, occurred_on desc) where deleted_at is null;
create index idx_transactions_account     on public.transactions (account_id, occurred_on) where deleted_at is null;
create index idx_transactions_to_account  on public.transactions (to_account_id, occurred_on) where deleted_at is null and to_account_id is not null;
create index idx_transactions_category    on public.transactions (user_id, category_id) where deleted_at is null;
create index idx_transactions_sync        on public.transactions (user_id, updated_at);
create index idx_transactions_dedupe      on public.transactions (user_id, dedupe_key) where dedupe_key is not null and deleted_at is null;
create index idx_transactions_ai_pending  on public.transactions (user_id) where ai_status = 'pending';
create index idx_transactions_group       on public.transactions (transfer_group_id) where transfer_group_id is not null;
create index idx_transactions_related     on public.transactions (related_transaction_id) where related_transaction_id is not null;

comment on table public.transactions is
  'Diario de transacciones. Una fila por hecho económico. amount > 0; el signo lo determina type.';

-- ---------------------------------------------------------------------------
-- Validación semántica (requiere consultar otras filas)
-- ---------------------------------------------------------------------------
create or replace function public.validate_transaction()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_from  public.accounts%rowtype;
  v_to    public.accounts%rowtype;
  v_cat   public.categories%rowtype;
  v_orig  public.transactions%rowtype;
  v_refunded numeric(14, 2);
begin
  select * into v_from from public.accounts where id = new.account_id and user_id = new.user_id;
  if not found then
    raise exception 'La cuenta % no existe o no pertenece al usuario', new.account_id using errcode = '23503';
  end if;
  if v_from.deleted_at is not null and (tg_op = 'INSERT' or new.account_id is distinct from old.account_id) then
    raise exception 'No se pueden registrar movimientos en una cuenta eliminada' using errcode = '23514';
  end if;
  if new.currency <> v_from.currency then
    raise exception 'La moneda del movimiento (%) no coincide con la de la cuenta (%)', new.currency, v_from.currency
      using errcode = '23514';
  end if;

  if new.to_account_id is not null then
    select * into v_to from public.accounts where id = new.to_account_id and user_id = new.user_id;
    if not found then
      raise exception 'La cuenta destino no existe o no pertenece al usuario' using errcode = '23503';
    end if;
    if v_to.deleted_at is not null and (tg_op = 'INSERT' or new.to_account_id is distinct from old.to_account_id) then
      raise exception 'No se pueden registrar movimientos hacia una cuenta eliminada' using errcode = '23514';
    end if;
    if v_to.currency <> v_from.currency then
      raise exception 'Transferencias entre monedas distintas no están soportadas en esta versión' using errcode = '23514';
    end if;
  end if;

  case new.type
    when 'CARD_PURCHASE' then
      if v_from.kind <> 'credit_card' then
        raise exception 'Una compra con tarjeta debe registrarse en una cuenta de tipo tarjeta de crédito' using errcode = '23514';
      end if;
    when 'CARD_PAYMENT' then
      if v_to.kind <> 'credit_card' then
        raise exception 'El destino de un pago de tarjeta debe ser una tarjeta de crédito' using errcode = '23514';
      end if;
      if v_from.kind = 'credit_card' then
        raise exception 'Un pago de tarjeta debe salir de una cuenta de activo (débito, ahorro, efectivo...)' using errcode = '23514';
      end if;
    when 'SAVINGS_CONTRIBUTION' then
      if v_to.kind not in ('savings', 'investment') then
        raise exception 'Una aportación de ahorro debe ir a una cuenta de ahorro o inversión' using errcode = '23514';
      end if;
    when 'INVESTMENT' then
      if new.to_account_id is not null and v_to.kind not in ('investment', 'savings', 'other_asset') then
        raise exception 'Una inversión debe ir a una cuenta de inversión, ahorro u otro activo' using errcode = '23514';
      end if;
    else
      null;
  end case;

  if new.category_id is not null then
    select * into v_cat from public.categories where id = new.category_id and user_id = new.user_id;
    if not found or v_cat.deleted_at is not null and (tg_op = 'INSERT' or new.category_id is distinct from old.category_id) then
      raise exception 'Categoría inválida' using errcode = '23503';
    end if;
  end if;

  if new.type = 'REFUND' and new.related_transaction_id is not null then
    select * into v_orig from public.transactions
      where id = new.related_transaction_id and user_id = new.user_id and deleted_at is null;
    if not found then
      raise exception 'El movimiento original de la devolución no existe' using errcode = '23503';
    end if;
    if v_orig.type not in ('EXPENSE', 'CARD_PURCHASE') then
      raise exception 'Solo se pueden devolver gastos o compras con tarjeta' using errcode = '23514';
    end if;
    select coalesce(sum(amount), 0) into v_refunded from public.transactions
      where related_transaction_id = new.related_transaction_id and type = 'REFUND'
        and deleted_at is null and id <> new.id;
    if v_refunded + new.amount > v_orig.amount then
      raise exception 'Las devoluciones (%) superan el importe original (%)', v_refunded + new.amount, v_orig.amount
        using errcode = '23514';
    end if;
  end if;

  -- Un movimiento conciliado no puede cambiar sus datos económicos sin desconciliarse.
  if tg_op = 'UPDATE' and old.reconciliation_status = 'reconciled' and new.reconciliation_status = 'reconciled'
     and new.deleted_at is null
     and (new.amount, new.account_id, new.to_account_id, new.occurred_on, new.type)
         is distinct from (old.amount, old.account_id, old.to_account_id, old.occurred_on, old.type) then
    raise exception 'Movimiento conciliado: márquelo como no conciliado antes de modificar importe, cuenta, fecha o tipo'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    if new.user_id <> old.user_id then
      raise exception 'No se puede cambiar el propietario de un movimiento' using errcode = '42501';
    end if;
    new.version := old.version + 1;
    new.created_at := old.created_at;
  end if;

  new.description := btrim(new.description);
  return new;
end;
$$;

create trigger trg_transactions_validate
  before insert or update on public.transactions
  for each row execute function public.validate_transaction();

create trigger trg_transactions_updated_at
  before update on public.transactions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Auditoría: cada modificación o borrado lógico guarda la versión anterior.
-- ---------------------------------------------------------------------------
create table public.transaction_audit (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  transaction_id  uuid not null references public.transactions (id) on delete cascade,
  action          text not null check (action in ('update', 'soft_delete', 'restore')),
  old_row         jsonb not null,
  changed_fields  text[] not null default '{}',
  changed_by      uuid,
  changed_at      timestamptz not null default now()
);

create index idx_transaction_audit_tx on public.transaction_audit (transaction_id, changed_at desc);
create index idx_transaction_audit_user on public.transaction_audit (user_id, changed_at desc);

create or replace function public.audit_transaction_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  v_changed text[];
  v_action text;
begin
  select coalesce(array_agg(key order by key), '{}') into v_changed
  from jsonb_each(v_new) n
  where key not in ('updated_at', 'version')
    and n.value is distinct from v_old -> key;

  if array_length(v_changed, 1) is null then
    return new;
  end if;

  -- Cambios solo del procesamiento IA no se auditan como ediciones contables.
  if v_changed <@ array['ai_status', 'ai_suggestion', 'ai_processed_at', 'ai_error'] then
    return new;
  end if;

  v_action := case
    when old.deleted_at is null and new.deleted_at is not null then 'soft_delete'
    when old.deleted_at is not null and new.deleted_at is null then 'restore'
    else 'update'
  end;

  insert into public.transaction_audit (user_id, transaction_id, action, old_row, changed_fields, changed_by)
  values (old.user_id, old.id, v_action, v_old, v_changed, auth.uid());
  return new;
end;
$$;

create trigger trg_transactions_audit
  after update on public.transactions
  for each row execute function public.audit_transaction_change();
