import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, ErrorBox, Loading, Modal, Money, Notice } from '@/components/ui';
import { SimpleEntry } from '@/components/SimpleEntry';
import { SimpleTransactionList } from '@/components/TransactionList';
import { TransactionDetail } from '@/components/TransactionDetail';
import { useFinancialSnapshot, type UiTransaction } from '@/hooks/useFinance';
import { formatDateEs, monthLabelEs } from '@/domain/dates';
import { LIQUID_ASSET_KINDS } from '@/domain/types';
import { ZERO } from '@/domain/money';

export function SimpleHome() {
  const { snapshot: s, loading, error, transactions, profile } = useFinancialSnapshot();
  const [entry, setEntry] = useState<'in' | 'out' | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [selected, setSelected] = useState<UiTransaction | null>(null);

  if (loading) return <Loading />;
  const m = s.monthStatement;
  const hello = profile?.displayName ? `Hola, ${profile.displayName.split(' ')[0]}` : 'Hola';

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <h1 className="sr-only">Inicio</h1>
      <ErrorBox error={error} />
      <div>
        <p className="text-sm text-muted">{hello} · {formatDateEs(s.today, 'long')}</p>
        <section className="mt-2 rounded-xl bg-brand-800 p-5 text-white shadow-sm">
          <p className="text-sm text-brand-100">Dinero disponible</p>
          <p className="mt-1 text-4xl font-semibold tabular"><Money value={s.available} /></p>
          <p className="mt-1 text-xs text-brand-200">Suma de tus cuentas de débito, ahorro y efectivo. No incluye el crédito de la tarjeta.</p>
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg bg-white/10 p-3"><div className="text-brand-100">Entró hoy</div><div className="text-lg font-semibold tabular"><Money value={s.todayIn} /></div></div>
            <div className="rounded-lg bg-white/10 p-3"><div className="text-brand-100">Salió hoy</div><div className="text-lg font-semibold tabular"><Money value={s.todayOut} /></div></div>
          </div>
        </section>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Button variant="income" size="lg" className="py-5 text-lg" onClick={() => setEntry('in')}>＋ ENTRÓ DINERO</Button>
        <Button variant="expense" size="lg" className="py-5 text-lg" onClick={() => setEntry('out')}>－ SALIÓ DINERO</Button>
      </div>
      {toast && <Notice tone="ok">{toast}</Notice>}
      {s.reminders.slice(0, 2).map((r) => (
        <Notice key={r.id} tone={r.severity === 'info' ? 'info' : 'warn'}><strong>{r.title}.</strong> {r.detail}</Notice>
      ))}

      <Card>
        <h2 className="text-sm font-semibold">Resumen de {monthLabelEs(s.today)}</h2>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center text-sm">
          <div><div className="text-muted">Entró</div><div className="font-semibold text-pos"><Money value={m.income} /></div></div>
          <div><div className="text-muted">Salió</div><div className="font-semibold text-neg"><Money value={m.expenses} /></div></div>
          <div><div className="text-muted">Ahorré</div><div className="font-semibold"><Money value={m.savings} /></div></div>
        </div>
        <p className="mt-3 rounded-lg bg-slate-50 p-2 text-center text-sm">
          Te {m.result >= 0 ? 'sobran' : 'faltan'} <strong><Money value={m.result} tone="auto" /></strong> este mes (entró − salió).
        </p>
        <div className="mt-3 space-y-1.5 text-sm">
          {s.accounts.filter((a) => !a.isArchived).map((a) => (
            <div key={a.id} className="flex justify-between">
              <span className="text-muted">{a.name}{a.kind === 'credit_card' ? ' (debes)' : ''}</span>
              <Money value={s.balances.get(a.id)?.balance ?? ZERO} className={LIQUID_ASSET_KINDS.has(a.kind) ? '' : 'text-neg'} />
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Últimos movimientos</h2>
          <Link to="/simple/movimientos" className="text-sm text-brand-700">Ver todos</Link>
        </div>
        {transactions.length === 0
          ? <p className="py-6 text-center text-sm text-muted">Aún no hay movimientos. Usa los botones de arriba.</p>
          : <SimpleTransactionList items={transactions.slice(0, 8)} onSelect={setSelected} />}
      </Card>

      <Modal open={entry !== null} onClose={() => setEntry(null)} title={entry === 'in' ? 'Entró dinero' : 'Salió dinero'}>
        {entry && <SimpleEntry direction={entry} onDone={(msg) => { setEntry(null); setToast(msg); window.setTimeout(() => setToast(null), 4000); }} />}
      </Modal>
      <Modal open={selected !== null} onClose={() => setSelected(null)} title="Detalle">
        {selected && <TransactionDetail t={selected} simple onClose={() => setSelected(null)} />}
      </Modal>
    </div>
  );
}
