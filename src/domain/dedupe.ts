/**
 * Deduplicación de movimientos importados.
 * Clave = cuenta + fecha + importe + descripción normalizada (+ referencia bancaria si existe).
 * La coincidencia NUNCA descarta filas automáticamente: dos compras legítimas
 * pueden tener el mismo importe y fecha. La UI pide revisión manual.
 */
import { normalizeText } from '@shared/keywordRules';
import { type Cents, toDecimalString } from './money';
import { type IsoDate, diffDays } from './dates';
import type { Transaction, Uuid } from './types';

/** Normaliza descripciones bancarias: sin acentos, sin números de referencia largos, sin espacios dobles. */
export function normalizeBankDescription(desc: string): string {
  return normalizeText(desc)
    .replace(/\b\d{5,}\b/g, ' ')     // referencias/autorizaciones largas
    .replace(/\b(ref|aut|no|num|trx)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function dedupeKey(p: {
  accountId: Uuid;
  occurredOn: IsoDate;
  amount: Cents;
  description: string;
  bankReference?: string | null;
}): string {
  const ref = p.bankReference ? normalizeText(p.bankReference).replace(/\s/g, '') : '';
  return [p.accountId.slice(0, 8), p.occurredOn, toDecimalString(p.amount), normalizeBankDescription(p.description).slice(0, 60), ref]
    .join('|')
    .slice(0, 200);
}

export type DuplicateLevel = 'exact' | 'probable' | 'none';

export interface DuplicateCheck {
  level: DuplicateLevel;
  matchTransactionId: Uuid | null;
  /** Índice de otra fila del mismo lote con la misma clave (posible duplicado interno). */
  sameBatchIndex: number | null;
  reason: string | null;
}

type Existing = Pick<Transaction, 'id' | 'accountId' | 'toAccountId' | 'occurredOn' | 'amount' | 'description' | 'dedupeKey' | 'bankReference' | 'deletedAt'>;

function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(a.split(' ').filter((w) => w.length > 2));
  const tb = new Set(b.split(' ').filter((w) => w.length > 2));
  if (!ta.size || !tb.size) return a === b ? 1 : 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.max(ta.size, tb.size);
}

export function checkDuplicates(
  rows: readonly { accountId: Uuid; occurredOn: IsoDate; amount: Cents; description: string; bankReference?: string | null }[],
  existing: readonly Existing[],
): DuplicateCheck[] {
  const live = existing.filter((e) => !e.deletedAt);
  const byKey = new Map<string, Existing>();
  for (const e of live) if (e.dedupeKey) byKey.set(e.dedupeKey, e);
  const seen = new Map<string, number>();

  return rows.map((row, i) => {
    const key = dedupeKey(row);
    const sameBatchIndex = seen.has(key) ? seen.get(key)! : null;
    if (!seen.has(key)) seen.set(key, i);

    if (row.bankReference) {
      const byRef = live.find((e) => e.accountId === row.accountId && e.bankReference === row.bankReference && e.amount === row.amount);
      if (byRef) return { level: 'exact', matchTransactionId: byRef.id, sameBatchIndex, reason: 'Misma referencia bancaria e importe' };
    }
    const exact = byKey.get(key);
    if (exact) return { level: 'exact', matchTransactionId: exact.id, sameBatchIndex, reason: 'Misma cuenta, fecha, importe y descripción' };

    const norm = normalizeBankDescription(row.description);
    const probable = live.find(
      (e) =>
        (e.accountId === row.accountId || e.toAccountId === row.accountId) &&
        e.amount === row.amount &&
        Math.abs(diffDays(e.occurredOn, row.occurredOn)) <= 3 &&
        (tokenSimilarity(normalizeBankDescription(e.description), norm) >= 0.3 || e.toAccountId === row.accountId),
    );
    if (probable) {
      return { level: 'probable', matchTransactionId: probable.id, sameBatchIndex, reason: 'Mismo importe en fecha cercana (±3 días)' };
    }
    return {
      level: 'none',
      matchTransactionId: null,
      sameBatchIndex,
      reason: sameBatchIndex !== null ? 'Fila repetida dentro del mismo archivo: revísala' : null,
    };
  });
}
