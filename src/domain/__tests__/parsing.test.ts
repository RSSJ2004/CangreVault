import { describe, expect, it } from 'vitest';
import { parseSimpleEntry } from '../naturalLanguage';
import { checkDuplicates, dedupeKey } from '../dedupe';
import { previewReconciliation } from '../reconciliation';
import { computeReminders } from '../reminders';
import { summarizeCard } from '../creditCard';
import { C, D, accounts, card, tx } from './fixtures';

const today = D('2026-03-15');

describe('notas del Modo Simple', () => {
  it('"Recibí 24,240 de mi trabajo" → ingreso de salario en débito', () => {
    const p = parseSimpleEntry('Recibí 24,240 de mi trabajo', accounts, today);
    expect(p).toMatchObject({ amount: C(24240), type: 'INCOME', accountId: 'debit', categorySlug: 'salary', confidence: 'high' });
  });
  it('"Pagué 850 de luz" → gasto de electricidad', () => {
    expect(parseSimpleEntry('Pagué 850 de luz', accounts, today)).toMatchObject({ amount: C(850), type: 'EXPENSE', categorySlug: 'electricity' });
  });
  it('"Pasé 1,200 al ahorro" → aporte a ahorro (transferencia, no gasto)', () => {
    expect(parseSimpleEntry('Pasé 1,200 al ahorro', accounts, today)).toMatchObject({
      amount: C(1200), type: 'SAVINGS_CONTRIBUTION', accountId: 'debit', toAccountId: 'savings',
    });
  });
  it('"Compré comida por 1,500" → gasto de alimentación', () => {
    expect(parseSimpleEntry('Compré comida por 1,500', accounts, today)).toMatchObject({ amount: C(1500), type: 'EXPENSE', categorySlug: 'food' });
  });
  it('pago de tarjeta y compra con tarjeta', () => {
    expect(parseSimpleEntry('Pagué la tarjeta 2,000', accounts, today)).toMatchObject({ type: 'CARD_PAYMENT', toAccountId: 'card' });
    expect(parseSimpleEntry('Compré gasolina con la tarjeta 1,000', accounts, today)).toMatchObject({
      type: 'CARD_PURCHASE', accountId: 'card', categorySlug: 'fuel',
    });
  });
  it('fechas relativas y sin inventar importes', () => {
    expect(parseSimpleEntry('Pagué 300 de agua ayer', accounts, today).occurredOn).toBe('2026-03-14');
    expect(parseSimpleEntry('Pagué 300 de agua el 20', accounts, today).occurredOn).toBe('2026-02-20');
    const noAmount = parseSimpleEntry('Pagué la luz', accounts, today);
    expect(noAmount.amount).toBeNull();
    expect(noAmount.confidence).toBe('low');
  });
  it('el botón SALIÓ DINERO fuerza la dirección', () => {
    expect(parseSimpleEntry('Altice 1,530', accounts, today, { forcedDirection: 'out' })).toMatchObject({ type: 'EXPENSE', categorySlug: 'telecom' });
  });
});

describe('deduplicación', () => {
  const row = { accountId: 'card', occurredOn: D('2026-03-03'), amount: C(1500), description: 'SUPERMERCADO NACIONAL 123456789' };
  it('la clave ignora referencias largas y acentos', () => {
    expect(dedupeKey(row)).toBe(dedupeKey({ ...row, description: 'Supermercado Nacional 987654321' }));
  });
  it('exacto, probable, interno y ninguno', () => {
    const existing = [
      { ...tx('CARD_PURCHASE', 'card', 1500, '2026-03-03', { description: 'Supermercado Nacional' }), dedupeKey: dedupeKey(row) },
      tx('CARD_PURCHASE', 'card', 700, '2026-03-05', { description: 'Farmacia Carol' }),
    ];
    const res = checkDuplicates([
      row,
      { accountId: 'card', occurredOn: D('2026-03-06'), amount: C(700), description: 'FARMACIA CAROL SUC 2' },
      { accountId: 'card', occurredOn: D('2026-03-09'), amount: C(50), description: 'Uber' },
      { accountId: 'card', occurredOn: D('2026-03-09'), amount: C(50), description: 'Uber' },
    ], existing);
    expect(res.map((r) => r.level)).toEqual(['exact', 'probable', 'none', 'none']);
    expect(res[3]!.sameBatchIndex).toBe(2);
  });
});

describe('conciliación y recordatorios', () => {
  it('diferencia y dirección del ajuste', () => {
    expect(previewReconciliation(C(32040), C(32050))).toMatchObject({ difference: C(10), adjustmentDirection: 'increase' });
    expect(previewReconciliation(C(100), C(100)).matches).toBe(true);
  });
  it('genera recordatorios de pago, utilización y recurrentes', () => {
    const summary = summarizeCard(card, C(3000), [], [], D('2026-04-16'));
    const reminders = computeReminders({
      today: D('2026-04-16'),
      cards: [{ account: card, summary }],
      recurring: [{
        id: 'altice', clientId: 'altice', name: 'Altice', amount: C(1530), currency: 'DOP', accountId: 'debit', categoryId: null,
        transactionType: 'EXPENSE', frequency: 'monthly', dayFrom: 18, dayTo: 18, weekday: null, monthOfYear: null,
        startDate: D('2026-01-01'), endDate: null, status: 'active', remindDaysBefore: 3, notes: null, deletedAt: null,
      }],
      transactions: [],
    });
    expect(reminders.map((r) => r.kind).sort()).toEqual(['card_due', 'card_utilization', 'recurring']);
  });
});
