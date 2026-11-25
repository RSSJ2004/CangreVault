/**
 * Tarjeta de crédito: fechas de ciclo, utilización y resumen.
 *
 * - Fecha de corte (statement date): cierre del ciclo de facturación.
 * - Fecha límite de pago (due date): último día para pagar el estado de cuenta.
 * - Pago mínimo / pago de contado: los define el emisor en cada estado de cuenta;
 *   se toman del ciclo registrado (credit_card_cycles). NO se inventan.
 * Los días configurados en la cuenta (p. ej. corte 30, límite 21) son solo una
 * referencia para estimar; si existe un ciclo registrado, sus fechas reales prevalecen.
 */
import { type Cents, ZERO, cents, max, percentOf, ratioPct, sub, sum, mulRatio } from './money';
import { type IsoDate, addDays, addMonths, clampedDate, diffDays, parts } from './dates';
import type { Account, CreditCardCycle, Transaction } from './types';

/** Próxima fecha de corte >= hoy, ajustando meses cortos (30 → 28/29 feb). */
export function nextStatementDate(today: IsoDate, statementDay: number): IsoDate {
  const { y, m } = parts(today);
  const thisMonth = clampedDate(y, m, statementDay);
  if (today <= thisMonth) return thisMonth;
  const next = addMonths(clampedDate(y, m, 1), 1);
  const p = parts(next);
  return clampedDate(p.y, p.m, statementDay);
}

/** Última fecha de corte < hoy (el corte de hoy aún no ha cerrado). */
export function previousStatementDate(today: IsoDate, statementDay: number): IsoDate {
  const next = nextStatementDate(today, statementDay);
  const p = parts(addMonths(clampedDate(parts(next).y, parts(next).m, 1), -1));
  return clampedDate(p.y, p.m, statementDay);
}

/** Primera fecha con día `dueDay` estrictamente posterior al corte. */
export function dueDateForStatement(statementDate: IsoDate, dueDay: number): IsoDate {
  const { y, m } = parts(statementDate);
  const sameMonth = clampedDate(y, m, dueDay);
  if (sameMonth > statementDate) return sameMonth;
  const p = parts(addMonths(clampedDate(y, m, 1), 1));
  return clampedDate(p.y, p.m, dueDay);
}

export interface CycleWindow {
  periodStart: IsoDate;
  statementDate: IsoDate;
  dueDate: IsoDate | null;
  /** true si las fechas salen de un estado de cuenta registrado; false si son estimadas. */
  fromStatement: boolean;
}

/** Ciclo abierto actual (compras que aparecerán en el PRÓXIMO estado). */
export function currentOpenCycle(
  today: IsoDate,
  card: Pick<Account, 'statementDay' | 'paymentDueDay'>,
  lastCycle: Pick<CreditCardCycle, 'statementDate'> | null,
): CycleWindow | null {
  if (lastCycle && lastCycle.statementDate < today) {
    const est = card.statementDay ? nextStatementDate(addDays(lastCycle.statementDate, 1), card.statementDay) : null;
    return {
      periodStart: addDays(lastCycle.statementDate, 1),
      statementDate: est ?? addMonths(lastCycle.statementDate, 1),
      dueDate: card.paymentDueDay && est ? dueDateForStatement(est, card.paymentDueDay) : null,
      fromStatement: false,
    };
  }
  if (!card.statementDay) return null;
  const next = nextStatementDate(today, card.statementDay);
  const prev = previousStatementDate(today, card.statementDay);
  return {
    periodStart: addDays(prev, 1),
    statementDate: next,
    dueDate: card.paymentDueDay ? dueDateForStatement(next, card.paymentDueDay) : null,
    fromStatement: false,
  };
}

export interface UtilizationInfo {
  limit: Cents;
  debt: Cents;
  available: Cents;
  utilizationPct: number;
  alertPct: number;
  alertAmount: Cents;
  alertTriggered: boolean;
  overLimit: boolean;
}

export function utilization(limit: Cents, debt: Cents, alertPct: number): UtilizationInfo {
  const alertAmount = percentOf(limit, alertPct);
  return {
    limit,
    debt,
    available: max(ZERO, sub(limit, debt)),
    utilizationPct: limit > 0 ? ratioPct(debt, limit) : 0,
    alertPct,
    alertAmount,
    alertTriggered: limit > 0 && debt >= alertAmount,
    overLimit: limit > 0 && debt > limit,
  };
}

type CardTx = Pick<Transaction, 'type' | 'accountId' | 'toAccountId' | 'amount' | 'occurredOn' | 'deletedAt' | 'adjustmentDirection'>;

export interface CardSummary {
  utilization: UtilizationInfo | null;
  openCycle: CycleWindow | null;
  lastStatement: CreditCardCycle | null;
  /** Compras/cargos posteriores al último corte (irán en el próximo estado). */
  purchasesSinceStatement: Cents;
  /** Pagos realizados desde el último corte. */
  paymentsSinceStatement: Cents;
  /** Pago de contado del último estado menos pagos posteriores (≥ 0). null si no hay estado registrado. */
  pendingForFullPayment: Cents | null;
  /** Pago mínimo del último estado menos pagos posteriores (≥ 0). */
  pendingForMinimumPayment: Cents | null;
  daysToDue: number | null;
  dueDate: IsoDate | null;
  /** true si la fecha límite se estimó con los días configurados (no hay estado registrado vigente). */
  dueDateEstimated: boolean;
  /** Estimación referencial de intereses de un mes sobre la deuda actual (tasa/12). */
  estimatedMonthlyInterest: Cents | null;
}

export function summarizeCard(
  card: Account,
  debt: Cents,
  transactions: readonly CardTx[],
  cycles: readonly CreditCardCycle[],
  today: IsoDate,
): CardSummary {
  const live = cycles.filter((c) => !c.deletedAt && c.accountId === card.id).sort((a, b) => (a.statementDate < b.statementDate ? 1 : -1));
  const lastStatement = live.find((c) => c.statementDate <= today) ?? null;
  const openCycle = currentOpenCycle(today, card, lastStatement);
  const since = lastStatement
    ? addDays(lastStatement.statementDate, 1)
    : openCycle?.periodStart ?? null;

  const relevant = transactions.filter((t) => !t.deletedAt && (!since || t.occurredOn >= since));
  const purchases = sum(
    relevant.filter((t) => t.accountId === card.id && (t.type === 'CARD_PURCHASE' || t.type === 'EXPENSE')).map((t) => t.amount),
  );
  const payments = sum(
    relevant
      .filter((t) => (t.toAccountId === card.id && (t.type === 'CARD_PAYMENT' || t.type === 'TRANSFER'))
        || (t.accountId === card.id && t.type === 'REFUND'))
      .map((t) => t.amount),
  );

  // Fecha límite relevante: la del último estado si aún no vence; si no hay estado
  // registrado, se estima la del corte anterior (p. ej. corte 30/mar → límite 21/abr).
  let dueDate: IsoDate | null = openCycle?.dueDate ?? null;
  let dueDateEstimated = true;
  if (lastStatement && lastStatement.dueDate >= today) {
    dueDate = lastStatement.dueDate;
    dueDateEstimated = false;
  } else if (!lastStatement && card.statementDay && card.paymentDueDay) {
    const prevDue = dueDateForStatement(previousStatementDate(today, card.statementDay), card.paymentDueDay);
    if (prevDue >= today) dueDate = prevDue;
  }
  const rate = card.annualInterestRatePct;
  return {
    utilization: card.creditLimit !== null ? utilization(card.creditLimit, debt, card.utilizationAlertPct) : null,
    openCycle,
    lastStatement,
    purchasesSinceStatement: purchases,
    paymentsSinceStatement: payments,
    pendingForFullPayment: lastStatement ? max(ZERO, sub(lastStatement.fullPayment, payments)) : null,
    pendingForMinimumPayment: lastStatement ? max(ZERO, sub(lastStatement.minimumPayment, payments)) : null,
    daysToDue: dueDate ? diffDays(dueDate, today) : null,
    dueDate,
    dueDateEstimated,
    estimatedMonthlyInterest: rate !== null && debt > 0 ? estimateMonthlyInterest(debt, rate) : null,
  };
}

/**
 * Estimación REFERENCIAL: deuda × tasa anual / 12. El emisor calcula sobre saldos
 * promedio diarios y condiciones del contrato; el resultado real puede diferir.
 */
export function estimateMonthlyInterest(balance: Cents, annualRatePct: number): Cents {
  const rateBp = Math.round(annualRatePct * 10_000); // pct con 4 decimales
  return mulRatio(balance, rateBp, 100 * 10_000 * 12);
}

/** Proyecta cuántos meses tardaría en saldarse una deuda pagando un monto fijo (tasa/12 mensual). */
export function payoffMonths(balance: Cents, annualRatePct: number, monthlyPayment: Cents, maxMonths = 600): number | null {
  let b: number = balance;
  if (estimateMonthlyInterest(balance, annualRatePct) >= monthlyPayment) return null; // el pago no cubre el interés
  for (let i = 1; i <= maxMonths; i++) {
    b += estimateMonthlyInterest(cents(b), annualRatePct);
    b -= monthlyPayment;
    if (b <= 0) return i;
  }
  return null;
}
