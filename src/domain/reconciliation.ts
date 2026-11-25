import { type Cents, abs, sub } from './money';

export interface ReconciliationPreview {
  calculated: Cents;
  statement: Cents;
  difference: Cents;
  matches: boolean;
  adjustmentDirection: 'increase' | 'decrease' | null;
  adjustmentAmount: Cents | null;
}

/** Diferencia = saldo del banco − saldo calculado (términos naturales: deuda positiva en tarjetas). */
export function previewReconciliation(calculated: Cents, statement: Cents): ReconciliationPreview {
  const difference = sub(statement, calculated);
  return {
    calculated,
    statement,
    difference,
    matches: difference === 0,
    adjustmentDirection: difference === 0 ? null : difference > 0 ? 'increase' : 'decrease',
    adjustmentAmount: difference === 0 ? null : abs(difference),
  };
}
