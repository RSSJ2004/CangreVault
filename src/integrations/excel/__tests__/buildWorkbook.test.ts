import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { buildWorkbook, SHEETS } from '../buildWorkbook';
import { accounts, tx, C, D } from '@/domain/__tests__/fixtures';
import type { SavingsContribution, SavingsGoal } from '@/domain/types';

const goal: SavingsGoal = { id: 'g1', clientId: 'g1', name: 'Fondo de emergencia', targetAmount: C(30000), currency: 'DOP', targetDate: D('2026-12-31'),
  accountId: 'savings', isEmergencyFund: true, status: 'active', notes: null, deletedAt: null };
const contributions: SavingsContribution[] = [
  { id: 'c1', clientId: 'c1', goalId: 'g1', kind: 'contribution', amount: C(1200), contributedOn: D('2026-03-02'), transactionId: null, notes: null, deletedAt: null },
  { id: 'c2', clientId: 'c2', goalId: 'g1', kind: 'withdrawal', amount: C(200), contributedOn: D('2026-03-20'), transactionId: null, notes: null, deletedAt: null },
];

export function sampleInput() {
  return {
    period: { from: D('2026-03-01'), to: D('2026-03-31') },
    accounts,
    categories: [{ id: 'food', clientId: 'food', name: 'Alimentación', kind: 'expense' as const, slug: 'food', color: null, isSystem: true, deletedAt: null }],
    transactions: [
      tx('INCOME', 'debit', 24240, '2026-03-01'),
      tx('EXPENSE', 'debit', 850, '2026-03-02'),
      tx('SAVINGS_CONTRIBUTION', 'debit', 1200, '2026-03-02', { toAccountId: 'savings' }),
      tx('CARD_PURCHASE', 'card', 1500, '2026-03-03', { categoryId: 'food', id: 'buy1' }),
      tx('CARD_PAYMENT', 'debit', 1000, '2026-03-05', { toAccountId: 'card' }),
      tx('REFUND', 'card', 300, '2026-03-10', { relatedTransactionId: 'buy1', categoryId: 'food' }),
      tx('ADJUSTMENT', 'card', 10, '2026-03-11', { adjustmentDirection: 'increase' }),
      tx('EXPENSE', 'debit', 999, '2026-04-02'), // fuera del período
    ],
    goals: [goal],
    contributions,
    generatedAt: new Date('2026-03-31T12:00:00Z'),
  };
}

describe('exportación Excel', () => {
  it('crea las tres hojas con fórmulas reales (no valores pegados)', async () => {
    const wb = buildWorkbook(sampleInput());
    expect(wb.worksheets.map((w) => w.name)).toEqual([SHEETS.summary, SHEETS.journal, SHEETS.savings]);
    const s = wb.getWorksheet(SHEETS.summary)!;
    const f = (addr: string) => (s.getCell(addr).value as { formula?: string }).formula ?? '';
    expect(f('B8')).toMatch(/^SUMIFS\('Diario_Transacciones'!\$F:\$F,'Diario_Transacciones'!\$E:\$E,"Ingreso"/);
    expect(f('B13')).toBe('B8-B11');
    expect(f('C9')).toBe('IF($B$8=0,0,B9/$B$8)');
    expect(s.getCell('B8').numFmt).toContain('RD$');
    const j = wb.getWorksheet(SHEETS.journal)!;
    expect(j.autoFilter).toBeTruthy();
    expect((j.getCell('M2').value as { formula: string }).formula).toContain('IF(E2="Ajuste de saldo"');
    expect(j.getCell('A2').numFmt).toBe('dd/mm/yyyy');
    const sv = wb.getWorksheet(SHEETS.savings)!;
    expect((sv.getCell('D4').value as { formula: string }).formula).toBe('SUMIFS($N:$N,$K:$K,A4)');
    const buf = await wb.xlsx.writeBuffer();
    expect(buf.byteLength).toBeGreaterThan(5000);
    if (process.env.EXCEL_OUT) writeFileSync(process.env.EXCEL_OUT, Buffer.from(buf));
  });
});
