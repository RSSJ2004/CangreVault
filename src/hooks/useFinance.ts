/**
 * Datos financieros desde Supabase (React Query) + instantánea calculada con el
 * motor de dominio. Los cálculos viven en src/domain; aquí solo se componen.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as repo from '@/repositories/finance';
import { useAuth } from '@/auth/AuthProvider';
import { useAppState } from '@/state/AppState';
import { computeBalances, computeNetWorth, availableMoney } from '@/domain/ledger';
import { computeIncomeStatement, dailyFlows } from '@/domain/incomeStatement';
import { summarizeCard } from '@/domain/creditCard';
import { pendingOccurrences, totalMonthlyRecurring } from '@/domain/recurring';
import { computeReminders } from '@/domain/reminders';
import { monthlyIncomeEquivalent } from '@/domain/projection';
import { endOfMonth, startOfMonth, todayIso, type IsoDate } from '@/domain/dates';
import { ZERO, cents, sum, type Cents } from '@/domain/money';
import type { Transaction } from '@/domain/types';

const opts = { staleTime: 30_000 };

export function useAccounts() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['accounts'], queryFn: repo.listAccounts, enabled: Boolean(user), ...opts });
}
export function useCategories() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['categories'], queryFn: repo.listCategories, enabled: Boolean(user), ...opts });
}
export function useTransactionsQuery() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['transactions'], queryFn: repo.listTransactions, enabled: Boolean(user), ...opts });
}
export function useRecurring() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['recurring'], queryFn: repo.listRecurring, enabled: Boolean(user), ...opts });
}
export function useProfile() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['profile'], queryFn: repo.getProfile, enabled: Boolean(user), ...opts });
}
export function useIncomeHistory() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['incomeHistory'], queryFn: repo.getIncomeHistory, enabled: Boolean(user), ...opts });
}
export function useIncomeSources() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['incomeSources'], queryFn: repo.listIncomeSources, enabled: Boolean(user), ...opts });
}
export function useGoals() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['goals'], queryFn: repo.listGoals, enabled: Boolean(user), ...opts });
}
export function useContributions() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['contributions'], queryFn: repo.listContributions, enabled: Boolean(user), ...opts });
}
export function useCycles() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['cycles'], queryFn: repo.listCycles, enabled: Boolean(user), ...opts });
}
export function useReconciliations() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['reconciliations'], queryFn: repo.listReconciliations, enabled: Boolean(user), ...opts });
}
export function useServerBalances() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['serverBalances'], queryFn: repo.listServerBalances, enabled: Boolean(user), ...opts });
}
export function useKnowledge() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['knowledge'], queryFn: repo.listKnowledge, enabled: Boolean(user), staleTime: 3_600_000 });
}

const today = () => todayIso();

export type UiTransaction = Transaction & { pendingSync?: boolean; syncError?: string | null };

/** Transacciones del servidor + las pendientes en la cola local (marcadas). */
export function useTransactions() {
  const q = useTransactionsQuery();
  const { outbox } = useAppState();
  const data = useMemo<UiTransaction[]>(() => {
    const server = q.data ?? [];
    const known = new Set(server.map((t) => t.clientId));
    const pending: UiTransaction[] = outbox
      .filter((o) => !known.has(o.clientId))
      .map((o) => ({
        type: 'EXPENSE' as const, accountId: '', amount: ZERO, occurredOn: today(), description: '', clientId: o.clientId, toAccountId: null, currency: 'DOP', postedOn: null, normalizedDescription: null,
        originalNote: null, categoryId: null, classificationSource: null, adjustmentDirection: null, relatedTransactionId: null,
        transferGroupId: null, recurringExpenseId: null, savingsGoalId: null, importBatchId: null, importRowRef: null,
        bankReference: null, dedupeKey: null, entryMode: 'normal', source: 'manual', reconciliationStatus: 'unreconciled',
        aiStatus: 'none', aiSuggestion: null, version: 0, createdAt: o.createdAt, updatedAt: o.createdAt, deletedAt: null,
        ...(o.payload as Partial<Transaction>),
        id: `pending:${o.clientId}`,
        pendingSync: true, syncError: o.status === 'failed' ? o.lastError : null,
      }));
    return [...pending, ...server];
  }, [q.data, outbox]);
  return { ...q, data };
}

export function useToday(): IsoDate {
  return todayIso();
}

/** Instantánea completa para Dashboard, Modo Simple, recordatorios y asesor. */
export function useFinancialSnapshot() {
  const accounts = useAccounts();
  const txs = useTransactions();
  const categories = useCategories();
  const recurring = useRecurring();
  const profile = useProfile();
  const cycles = useCycles();
  const incomeSources = useIncomeSources();
  const today = useToday();

  const loading = accounts.isLoading || txs.isLoading || profile.isLoading;
  const error = accounts.error ?? txs.error ?? profile.error ?? categories.error ?? recurring.error ?? cycles.error;

  const snapshot = useMemo(() => {
    const accs = accounts.data ?? [];
    const all = (txs.data ?? []).filter((t) => !t.syncError);
    const balances = computeBalances(accs, all);
    const netWorth = computeNetWorth(accs, balances);
    const month = { from: startOfMonth(today), to: endOfMonth(today) };
    const statement = computeIncomeStatement(all, categories.data ?? [], month);
    const recurringList = recurring.data ?? [];
    const recurringMonthly = totalMonthlyRecurring(recurringList);
    const pendingRecurringThisMonth = pendingOccurrences(recurringList, all, { from: today, to: month.to });
    const p = profile.data;
    const salaryMonthly = p ? monthlyIncomeEquivalent(p.salaryAmount, p.salaryFrequency) : ZERO;
    const extraMonthly = sum(
      (incomeSources.data ?? [])
        .filter((i) => i.isActive && !i.deletedAt && i.frequency !== 'one_time')
        .map((i) => (i.frequency === 'yearly' ? cents(Math.round(i.amount / 12)) : i.frequency === 'monthly' ? i.amount
          : monthlyIncomeEquivalent(i.amount, i.frequency as 'weekly' | 'biweekly' | 'semimonthly'))),
    );
    const cards = accs.filter((a) => a.kind === 'credit_card').map((account) => ({
      account,
      summary: summarizeCard(account, balances.get(account.id)?.balance ?? ZERO, all, cycles.data ?? [], today),
    }));
    const negativeAccounts = accs
      .filter((a) => !a.isLiability && (balances.get(a.id)?.balance ?? 0) < 0)
      .map((a) => ({ account: a, balance: balances.get(a.id)!.balance }));
    const reminders = computeReminders({ today, cards, recurring: recurringList, transactions: all, negativeAccounts });
    const today_ = dailyFlows(all, today);
    const estimatedSurplus: Cents = cents(salaryMonthly + extraMonthly - recurringMonthly);
    return {
      today,
      accounts: accs,
      balances,
      netWorth,
      available: availableMoney(accs, balances),
      monthStatement: statement,
      recurringMonthly,
      pendingRecurringThisMonth,
      salaryMonthly,
      extraMonthly,
      estimatedSurplus,
      cards,
      reminders,
      todayIn: today_.in,
      todayOut: today_.out,
      pendingSyncCount: (txs.data ?? []).filter((t) => t.pendingSync).length,
    };
  }, [accounts.data, txs.data, categories.data, recurring.data, profile.data, cycles.data, incomeSources.data, today]);

  return { loading, error, snapshot, profile: profile.data ?? null, categories: categories.data ?? [], transactions: txs.data ?? [] };
}

export function useBankData() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['bank'], queryFn: repo.listBankData, enabled: Boolean(user), staleTime: 15_000 });
}
