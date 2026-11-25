/**
 * Gastos recurrentes: proyección de ocurrencias futuras.
 * Solo los gastos en estado "active" generan proyecciones; "paused" y
 * "cancelled" (o con end_date vencida) quedan fuera. Las transacciones
 * históricas NUNCA se recalculan a partir de la plantilla.
 */
import { type Cents, ZERO, mulRatio, sum } from './money';
import { type IsoDate, addDays, addMonths, clampedDate, diffDays, parts, weekday } from './dates';
import type { DatePeriod, RecurringExpense, Transaction, Uuid } from './types';

export interface Occurrence {
  recurringId: Uuid;
  name: string;
  amount: Cents;
  accountId: Uuid;
  /** Fecha esperada (inicio del rango). */
  date: IsoDate;
  /** Fin del rango esperado (p. ej. Altice 21–23). */
  dateTo: IsoDate;
}

const MONTH_STEP: Partial<Record<RecurringExpense['frequency'], number>> = {
  monthly: 1, bimonthly: 2, quarterly: 3, yearly: 12,
};

export function isProjectable(r: Pick<RecurringExpense, 'status' | 'deletedAt'>): boolean {
  return r.status === 'active' && !r.deletedAt;
}

export function occurrencesBetween(r: RecurringExpense, period: DatePeriod): Occurrence[] {
  if (!isProjectable(r)) return [];
  const from = period.from > r.startDate ? period.from : r.startDate;
  const to = r.endDate && r.endDate < period.to ? r.endDate : period.to;
  if (from > to) return [];
  const out: Occurrence[] = [];
  const push = (d: IsoDate, dTo: IsoDate) => {
    if (d >= from && d <= to) out.push({ recurringId: r.id, name: r.name, amount: r.amount, accountId: r.accountId, date: d, dateTo: dTo });
  };

  if (r.frequency === 'weekly' || r.frequency === 'biweekly') {
    const step = r.frequency === 'weekly' ? 7 : 14;
    // Primera ocurrencia: primer día con ese weekday desde start_date.
    let d = r.startDate;
    const target = r.weekday ?? weekday(r.startDate);
    while (weekday(d) !== target) d = addDays(d, 1);
    if (d < from) {
      const jumps = Math.floor(diffDays(from, d) / step);
      d = addDays(d, jumps * step);
      while (d < from) d = addDays(d, step);
    }
    for (; d <= to; d = addDays(d, step)) push(d, d);
    return out;
  }

  const step = MONTH_STEP[r.frequency] ?? 1;
  const dayFrom = r.dayFrom ?? parts(r.startDate).d;
  const dayTo = r.dayTo ?? dayFrom;
  const start = parts(r.startDate);
  // Mes ancla: el de inicio (o el mes configurado si es anual).
  let anchor = r.frequency === 'yearly' && r.monthOfYear
    ? clampedDate(start.y, r.monthOfYear, 1)
    : clampedDate(start.y, start.m, 1);
  if (r.frequency === 'yearly' && anchor < clampedDate(start.y, start.m, 1)) anchor = addMonths(anchor, 12);
  // Avanza el ancla hasta cerca del período sin iterar desde el pasado lejano.
  const fp = parts(from);
  const ap = parts(anchor);
  const monthsGap = (fp.y - ap.y) * 12 + (fp.m - ap.m);
  if (monthsGap > step) anchor = addMonths(anchor, Math.floor((monthsGap - 1) / step) * step);
  for (let i = 0; i < 400; i++) {
    const p = parts(anchor);
    const d = clampedDate(p.y, p.m, dayFrom);
    const dTo = clampedDate(p.y, p.m, dayTo);
    if (d > to) break;
    if (d >= r.startDate) push(d, dTo);
    anchor = addMonths(anchor, step);
  }
  return out;
}

/** Equivalente mensual (para presupuestos): semanal ×52/12, quincenal ×26/12, etc. */
export function monthlyEquivalent(r: Pick<RecurringExpense, 'amount' | 'frequency'>): Cents {
  switch (r.frequency) {
    case 'weekly': return mulRatio(r.amount, 52, 12);
    case 'biweekly': return mulRatio(r.amount, 26, 12);
    case 'monthly': return r.amount;
    case 'bimonthly': return mulRatio(r.amount, 1, 2);
    case 'quarterly': return mulRatio(r.amount, 1, 3);
    case 'yearly': return mulRatio(r.amount, 1, 12);
  }
}

export function totalMonthlyRecurring(list: readonly RecurringExpense[]): Cents {
  return sum(list.filter(isProjectable).map(monthlyEquivalent));
}

/** Ocurrencias del período que aún no tienen una transacción registrada vinculada. */
export function pendingOccurrences(
  list: readonly RecurringExpense[],
  transactions: readonly Pick<Transaction, 'recurringExpenseId' | 'occurredOn' | 'deletedAt'>[],
  period: DatePeriod,
): Occurrence[] {
  const paid = new Map<Uuid, IsoDate[]>();
  for (const t of transactions) {
    if (t.deletedAt || !t.recurringExpenseId) continue;
    const arr = paid.get(t.recurringExpenseId) ?? [];
    arr.push(t.occurredOn);
    paid.set(t.recurringExpenseId, arr);
  }
  const result: Occurrence[] = [];
  for (const r of list) {
    for (const occ of occurrencesBetween(r, period)) {
      const dates = paid.get(r.id) ?? [];
      // Se considera pagada si hay una transacción vinculada dentro de ±10 días.
      const idx = dates.findIndex((d) => Math.abs(diffDays(d, occ.date)) <= 10);
      if (idx >= 0) dates.splice(idx, 1);
      else result.push(occ);
    }
  }
  return result.sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function sumOccurrences(occ: readonly Occurrence[]): Cents {
  return occ.length ? sum(occ.map((o) => o.amount)) : ZERO;
}

