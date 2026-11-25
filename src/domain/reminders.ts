/**
 * Recordatorios calculados (sin efectos secundarios). La UI los muestra y,
 * si la persona lo autoriza, los envía como notificación del navegador mientras
 * la app está abierta. Las notificaciones push con la app cerrada se harán en Android.
 */
import { formatMoney, type Cents } from './money';
import { type IsoDate, addDays, diffDays, formatDateEs } from './dates';
import type { Account, RecurringExpense, Transaction } from './types';
import type { CardSummary } from './creditCard';
import { pendingOccurrences } from './recurring';

export type ReminderSeverity = 'info' | 'warning' | 'critical';

export interface Reminder {
  id: string;
  severity: ReminderSeverity;
  title: string;
  detail: string;
  date: IsoDate | null;
  kind: 'card_due' | 'card_utilization' | 'card_statement' | 'recurring' | 'negative_balance' | 'over_limit';
}

export function computeReminders(input: {
  today: IsoDate;
  cards: { account: Account; summary: CardSummary }[];
  recurring: readonly RecurringExpense[];
  transactions: readonly Pick<Transaction, 'recurringExpenseId' | 'occurredOn' | 'deletedAt'>[];
  negativeAccounts?: { account: Account; balance: Cents }[];
  horizonDays?: number;
}): Reminder[] {
  const { today } = input;
  const horizon = input.horizonDays ?? 7;
  const out: Reminder[] = [];

  for (const { account, summary } of input.cards) {
    if (summary.dueDate && summary.daysToDue !== null && summary.daysToDue >= 0 && summary.daysToDue <= horizon) {
      const pending = summary.pendingForFullPayment;
      if (pending === null || pending > 0) {
        out.push({
          id: `card_due:${account.id}:${summary.dueDate}`,
          severity: summary.daysToDue <= 2 ? 'critical' : 'warning',
          kind: 'card_due',
          title: `Pago de ${account.name} vence ${summary.daysToDue === 0 ? 'HOY' : `en ${summary.daysToDue} día(s)`}`,
          detail: pending !== null
            ? `Pendiente para pago de contado: ${formatMoney(pending)}. Mínimo pendiente: ${formatMoney(summary.pendingForMinimumPayment ?? pending)}. Fecha límite: ${formatDateEs(summary.dueDate)}.`
            : `Fecha límite estimada: ${formatDateEs(summary.dueDate)}. Registra el estado de cuenta para conocer el pago mínimo y de contado reales.`,
          date: summary.dueDate,
        });
      }
    }
    const u = summary.utilization;
    if (u?.overLimit) {
      out.push({
        id: `over_limit:${account.id}`, severity: 'critical', kind: 'over_limit',
        title: `${account.name} sobre el límite`,
        detail: `Deuda ${formatMoney(u.debt)} con límite ${formatMoney(u.limit)}.`, date: null,
      });
    } else if (u?.alertTriggered) {
      out.push({
        id: `utilization:${account.id}`, severity: 'warning', kind: 'card_utilization',
        title: `Utilización de ${account.name}: ${u.utilizationPct}%`,
        detail: `Superaste tu alerta del ${u.alertPct}% (${formatMoney(u.alertAmount)}). Deuda actual ${formatMoney(u.debt)}.`,
        date: null,
      });
    }
    const st = summary.openCycle?.statementDate;
    if (st && diffDays(st, today) >= 0 && diffDays(st, today) <= 3) {
      out.push({
        id: `statement:${account.id}:${st}`, severity: 'info', kind: 'card_statement',
        title: `Corte de ${account.name} ${diffDays(st, today) === 0 ? 'hoy' : `en ${diffDays(st, today)} día(s)`}`,
        detail: `Las compras posteriores al ${formatDateEs(st)} pasarán al siguiente ciclo${summary.openCycle?.fromStatement ? '' : ' (fecha estimada; confírmala en tu estado de cuenta)'}.`,
        date: st,
      });
    }
  }

  for (const occ of pendingOccurrences(input.recurring, input.transactions, { from: addDays(today, -3), to: addDays(today, horizon) })) {
    const r = input.recurring.find((x) => x.id === occ.recurringId);
    const remind = r?.remindDaysBefore ?? 3;
    const days = diffDays(occ.date, today);
    if (days > remind) continue;
    out.push({
      id: `recurring:${occ.recurringId}:${occ.date}`,
      severity: days < 0 ? 'warning' : 'info',
      kind: 'recurring',
      title: days < 0 ? `${occ.name}: ¿ya lo pagaste?` : `${occ.name} ${days === 0 ? 'hoy' : `en ${days} día(s)`}`,
      detail: `${formatMoney(occ.amount)} · previsto ${formatDateEs(occ.date)}${occ.dateTo !== occ.date ? `–${formatDateEs(occ.dateTo)}` : ''}.`,
      date: occ.date,
    });
  }

  for (const { account, balance } of input.negativeAccounts ?? []) {
    out.push({
      id: `negative:${account.id}`, severity: 'critical', kind: 'negative_balance',
      title: `${account.name} con saldo negativo`,
      detail: `Saldo calculado ${formatMoney(balance)}. Revisa movimientos o concilia con el banco.`, date: null,
    });
  }

  const rank: Record<ReminderSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.date ?? '9').localeCompare(b.date ?? '9'));
}
