/**
 * Modelos de dominio (camelCase). Son independientes de la base de datos:
 * los repositorios convierten filas snake_case <-> dominio.
 * Contrato espejo en docs/SCHEMA.md y docs/ANDROID_CONTRACT.md.
 */
import type { Cents } from './money';
import type { IsoDate } from './dates';

export type Uuid = string;

export const ACCOUNT_KINDS = [
  'checking', 'savings', 'cash', 'investment', 'other_asset',
  'credit_card', 'loan', 'other_liability',
] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const LIABILITY_KINDS: ReadonlySet<AccountKind> = new Set(['credit_card', 'loan', 'other_liability']);
export const LIQUID_ASSET_KINDS: ReadonlySet<AccountKind> = new Set(['checking', 'savings', 'cash']);

export const ACCOUNT_KIND_LABEL: Record<AccountKind, string> = {
  checking: 'Débito / corriente',
  savings: 'Ahorro',
  cash: 'Efectivo',
  investment: 'Inversión',
  other_asset: 'Otro activo',
  credit_card: 'Tarjeta de crédito',
  loan: 'Préstamo',
  other_liability: 'Otra obligación',
};

export interface Account {
  id: Uuid;
  clientId: Uuid;
  name: string;
  institution: string | null;
  kind: AccountKind;
  isLiability: boolean;
  currency: string;
  openingBalance: Cents;
  openingBalanceDate: IsoDate;
  creditLimit: Cents | null;
  annualInterestRatePct: number | null;
  statementDay: number | null;
  paymentDueDay: number | null;
  utilizationAlertPct: number;
  last4: string | null;
  color: string | null;
  sortOrder: number;
  isArchived: boolean;
  updatedAt: string;
  deletedAt: string | null;
}

export const TRANSACTION_TYPES = [
  'INCOME', 'EXPENSE', 'TRANSFER', 'CARD_PURCHASE', 'CARD_PAYMENT',
  'SAVINGS_CONTRIBUTION', 'INVESTMENT', 'REFUND', 'ADJUSTMENT',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_TYPE_LABEL: Record<TransactionType, string> = {
  INCOME: 'Ingreso',
  EXPENSE: 'Gasto',
  TRANSFER: 'Transferencia',
  CARD_PURCHASE: 'Compra con tarjeta',
  CARD_PAYMENT: 'Pago de tarjeta',
  SAVINGS_CONTRIBUTION: 'Aporte a ahorro',
  INVESTMENT: 'Inversión',
  REFUND: 'Devolución',
  ADJUSTMENT: 'Ajuste de saldo',
};

/** Tipos que mueven dinero entre cuentas propias y requieren destino. */
export const TYPES_REQUIRING_DESTINATION: ReadonlySet<TransactionType> = new Set([
  'TRANSFER', 'CARD_PAYMENT', 'SAVINGS_CONTRIBUTION',
]);

export type EntryMode = 'simple' | 'normal' | 'import' | 'recurring' | 'system';
export type TransactionSource = 'manual' | 'pdf_import' | 'recurring' | 'reconciliation' | 'android' | 'api';
export type ReconciliationStatus = 'unreconciled' | 'reconciled' | 'disputed';
export type AiStatus = 'none' | 'pending' | 'processing' | 'suggested' | 'accepted' | 'rejected' | 'failed' | 'skipped';
export type ClassificationSource = 'user' | 'rules' | 'ai';
export type AdjustmentDirection = 'increase' | 'decrease';

export interface AiSuggestion {
  categoryId?: Uuid | null;
  categorySlug?: string | null;
  normalizedDescription?: string | null;
  accountId?: Uuid | null;
  confidence?: number | null;
  model?: string | null;
  rationale?: string | null;
  engine: 'groq' | 'rules';
}

export interface Transaction {
  id: Uuid;
  clientId: Uuid;
  type: TransactionType;
  accountId: Uuid;
  toAccountId: Uuid | null;
  amount: Cents;
  currency: string;
  occurredOn: IsoDate;
  postedOn: IsoDate | null;
  description: string;
  normalizedDescription: string | null;
  originalNote: string | null;
  categoryId: Uuid | null;
  classificationSource: ClassificationSource | null;
  adjustmentDirection: AdjustmentDirection | null;
  relatedTransactionId: Uuid | null;
  transferGroupId: Uuid | null;
  recurringExpenseId: Uuid | null;
  savingsGoalId: Uuid | null;
  importBatchId: Uuid | null;
  importRowRef: string | null;
  bankReference: string | null;
  dedupeKey: string | null;
  entryMode: EntryMode;
  source: TransactionSource;
  reconciliationStatus: ReconciliationStatus;
  aiStatus: AiStatus;
  aiSuggestion: AiSuggestion | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type CategoryKind = 'income' | 'expense' | 'savings';

export interface Category {
  id: Uuid;
  clientId: Uuid;
  name: string;
  kind: CategoryKind;
  slug: string | null;
  color: string | null;
  isSystem: boolean;
  deletedAt: string | null;
}

export type RecurringFrequency = 'weekly' | 'biweekly' | 'monthly' | 'bimonthly' | 'quarterly' | 'yearly';
export type RecurringStatus = 'active' | 'paused' | 'cancelled';

export const RECURRING_FREQUENCY_LABEL: Record<RecurringFrequency, string> = {
  weekly: 'Semanal',
  biweekly: 'Cada 2 semanas',
  monthly: 'Mensual',
  bimonthly: 'Bimestral',
  quarterly: 'Trimestral',
  yearly: 'Anual',
};

export interface RecurringExpense {
  id: Uuid;
  clientId: Uuid;
  name: string;
  amount: Cents;
  currency: string;
  accountId: Uuid;
  categoryId: Uuid | null;
  transactionType: 'EXPENSE' | 'CARD_PURCHASE';
  frequency: RecurringFrequency;
  dayFrom: number | null;
  dayTo: number | null;
  weekday: number | null;
  monthOfYear: number | null;
  startDate: IsoDate;
  endDate: IsoDate | null;
  status: RecurringStatus;
  remindDaysBefore: number;
  notes: string | null;
  deletedAt: string | null;
}

export type PayFrequency = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';

export const PAY_FREQUENCY_LABEL: Record<PayFrequency, string> = {
  weekly: 'Semanal',
  biweekly: 'Cada 2 semanas',
  semimonthly: 'Quincenal (2 veces al mes)',
  monthly: 'Mensual',
};

export interface Profile {
  userId: Uuid;
  displayName: string | null;
  baseCurrency: string;
  preferredMode: 'simple' | 'normal';
  salaryAmount: Cents;
  salaryFrequency: PayFrequency;
  salaryPayDays: number[];
  salaryAccountId: Uuid | null;
  salaryEffectiveFrom: IsoDate | null;
  emergencyFundMonths: number;
  onboardingCompletedAt: string | null;
}

export interface IncomeHistoryEntry {
  id: Uuid;
  changedAt: string;
  oldAmount: Cents | null;
  newAmount: Cents;
  oldFrequency: string | null;
  newFrequency: string;
  effectiveFrom: IsoDate | null;
}

export type IncomeFrequency = 'one_time' | 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'yearly';

export interface IncomeSource {
  id: Uuid;
  clientId: Uuid;
  name: string;
  amount: Cents;
  currency: string;
  frequency: IncomeFrequency;
  payDay: number | null;
  accountId: Uuid | null;
  startDate: IsoDate;
  endDate: IsoDate | null;
  isActive: boolean;
  notes: string | null;
  deletedAt: string | null;
}

export interface SavingsGoal {
  id: Uuid;
  clientId: Uuid;
  name: string;
  targetAmount: Cents;
  currency: string;
  targetDate: IsoDate | null;
  accountId: Uuid | null;
  isEmergencyFund: boolean;
  status: 'active' | 'completed' | 'archived';
  notes: string | null;
  deletedAt: string | null;
}

export interface SavingsContribution {
  id: Uuid;
  clientId: Uuid;
  goalId: Uuid;
  kind: 'contribution' | 'withdrawal';
  amount: Cents;
  contributedOn: IsoDate;
  transactionId: Uuid | null;
  notes: string | null;
  deletedAt: string | null;
}

export interface CreditCardCycle {
  id: Uuid;
  clientId: Uuid;
  accountId: Uuid;
  periodStart: IsoDate;
  statementDate: IsoDate;
  dueDate: IsoDate;
  previousBalance: Cents | null;
  statementBalance: Cents;
  minimumPayment: Cents;
  fullPayment: Cents;
  interestCharged: Cents | null;
  feesCharged: Cents | null;
  annualRatePct: number | null;
  source: 'manual' | 'pdf_import';
  notes: string | null;
  deletedAt: string | null;
}

export interface ReconciliationRecord {
  id: Uuid;
  clientId: Uuid;
  accountId: Uuid;
  reconciledOn: IsoDate;
  statementBalance: Cents;
  calculatedBalance: Cents;
  difference: Cents;
  status: 'matched' | 'adjusted' | 'pending';
  adjustmentTransactionId: Uuid | null;
  notes: string | null;
  createdAt: string;
}

export interface KnowledgeEntry {
  id: Uuid;
  slug: string;
  title: string;
  topic: 'credit_card' | 'budgeting' | 'emergency_fund' | 'debt_management' | 'investing_basics' | 'accounting_basics';
  targetAudience: 'simple' | 'normal' | 'all';
  contentType: 'official' | 'general_principle' | 'guidance';
  principleSummary: string;
  actionableTip: string;
  sourceReference: string;
  sourceUrl: string | null;
  verificationDate: IsoDate | null;
}

export interface DatePeriod {
  from: IsoDate;
  to: IsoDate;
}
