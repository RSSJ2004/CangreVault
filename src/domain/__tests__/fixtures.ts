import { cents } from '../money';
import { isoDate, type IsoDate } from '../dates';
import type { Account, Transaction, TransactionType } from '../types';

export const D = (s: string): IsoDate => isoDate(s);
export const C = (units: number) => cents(Math.round(units * 100));

export function account(p: Partial<Account> & Pick<Account, 'id' | 'kind'>): Account {
  const isLiability = ['credit_card', 'loan', 'other_liability'].includes(p.kind);
  return {
    clientId: p.id, name: p.id, institution: 'Banreservas', currency: 'DOP',
    openingBalance: cents(0), openingBalanceDate: D('2026-01-01'), creditLimit: null,
    annualInterestRatePct: null, statementDay: null, paymentDueDay: null, utilizationAlertPct: 30,
    last4: null, color: null, sortOrder: 0, isArchived: false, updatedAt: '', deletedAt: null,
    ...p, isLiability,
  };
}

let seq = 0;
export function tx(type: TransactionType, accountId: string, amount: number, date: string, extra: Partial<Transaction> = {}): Transaction {
  seq++;
  return {
    id: `tx-${seq}`, clientId: `c-${seq}`, type, accountId, toAccountId: null, amount: C(amount), currency: 'DOP',
    occurredOn: D(date), postedOn: null, description: type, normalizedDescription: null, originalNote: null,
    categoryId: null, classificationSource: null, adjustmentDirection: null, relatedTransactionId: null,
    transferGroupId: null, recurringExpenseId: null, savingsGoalId: null, importBatchId: null, importRowRef: null,
    bankReference: null, dedupeKey: null, entryMode: 'normal', source: 'manual', reconciliationStatus: 'unreconciled',
    aiStatus: 'none', aiSuggestion: null, version: 1, createdAt: '', updatedAt: '', deletedAt: null, ...extra,
  };
}

export const debit = account({ id: 'debit', kind: 'checking', openingBalance: C(10000) });
export const savings = account({ id: 'savings', kind: 'savings' });
export const card = account({
  id: 'card', kind: 'credit_card', creditLimit: C(8000), annualInterestRatePct: 60, statementDay: 30, paymentDueDay: 21,
});
export const accounts = [debit, savings, card];
