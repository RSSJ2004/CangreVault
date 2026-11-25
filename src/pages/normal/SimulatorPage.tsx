import { useMemo, useState } from 'react';
import { Card, CardTitle, Field, Input, Loading, Money, Notice, PageHeader, Stat } from '@/components/ui';
import { useFinancialSnapshot } from '@/hooks/useFinance';
import { simulate } from '@/domain/projection';
import { parseUserAmount, toDecimalString, ZERO, formatMoney, type Cents } from '@/domain/money';

export function SimulatorPage() {
  const { snapshot: s, loading } = useFinancialSnapshot();
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const defaults = useMemo(() => ({
    income: toDecimalString(s.salaryMonthly),
    extra: toDecimalString(s.extraMonthly),
    recurring: toDecimalString(s.recurringMonthly),
    variable: toDecimalString((s.monthStatement.expenses - s.monthStatement.recurringExpenses > 0 ? s.monthStatement.expenses - s.monthStatement.recurringExpenses : 0) as Cents),
    debt: '0.00',
    savings: '0.00',
    start: toDecimalString(s.available),
  }), [s]);
  const val = (k: keyof typeof defaults) => overrides[k] ?? defaults[k];
  const num = (k: keyof typeof defaults) => parseUserAmount(val(k)) ?? ZERO;

  const result = simulate({
    monthlyIncome: num('income'), extraMonthlyIncome: num('extra'), recurringExpenses: num('recurring'), variableExpenses: num('variable'),
    debtPayments: num('debt'), plannedSavings: num('savings'), startingLiquid: num('start'), months: 12,
  });
  if (loading) return <Loading />;
  const input = (k: keyof typeof defaults, label: string, hint?: string) => (
    <Field label={label} hint={hint}>{(id) => <Input id={id} inputMode="decimal" value={val(k)} onChange={(e) => setOverrides((o) => ({ ...o, [k]: e.target.value }))} />}</Field>
  );
  const maxBal = Math.max(1, ...result.months.map((m) => Math.abs(m.liquidBalance)));

  return (
    <div className="space-y-5">
      <PageHeader title="Simulador financiero" subtitle="Cambia los valores y observa el efecto al instante. Nada de esto se guarda." />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle hint="Precargado con tu configuración y el mes actual">Supuestos mensuales</CardTitle>
          <div className="space-y-3">
            {input('income', 'Ingreso mensual (sueldo)')}
            {input('extra', 'Ingresos adicionales')}
            {input('recurring', 'Gastos recurrentes')}
            {input('variable', 'Gastos variables', 'Comida, transporte, otros')}
            {input('debt', 'Pagos de deuda (tarjeta, préstamos)')}
            {input('savings', 'Ahorro planificado')}
            {input('start', 'Dinero disponible hoy')}
            <button className="text-xs text-brand-700 underline" onClick={() => setOverrides({})}>Restablecer valores</button>
          </div>
        </Card>
        <div className="space-y-4 lg:col-span-2">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Excedente mensual" value={<Money value={result.monthlySurplusBeforeSavings} tone="auto" />} hint="Antes de ahorrar" />
            <Stat label="Capacidad de ahorro" value={<Money value={result.savingsCapacity} />} />
            <Stat label="Libre tras ahorrar" value={<Money value={result.monthlyFreeCash} tone="auto" />} />
            <Stat label="Tasa de ahorro" value={`${result.savingsRatePct}%`} />
          </div>
          {result.warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}
          <Card>
            <CardTitle>Proyección</CardTitle>
            <div className="grid grid-cols-3 gap-3 text-center">
              {result.checkpoints.map((c) => (
                <div key={c.months} className="rounded-lg bg-slate-50 p-3">
                  <div className="text-xs text-muted">{c.months} meses</div>
                  <div className="text-sm">Ahorrado: <strong><Money value={c.cumulativeSavings} /></strong></div>
                  <div className="text-sm">Disponible: <strong><Money value={c.liquidBalance} tone="auto" /></strong></div>
                </div>
              ))}
            </div>
            <div className="mt-5 flex h-40 items-end gap-1" aria-label="Dinero disponible proyectado por mes">
              {result.months.map((m) => (
                <div key={m.month} className="flex flex-1 flex-col items-center justify-end gap-1" title={`Mes ${m.month}: ${formatMoney(m.liquidBalance)}`}>
                  <div className={`w-full rounded-t ${m.liquidBalance < 0 ? 'bg-orange-600' : 'bg-brand-500'}`} style={{ height: `${(Math.abs(m.liquidBalance) / maxBal) * 100}%` }} />
                  <span className="text-[10px] text-muted">{m.month}</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">Dinero disponible al final de cada mes (sin incluir lo ahorrado). Proyección lineal: no considera intereses, imprevistos ni inflación.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
