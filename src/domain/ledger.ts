/**
 * Motor contable. Reglas (espejo exacto de public.transaction_signed_effect en SQL):
 *
 * Convención interna "con signo": activos positivos, pasivos negativos.
 *  - INCOME / REFUND           : cuenta +importe
 *  - EXPENSE / CARD_PURCHASE   : cuenta −importe (en tarjeta => la deuda sube)
 *  - TRANSFER / CARD_PAYMENT /
 *    SAVINGS_CONTRIBUTION /
 *    INVESTMENT                : origen −importe, destino +importe
 *                                (pagar la tarjeta reduce su deuda; NO es un gasto)
 *  - ADJUSTMENT                : "increase" aumenta el saldo natural de la cuenta
 *                                (dinero en activos, deuda en pasivos)
 * Saldo natural = saldo inicial + (activo ? +1 : −1) × Σ efectos con signo,
 * contando solo movimientos no eliminados con fecha >= fecha del saldo inicial.
 */
import { type Cents, ZERO, add, cents, neg, sum, sub, max } from './money';
import type { IsoDate } from './dates';
import {
  type Account, type Transaction, type TransactionType, type Uuid,
  LIQUID_ASSET_KINDS, TYPES_REQUIRING_DESTINATION,
} from './types';

type LedgerTx = Pick<
  Transaction,
  'type' | 'accountId' | 'toAccountId' | 'amount' | 'occurredOn' | 'deletedAt' | 'adjustmentDirection'
>;

/** Efecto con signo de una transacción sobre una cuenta concreta (0 si no la afecta). */
export function signedEffect(tx: LedgerTx, account: Pick<Account, 'id' | 'isLiability'>): Cents {
  if (tx.toAccountId === account.id && tx.accountId !== account.id) return tx.amount;
  if (tx.accountId !== account.id) return ZERO;
  switch (tx.type) {
    case 'INCOME':
    case 'REFUND':
      return tx.amount;
    case 'EXPENSE':
    case 'CARD_PURCHASE':
    case 'TRANSFER':
    case 'CARD_PAYMENT':
    case 'SAVINGS_CONTRIBUTION':
    case 'INVESTMENT':
      return neg(tx.amount);
    case 'ADJUSTMENT':
      return (tx.adjustmentDirection === 'increase') !== account.isLiability ? tx.amount : neg(tx.amount);
  }
}

export interface AccountBalance {
  accountId: Uuid;
  /** Dinero disponible (activos) o deuda (pasivos), en términos naturales. */
  balance: Cents;
  /** Activos positivos, pasivos negativos: sumable directamente para patrimonio. */
  signedBalance: Cents;
  lastMovementOn: IsoDate | null;
}

export function computeAccountBalance(
  account: Pick<Account, 'id' | 'isLiability' | 'openingBalance' | 'openingBalanceDate'>,
  transactions: readonly LedgerTx[],
  asOf?: IsoDate,
): AccountBalance {
  let movements = 0;
  let last: IsoDate | null = null;
  for (const tx of transactions) {
    if (tx.deletedAt) continue;
    if (tx.occurredOn < account.openingBalanceDate) continue;
    if (asOf && tx.occurredOn > asOf) continue;
    const eff = signedEffect(tx, account);
    if (eff === 0 && tx.accountId !== account.id && tx.toAccountId !== account.id) continue;
    movements += eff;
    if (!last || tx.occurredOn > last) last = tx.occurredOn;
  }
  const mov = cents(movements);
  const balance = account.isLiability ? sub(account.openingBalance, mov) : add(account.openingBalance, mov);
  return {
    accountId: account.id,
    balance,
    signedBalance: account.isLiability ? neg(balance) : balance,
    lastMovementOn: last,
  };
}

export function computeBalances(
  accounts: readonly Account[],
  transactions: readonly LedgerTx[],
  asOf?: IsoDate,
): Map<Uuid, AccountBalance> {
  const byAccount = new Map<Uuid, LedgerTx[]>();
  for (const tx of transactions) {
    for (const id of [tx.accountId, tx.toAccountId]) {
      if (!id) continue;
      const list = byAccount.get(id) ?? [];
      list.push(tx);
      byAccount.set(id, list);
    }
  }
  const result = new Map<Uuid, AccountBalance>();
  for (const acc of accounts) {
    if (acc.deletedAt) continue;
    result.set(acc.id, computeAccountBalance(acc, byAccount.get(acc.id) ?? [], asOf));
  }
  return result;
}

export interface NetWorthSummary {
  liquidAssets: Cents;      // débito + ahorro + efectivo
  otherAssets: Cents;       // inversión + otros activos
  creditCardDebt: Cents;
  otherLiabilities: Cents;
  /** Débito + Ahorro + otros activos líquidos − deudas de tarjetas − otras obligaciones. */
  liquidNetWorth: Cents;
  totalNetWorth: Cents;
  /** Informativo: NUNCA se suma al patrimonio. */
  availableCredit: Cents;
}

export function computeNetWorth(accounts: readonly Account[], balances: Map<Uuid, AccountBalance>): NetWorthSummary {
  let liquid = 0, other = 0, card = 0, otherLiab = 0, available = 0;
  for (const acc of accounts) {
    if (acc.deletedAt || acc.isArchived && (balances.get(acc.id)?.balance ?? 0) === 0) continue;
    const b = balances.get(acc.id)?.balance ?? ZERO;
    if (acc.kind === 'credit_card') {
      card += b;
      if (acc.creditLimit !== null) available += Math.max(0, acc.creditLimit - b);
    } else if (acc.isLiability) {
      otherLiab += b;
    } else if (LIQUID_ASSET_KINDS.has(acc.kind)) {
      liquid += b;
    } else {
      other += b;
    }
  }
  return {
    liquidAssets: cents(liquid),
    otherAssets: cents(other),
    creditCardDebt: cents(card),
    otherLiabilities: cents(otherLiab),
    liquidNetWorth: cents(liquid - card - otherLiab),
    totalNetWorth: cents(liquid + other - card - otherLiab),
    availableCredit: cents(available),
  };
}

/** Dinero disponible para el día a día (Modo Simple): suma de activos líquidos. */
export function availableMoney(accounts: readonly Account[], balances: Map<Uuid, AccountBalance>): Cents {
  return sum(
    accounts
      .filter((a) => !a.deletedAt && LIQUID_ASSET_KINDS.has(a.kind))
      .map((a) => balances.get(a.id)?.balance ?? ZERO),
  );
}

/** ¿El movimiento representa una entrada/salida de dinero real para el Modo Simple? */
export function simpleFlowDirection(tx: Pick<Transaction, 'type' | 'adjustmentDirection'>): 'in' | 'out' | 'internal' {
  switch (tx.type) {
    case 'INCOME':
    case 'REFUND':
      return 'in';
    case 'EXPENSE':
    case 'CARD_PURCHASE':
      return 'out';
    case 'ADJUSTMENT':
      return 'internal';
    default:
      return 'internal';
  }
}

// ---------------------------------------------------------------------------
// Validación (espejo de las restricciones y del trigger validate_transaction)
// ---------------------------------------------------------------------------
export interface TransactionDraft {
  type: TransactionType;
  accountId: Uuid | null;
  toAccountId: Uuid | null;
  amount: Cents | null;
  occurredOn: IsoDate | null;
  description: string;
  currency?: string;
  adjustmentDirection?: 'increase' | 'decrease' | null;
  relatedTransactionId?: Uuid | null;
}

export interface ValidationError {
  field: keyof TransactionDraft | 'form';
  message: string;
}

export function validateTransactionDraft(
  draft: TransactionDraft,
  accounts: readonly Account[],
  opts: { originalForRefund?: Pick<Transaction, 'type' | 'amount'> | null; alreadyRefunded?: Cents } = {},
): ValidationError[] {
  const errors: ValidationError[] = [];
  const from = accounts.find((a) => a.id === draft.accountId && !a.deletedAt);
  const to = draft.toAccountId ? accounts.find((a) => a.id === draft.toAccountId && !a.deletedAt) : undefined;

  if (draft.amount === null || draft.amount <= 0) errors.push({ field: 'amount', message: 'El importe debe ser mayor que cero.' });
  if (!draft.occurredOn) errors.push({ field: 'occurredOn', message: 'Indica la fecha.' });
  if (!draft.description.trim()) errors.push({ field: 'description', message: 'Escribe una descripción.' });
  if (draft.description.trim().length > 300) errors.push({ field: 'description', message: 'Máximo 300 caracteres.' });
  if (!from) {
    errors.push({ field: 'accountId', message: 'Selecciona la cuenta.' });
    return errors;
  }
  if (draft.currency && draft.currency !== from.currency) {
    errors.push({ field: 'form', message: `La moneda no coincide con la cuenta (${from.currency}).` });
  }

  const needsDest = TYPES_REQUIRING_DESTINATION.has(draft.type);
  if (needsDest && !to) errors.push({ field: 'toAccountId', message: 'Selecciona la cuenta destino.' });
  if (!needsDest && draft.type !== 'INVESTMENT' && draft.toAccountId) {
    errors.push({ field: 'toAccountId', message: 'Este tipo de movimiento no lleva cuenta destino.' });
  }
  if (to && to.id === from.id) errors.push({ field: 'toAccountId', message: 'Origen y destino deben ser distintos.' });
  if (to && to.currency !== from.currency) {
    errors.push({ field: 'toAccountId', message: 'Transferencias entre monedas distintas no están soportadas aún.' });
  }

  switch (draft.type) {
    case 'CARD_PURCHASE':
      if (from.kind !== 'credit_card') errors.push({ field: 'accountId', message: 'Una compra con tarjeta debe usar una tarjeta de crédito.' });
      break;
    case 'CARD_PAYMENT':
      if (to && to.kind !== 'credit_card') errors.push({ field: 'toAccountId', message: 'El destino debe ser una tarjeta de crédito.' });
      if (from.kind === 'credit_card') errors.push({ field: 'accountId', message: 'Paga la tarjeta desde una cuenta de débito, ahorro o efectivo.' });
      break;
    case 'SAVINGS_CONTRIBUTION':
      if (to && to.kind !== 'savings' && to.kind !== 'investment') {
        errors.push({ field: 'toAccountId', message: 'El destino debe ser una cuenta de ahorro o inversión.' });
      }
      break;
    case 'INVESTMENT':
      if (to && !['investment', 'savings', 'other_asset'].includes(to.kind)) {
        errors.push({ field: 'toAccountId', message: 'El destino debe ser una cuenta de inversión, ahorro u otro activo.' });
      }
      break;
    case 'ADJUSTMENT':
      if (!draft.adjustmentDirection) errors.push({ field: 'adjustmentDirection', message: 'Indica si el ajuste aumenta o disminuye el saldo.' });
      break;
    case 'REFUND': {
      const orig = opts.originalForRefund;
      if (draft.relatedTransactionId && orig) {
        if (orig.type !== 'EXPENSE' && orig.type !== 'CARD_PURCHASE') {
          errors.push({ field: 'relatedTransactionId', message: 'Solo se pueden devolver gastos o compras con tarjeta.' });
        } else if (draft.amount !== null && (opts.alreadyRefunded ?? 0) + draft.amount > orig.amount) {
          errors.push({ field: 'amount', message: 'La devolución supera el importe original.' });
        }
      }
      break;
    }
    default:
      break;
  }
  if (draft.type !== 'ADJUSTMENT' && draft.adjustmentDirection) {
    errors.push({ field: 'adjustmentDirection', message: 'Solo los ajustes llevan dirección.' });
  }
  return errors;
}

/** Utilización de crédito con piso en 0 para el disponible. */
export function availableCredit(limit: Cents, debt: Cents): Cents {
  return max(ZERO, sub(limit, debt));
}
