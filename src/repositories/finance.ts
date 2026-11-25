/**
 * Acceso a datos en Supabase. Toda consulta está protegida por RLS en el servidor;
 * aquí solo se filtra por conveniencia (deleted_at) y se mapea al dominio.
 */
import { requireSupabase } from '@/lib/supabase';
import type { IsoDate } from '@/domain/dates';
import type {
  Account, Category, CreditCardCycle, IncomeSource, Profile, RecurringExpense, SavingsContribution, SavingsGoal, Transaction, Uuid,
} from '@/domain/types';
import {
  accountToRow, mapAccount, mapCategory, mapContribution, mapCycle, mapGoal, mapIncomeHistory, mapIncomeSource,
  mapKnowledge, mapProfile, mapReconciliation, mapRecurring, mapTransaction, money, moneyN, recurringToRow, transactionToRow,
} from './mappers';

type Row = Record<string, unknown>;
const PAGE = 1000;

function check<T>(res: { data: T | null; error: unknown }): T {
  if (res.error) throw res.error;
  return res.data as T;
}

/** Descarga todas las filas paginando de 1000 en 1000 (límite por defecto de PostgREST). */
async function fetchAll(table: string, onlyLive = true): Promise<Row[]> {
  const sb = requireSupabase();
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select('*');
    if (onlyLive) q = q.is('deleted_at', null);
    const rows = check(await q.order('id', { ascending: true }).range(from, from + PAGE - 1)) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// ---------------------------------------------------------------- perfil
export async function getProfile(): Promise<Profile | null> {
  const sb = requireSupabase();
  const rows = check(await sb.from('profiles').select('*').limit(1)) as Row[];
  return rows[0] ? mapProfile(rows[0]) : null;
}

export async function updateProfile(userId: Uuid, p: Partial<Profile>): Promise<void> {
  const row: Row = {};
  if (p.displayName !== undefined) row.display_name = p.displayName;
  if (p.preferredMode !== undefined) row.preferred_mode = p.preferredMode;
  if (p.salaryAmount !== undefined) row.salary_amount = money(p.salaryAmount);
  if (p.salaryFrequency !== undefined) row.salary_frequency = p.salaryFrequency;
  if (p.salaryPayDays !== undefined) row.salary_pay_days = p.salaryPayDays;
  if (p.salaryAccountId !== undefined) row.salary_account_id = p.salaryAccountId;
  if (p.salaryEffectiveFrom !== undefined) row.salary_effective_from = p.salaryEffectiveFrom;
  if (p.emergencyFundMonths !== undefined) row.emergency_fund_months = p.emergencyFundMonths;
  check(await requireSupabase().from('profiles').update(row).eq('user_id', userId));
}

export async function getIncomeHistory() {
  const rows = check(await requireSupabase().from('profile_income_history').select('*').order('changed_at', { ascending: false }).limit(50)) as Row[];
  return rows.map(mapIncomeHistory);
}

export async function completeOnboarding(payload: unknown): Promise<void> {
  check(await requireSupabase().rpc('complete_onboarding', { p_payload: payload }));
}

// ---------------------------------------------------------------- cuentas
export async function listAccounts(): Promise<Account[]> {
  return (await fetchAll('accounts')).map(mapAccount)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export async function saveAccount(a: Partial<Account> & { clientId: Uuid }): Promise<void> {
  const sb = requireSupabase();
  const row = accountToRow(a);
  if (a.id) check(await sb.from('accounts').update(row).eq('id', a.id));
  else check(await sb.from('accounts').upsert(row, { onConflict: 'client_id' }));
}

export async function softDeleteAccount(id: Uuid): Promise<void> {
  check(await requireSupabase().from('accounts').update({ deleted_at: new Date().toISOString() }).eq('id', id));
}

/** Saldos calculados por el SERVIDOR (vista account_balances) para verificación de integridad. */
export async function listServerBalances(): Promise<Map<Uuid, string>> {
  const rows = check(await requireSupabase().from('account_balances').select('account_id, balance')) as Row[];
  return new Map(rows.map((r) => [String(r.account_id), String(r.balance)]));
}

// ---------------------------------------------------------------- categorías
export async function listCategories(): Promise<Category[]> {
  return (await fetchAll('categories')).map(mapCategory).sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export async function saveCategory(c: { id?: Uuid; clientId: Uuid; name: string; kind: Category['kind'] }): Promise<void> {
  const sb = requireSupabase();
  if (c.id) check(await sb.from('categories').update({ name: c.name, kind: c.kind }).eq('id', c.id));
  else check(await sb.from('categories').upsert({ client_id: c.clientId, name: c.name, kind: c.kind }, { onConflict: 'client_id' }));
}

export async function softDeleteCategory(id: Uuid): Promise<void> {
  check(await requireSupabase().from('categories').update({ deleted_at: new Date().toISOString() }).eq('id', id));
}

// ---------------------------------------------------------------- transacciones
export async function listTransactions(): Promise<Transaction[]> {
  return (await fetchAll('transactions')).map(mapTransaction)
    .sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : a.occurredOn > b.occurredOn ? -1 : b.createdAt.localeCompare(a.createdAt)));
}

/** Inserción idempotente por client_id (reintentos seguros desde la cola offline o Android). */
export async function upsertTransaction(t: Partial<Transaction> & { clientId: Uuid }): Promise<Transaction> {
  const rows = check(
    await requireSupabase().from('transactions').upsert(transactionToRow(t), { onConflict: 'client_id' }).select('*'),
  ) as Row[];
  return mapTransaction(rows[0]!);
}

export async function insertTransactions(list: (Partial<Transaction> & { clientId: Uuid })[]): Promise<number> {
  if (!list.length) return 0;
  const rows = check(
    await requireSupabase().from('transactions').upsert(list.map(transactionToRow), { onConflict: 'client_id', ignoreDuplicates: true }).select('id'),
  ) as Row[];
  return rows.length;
}

export async function updateTransaction(id: Uuid, patch: Partial<Transaction>): Promise<void> {
  check(await requireSupabase().from('transactions').update(transactionToRow(patch)).eq('id', id));
}

export async function softDeleteTransaction(id: Uuid): Promise<void> {
  check(await requireSupabase().from('transactions').update({ deleted_at: new Date().toISOString() }).eq('id', id));
}

export async function listTransactionAudit(transactionId: Uuid) {
  return check(await requireSupabase().from('transaction_audit').select('*').eq('transaction_id', transactionId)
    .order('changed_at', { ascending: false })) as Row[];
}

// ---------------------------------------------------------------- recurrentes
export async function listRecurring(): Promise<RecurringExpense[]> {
  return (await fetchAll('recurring_expenses')).map(mapRecurring).sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export async function saveRecurring(r: Partial<RecurringExpense> & { clientId: Uuid }): Promise<void> {
  const sb = requireSupabase();
  const row = recurringToRow(r);
  if (r.id) check(await sb.from('recurring_expenses').update(row).eq('id', r.id));
  else check(await sb.from('recurring_expenses').upsert(row, { onConflict: 'client_id' }));
}

export async function softDeleteRecurring(id: Uuid): Promise<void> {
  check(await requireSupabase().from('recurring_expenses').update({ deleted_at: new Date().toISOString() }).eq('id', id));
}

// ---------------------------------------------------------------- ingresos adicionales
export async function listIncomeSources(): Promise<IncomeSource[]> {
  return (await fetchAll('income_sources')).map(mapIncomeSource);
}

export async function saveIncomeSource(i: Partial<IncomeSource> & { clientId: Uuid }): Promise<void> {
  const sb = requireSupabase();
  const row: Row = {
    client_id: i.clientId, name: i.name, amount: i.amount !== undefined ? money(i.amount) : undefined, frequency: i.frequency,
    pay_day: i.payDay, account_id: i.accountId, start_date: i.startDate, end_date: i.endDate, is_active: i.isActive, notes: i.notes,
  };
  Object.keys(row).forEach((k) => row[k] === undefined && delete row[k]);
  if (i.id) check(await sb.from('income_sources').update(row).eq('id', i.id));
  else check(await sb.from('income_sources').upsert(row, { onConflict: 'client_id' }));
}

export async function softDeleteIncomeSource(id: Uuid): Promise<void> {
  check(await requireSupabase().from('income_sources').update({ deleted_at: new Date().toISOString() }).eq('id', id));
}

// ---------------------------------------------------------------- metas
export async function listGoals(): Promise<SavingsGoal[]> {
  return (await fetchAll('savings_goals')).map(mapGoal);
}

export async function saveGoal(g: Partial<SavingsGoal> & { clientId: Uuid }): Promise<void> {
  const sb = requireSupabase();
  const row: Row = {
    client_id: g.clientId, name: g.name, target_amount: g.targetAmount !== undefined ? money(g.targetAmount) : undefined,
    target_date: g.targetDate, account_id: g.accountId, is_emergency_fund: g.isEmergencyFund, status: g.status, notes: g.notes,
  };
  Object.keys(row).forEach((k) => row[k] === undefined && delete row[k]);
  if (g.id) check(await sb.from('savings_goals').update(row).eq('id', g.id));
  else check(await sb.from('savings_goals').upsert(row, { onConflict: 'client_id' }));
}

export async function softDeleteGoal(id: Uuid): Promise<void> {
  check(await requireSupabase().from('savings_goals').update({ deleted_at: new Date().toISOString() }).eq('id', id));
}

export async function listContributions(): Promise<SavingsContribution[]> {
  return (await fetchAll('savings_contributions')).map(mapContribution);
}

export async function addContribution(c: Omit<SavingsContribution, 'id' | 'deletedAt'>): Promise<void> {
  check(await requireSupabase().from('savings_contributions').upsert({
    client_id: c.clientId, goal_id: c.goalId, kind: c.kind, amount: money(c.amount), contributed_on: c.contributedOn,
    transaction_id: c.transactionId, notes: c.notes,
  }, { onConflict: 'client_id' }));
}

export async function softDeleteContribution(id: Uuid): Promise<void> {
  check(await requireSupabase().from('savings_contributions').update({ deleted_at: new Date().toISOString() }).eq('id', id));
}

// ---------------------------------------------------------------- ciclos de tarjeta
export async function listCycles(): Promise<CreditCardCycle[]> {
  return (await fetchAll('credit_card_cycles')).map(mapCycle);
}

export async function saveCycle(c: Partial<CreditCardCycle> & { clientId: Uuid; accountId: Uuid }, importBatchId?: Uuid): Promise<void> {
  const sb = requireSupabase();
  const row: Row = {
    client_id: c.clientId, account_id: c.accountId, period_start: c.periodStart, statement_date: c.statementDate, due_date: c.dueDate,
    previous_balance: moneyN(c.previousBalance), statement_balance: moneyN(c.statementBalance), minimum_payment: moneyN(c.minimumPayment),
    full_payment: moneyN(c.fullPayment), interest_charged: moneyN(c.interestCharged), fees_charged: moneyN(c.feesCharged),
    annual_rate_pct: c.annualRatePct, source: c.source ?? 'manual', notes: c.notes, import_batch_id: importBatchId,
  };
  Object.keys(row).forEach((k) => row[k] === undefined && delete row[k]);
  if (c.id) check(await sb.from('credit_card_cycles').update(row).eq('id', c.id));
  else check(await sb.from('credit_card_cycles').upsert(row, { onConflict: 'client_id' }));
}

export async function softDeleteCycle(id: Uuid): Promise<void> {
  check(await requireSupabase().from('credit_card_cycles').update({ deleted_at: new Date().toISOString() }).eq('id', id));
}

// ---------------------------------------------------------------- conciliación
export async function listReconciliations() {
  const rows = check(await requireSupabase().from('reconciliation_records').select('*').is('deleted_at', null)
    .order('reconciled_on', { ascending: false }).limit(200)) as Row[];
  return rows.map(mapReconciliation);
}

export async function reconcileAccount(p: {
  accountId: Uuid; date: IsoDate; statementBalance: string; createAdjustment: boolean; markTransactions: boolean; notes: string | null; clientId: Uuid;
}) {
  const row = check(await requireSupabase().rpc('reconcile_account', {
    p_account_id: p.accountId, p_reconciled_on: p.date, p_statement_balance: p.statementBalance,
    p_create_adjustment: p.createAdjustment, p_mark_transactions: p.markTransactions, p_notes: p.notes, p_client_id: p.clientId,
  })) as Row;
  return mapReconciliation(row);
}

// ---------------------------------------------------------------- importaciones
export async function createImportBatch(b: Row): Promise<Uuid> {
  const rows = check(await requireSupabase().from('import_batches').upsert(b, { onConflict: 'client_id' }).select('id')) as Row[];
  return String(rows[0]!.id);
}

export async function findImportsByHash(sha256: string) {
  return check(await requireSupabase().from('import_batches').select('id, file_name, created_at, rows_imported')
    .eq('file_sha256', sha256).eq('status', 'confirmed').is('deleted_at', null)) as Row[];
}

// ---------------------------------------------------------------- conocimiento
export async function listKnowledge() {
  const rows = check(await requireSupabase().from('ai_knowledge_base').select('*').eq('is_active', true).order('topic')) as Row[];
  return rows.map(mapKnowledge);
}
