import { type Cents, ZERO, cents, max, ratioPct, sub, sum } from './money';
import { type IsoDate, addMonths, parts } from './dates';
import type { SavingsContribution, SavingsGoal } from './types';

export interface GoalProgress {
  saved: Cents;
  remaining: Cents;
  pct: number;
  completed: boolean;
  monthsLeft: number | null;
  /** Aporte mensual necesario para llegar a la fecha objetivo. */
  requiredMonthly: Cents | null;
  overdue: boolean;
}

export function goalSaved(goalId: string, contributions: readonly SavingsContribution[]): Cents {
  return sum(
    contributions
      .filter((c) => c.goalId === goalId && !c.deletedAt)
      .map((c) => (c.kind === 'withdrawal' ? cents(-c.amount) : c.amount)),
  );
}

/** Meses completos de calendario entre hoy y la fecha objetivo (mínimo 1 si no ha vencido). */
export function monthsUntil(today: IsoDate, target: IsoDate): number {
  const a = parts(today);
  const b = parts(target);
  let m = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d < a.d) m -= 1;
  return m;
}

export function goalProgress(goal: SavingsGoal, contributions: readonly SavingsContribution[], today: IsoDate): GoalProgress {
  const saved = goalSaved(goal.id, contributions);
  const remaining = max(ZERO, sub(goal.targetAmount, saved));
  const completed = saved >= goal.targetAmount;
  let monthsLeft: number | null = null;
  let requiredMonthly: Cents | null = null;
  let overdue = false;
  if (goal.targetDate) {
    monthsLeft = monthsUntil(today, goal.targetDate);
    overdue = !completed && goal.targetDate < today;
    if (!completed) {
      const m = Math.max(1, monthsLeft);
      requiredMonthly = cents(Math.ceil(remaining / m));
    }
  }
  return {
    saved,
    remaining,
    pct: Math.min(100, ratioPct(saved, goal.targetAmount)),
    completed,
    monthsLeft,
    requiredMonthly: completed ? ZERO : requiredMonthly,
    overdue,
  };
}

/** Simula aportes mensuales fijos: ¿en cuántos meses y en qué fecha se completa? */
export function simulateGoal(
  remaining: Cents,
  monthlyContribution: Cents,
  today: IsoDate,
): { months: number; completionDate: IsoDate } | null {
  if (remaining <= 0) return { months: 0, completionDate: today };
  if (monthlyContribution <= 0) return null;
  const months = Math.ceil(remaining / monthlyContribution);
  return { months, completionDate: addMonths(today, months) };
}

/** Meta sugerida de fondo de emergencia: gastos esenciales mensuales × meses. */
export function emergencyFundTarget(monthlyEssentialExpenses: Cents, months: number): Cents {
  return cents(monthlyEssentialExpenses * months);
}
