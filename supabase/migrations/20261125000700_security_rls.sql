-- =============================================================================
-- CangreVault · 0700 · Seguridad: RLS, privilegios y Realtime
--
-- Principios:
--  * Aislamiento estricto por usuario: auth.uid() = user_id.
--  * Sin políticas DELETE: los registros financieros se eliminan con soft-delete
--    (deleted_at). El borrado físico solo ocurre al eliminar la cuenta de Auth.
--  * anon no tiene acceso a ninguna tabla financiera.
-- =============================================================================

do $$
declare
  t text;
  owned_tables text[] := array[
    'accounts', 'categories', 'income_sources', 'transactions', 'recurring_expenses',
    'savings_goals', 'savings_contributions', 'credit_card_cycles', 'import_batches',
    'reconciliation_records'];
begin
  foreach t in array owned_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, public', t);
    execute format('revoke delete, truncate on public.%I from authenticated', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);

    execute format($p$create policy %I on public.%I for select to authenticated
                     using ((select auth.uid()) = user_id)$p$, t || '_select_own', t);
    execute format($p$create policy %I on public.%I for insert to authenticated
                     with check ((select auth.uid()) = user_id)$p$, t || '_insert_own', t);
    execute format($p$create policy %I on public.%I for update to authenticated
                     using ((select auth.uid()) = user_id)
                     with check ((select auth.uid()) = user_id)$p$, t || '_update_own', t);
  end loop;
end;
$$;

-- Perfiles
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, public;
revoke delete, truncate on public.profiles from authenticated;
grant select, insert, update on public.profiles to authenticated;
create policy profiles_select_own on public.profiles for select to authenticated
  using ((select auth.uid()) = user_id);
create policy profiles_insert_own on public.profiles for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy profiles_update_own on public.profiles for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Tablas de solo lectura para el usuario (las escriben triggers SECURITY DEFINER)
alter table public.profile_income_history enable row level security;
revoke all on public.profile_income_history from anon, public, authenticated;
grant select on public.profile_income_history to authenticated;
create policy income_history_select_own on public.profile_income_history for select to authenticated
  using ((select auth.uid()) = user_id);

alter table public.transaction_audit enable row level security;
revoke all on public.transaction_audit from anon, public, authenticated;
grant select on public.transaction_audit to authenticated;
create policy tx_audit_select_own on public.transaction_audit for select to authenticated
  using ((select auth.uid()) = user_id);

-- Base de conocimiento: lectura para usuarios autenticados; escritura solo vía migraciones/service_role.
alter table public.ai_knowledge_base enable row level security;
revoke all on public.ai_knowledge_base from anon, public, authenticated;
grant select on public.ai_knowledge_base to authenticated;
create policy kb_select_active on public.ai_knowledge_base for select to authenticated
  using (is_active);

-- Vista de saldos (security_invoker => aplica RLS de accounts/transactions)
revoke all on public.account_balances from anon, public;
grant select on public.account_balances to authenticated;

-- Funciones expuestas por RPC: solo usuarios autenticados.
revoke all on function public.reconcile_account(uuid, date, numeric, boolean, boolean, text, uuid) from public, anon;
grant execute on function public.reconcile_account(uuid, date, numeric, boolean, boolean, text, uuid) to authenticated;
revoke all on function public.complete_onboarding(jsonb) from public, anon;
grant execute on function public.complete_onboarding(jsonb) to authenticated;
revoke all on function public.account_balance_at(uuid, date) from public, anon;
grant execute on function public.account_balance_at(uuid, date) to authenticated;
revoke all on function public.account_signed_movements(uuid, date, date) from public, anon;
grant execute on function public.account_signed_movements(uuid, date, date) to authenticated;

-- Realtime (Postgres Changes respeta RLS). Solo si la publicación existe (Supabase).
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array[
      'profiles', 'accounts', 'categories', 'income_sources', 'transactions', 'recurring_expenses',
      'savings_goals', 'savings_contributions', 'credit_card_cycles', 'import_batches',
      'reconciliation_records'] loop
      if not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;
