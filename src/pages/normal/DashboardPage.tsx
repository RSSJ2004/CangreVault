import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BarList, Button, Card, CardTitle, ErrorBox, Loading, Modal, Money, Notice, PageHeader, ProgressBar, Stat, Badge } from '@/components/ui';
import { TransactionForm } from '@/components/TransactionForm';
import { useFinancialSnapshot, useServerBalances } from '@/hooks/useFinance';
import { useLookups } from '@/hooks/useLookups';
import { formatDateEs, monthLabelEs } from '@/domain/dates';
import { formatMoney, fromDecimalString, ZERO } from '@/domain/money';
import { ACCOUNT_KIND_LABEL } from '@/domain/types';

export function DashboardPage() {
  const { snapshot: s, loading, error } = useFinancialSnapshot();
  const server = useServerBalances();
  const { categoryName } = useLookups();
  const [adding, setAdding] = useState(false);
  if (loading) return <Loading />;
  const nw = s.netWorth;
  const m = s.monthStatement;
  const debitAcc = s.accounts.filter((a) => a.kind === 'checking');
  const savingsAcc = s.accounts.filter((a) => a.kind === 'savings');
  const bal = (ids: typeof debitAcc) => ids.reduce((t, a) => t + (s.balances.get(a.id)?.balance ?? 0), 0) as typeof ZERO;
  // Verificación de integridad: saldo calculado en el cliente vs vista del servidor.
  const mismatches = server.data
    ? s.accounts.filter((a) => {
        const sv = server.data!.get(a.id);
        return sv !== undefined && s.pendingSyncCount === 0 && fromDecimalString(sv) !== (s.balances.get(a.id)?.balance ?? 0);
      })
    : [];

  return (
    <div className="space-y-6">
      <PageHeader title="Estado Mayor" subtitle={`${formatDateEs(s.today, 'long')} · ${monthLabelEs(s.today)}`}
        actions={<Button onClick={() => setAdding(true)}>+ Registrar movimiento</Button>} />
      <ErrorBox error={error} />
      {mismatches.length > 0 && <Notice tone="warn">Diferencia entre el saldo calculado localmente y el del servidor en: {mismatches.map((a) => a.name).join(', ')}. Recarga la página; si persiste, revisa la conciliación.</Notice>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Balance débito" value={<Money value={bal(debitAcc)} />} />
        <Stat label="Balance ahorro" value={<Money value={bal(savingsAcc)} />} />
        <Stat label="Deuda de tarjetas" value={<Money value={nw.creditCardDebt} />} tone={nw.creditCardDebt > 0 ? 'neg' : undefined}
          hint={`Crédito disponible ${formatMoney(nw.availableCredit)}`} />
        <Stat label="Patrimonio líquido neto" value={<Money value={nw.liquidNetWorth} tone="auto" />} emphasis
          hint="Débito + ahorro + efectivo − deudas. El límite de crédito no suma." />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle hint="Parámetros configurados (no son movimientos)">Planificación mensual</CardTitle>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Ingreso mensual" value={<Money value={s.salaryMonthly} />} hint={s.extraMonthly ? `+ ${formatMoney(s.extraMonthly)} adicionales` : 'Sueldo configurado'} />
            <Stat label="Gastos recurrentes" value={<Money value={s.recurringMonthly} />} hint={<Link className="underline" to="/recurrentes">Ver / editar</Link>} />
            <Stat label="Excedente estimado" value={<Money value={s.estimatedSurplus} tone="auto" />} hint="Ingresos − recurrentes (antes de gastos variables)" />
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Este mes (real)</h3>
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between"><dt>Ingresos</dt><dd><Money value={m.income} tone="pos" /></dd></div>
                <div className="flex justify-between"><dt>Gastos</dt><dd><Money value={m.expenses} tone="neg" /></dd></div>
                <div className="flex justify-between"><dt>Enviado a ahorro/inversión</dt><dd><Money value={m.savings} /></dd></div>
                <div className="flex justify-between border-t border-line pt-1.5 font-semibold"><dt>Resultado</dt><dd><Money value={m.result} tone="auto" /></dd></div>
                <div className="flex justify-between text-muted"><dt>Excedente no asignado</dt><dd><Money value={m.unallocatedSurplus} tone="auto" /></dd></div>
              </dl>
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Gastos por categoría</h3>
              {m.expensesByCategory.length
                ? <BarList items={m.expensesByCategory.slice(0, 5).map((l) => ({ label: l.categoryId ? categoryName(l.categoryId) : l.name, value: l.amount, pct: l.pctOfTotal }))} />
                : <p className="text-sm text-muted">Sin gastos este mes.</p>}
            </div>
          </div>
        </Card>

        <Card>
          <CardTitle>Recordatorios</CardTitle>
          {s.reminders.length === 0 && <p className="text-sm text-muted">Nada urgente.</p>}
          <ul className="space-y-2">
            {s.reminders.slice(0, 6).map((r) => (
              <li key={r.id} className={`rounded-lg border p-2.5 text-sm ${r.severity === 'critical' ? 'border-red-200 bg-red-50' : r.severity === 'warning' ? 'border-amber-200 bg-amber-50' : 'border-line'}`}>
                <div className="font-medium">{r.title}</div><div className="text-xs text-muted">{r.detail}</div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {s.cards.map(({ account, summary }) => {
          const u = summary.utilization;
          return (
            <Card key={account.id}>
              <CardTitle action={<Link to="/tarjeta" className="text-sm text-brand-700">Detalle</Link>}>{account.name}</CardTitle>
              {u ? (
                <>
                  <div className="flex items-end justify-between text-sm">
                    <span>Utilización <strong className={u.alertTriggered ? 'text-amber-700' : ''}>{u.utilizationPct}%</strong></span>
                    <span className="text-muted"><Money value={u.debt} /> de <Money value={u.limit} /></span>
                  </div>
                  <div className="mt-2"><ProgressBar pct={u.utilizationPct} tone={u.overLimit ? 'neg' : u.alertTriggered ? 'warn' : 'brand'} marker={u.alertPct} /></div>
                  <p className="mt-1 text-xs text-muted">Alerta al {u.alertPct}% = {formatMoney(u.alertAmount)}</p>
                </>
              ) : <Notice tone="warn">Configura el límite de crédito para ver la utilización.</Notice>}
              <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <div><dt className="text-muted">Próximo corte</dt><dd>{summary.openCycle ? formatDateEs(summary.openCycle.statementDate) : '—'} <Badge>estimado</Badge></dd></div>
                <div><dt className="text-muted">Fecha límite de pago</dt><dd>{summary.dueDate ? formatDateEs(summary.dueDate) : '—'} {summary.dueDateEstimated && summary.dueDate && <Badge>estimada</Badge>}</dd></div>
              </dl>
            </Card>
          );
        })}
        <Card>
          <CardTitle>Cuentas</CardTitle>
          <ul className="divide-y divide-line text-sm">
            {s.accounts.map((a) => (
              <li key={a.id} className="flex justify-between py-2">
                <span>{a.name} <span className="text-xs text-muted">· {ACCOUNT_KIND_LABEL[a.kind]}</span></span>
                <Money value={s.balances.get(a.id)?.balance ?? ZERO} className={a.isLiability ? 'text-neg' : ''} />
              </li>
            ))}
          </ul>
          {s.pendingSyncCount > 0 && <p className="mt-2 text-xs text-amber-700">Incluye {s.pendingSyncCount} movimiento(s) pendientes de sincronizar.</p>}
        </Card>
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} title="Registrar movimiento">
        {adding && <TransactionForm onDone={() => setAdding(false)} />}
      </Modal>
    </div>
  );
}
