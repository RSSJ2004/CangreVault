// Convierte movimientos ORIGINALES del proveedor en hechos económicos de CangreVault
// (una fila por hecho, docs/DECISIONS.md §1), sin tocar el motor financiero.
//
// Reglas:
//  * pending → no se contabiliza (pending_bank). void → no se contabiliza.
//  * Sin cuenta interna vinculada → unlinked_account (se reevalúa al vincular).
//  * Dos lados del mismo movimiento entre cuentas conectadas (importe igual, signo
//    opuesto, ≤ PAIR_WINDOW_DAYS días) → UNA sola fila:
//      depósito → tarjeta = CARD_PAYMENT (nunca un segundo gasto)
//      depósito → ahorro/inversión = SAVINGS_CONTRIBUTION · depósito → depósito = TRANSFER
//  * Entrada en cuenta de depósito = INCOME (nómina → categoría salary) o REFUND si
//    dice devolución/reverso. Parece transferencia → needs_review.
//  * Salida de cuenta de depósito = EXPENSE. Parece pago de tarjeta o transferencia
//    sin su contraparte conectada → needs_review (evita contar como gasto un pago).
//  * Cargo en tarjeta = CARD_PURCHASE (sí es gasto). Abono en tarjeta: devolución →
//    REFUND; pago u otro → needs_review (el origen no es conocido).
//  * Posible duplicado de un movimiento manual/PDF ya registrado → needs_review.
//  * La IA no participa aquí: importes, fechas y cuentas salen solo del banco.
import { matchCategorySlug, normalizeText } from '../keywordRules.ts';

export const PAIR_WINDOW_DAYS = 3;
export const DUPLICATE_WINDOW_DAYS = 2;

export type InternalKind = 'checking' | 'savings' | 'cash' | 'investment' | 'other_asset' | 'credit_card' | 'loan' | 'other_liability';
export type TxType = 'INCOME' | 'EXPENSE' | 'TRANSFER' | 'CARD_PURCHASE' | 'CARD_PAYMENT' | 'SAVINGS_CONTRIBUTION' | 'REFUND';

export interface ClassifyRow {
  rawId: string;
  providerTransactionId: string;
  externalAccountId: string;
  providerType: 'depository' | 'credit';
  /** Cuenta interna vinculada (null = sin vincular o sincronización pausada). */
  accountId: string | null;
  accountKind: InternalKind | null;
  currency: string;
  /** Centavos con signo del proveedor (negativo = salida/cargo). */
  amount: number;
  occurredOn: string;
  description: string;
  reference: string | null;
  status: 'pending' | 'posted' | 'void';
  syncFrom: string | null;
  /** Ya enlazada a un movimiento de CangreVault. */
  linkedTransactionId: string | null;
}

export interface ExistingTx {
  id: string;
  accountId: string;
  toAccountId: string | null;
  amount: number;
  occurredOn: string;
  source: string;
  description: string;
}

export interface CategoryRef { id: string; slug: string | null; kind: 'income' | 'expense' | 'savings' }

export interface CreateDecision {
  action: 'create';
  rawIds: string[];
  /** Identificador estable del hecho para client_id/dedupe (idempotente entre ejecuciones). */
  key: string;
  type: TxType;
  accountId: string;
  toAccountId: string | null;
  amount: number;
  currency: string;
  occurredOn: string;
  description: string;
  reference: string | null;
  categoryId: string | null;
}

export interface StatusDecision {
  action: 'status';
  rawIds: string[];
  status: 'pending_bank' | 'needs_review' | 'void' | 'unlinked_account' | 'ignored';
  reason: string;
  duplicateOf?: string;
}

export type Decision = CreateDecision | StatusDecision;

const TRANSFER_WORDS = ['transferencia', 'transf', 'trf', 'tef', 'lbtr', 'ach', 'traspaso', 'envio a', 'deposito desde'];
const CARD_PAYMENT_WORDS = ['pago tarjeta', 'pago tc', 'pago a tarjeta', 'pago de tarjeta', 'pago visa', 'pago mastercard', 'abono tarjeta', 'pago tdc'];
const REFUND_WORDS = ['devolucion', 'reverso', 'reembolso', 'reversion', 'credito por devolucion', 'contracargo'];
const PAYMENT_ON_CARD_WORDS = ['pago', 'abono', 'su pago', 'gracias por su pago'];

const has = (text: string, words: string[]) => { const t = ` ${normalizeText(text)} `; return words.some((w) => t.includes(` ${w}`)); };
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
const isSavingsKind = (k: InternalKind | null) => k === 'savings' || k === 'investment';

function category(text: string, kind: CategoryRef['kind'], cats: CategoryRef[]): string | null {
  const slug = matchCategorySlug(text);
  if (!slug) return null;
  return cats.find((c) => c.slug === slug && c.kind === kind)?.id ?? null;
}

export function classifyBankRows(rows: ClassifyRow[], existing: ExistingTx[], categories: CategoryRef[]): Decision[] {
  const out: Decision[] = [];
  const open: ClassifyRow[] = [];

  for (const r of rows) {
    if (r.linkedTransactionId) {
      if (r.status === 'void') out.push({ action: 'status', rawIds: [r.rawId], status: 'needs_review', reason: 'El banco anuló este movimiento después de contabilizarlo. Revisa y elimina el movimiento vinculado si corresponde.' });
      continue; // ya contabilizada: nunca se recrea
    }
    if (r.status === 'void') { out.push({ action: 'status', rawIds: [r.rawId], status: 'void', reason: 'Anulado por el banco.' }); continue; }
    if (r.status === 'pending') { out.push({ action: 'status', rawIds: [r.rawId], status: 'pending_bank', reason: 'Pendiente en el banco: se registrará cuando se contabilice.' }); continue; }
    if (!r.accountId || !r.accountKind) { out.push({ action: 'status', rawIds: [r.rawId], status: 'unlinked_account', reason: 'Vincula esta cuenta bancaria con una cuenta de CangreVault.' }); continue; }
    if (r.syncFrom && r.occurredOn < r.syncFrom) { out.push({ action: 'status', rawIds: [r.rawId], status: 'ignored', reason: 'Anterior a la fecha de inicio de la sincronización (ya incluido en el saldo inicial).' }); continue; }
    if (r.amount === 0) { out.push({ action: 'status', rawIds: [r.rawId], status: 'ignored', reason: 'Importe cero.' }); continue; }
    open.push(r);
  }

  // 1) Emparejar los dos lados de un mismo movimiento entre cuentas conectadas.
  const used = new Set<string>();
  const outs = open.filter((r) => r.amount < 0).sort((a, b) => a.occurredOn.localeCompare(b.occurredOn) || a.rawId.localeCompare(b.rawId));
  for (const o of outs) {
    const candidates = open.filter((i) => !used.has(i.rawId) && i.amount === -o.amount && i.externalAccountId !== o.externalAccountId
      && i.currency === o.currency && i.accountId !== o.accountId && dayDiff(i.occurredOn, o.occurredOn) <= PAIR_WINDOW_DAYS);
    if (!candidates.length || used.has(o.rawId)) continue;
    candidates.sort((a, b) => dayDiff(a.occurredOn, o.occurredOn) - dayDiff(b.occurredOn, o.occurredOn) || a.rawId.localeCompare(b.rawId));
    const tie = candidates.length > 1 && dayDiff(candidates[0]!.occurredOn, o.occurredOn) === dayDiff(candidates[1]!.occurredOn, o.occurredOn);
    const i = candidates[0]!;
    used.add(o.rawId); used.add(i.rawId);
    if (tie) {
      out.push({ action: 'status', rawIds: [o.rawId, ...candidates.map((c) => c.rawId)], status: 'needs_review', reason: 'Varias contrapartes posibles para esta transferencia entre tus cuentas.' });
      candidates.forEach((c) => used.add(c.rawId));
      continue;
    }
    if (o.providerType === 'credit') {
      out.push({ action: 'status', rawIds: [o.rawId, i.rawId], status: 'needs_review', reason: 'Salida de la tarjeta hacia otra cuenta (posible avance de efectivo).' });
      continue;
    }
    const type: TxType = i.accountKind === 'credit_card' ? 'CARD_PAYMENT' : isSavingsKind(i.accountKind) ? 'SAVINGS_CONTRIBUTION' : 'TRANSFER';
    const keyIds = [o.providerTransactionId, i.providerTransactionId].sort();
    out.push({
      action: 'create', rawIds: [o.rawId, i.rawId], key: `pair:${keyIds.join('+')}`, type, accountId: o.accountId!, toAccountId: i.accountId!,
      amount: -o.amount, currency: o.currency, occurredOn: o.occurredOn, description: o.description, reference: o.reference ?? i.reference,
      categoryId: type === 'SAVINGS_CONTRIBUTION' ? category(o.description, 'savings', categories) : null,
    });
  }

  // 2) Movimientos de un solo lado.
  for (const r of open) {
    if (used.has(r.rawId)) continue;
    const abs = Math.abs(r.amount);
    const dup = existing.find((e) => e.source !== 'bank_sync' && e.amount === abs && dayDiff(e.occurredOn, r.occurredOn) <= DUPLICATE_WINDOW_DAYS
      && (e.accountId === r.accountId || e.toAccountId === r.accountId));
    if (dup) {
      out.push({ action: 'status', rawIds: [r.rawId], status: 'needs_review', duplicateOf: dup.id,
        reason: `Posible duplicado de «${dup.description}» (${dup.source === 'pdf_import' ? 'importado de PDF' : 'registrado manualmente'}).` });
      continue;
    }
    const base = { action: 'create' as const, rawIds: [r.rawId], key: `single:${r.providerTransactionId}`, currency: r.currency, occurredOn: r.occurredOn,
      description: r.description, reference: r.reference, amount: abs, toAccountId: null };
    const review = (reason: string) => out.push({ action: 'status', rawIds: [r.rawId], status: 'needs_review', reason });

    if (r.providerType === 'depository') {
      if (r.amount > 0) {
        if (has(r.description, REFUND_WORDS)) out.push({ ...base, type: 'REFUND', accountId: r.accountId!, categoryId: null });
        else if (has(r.description, TRANSFER_WORDS)) review('Entrada que parece una transferencia: ¿viene de otra cuenta tuya (no es ingreso) o de un tercero?');
        else out.push({ ...base, type: 'INCOME', accountId: r.accountId!, categoryId: category(r.description, 'income', categories) });
      } else if (has(r.description, CARD_PAYMENT_WORDS)) {
        review('Parece un pago de tarjeta y la tarjeta no está conectada o aún no reporta el abono. Un pago de tarjeta no es un gasto nuevo.');
      } else if (has(r.description, TRANSFER_WORDS)) {
        review('Salida que parece una transferencia: ¿va a otra cuenta tuya (no es gasto) o es un pago a un tercero?');
      } else {
        out.push({ ...base, type: 'EXPENSE', accountId: r.accountId!, categoryId: category(r.description, 'expense', categories) });
      }
    } else {
      if (r.accountKind !== 'credit_card') { review('La cuenta vinculada no es una tarjeta de crédito.'); continue; }
      if (r.amount < 0) out.push({ ...base, type: 'CARD_PURCHASE', accountId: r.accountId!, categoryId: category(r.description, 'expense', categories) });
      else if (has(r.description, REFUND_WORDS)) out.push({ ...base, type: 'REFUND', accountId: r.accountId!, categoryId: null });
      else if (has(r.description, PAYMENT_ON_CARD_WORDS)) review('Pago recibido en la tarjeta desde una cuenta no conectada: indica la cuenta de origen.');
      else review('Abono en la tarjeta sin identificar (¿pago o devolución?).');
    }
  }
  return out;
}

/** UUID determinístico (formato v5) a partir de una clave estable → client_id idempotente. */
export async function stableUuid(namespace: string, key: string): Promise<string> {
  const data = new TextEncoder().encode(`${namespace}:${key}`);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data)).slice(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
