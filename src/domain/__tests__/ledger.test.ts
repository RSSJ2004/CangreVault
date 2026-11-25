import { describe, expect, it } from 'vitest';
import { computeBalances, computeNetWorth, validateTransactionDraft, availableMoney } from '../ledger';
import { computeIncomeStatement } from '../incomeStatement';
import { C, D, accounts, card, debit, savings, tx } from './fixtures';

const scenario = () => [
  tx('INCOME', 'debit', 24240, '2026-03-01', { categoryId: 'salary' }),
  tx('EXPENSE', 'debit', 850, '2026-03-02', { categoryId: 'electricity' }),
  tx('SAVINGS_CONTRIBUTION', 'debit', 1200, '2026-03-02', { toAccountId: 'savings' }),
  tx('CARD_PURCHASE', 'card', 1500, '2026-03-03', { categoryId: 'food', id: 'buy1' }),
  tx('CARD_PAYMENT', 'debit', 1000, '2026-03-05', { toAccountId: 'card' }),
  tx('EXPENSE', 'debit', 50, '2026-03-06', { categoryId: 'bank_fees' }),
];

describe('reglas contables', () => {
  it('1-5: ingresos, gastos, transferencias, compras y pagos de tarjeta afectan los saldos correctos', () => {
    const b = computeBalances(accounts, scenario());
    expect(b.get('debit')!.balance).toBe(C(10000 + 24240 - 850 - 1200 - 1000 - 50));
    expect(b.get('savings')!.balance).toBe(C(1200));
    expect(b.get('card')!.balance).toBe(C(500)); // deuda: 1500 compra − 1000 pago
  });

  it('6-8: pagar la tarjeta NO duplica el gasto; el ahorro no es gasto; la comisión sí', () => {
    const s = computeIncomeStatement(scenario(), [], { from: D('2026-03-01'), to: D('2026-03-31') });
    expect(s.income).toBe(C(24240));
    expect(s.expenses).toBe(C(850 + 1500 + 50)); // pago de tarjeta y ahorro excluidos
    expect(s.savings).toBe(C(1200));
    expect(s.result).toBe(C(24240 - 2400));
    expect(s.unallocatedSurplus).toBe(C(24240 - 2400 - 1200));
    expect(s.excludedTransfers).toBe(1);
  });

  it('3: una transferencia no cambia el patrimonio', () => {
    const before = computeNetWorth(accounts, computeBalances(accounts, [])).liquidNetWorth;
    const after = computeNetWorth(accounts, computeBalances(accounts, [tx('TRANSFER', 'debit', 500, '2026-03-01', { toAccountId: 'savings' })])).liquidNetWorth;
    expect(after).toBe(before);
  });

  it('patrimonio líquido neto = débito + ahorro − deuda; el límite de crédito NO suma', () => {
    const nw = computeNetWorth(accounts, computeBalances(accounts, scenario()));
    expect(nw.liquidAssets).toBe(C(31140 + 1200));
    expect(nw.creditCardDebt).toBe(C(500));
    expect(nw.liquidNetWorth).toBe(C(31140 + 1200 - 500));
    expect(nw.availableCredit).toBe(C(7500));
    expect(availableMoney(accounts, computeBalances(accounts, scenario()))).toBe(C(32340));
  });

  it('9: devoluciones vinculadas reducen deuda y gasto de la categoría original', () => {
    const txs = [...scenario(), tx('REFUND', 'card', 300, '2026-03-10', { relatedTransactionId: 'buy1' })];
    expect(computeBalances(accounts, txs).get('card')!.balance).toBe(C(200));
    const s = computeIncomeStatement(txs, [{ id: 'food', name: 'Alimentación' }], { from: D('2026-03-01'), to: D('2026-03-31') });
    expect(s.refunds).toBe(C(300));
    expect(s.expensesByCategory.find((l) => l.categoryId === 'food')!.amount).toBe(C(1200));
  });

  it('10: ajustes identificados; "increase" en tarjeta aumenta la deuda', () => {
    const txs = [tx('ADJUSTMENT', 'card', 10, '2026-03-01', { adjustmentDirection: 'increase' }),
      tx('ADJUSTMENT', 'debit', 5, '2026-03-01', { adjustmentDirection: 'decrease' })];
    const b = computeBalances(accounts, txs);
    expect(b.get('card')!.balance).toBe(C(10));
    expect(b.get('debit')!.balance).toBe(C(9995));
    const s = computeIncomeStatement(txs, [], { from: D('2026-03-01'), to: D('2026-03-31') });
    expect(s.expenses).toBe(0);
    expect(s.adjustmentsIn).toBe(C(10));
  });

  it('ignora eliminados y movimientos anteriores al saldo inicial', () => {
    const txs = [tx('EXPENSE', 'debit', 100, '2025-12-31'), tx('EXPENSE', 'debit', 100, '2026-02-01', { deletedAt: '2026-02-02' })];
    expect(computeBalances(accounts, txs).get('debit')!.balance).toBe(C(10000));
  });

  it('saldo a una fecha (asOf)', () => {
    expect(computeBalances(accounts, scenario(), D('2026-03-01')).get('debit')!.balance).toBe(C(34240));
  });
});

describe('validación de borradores (espejo de la base de datos)', () => {
  const base = { accountId: 'debit', toAccountId: null, amount: C(10), occurredOn: D('2026-03-01'), description: 'x' };
  it('rechaza compra con tarjeta en débito', () => {
    expect(validateTransactionDraft({ ...base, type: 'CARD_PURCHASE' }, accounts).map((e) => e.field)).toContain('accountId');
  });
  it('rechaza pago de tarjeta hacia ahorro', () => {
    expect(validateTransactionDraft({ ...base, type: 'CARD_PAYMENT', toAccountId: savings.id }, accounts).length).toBeGreaterThan(0);
  });
  it('exige destino en transferencias y que sea distinto', () => {
    expect(validateTransactionDraft({ ...base, type: 'TRANSFER' }, accounts)[0]!.field).toBe('toAccountId');
    expect(validateTransactionDraft({ ...base, type: 'TRANSFER', toAccountId: debit.id }, accounts).length).toBe(1);
  });
  it('acepta un pago de tarjeta válido', () => {
    expect(validateTransactionDraft({ ...base, type: 'CARD_PAYMENT', toAccountId: card.id }, accounts)).toEqual([]);
  });
  it('rechaza importes no positivos y devoluciones excesivas', () => {
    expect(validateTransactionDraft({ ...base, type: 'EXPENSE', amount: C(0) }, accounts)[0]!.field).toBe('amount');
    const errs = validateTransactionDraft({ ...base, accountId: 'card', type: 'REFUND', amount: C(600), relatedTransactionId: 'buy1' }, accounts,
      { originalForRefund: { type: 'CARD_PURCHASE', amount: C(1500) }, alreadyRefunded: C(1000) });
    expect(errs[0]!.message).toMatch(/supera/);
  });
  it('ajuste requiere dirección', () => {
    expect(validateTransactionDraft({ ...base, type: 'ADJUSTMENT' }, accounts)[0]!.field).toBe('adjustmentDirection');
  });
});
