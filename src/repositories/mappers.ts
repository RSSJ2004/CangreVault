/**
 * Conversión fila (snake_case, numeric como string/number) <-> dominio (camelCase, centavos).
 * Este archivo es el contrato de datos: cualquier cambio de columnas debe reflejarse
 * aquí, en docs/SCHEMA.md y en el cliente Android.
 */
import { fromDb, fromDbNullable, toDecimalString, type Cents } from '@/domain/money';
import type { IsoDate } from '@/domain/dates';
import type {
  Account, AiSuggestion, Category, CreditCardCycle, IncomeHistoryEntry, IncomeSource, KnowledgeEntry, Profile,
  ReconciliationRecord, RecurringExpense, SavingsContribution, SavingsGoal, Transaction,
} from '@/domain/types';

type Row = Record<string, unknown>;
type Num = string | number | null;

const s = (v: unknown) => v as string;
const sn = (v: unknown) => (v ?? null) as string | null;
const d = (v: unknown) => v as IsoDate;
const dn = (v: unknown) => (v ?? null) as IsoDate | null;
const nn = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export const money = (c: Cents) => toDecimalString(c);
export const moneyN = (c: Cents | null | undefined) => (c === null || c === undefined ? null : toDecimalString(c));

export function mapAccount(r: Row): Account {
  return {
    id: s(r.id), clientId: s(r.client_id), name: s(r.name), institution: sn(r.institution),
    kind: r.kind as Account['kind'], isLiability: Boolean(r.is_liability), currency: s(r.currency),
    openingBalance: fromDb(r.opening_balance as Num), openingBalanceDate: d(r.opening_balance_date),
    creditLimit: fromDbNullable(r.credit_limit as Num), annualInterestRatePct: nn(r.annual_interest_rate_pct),
    statementDay: nn(r.statement_day), paymentDueDay: nn(r.payment_due_day),
    utilizationAlertPct: Number(r.utilization_alert_pct ?? 30), last4: sn(r.last4), color: sn(r.color),
    sortOrder: Number(r.sort_order ?? 0), isArchived: Boolean(r.is_archived), updatedAt: s(r.updated_at), deletedAt: sn(r.deleted_at),
  };
}

export function accountToRow(a: Partial<Account>): Row {
  const row: Row = {};
  if (a.id !== undefined) row.id = a.id;
  if (a.clientId !== undefined) row.client_id = a.clientId;
  if (a.name !== undefined) row.name = a.name.trim();
  if (a.institution !== undefined) row.institution = a.institution;
  if (a.kind !== undefined) row.kind = a.kind;
  if (a.currency !== undefined) row.currency = a.currency;
  if (a.openingBalance !== undefined) row.opening_balance = money(a.openingBalance);
  if (a.openingBalanceDate !== undefined) row.opening_balance_date = a.openingBalanceDate;
  if (a.creditLimit !== undefined) row.credit_limit = moneyN(a.creditLimit);
  if (a.annualInterestRatePct !== undefined) row.annual_interest_rate_pct = a.annualInterestRatePct;
  if (a.statementDay !== undefined) row.statement_day = a.statementDay;
  if (a.paymentDueDay !== undefined) row.payment_due_day = a.paymentDueDay;
  if (a.utilizationAlertPct !== undefined) row.utilization_alert_pct = a.utilizationAlertPct;
  if (a.last4 !== undefined) row.last4 = a.last4;
  if (a.color !== undefined) row.color = a.color;
  if (a.sortOrder !== undefined) row.sort_order = a.sortOrder;
  if (a.isArchived !== undefined) row.is_archived = a.isArchived;
  return row;
}

function mapAiSuggestion(v: unknown): AiSuggestion | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Row;
  return {
    categoryId: sn(o.category_id), categorySlug: sn(o.category_slug), normalizedDescription: sn(o.normalized_description),
    accountId: sn(o.account_id), confidence: nn(o.confidence), model: sn(o.model), rationale: sn(o.rationale),
    engine: (o.engine as AiSuggestion['engine']) ?? 'groq',
  };
}

export function mapTransaction(r: Row): Transaction {
  return {
    id: s(r.id), clientId: s(r.client_id), type: r.type as Transaction['type'], accountId: s(r.account_id),
    toAccountId: sn(r.to_account_id), amount: fromDb(r.amount as Num), currency: s(r.currency),
    occurredOn: d(r.occurred_on), postedOn: dn(r.posted_on), description: s(r.description),
    normalizedDescription: sn(r.normalized_description), originalNote: sn(r.original_note), categoryId: sn(r.category_id),
    classificationSource: (r.classification_source ?? null) as Transaction['classificationSource'],
    adjustmentDirection: (r.adjustment_direction ?? null) as Transaction['adjustmentDirection'],
    relatedTransactionId: sn(r.related_transaction_id), transferGroupId: sn(r.transfer_group_id),
    recurringExpenseId: sn(r.recurring_expense_id), savingsGoalId: sn(r.savings_goal_id), importBatchId: sn(r.import_batch_id),
    importRowRef: sn(r.import_row_ref), bankReference: sn(r.bank_reference), dedupeKey: sn(r.dedupe_key),
    entryMode: r.entry_mode as Transaction['entryMode'], source: r.source as Transaction['source'],
    reconciliationStatus: r.reconciliation_status as Transaction['reconciliationStatus'],
    aiStatus: r.ai_status as Transaction['aiStatus'], aiSuggestion: mapAiSuggestion(r.ai_suggestion),
    version: Number(r.version ?? 1), createdAt: s(r.created_at), updatedAt: s(r.updated_at), deletedAt: sn(r.deleted_at),
  };
}

/** Fila para insertar/actualizar. Nunca envía campos calculados por el servidor (version, created_at...). */
export function transactionToRow(t: Partial<Transaction>): Row {
  const map: [keyof Transaction, string, ((v: never) => unknown)?][] = [
    ['id', 'id'], ['clientId', 'client_id'], ['type', 'type'], ['accountId', 'account_id'], ['toAccountId', 'to_account_id'],
    ['amount', 'amount', (v: Cents) => money(v)], ['currency', 'currency'], ['occurredOn', 'occurred_on'], ['postedOn', 'posted_on'],
    ['description', 'description'], ['normalizedDescription', 'normalized_description'], ['originalNote', 'original_note'],
    ['categoryId', 'category_id'], ['classificationSource', 'classification_source'], ['adjustmentDirection', 'adjustment_direction'],
    ['relatedTransactionId', 'related_transaction_id'], ['transferGroupId', 'transfer_group_id'],
    ['recurringExpenseId', 'recurring_expense_id'], ['savingsGoalId', 'savings_goal_id'], ['importBatchId', 'import_batch_id'],
    ['importRowRef', 'import_row_ref'], ['bankReference', 'bank_reference'], ['dedupeKey', 'dedupe_key'],
    ['entryMode', 'entry_mode'], ['source', 'source'], ['reconciliationStatus', 'reconciliation_status'], ['aiStatus', 'ai_status'],
    ['deletedAt', 'deleted_at'],
  ];
  const row: Row = {};
  for (const [k, col, conv] of map) {
    if (t[k] !== undefined) row[col] = conv ? conv(t[k] as never) : t[k];
  }
  return row;
}

export function mapCategory(r: Row): Category {
  return {
    id: s(r.id), clientId: s(r.client_id), name: s(r.name), kind: r.kind as Category['kind'], slug: sn(r.slug),
    color: sn(r.color), isSystem: Boolean(r.is_system), deletedAt: sn(r.deleted_at),
  };
}

export function mapRecurring(r: Row): RecurringExpense {
  return {
    id: s(r.id), clientId: s(r.client_id), name: s(r.name), amount: fromDb(r.amount as Num), currency: s(r.currency),
    accountId: s(r.account_id), categoryId: sn(r.category_id), transactionType: r.transaction_type as RecurringExpense['transactionType'],
    frequency: r.frequency as RecurringExpense['frequency'], dayFrom: nn(r.day_from), dayTo: nn(r.day_to), weekday: nn(r.weekday),
    monthOfYear: nn(r.month_of_year), startDate: d(r.start_date), endDate: dn(r.end_date), status: r.status as RecurringExpense['status'],
    remindDaysBefore: Number(r.remind_days_before ?? 3), notes: sn(r.notes), deletedAt: sn(r.deleted_at),
  };
}

export function recurringToRow(r: Partial<RecurringExpense>): Row {
  const row: Row = {};
  const set = (k: keyof RecurringExpense, col: string, v?: unknown) => { if (r[k] !== undefined) row[col] = v ?? r[k]; };
  set('id', 'id'); set('clientId', 'client_id'); set('name', 'name');
  if (r.amount !== undefined) row.amount = money(r.amount);
  set('currency', 'currency'); set('accountId', 'account_id'); set('categoryId', 'category_id');
  set('transactionType', 'transaction_type'); set('frequency', 'frequency'); set('dayFrom', 'day_from'); set('dayTo', 'day_to');
  set('weekday', 'weekday'); set('monthOfYear', 'month_of_year'); set('startDate', 'start_date'); set('endDate', 'end_date');
  set('status', 'status'); set('remindDaysBefore', 'remind_days_before'); set('notes', 'notes'); set('deletedAt', 'deleted_at');
  return row;
}

export function mapProfile(r: Row): Profile {
  return {
    userId: s(r.user_id), displayName: sn(r.display_name), baseCurrency: s(r.base_currency),
    preferredMode: r.preferred_mode as Profile['preferredMode'], salaryAmount: fromDb(r.salary_amount as Num),
    salaryFrequency: r.salary_frequency as Profile['salaryFrequency'], salaryPayDays: ((r.salary_pay_days as number[]) ?? []).map(Number),
    salaryAccountId: sn(r.salary_account_id), salaryEffectiveFrom: dn(r.salary_effective_from),
    emergencyFundMonths: Number(r.emergency_fund_months ?? 3), onboardingCompletedAt: sn(r.onboarding_completed_at),
  };
}

export function mapIncomeHistory(r: Row): IncomeHistoryEntry {
  return {
    id: s(r.id), changedAt: s(r.changed_at), oldAmount: fromDbNullable(r.old_amount as Num), newAmount: fromDb(r.new_amount as Num),
    oldFrequency: sn(r.old_frequency), newFrequency: s(r.new_frequency), effectiveFrom: dn(r.effective_from),
  };
}

export function mapIncomeSource(r: Row): IncomeSource {
  return {
    id: s(r.id), clientId: s(r.client_id), name: s(r.name), amount: fromDb(r.amount as Num), currency: s(r.currency),
    frequency: r.frequency as IncomeSource['frequency'], payDay: nn(r.pay_day), accountId: sn(r.account_id),
    startDate: d(r.start_date), endDate: dn(r.end_date), isActive: Boolean(r.is_active), notes: sn(r.notes), deletedAt: sn(r.deleted_at),
  };
}

export function mapGoal(r: Row): SavingsGoal {
  return {
    id: s(r.id), clientId: s(r.client_id), name: s(r.name), targetAmount: fromDb(r.target_amount as Num), currency: s(r.currency),
    targetDate: dn(r.target_date), accountId: sn(r.account_id), isEmergencyFund: Boolean(r.is_emergency_fund),
    status: r.status as SavingsGoal['status'], notes: sn(r.notes), deletedAt: sn(r.deleted_at),
  };
}

export function mapContribution(r: Row): SavingsContribution {
  return {
    id: s(r.id), clientId: s(r.client_id), goalId: s(r.goal_id), kind: r.kind as SavingsContribution['kind'],
    amount: fromDb(r.amount as Num), contributedOn: d(r.contributed_on), transactionId: sn(r.transaction_id),
    notes: sn(r.notes), deletedAt: sn(r.deleted_at),
  };
}

export function mapCycle(r: Row): CreditCardCycle {
  return {
    id: s(r.id), clientId: s(r.client_id), accountId: s(r.account_id), periodStart: d(r.period_start),
    statementDate: d(r.statement_date), dueDate: d(r.due_date), previousBalance: fromDbNullable(r.previous_balance as Num),
    statementBalance: fromDb(r.statement_balance as Num), minimumPayment: fromDb(r.minimum_payment as Num),
    fullPayment: fromDb(r.full_payment as Num), interestCharged: fromDbNullable(r.interest_charged as Num),
    feesCharged: fromDbNullable(r.fees_charged as Num), annualRatePct: nn(r.annual_rate_pct),
    source: r.source as CreditCardCycle['source'], notes: sn(r.notes), deletedAt: sn(r.deleted_at),
  };
}

export function mapReconciliation(r: Row): ReconciliationRecord {
  return {
    id: s(r.id), clientId: s(r.client_id), accountId: s(r.account_id), reconciledOn: d(r.reconciled_on),
    statementBalance: fromDb(r.statement_balance as Num), calculatedBalance: fromDb(r.calculated_balance as Num),
    difference: fromDb(r.difference as Num), status: r.status as ReconciliationRecord['status'],
    adjustmentTransactionId: sn(r.adjustment_transaction_id), notes: sn(r.notes), createdAt: s(r.created_at),
  };
}

export function mapKnowledge(r: Row): KnowledgeEntry {
  return {
    id: s(r.id), slug: s(r.slug), title: s(r.title), topic: r.topic as KnowledgeEntry['topic'],
    targetAudience: r.target_audience as KnowledgeEntry['targetAudience'], contentType: r.content_type as KnowledgeEntry['contentType'],
    principleSummary: s(r.principle_summary), actionableTip: s(r.actionable_tip), sourceReference: s(r.source_reference),
    sourceUrl: sn(r.source_url), verificationDate: dn(r.verification_date),
  };
}
