/**
 * Simulador y proyección de excedente/ahorro a N meses.
 * Todo en centavos; los resultados se recalculan al instante en la UI.
 */
import { type Cents, ZERO, cents, mulRatio, sub, sum } from './money';
import type { PayFrequency } from './types';

/** Ingreso mensual equivalente según frecuencia de pago. */
export function monthlyIncomeEquivalent(amount: Cents, frequency: PayFrequency): Cents {
  switch (frequency) {
    case 'weekly': return mulRatio(amount, 52, 12);
    case 'biweekly': return mulRatio(amount, 26, 12);
    case 'semimonthly': return cents(amount * 2);
    case 'monthly': return amount;
  }
}

export interface SimulationInput {
  monthlyIncome: Cents;
  extraMonthlyIncome: Cents;
  recurringExpenses: Cents;
  variableExpenses: Cents;
  /** Pago mensual destinado a deudas (p. ej. tarjeta). */
  debtPayments: Cents;
  plannedSavings: Cents;
  startingLiquid: Cents;
  months: number;
}

export interface SimulationMonth {
  month: number;
  income: Cents;
  expenses: Cents;
  savings: Cents;
  surplus: Cents;
  cumulativeSavings: Cents;
  liquidBalance: Cents;
}

export interface SimulationResult {
  totalIncome: Cents;
  totalExpenses: Cents;
  /** Ingresos − gastos − pagos de deuda (antes de ahorrar). */
  monthlySurplusBeforeSavings: Cents;
  /** Lo que queda después del ahorro planificado. */
  monthlyFreeCash: Cents;
  /** Capacidad de ahorro = max(0, excedente antes de ahorro). */
  savingsCapacity: Cents;
  savingsRatePct: number;
  months: SimulationMonth[];
  checkpoints: { months: number; cumulativeSavings: Cents; liquidBalance: Cents }[];
  warnings: string[];
}

export function simulate(input: SimulationInput): SimulationResult {
  const income = sum([input.monthlyIncome, input.extraMonthlyIncome]);
  const expenses = sum([input.recurringExpenses, input.variableExpenses, input.debtPayments]);
  const surplusBefore = sub(income, expenses);
  const free = sub(surplusBefore, input.plannedSavings);
  const warnings: string[] = [];
  if (surplusBefore < 0) warnings.push('Los gastos superan los ingresos: el plan genera déficit cada mes.');
  else if (free < 0) warnings.push('El ahorro planificado supera el excedente disponible.');

  const months: SimulationMonth[] = [];
  let cumSavings = 0;
  let liquid: number = input.startingLiquid;
  const n = Math.max(1, Math.min(120, Math.floor(input.months)));
  for (let i = 1; i <= n; i++) {
    cumSavings += input.plannedSavings;
    liquid += free;
    months.push({
      month: i,
      income,
      expenses,
      savings: input.plannedSavings,
      surplus: free,
      cumulativeSavings: cents(cumSavings),
      liquidBalance: cents(liquid),
    });
  }
  const at = (k: number) => months[Math.min(k, n) - 1];
  return {
    totalIncome: income,
    totalExpenses: expenses,
    monthlySurplusBeforeSavings: surplusBefore,
    monthlyFreeCash: free,
    savingsCapacity: surplusBefore > 0 ? surplusBefore : ZERO,
    savingsRatePct: income > 0 ? Math.round((input.plannedSavings / income) * 10_000) / 100 : 0,
    months,
    checkpoints: [3, 6, 12].filter((k) => k <= n).map((k) => ({
      months: k,
      cumulativeSavings: at(k)!.cumulativeSavings,
      liquidBalance: at(k)!.liquidBalance,
    })),
    warnings,
  };
}
