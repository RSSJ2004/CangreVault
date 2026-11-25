import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardTitle, ErrorBox, Field, Input, Loading, Money, Notice, PageHeader, Select } from '@/components/ui';
import { useFinancialSnapshot, useReconciliations, useTransactions } from '@/hooks/useFinance';
import { useLookups } from '@/hooks/useLookups';
import { reconcileAccount } from '@/repositories/finance';
import { computeAccountBalance } from '@/domain/ledger';
import { previewReconciliation } from '@/domain/reconciliation';
import { formatDateEs, isIsoDate, todayIso, type IsoDate } from '@/domain/dates';
import { parseUserAmount, toDecimalString, type Cents } from '@/domain/money';
import { newUuid } from '@/lib/supabase';
import { toAppError } from '@/lib/errors';

export function ReconcilePage() {
  const qc = useQueryClient();
  const { snapshot: s, loading } = useFinancialSnapshot();
  const txs = useTransactions();
  const recs = useReconciliations();
  const { accountName } = useLookups();
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState<string>(todayIso());
  const [stmt, setStmt] = useState('');
  const [adjust, setAdjust] = useState(true);
  const [mark, setMark] = useState(true);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (loading) return <Loading />;
  const acc = s.accounts.find((a) => a.id === accountId) ?? s.accounts[0];
  if (!acc) return <Notice>Crea una cuenta primero.</Notice>;
  const calc = isIsoDate(date) ? computeAccountBalance(acc, txs.data.filter((t) => !t.pendingSync), date as IsoDate).balance : null;
  const statement = stmt.trim() === '0' ? (0 as Cents) : parseUserAmount(stmt);
  const preview = calc !== null && statement !== null ? previewReconciliation(calc, statement) : null;

  return (
    <div className="space-y-5">
      <PageHeader title="Conciliación" subtitle="Compara el saldo calculado con el que reporta el banco." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Nueva conciliación</CardTitle>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Cuenta">{(id) => <Select id={id} value={acc.id} onChange={(e) => setAccountId(e.target.value)}>{s.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
            <Field label="Fecha del saldo del banco">{(id) => <Input id={id} type="date" max={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
            <Field label={acc.isLiability ? 'Deuda según el banco' : 'Saldo según el banco'} className="sm:col-span-2">
              {(id) => <Input id={id} inputMode="decimal" value={stmt} onChange={(e) => setStmt(e.target.value)} placeholder="0.00" />}
            </Field>
          </div>
          {preview && (
            <dl className="mt-4 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-center text-sm">
              <div><dt className="text-xs text-muted">Calculado</dt><dd><Money value={preview.calculated} /></dd></div>
              <div><dt className="text-xs text-muted">Banco</dt><dd><Money value={preview.statement} /></dd></div>
              <div><dt className="text-xs text-muted">Diferencia</dt><dd className={preview.matches ? 'text-pos' : 'text-neg'}><Money value={preview.difference} sign /></dd></div>
            </dl>
          )}
          {preview && !preview.matches && (
            <Notice tone="warn">
              Antes de ajustar, busca la causa: movimientos sin registrar, duplicados o importes mal escritos.
              Si creas un ajuste, quedará identificado como «Ajuste de conciliación» y auditado.
            </Notice>
          )}
          <div className="mt-3 space-y-2 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={adjust} onChange={(e) => setAdjust(e.target.checked)} /> Crear ajuste por la diferencia</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={mark} onChange={(e) => setMark(e.target.checked)} /> Marcar como conciliados los movimientos hasta esa fecha</label>
          </div>
          <Field label="Notas" className="mt-3">{(id) => <Input id={id} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
          <ErrorBox error={error} title="No se pudo conciliar" />
          {ok && <div className="mt-3"><Notice tone="ok">{ok}</Notice></div>}
          <div className="mt-4 flex justify-end">
            <Button loading={busy} disabled={!preview} onClick={async () => {
              setBusy(true); setError(null); setOk(null);
              try {
                const r = await reconcileAccount({ accountId: acc.id, date: date as IsoDate, statementBalance: toDecimalString(statement!), createAdjustment: adjust,
                  markTransactions: mark, notes: notes.trim() || null, clientId: newUuid() });
                setOk(`Conciliación registrada. Saldo calculado por el servidor: ${toDecimalString(r.calculatedBalance)}; diferencia ${toDecimalString(r.difference)}.`);
                await qc.invalidateQueries();
              } catch (e) { setError(toAppError(e).message); } finally { setBusy(false); }
            }}>Conciliar</Button>
          </div>
          <p className="mt-2 text-xs text-muted">El saldo calculado definitivo lo determina el servidor a partir del diario; los movimientos pendientes de sincronizar no se incluyen.</p>
        </Card>
        <Card>
          <CardTitle>Historial</CardTitle>
          <ul className="divide-y divide-line text-sm">
            {(recs.data ?? []).map((r) => (
              <li key={r.id} className="py-2">
                <div className="flex justify-between"><span className="font-medium">{accountName(r.accountId)}</span><span>{formatDateEs(r.reconciledOn)}</span></div>
                <div className="flex justify-between text-xs text-muted">
                  <span>Banco <Money value={r.statementBalance} /> · Calculado <Money value={r.calculatedBalance} /></span>
                  <span><Money value={r.difference} sign /> <Badge tone={r.status === 'matched' ? 'pos' : r.status === 'adjusted' ? 'info' : 'warn'}>{r.status === 'matched' ? 'cuadra' : r.status === 'adjusted' ? 'ajustado' : 'pendiente'}</Badge></span>
                </div>
              </li>
            ))}
            {!(recs.data ?? []).length && <li className="py-3 text-muted">Sin conciliaciones.</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}
