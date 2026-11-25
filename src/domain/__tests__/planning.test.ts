import { describe, expect, it } from 'vitest';
import { monthlyEquivalent, occurrencesBetween, pendingOccurrences, totalMonthlyRecurring } from '../recurring';
import { simulate, monthlyIncomeEquivalent } from '../projection';
import { goalProgress, simulateGoal } from '../savingsGoals';
import type { RecurringExpense, SavingsGoal } from '../types';
import { C, D, tx } from './fixtures';

const rec = (p: Partial<RecurringExpense>): RecurringExpense => ({
  id: 'altice', clientId: 'altice', name: 'Altice', amount: C(1530), currency: 'DOP', accountId: 'debit', categoryId: null,
  transactionType: 'EXPENSE', frequency: 'monthly', dayFrom: 21, dayTo: 23, weekday: null, monthOfYear: null,
  startDate: D('2026-01-01'), endDate: null, status: 'active', remindDaysBefore: 3, notes: null, deletedAt: null, ...p,
});

describe('gastos recurrentes', () => {
  it('proyecta Altice entre los días 21 y 23', () => {
    const occ = occurrencesBetween(rec({}), { from: D('2026-03-01'), to: D('2026-05-31') });
    expect(occ.map((o) => [o.date, o.dateTo])).toEqual([
      ['2026-03-21', '2026-03-23'], ['2026-04-21', '2026-04-23'], ['2026-05-21', '2026-05-23'],
    ]);
  });
  it('pausados, cancelados y eliminados no aparecen en proyecciones', () => {
    const p = { from: D('2026-03-01'), to: D('2026-12-31') };
    expect(occurrencesBetween(rec({ status: 'paused' }), p)).toEqual([]);
    expect(occurrencesBetween(rec({ status: 'cancelled' }), p)).toEqual([]);
    expect(occurrencesBetween(rec({ deletedAt: 'x' }), p)).toEqual([]);
    expect(totalMonthlyRecurring([rec({}), rec({ id: 'b', status: 'paused', amount: C(1250) })])).toBe(C(1530));
  });
  it('respeta fecha de fin y día 31 en meses cortos', () => {
    const occ = occurrencesBetween(rec({ dayFrom: 31, dayTo: 31, endDate: D('2026-04-15') }), { from: D('2026-02-01'), to: D('2026-06-30') });
    expect(occ.map((o) => o.date)).toEqual(['2026-02-28', '2026-03-31']);
  });
  it('semanal y anual', () => {
    const w = occurrencesBetween(rec({ frequency: 'weekly', weekday: 1, startDate: D('2026-03-01') }), { from: D('2026-03-01'), to: D('2026-03-31') });
    expect(w.map((o) => o.date)).toEqual(['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23', '2026-03-30']);
    const y = occurrencesBetween(rec({ frequency: 'yearly', monthOfYear: 7, dayFrom: 10, dayTo: null }), { from: D('2026-01-01'), to: D('2027-12-31') });
    expect(y.map((o) => o.date)).toEqual(['2026-07-10', '2027-07-10']);
  });
  it('equivalente mensual', () => {
    expect(monthlyEquivalent({ amount: C(1200), frequency: 'yearly' })).toBe(C(100));
    expect(monthlyEquivalent({ amount: C(100), frequency: 'weekly' })).toBe(C(433.33));
  });
  it('ocurrencias ya registradas no quedan pendientes', () => {
    const paid = [tx('EXPENSE', 'debit', 1530, '2026-03-22', { recurringExpenseId: 'altice' })];
    const pend = pendingOccurrences([rec({})], paid, { from: D('2026-03-01'), to: D('2026-04-30') });
    expect(pend.map((o) => o.date)).toEqual(['2026-04-21']);
  });
});

describe('simulador', () => {
  it('proyecta excedente y ahorro a 3/6/12 meses', () => {
    const r = simulate({
      monthlyIncome: C(24240), extraMonthlyIncome: C(0), recurringExpenses: C(2780), variableExpenses: C(12000),
      debtPayments: C(2000), plannedSavings: C(3000), startingLiquid: C(5000), months: 12,
    });
    expect(r.monthlySurplusBeforeSavings).toBe(C(7460));
    expect(r.monthlyFreeCash).toBe(C(4460));
    expect(r.checkpoints).toEqual([
      { months: 3, cumulativeSavings: C(9000), liquidBalance: C(5000 + 3 * 4460) },
      { months: 6, cumulativeSavings: C(18000), liquidBalance: C(5000 + 6 * 4460) },
      { months: 12, cumulativeSavings: C(36000), liquidBalance: C(5000 + 12 * 4460) },
    ]);
    expect(r.warnings).toEqual([]);
  });
  it('advierte déficit', () => {
    const r = simulate({ monthlyIncome: C(1000), extraMonthlyIncome: C(0), recurringExpenses: C(2000), variableExpenses: C(0),
      debtPayments: C(0), plannedSavings: C(0), startingLiquid: C(0), months: 3 });
    expect(r.warnings[0]).toMatch(/déficit/);
    expect(r.savingsCapacity).toBe(0);
  });
  it('frecuencias de pago', () => {
    expect(monthlyIncomeEquivalent(C(12120), 'semimonthly')).toBe(C(24240));
    expect(monthlyIncomeEquivalent(C(1000), 'biweekly')).toBe(C(2166.67));
  });
});

describe('metas de ahorro', () => {
  const goal: SavingsGoal = { id: 'g', clientId: 'g', name: 'Fondo', targetAmount: C(30000), currency: 'DOP',
    targetDate: D('2026-12-31'), accountId: null, isEmergencyFund: true, status: 'active', notes: null, deletedAt: null };
  const contrib = (amount: number, kind: 'contribution' | 'withdrawal' = 'contribution') => ({
    id: String(Math.random()), clientId: 'x', goalId: 'g', kind, amount: C(amount), contributedOn: D('2026-03-01'), transactionId: null, notes: null, deletedAt: null,
  });
  it('progreso, restante y aporte mensual requerido', () => {
    const p = goalProgress(goal, [contrib(6000), contrib(1000, 'withdrawal')], D('2026-03-15'));
    expect(p.saved).toBe(C(5000));
    expect(p.remaining).toBe(C(25000));
    expect(p.pct).toBe(16.67);
    expect(p.monthsLeft).toBe(9);
    expect(p.requiredMonthly).toBe(C(2777.78)); // redondeo hacia arriba al centavo
  });
  it('simula fecha de cumplimiento', () => {
    expect(simulateGoal(C(25000), C(3000), D('2026-03-15'))).toEqual({ months: 9, completionDate: '2026-12-15' });
    expect(simulateGoal(C(25000), C(0), D('2026-03-15'))).toBeNull();
  });
});
