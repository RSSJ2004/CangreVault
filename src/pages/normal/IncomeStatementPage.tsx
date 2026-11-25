import { useMemo, useState } from 'react';
import { BarList, Card, CardTitle, Input, Loading, Money, PageHeader, Select, Notice } from '@/components/ui';
import { useCategories, useTransactions } from '@/hooks/useFinance';
import { computeIncomeStatement } from '@/domain/incomeStatement';
import { addMonths, endOfMonth, startOfMonth, todayIso, isIsoDate, type IsoDate, monthLabelEs } from '@/domain/dates';

export function IncomeStatementPage() {
  const txs = useTransactions();
  const cats = useCategories();
  const today = todayIso();
  const [preset, setPreset] = useState('this');
  const [from, setFrom] = useState<string>(startOfMonth(today));
  const [to, setTo] = useState<string>(endOfMonth(today));

  function applyPreset(p: string) {
    setPreset(p);
    const base = startOfMonth(today);
    if (p === 'this') { setFrom(base); setTo(endOfMonth(today)); }
    if (p === 'last') { const l = addMonths(base, -1); setFrom(l); setTo(endOfMonth(l)); }
    if (p === '3m') { setFrom(addMonths(base, -2)); setTo(endOfMonth(today)); }
    if (p === 'year') { setFrom(`${today.slice(0, 4)}-01-01`); setTo(`${today.slice(0, 4)}-12-31`); }
  }

  const st = useMemo(() => {
    if (!isIsoDate(from) || !isIsoDate(to)) return null;
    return computeIncomeStatement(txs.data.filter((t) => !t.syncError), cats.data ?? [], { from: from as IsoDate, to: to as IsoDate });
  }, [txs.data, cats.data, from, to]);

  if (txs.isLoading) return <Loading />;
  return (
    <div>
      <PageHeader title="Estado de resultados" subtitle={preset === 'this' ? monthLabelEs(today) : `${from} a ${to}`} />
      <Card className="mb-4 flex flex-wrap items-end gap-2">
        <Select value={preset} onChange={(e) => applyPreset(e.target.value)} className="w-auto">
          <option value="this">Este mes</option><option value="last">Mes anterior</option><option value="3m">Últimos 3 meses</option>
          <option value="year">Este año</option><option value="custom">Personalizado</option>
        </Select>
        <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPreset('custom'); }} className="w-auto" />
        <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPreset('custom'); }} className="w-auto" />
      </Card>
      {st && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-1">
            <CardTitle>Resumen</CardTitle>
            <table className="w-full text-sm"><tbody>
              <tr><td className="py-1">Ingresos</td><td className="text-right"><Money value={st.income} tone="pos" /></td></tr>
              <tr><td className="py-1">Gastos brutos</td><td className="text-right"><Money value={st.grossExpenses} /></td></tr>
              <tr><td className="py-1 text-muted">(−) Devoluciones</td><td className="text-right text-muted"><Money value={st.refunds} /></td></tr>
              <tr><td className="py-1">Gastos netos</td><td className="text-right"><Money value={st.expenses} tone="neg" /></td></tr>
              <tr><td className="py-1 pl-3 text-xs text-muted">de ellos, recurrentes</td><td className="text-right text-xs text-muted"><Money value={st.recurringExpenses} /></td></tr>
              <tr className="border-t border-line font-semibold"><td className="py-1.5">Resultado (excedente)</td><td className="text-right"><Money value={st.result} tone="auto" /></td></tr>
              <tr><td className="py-1">Ahorro e inversión</td><td className="text-right"><Money value={st.savings} /></td></tr>
              <tr className="border-t border-line"><td className="py-1.5">Excedente no asignado</td><td className="text-right"><Money value={st.unallocatedSurplus} tone="auto" /></td></tr>
            </tbody></table>
            <div className="mt-4 grid grid-cols-2 gap-2 text-center text-sm">
              <div className="rounded-lg bg-slate-50 p-2"><div className="text-xs text-muted">Gastos / ingresos</div><div className="font-semibold">{st.expenseRatePct}%</div></div>
              <div className="rounded-lg bg-slate-50 p-2"><div className="text-xs text-muted">Tasa de ahorro</div><div className="font-semibold">{st.savingsRatePct}%</div></div>
            </div>
            {(st.adjustmentsIn > 0 || st.adjustmentsOut > 0) && (
              <p className="mt-3 text-xs text-muted">Ajustes de saldo (fuera del resultado): +<Money value={st.adjustmentsIn} /> / −<Money value={st.adjustmentsOut} /></p>
            )}
            <Notice><span className="text-xs">Las transferencias entre tus cuentas ({st.excludedTransfers}) y los pagos de tarjeta no son gastos: el gasto se reconoce cuando compras.</span></Notice>
          </Card>
          <Card>
            <CardTitle>Gastos por categoría</CardTitle>
            {st.expensesByCategory.length ? <BarList items={st.expensesByCategory.map((l) => ({ label: l.name, value: l.amount, pct: l.pctOfTotal }))} /> : <p className="text-sm text-muted">Sin gastos.</p>}
          </Card>
          <Card>
            <CardTitle>Ingresos por categoría</CardTitle>
            {st.incomeByCategory.length ? <BarList items={st.incomeByCategory.map((l) => ({ label: l.name, value: l.amount, pct: l.pctOfTotal }))} /> : <p className="text-sm text-muted">Sin ingresos.</p>}
          </Card>
        </div>
      )}
    </div>
  );
}
