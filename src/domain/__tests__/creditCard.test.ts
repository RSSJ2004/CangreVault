import { describe, expect, it } from 'vitest';
import {
  dueDateForStatement, estimateMonthlyInterest, nextStatementDate, payoffMonths, previousStatementDate, summarizeCard, utilization,
} from '../creditCard';
import type { CreditCardCycle } from '../types';
import { C, D, card, tx } from './fixtures';

describe('fechas de tarjeta', () => {
  it('corte día 30 se ajusta en febrero', () => {
    expect(nextStatementDate(D('2026-02-10'), 30)).toBe('2026-02-28');
    expect(nextStatementDate(D('2026-03-01'), 30)).toBe('2026-03-30');
    expect(nextStatementDate(D('2026-03-30'), 30)).toBe('2026-03-30');
    expect(nextStatementDate(D('2026-03-31'), 30)).toBe('2026-04-30');
    expect(previousStatementDate(D('2026-03-15'), 30)).toBe('2026-02-28');
  });
  it('fecha límite 21 cae el mes siguiente al corte 30', () => {
    expect(dueDateForStatement(D('2026-03-30'), 21)).toBe('2026-04-21');
    expect(dueDateForStatement(D('2026-12-30'), 21)).toBe('2027-01-21');
  });
});

describe('utilización', () => {
  it('30% de RD$8,000 es RD$2,400', () => {
    const u = utilization(C(8000), C(2400), 30);
    expect(u.alertAmount).toBe(C(2400));
    expect(u.alertTriggered).toBe(true);
    expect(u.utilizationPct).toBe(30);
    expect(u.available).toBe(C(5600));
    expect(utilization(C(8000), C(2399.99), 30).alertTriggered).toBe(false);
  });
  it('sobre el límite: disponible 0', () => {
    const u = utilization(C(8000), C(8100), 30);
    expect(u.overLimit).toBe(true);
    expect(u.available).toBe(0);
  });
});

describe('resumen de ciclo', () => {
  const cycle: CreditCardCycle = {
    id: 'cy1', clientId: 'cy1', accountId: 'card', periodStart: D('2026-02-01'), statementDate: D('2026-02-28'),
    dueDate: D('2026-03-21'), previousBalance: null, statementBalance: C(6462.61), minimumPayment: C(250),
    fullPayment: C(6462.61), interestCharged: null, feesCharged: null, annualRatePct: 60, source: 'manual', notes: null, deletedAt: null,
  };
  it('usa el estado registrado: pago pendiente de contado = contado − pagos posteriores', () => {
    const txs = [
      tx('CARD_PAYMENT', 'debit', 2000, '2026-03-05', { toAccountId: 'card' }),
      tx('CARD_PURCHASE', 'card', 700, '2026-03-06'),
      tx('CARD_PURCHASE', 'card', 999, '2026-02-20'), // del ciclo anterior
    ];
    const s = summarizeCard(card, C(5162.61), txs, [cycle], D('2026-03-10'));
    expect(s.lastStatement?.id).toBe('cy1');
    expect(s.paymentsSinceStatement).toBe(C(2000));
    expect(s.purchasesSinceStatement).toBe(C(700));
    expect(s.pendingForFullPayment).toBe(C(4462.61));
    expect(s.pendingForMinimumPayment).toBe(0);
    expect(s.dueDate).toBe('2026-03-21');
    expect(s.daysToDue).toBe(11);
    expect(s.openCycle?.statementDate).toBe('2026-03-30');
  });
  it('sin estado registrado: fechas estimadas y sin inventar mínimos', () => {
    const s = summarizeCard(card, C(1000), [], [], D('2026-03-10'));
    expect(s.pendingForFullPayment).toBeNull();
    expect(s.openCycle?.fromStatement).toBe(false);
    expect(s.dueDate).toBe('2026-03-21'); // corte estimado 28/feb → límite 21/mar
    expect(s.dueDateEstimated).toBe(true);
  });
});

describe('intereses (estimación)', () => {
  it('60% anual sobre RD$6,462.61 ≈ RD$323.13 al mes', () => {
    expect(estimateMonthlyInterest(C(6462.61), 60)).toBe(C(323.13));
  });
  it('pagar solo el mínimo de RD$250 no cubre el interés: nunca se salda', () => {
    expect(payoffMonths(C(6462.61), 60, C(250))).toBeNull();
    expect(payoffMonths(C(6462.61), 60, C(1000))).toBeGreaterThan(6);
  });
});
