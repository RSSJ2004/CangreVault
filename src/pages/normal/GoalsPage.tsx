import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, Money, Notice, PageHeader, ProgressBar, Select } from '@/components/ui';
import { useContributions, useFinancialSnapshot, useGoals } from '@/hooks/useFinance';
import { useLookups } from '@/hooks/useLookups';
import { addContribution, saveGoal, softDeleteContribution, softDeleteGoal, upsertTransaction } from '@/repositories/finance';
import { goalProgress, simulateGoal, emergencyFundTarget } from '@/domain/savingsGoals';
import { formatDateEs, isIsoDate, todayIso, type IsoDate } from '@/domain/dates';
import { formatMoney, parseUserAmount, toDecimalString } from '@/domain/money';
import type { SavingsGoal } from '@/domain/types';
import { newUuid } from '@/lib/supabase';
import { toAppError } from '@/lib/errors';

function GoalForm({ initial, suggestion, onDone }: { initial?: SavingsGoal; suggestion?: { target: string; emergency: boolean }; onDone: () => void }) {
  const qc = useQueryClient();
  const { accounts } = useLookups();
  const [name, setName] = useState(initial?.name ?? (suggestion?.emergency ? 'Fondo de emergencia' : ''));
  const [target, setTarget] = useState(initial ? toDecimalString(initial.targetAmount) : suggestion?.target ?? '');
  const [date, setDate] = useState<string>(initial?.targetDate ?? '');
  const [accountId, setAccountId] = useState(initial?.accountId ?? accounts.find((a) => a.kind === 'savings')?.id ?? '');
  const [emergency, setEmergency] = useState(initial?.isEmergencyFund ?? suggestion?.emergency ?? false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const t = parseUserAmount(target);
      if (!name.trim() || !t || t <= 0) return setError('Nombre e importe objetivo son obligatorios.');
      if (date && !isIsoDate(date)) return setError('Fecha inválida.');
      setSaving(true);
      try {
        await saveGoal({ id: initial?.id, clientId: initial?.clientId ?? newUuid(), name: name.trim(), targetAmount: t, targetDate: (date || null) as IsoDate | null,
          accountId: accountId || null, isEmergencyFund: emergency, status: initial?.status ?? 'active' });
        await qc.invalidateQueries({ queryKey: ['goals'] });
        onDone();
      } catch (ex) { setError(toAppError(ex).message); } finally { setSaving(false); }
    }}>
      <Field label="Nombre">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Objetivo (RD$)">{(id) => <Input id={id} value={target} inputMode="decimal" onChange={(e) => setTarget(e.target.value)} />}</Field>
        <Field label="Fecha objetivo (opcional)">{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
      </div>
      <Field label="Cuenta donde se guarda">{(id) => <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
        <option value="">— Ninguna —</option>{accounts.filter((a) => !a.isLiability).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={emergency} onChange={(e) => setEmergency(e.target.checked)} /> Es mi fondo de emergencia</label>
      <ErrorBox error={error} />
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onDone}>Cancelar</Button><Button type="submit" loading={saving}>Guardar</Button></div>
    </form>
  );
}

function ContributionForm({ goal, onDone }: { goal: SavingsGoal; onDone: () => void }) {
  const qc = useQueryClient();
  const { accounts } = useLookups();
  const [kind, setKind] = useState<'contribution' | 'withdrawal'>('contribution');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState<string>(todayIso());
  const [fromId, setFromId] = useState(accounts.find((a) => a.kind === 'checking')?.id ?? '');
  const [withTx, setWithTx] = useState(Boolean(goal.accountId));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dest = accounts.find((a) => a.id === goal.accountId);
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {(['contribution', 'withdrawal'] as const).map((k) => <Button key={k} variant={kind === k ? 'primary' : 'secondary'} size="sm" onClick={() => setKind(k)}>{k === 'contribution' ? 'Aportar' : 'Retirar'}</Button>)}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Importe">{(id) => <Input id={id} value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Field label="Fecha">{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
      </div>
      {kind === 'contribution' && dest && dest.kind === 'savings' && (
        <>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={withTx} onChange={(e) => setWithTx(e.target.checked)} /> Registrar también el movimiento a «{dest.name}» (aporte a ahorro, no es gasto)</label>
          {withTx && <Field label="Desde la cuenta">{(id) => <Select id={id} value={fromId} onChange={(e) => setFromId(e.target.value)}>
            {accounts.filter((a) => a.id !== dest.id && !a.isLiability).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>}
        </>
      )}
      <ErrorBox error={error} />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>Cancelar</Button>
        <Button loading={saving} onClick={async () => {
          const c = parseUserAmount(amount);
          if (!c || c <= 0 || !isIsoDate(date)) return setError('Revisa importe y fecha.');
          setSaving(true);
          try {
            let transactionId: string | null = null;
            if (kind === 'contribution' && withTx && dest) {
              const from = accounts.find((a) => a.id === fromId);
              if (!from) throw new Error('Selecciona la cuenta de origen.');
              const tx = await upsertTransaction({ clientId: newUuid(), type: 'SAVINGS_CONTRIBUTION', accountId: from.id, toAccountId: dest.id, amount: c,
                currency: from.currency, occurredOn: date as IsoDate, description: `Aporte a meta: ${goal.name}`, savingsGoalId: goal.id, entryMode: 'normal', source: 'manual' });
              transactionId = tx.id;
            }
            await addContribution({ clientId: newUuid(), goalId: goal.id, kind, amount: c, contributedOn: date as IsoDate, transactionId, notes: null });
            await Promise.all([qc.invalidateQueries({ queryKey: ['contributions'] }), qc.invalidateQueries({ queryKey: ['transactions'] })]);
            onDone();
          } catch (ex) { setError(toAppError(ex).message); } finally { setSaving(false); }
        }}>Guardar</Button>
      </div>
      <p className="text-xs text-muted">Registrar el aporte en la meta y el movimiento entre cuentas requiere conexión.</p>
    </div>
  );
}

export function GoalsPage() {
  const qc = useQueryClient();
  const goals = useGoals();
  const contribs = useContributions();
  const { snapshot, loading } = useFinancialSnapshot();
  const { profile } = useFinancialSnapshot();
  const [form, setForm] = useState<{ initial?: SavingsGoal; suggestion?: { target: string; emergency: boolean } } | null>(null);
  const [contrib, setContrib] = useState<SavingsGoal | null>(null);
  const [sim, setSim] = useState<Record<string, string>>({});
  const today = todayIso();
  if (goals.isLoading || loading) return <Loading />;
  const list = (goals.data ?? []).filter((g) => g.status !== 'archived');
  const hasEmergency = list.some((g) => g.isEmergencyFund);
  const efMonths = profile?.emergencyFundMonths ?? 3;
  const essential = snapshot.monthStatement.expenses > 0 ? snapshot.monthStatement.expenses : snapshot.recurringMonthly;
  const efTarget = emergencyFundTarget(essential, efMonths);

  return (
    <div className="space-y-5">
      <PageHeader title="Metas de ahorro" actions={<Button onClick={() => setForm({})}>+ Nueva meta</Button>} />
      {!hasEmergency && efTarget > 0 && (
        <Notice>
          Aún no tienes un fondo de emergencia. Una referencia común es reunir {efMonths} meses de gastos esenciales: con tus gastos actuales serían
          aproximadamente <strong>{formatMoney(efTarget)}</strong>.{' '}
          <button className="font-medium underline" onClick={() => setForm({ suggestion: { target: toDecimalString(efTarget), emergency: true } })}>Crear meta</button>
        </Notice>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {list.map((g) => {
          const p = goalProgress(g, contribs.data ?? [], today);
          const simAmt = parseUserAmount(sim[g.id] ?? '');
          const simRes = simAmt ? simulateGoal(p.remaining, simAmt, today) : null;
          const history = (contribs.data ?? []).filter((c) => c.goalId === g.id).sort((a, b) => (a.contributedOn < b.contributedOn ? 1 : -1));
          return (
            <Card key={g.id}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="font-semibold">{g.name} {g.isEmergencyFund && <Badge tone="info">Emergencia</Badge>} {p.completed && <Badge tone="pos">Completada</Badge>}</h2>
                  <p className="text-xs text-muted">{g.targetDate ? `Objetivo: ${formatDateEs(g.targetDate)}` : 'Sin fecha objetivo'}</p>
                </div>
                <div className="text-right text-sm"><Money value={p.saved} className="font-semibold" /> <span className="text-muted">/ <Money value={g.targetAmount} /></span></div>
              </div>
              <div className="mt-3"><ProgressBar pct={p.pct} /></div>
              <div className="mt-2 flex justify-between text-xs text-muted"><span>{p.pct}%</span><span>Faltan <Money value={p.remaining} /></span></div>
              {p.requiredMonthly !== null && !p.completed && (
                <p className={`mt-2 text-sm ${p.overdue ? 'text-red-700' : ''}`}>
                  {p.overdue ? 'La fecha objetivo ya pasó.' : `Para llegar a tiempo: ${formatMoney(p.requiredMonthly)} al mes (${Math.max(1, p.monthsLeft ?? 1)} mes(es)).`}
                </p>
              )}
              <div className="mt-3 flex items-center gap-2 text-sm">
                <span className="text-muted">Simular aporte mensual</span>
                <Input className="w-28 py-1" placeholder="2,000" value={sim[g.id] ?? ''} onChange={(e) => setSim((s) => ({ ...s, [g.id]: e.target.value }))} />
                {simRes && <span>→ {simRes.months} mes(es), {formatDateEs(simRes.completionDate)}</span>}
              </div>
              {history.length > 0 && (
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer text-muted">Aportaciones ({history.length})</summary>
                  <ul className="mt-1 divide-y divide-line">
                    {history.map((c) => (
                      <li key={c.id} className="flex justify-between py-1">
                        <span>{formatDateEs(c.contributedOn)} {c.kind === 'withdrawal' && <Badge tone="warn">retiro</Badge>} {c.transactionId && <Badge>con movimiento</Badge>}</span>
                        <span className="flex items-center gap-2"><Money value={c.amount} />
                          <button className="text-xs text-muted hover:text-red-700" onClick={() => void softDeleteContribution(c.id).then(() => qc.invalidateQueries({ queryKey: ['contributions'] }))}>quitar</button></span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setContrib(g)}>Registrar aportación</Button>
                <Button size="sm" variant="secondary" onClick={() => setForm({ initial: g })}>Editar</Button>
                <Button size="sm" variant="ghost" onClick={() => { if (confirm('¿Eliminar la meta?')) void softDeleteGoal(g.id).then(() => qc.invalidateQueries({ queryKey: ['goals'] })); }}>Eliminar</Button>
              </div>
            </Card>
          );
        })}
      </div>
      {!list.length && <p className="text-sm text-muted">Crea tu primera meta de ahorro.</p>}
      <Modal open={form !== null} onClose={() => setForm(null)} title={form?.initial ? 'Editar meta' : 'Nueva meta'}>
        {form && <GoalForm initial={form.initial} suggestion={form.suggestion} onDone={() => setForm(null)} />}
      </Modal>
      <Modal open={contrib !== null} onClose={() => setContrib(null)} title={`Aportación: ${contrib?.name ?? ''}`}>
        {contrib && <ContributionForm goal={contrib} onDone={() => setContrib(null)} />}
      </Modal>
    </div>
  );
}
