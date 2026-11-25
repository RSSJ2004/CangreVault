/**
 * Estado de Resultados personal (base devengo):
 *  - Ingresos:      INCOME
 *  - Gastos:        EXPENSE + CARD_PURCHASE − REFUND (el gasto se reconoce al comprar)
 *  - Ahorro/inversión: SAVINGS_CONTRIBUTION + INVESTMENT (destino de recursos, NO gasto)
 *  - Excluidos:     TRANSFER y CARD_PAYMENT (movimientos entre cuentas propias) y
 *                   ADJUSTMENT (se informan aparte para auditoría).
 */
import { type Cents, cents, ratioPct } from './money';
import type { Category, DatePeriod, Transaction, Uuid } from './types';

export interface CategoryLine {
  categoryId: Uuid | null;
  name: string;
  amount: Cents;
  pctOfTotal: number;
  count: number;
}

export interface IncomeStatement {
  period: DatePeriod;
  income: Cents;
  grossExpenses: Cents;
  refunds: Cents;
  expenses: Cents;
  recurringExpenses: Cents;
  savings: Cents;
  /** Ingresos − gastos */
  result: Cents;
  /** Resultado − lo enviado a ahorro/inversión */
  unallocatedSurplus: Cents;
  savingsRatePct: number;
  expenseRatePct: number;
  adjustmentsIn: Cents;
  adjustmentsOut: Cents;
  incomeByCategory: CategoryLine[];
  expensesByCategory: CategoryLine[];
  excludedTransfers: number;
}

type StatementTx = Pick<
  Transaction,
  'type' | 'amount' | 'occurredOn' | 'deletedAt' | 'categoryId' | 'recurringExpenseId' | 'relatedTransactionId' | 'adjustmentDirection' | 'id'
>;

export function computeIncomeStatement(
  transactions: readonly StatementTx[],
  categories: readonly Pick<Category, 'id' | 'name'>[],
  period: DatePeriod,
): IncomeStatement {
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const byId = new Map(transactions.map((t) => [t.id, t]));
  let income = 0, gross = 0, refunds = 0, recurring = 0, savings = 0, adjIn = 0, adjOut = 0, excluded = 0;
  const incomeCats = new Map<Uuid | null, { amount: number; count: number }>();
  const expenseCats = new Map<Uuid | null, { amount: number; count: number }>();
  const bump = (m: typeof incomeCats, k: Uuid | null, v: number) => {
    const cur = m.get(k) ?? { amount: 0, count: 0 };
    cur.amount += v;
    cur.count += 1;
    m.set(k, cur);
  };

  for (const tx of transactions) {
    if (tx.deletedAt || tx.occurredOn < period.from || tx.occurredOn > period.to) continue;
    switch (tx.type) {
      case 'INCOME':
        income += tx.amount;
        bump(incomeCats, tx.categoryId, tx.amount);
        break;
      case 'EXPENSE':
      case 'CARD_PURCHASE':
        gross += tx.amount;
        if (tx.recurringExpenseId) recurring += tx.amount;
        bump(expenseCats, tx.categoryId, tx.amount);
        break;
      case 'REFUND': {
        refunds += tx.amount;
        const original = tx.relatedTransactionId ? byId.get(tx.relatedTransactionId) : undefined;
        bump(expenseCats, tx.categoryId ?? original?.categoryId ?? null, -tx.amount);
        break;
      }
      case 'SAVINGS_CONTRIBUTION':
      case 'INVESTMENT':
        savings += tx.amount;
        break;
      case 'ADJUSTMENT':
        if (tx.adjustmentDirection === 'increase') adjIn += tx.amount;
        else adjOut += tx.amount;
        break;
      case 'TRANSFER':
      case 'CARD_PAYMENT':
        excluded += 1;
        break;
    }
  }

  const expenses = gross - refunds;
  const result = income - expenses;
  const lines = (m: typeof incomeCats, total: number): CategoryLine[] =>
    [...m.entries()]
      .map(([id, v]) => ({
        categoryId: id,
        name: id ? catName.get(id) ?? 'Categoría eliminada' : 'Sin categoría',
        amount: cents(v.amount),
        pctOfTotal: ratioPct(cents(v.amount), cents(total)),
        count: v.count,
      }))
      .filter((l) => l.amount !== 0)
      .sort((a, b) => b.amount - a.amount);

  return {
    period,
    income: cents(income),
    grossExpenses: cents(gross),
    refunds: cents(refunds),
    expenses: cents(expenses),
    recurringExpenses: cents(recurring),
    savings: cents(savings),
    result: cents(result),
    unallocatedSurplus: cents(result - savings),
    savingsRatePct: income ? ratioPct(cents(savings), cents(income)) : 0,
    expenseRatePct: income ? ratioPct(cents(expenses), cents(income)) : 0,
    adjustmentsIn: cents(adjIn),
    adjustmentsOut: cents(adjOut),
    incomeByCategory: lines(incomeCats, income),
    expensesByCategory: lines(expenseCats, expenses),
    excludedTransfers: excluded,
  };
}

/** Totales de entradas/salidas de un día para el Modo Simple. */
export function dailyFlows(
  transactions: readonly Pick<Transaction, 'type' | 'amount' | 'occurredOn' | 'deletedAt'>[],
  day: string,
): { in: Cents; out: Cents } {
  let inn = 0, out = 0;
  for (const t of transactions) {
    if (t.deletedAt || t.occurredOn !== day) continue;
    if (t.type === 'INCOME' || t.type === 'REFUND') inn += t.amount;
    else if (t.type === 'EXPENSE' || t.type === 'CARD_PURCHASE') out += t.amount;
  }
  return { in: cents(inn), out: cents(out) };
}

