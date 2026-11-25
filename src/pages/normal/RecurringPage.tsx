import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardTitle, ErrorBox, Field, Input, Loading, Modal, Money, PageHeader, Select, Stat, Textarea } from '@/components/ui';
import { useRecurring, useTransactions } from '@/hooks/useFinance';
import { useLookups } from '@/hooks/useLookups';
import { saveRecurring, softDeleteRecurring } from '@/repositories/finance';
import { monthlyEquivalent, pendingOccurrences, totalMonthlyRecurring } from '@/domain/recurring';
import { addDays, formatDateEs, isIsoDate, todayIso, type IsoDate } from '@/domain/dates';
import { formatMoney, parseUserAmount, toDecimalString, type Cents } from '@/domain/money';
import { RECURRING_FREQUENCY_LABEL, type RecurringExpense, type RecurringFrequency, type RecurringStatus } from '@/domain/types';
import { enqueueTransaction } from '@/sync/outbox';
import { newUuid } from '@/lib/supabase';
import { toAppError } from '@/lib/errors';

const STATUS: Record<RecurringStatus, { label: string; tone: 'pos' | 'warn' | 'neutral' }> = {
  active: { label: 'Activo', tone: 'pos' }, paused: { label: 'Pausado', tone: 'warn' }, cancelled: { label: 'Cancelado', tone: 'neutral' },
};
const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function RecurringForm({ initial, onDone }: { initial?: RecurringExpense; onDone: () => void }) {
  const qc = useQueryClient();
  const { accounts, categories } = useLookups();
  const [f, setF] = useState({
    name: initial?.name ?? '', amount: initial ? toDecimalString(initial.amount) : '', accountId: initial?.accountId ?? accounts[0]?.id ?? '',
    categoryId: initial?.categoryId ?? '', frequency: (initial?.frequency ?? 'monthly') as RecurringFrequency,
    dayFrom: initial?.dayFrom?.toString() ?? '', dayTo: initial?.dayTo?.toString() ?? '', weekday: initial?.weekday?.toString() ?? '1',
    monthOfYear: initial?.monthOfYear?.toString() ?? '1', startDate: initial?.startDate ?? todayIso(), endDate: initial?.endDate ?? '',
    remind: initial?.remindDaysBefore?.toString() ?? '3', notes: initial?.notes ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const acc = accounts.find((a) => a.id === f.accountId);
  const weekly = f.frequency === 'weekly' || f.frequency === 'biweekly';
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const amount = parseUserAmount(f.amount);
    if (!f.name.trim()) return setError('Escribe un nombre.');
    if (!amount || amount <= 0) return setError('Importe inválido.');
    if (!acc) return setError('Selecciona la cuenta.');
    if (!weekly && (!f.dayFrom || Number(f.dayFrom) < 1 || Number(f.dayFrom) > 31)) return setError('Indica el día del mes (1–31).');
    if (f.dayTo && Number(f.dayTo) < Number(f.dayFrom)) return setError('El día final del rango debe ser mayor o igual al inicial.');
    if (!isIsoDate(f.startDate)) return setError('Fecha de inicio inválida.');
    if (f.endDate && (!isIsoDate(f.endDate) || f.endDate < f.startDate)) return setError('La fecha de fin debe ser posterior al inicio.');
    setSaving(true);
    try {
      await saveRecurring({
        id: initial?.id, clientId: initial?.clientId ?? newUuid(), name: f.name.trim(), amount, currency: acc.currency, accountId: acc.id,
        categoryId: f.categoryId || null, transactionType: acc.kind === 'credit_card' ? 'CARD_PURCHASE' : 'EXPENSE', frequency: f.frequency,
        dayFrom: weekly ? null : Number(f.dayFrom), dayTo: weekly || !f.dayTo ? null : Number(f.dayTo), weekday: weekly ? Number(f.weekday) : null,
        monthOfYear: f.frequency === 'yearly' ? Number(f.monthOfYear) : null, startDate: f.startDate as IsoDate, endDate: (f.endDate || null) as IsoDate | null,
        remindDaysBefore: Number(f.remind || 3), notes: f.notes.trim() || null, status: initial?.status ?? 'active',
      });
      await qc.invalidateQueries({ queryKey: ['recurring'] });
      onDone();
    } catch (ex) {
      setError(toAppError(ex).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {initial && <p className="text-xs text-muted">Los cambios afectan solo a las proyecciones futuras. Los movimientos ya registrados no se modifican.</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nombre">{(id) => <Input id={id} value={f.name} onChange={set('name')} placeholder="Altice" />}</Field>
        <Field label="Importe (RD$)">{(id) => <Input id={id} value={f.amount} inputMode="decimal" onChange={set('amount')} />}</Field>
        <Field label="Cuenta" hint={acc?.kind === 'credit_card' ? 'Se registrará como compra con tarjeta.' : undefined}>
          {(id) => <Select id={id} value={f.accountId} onChange={set('accountId')}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}
        </Field>
        <Field label="Categoría">{(id) => <Select id={id} value={f.categoryId} onChange={set('categoryId')}>
          <option value="">Sin categoría</option>{categories.filter((c) => c.kind === 'expense').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
        <Field label="Frecuencia">{(id) => <Select id={id} value={f.frequency} onChange={set('frequency')}>
          {Object.entries(RECURRING_FREQUENCY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
        {weekly ? (
          <Field label="Día de la semana">{(id) => <Select id={id} value={f.weekday} onChange={set('weekday')}>{WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}</Select>}</Field>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {f.frequency === 'yearly' && <Field label="Mes">{(id) => <Input id={id} value={f.monthOfYear} inputMode="numeric" onChange={set('monthOfYear')} />}</Field>}
            <Field label="Día (desde)">{(id) => <Input id={id} value={f.dayFrom} inputMode="numeric" onChange={set('dayFrom')} placeholder="21" />}</Field>
            <Field label="Día (hasta)">{(id) => <Input id={id} value={f.dayTo} inputMode="numeric" onChange={set('dayTo')} placeholder="23" />}</Field>
          </div>
        )}
        <Field label="Fecha de inicio">{(id) => <Input id={id} type="date" value={f.startDate} onChange={set('startDate')} />}</Field>
        <Field label="Fecha de fin (opcional)">{(id) => <Input id={id} type="date" value={f.endDate} onChange={set('endDate')} />}</Field>
        <Field label="Recordar con (días de anticipación)">{(id) => <Input id={id} value={f.remind} inputMode="numeric" onChange={set('remind')} />}</Field>
      </div>
      <Field label="Notas">{(id) => <Textarea id={id} rows={2} value={f.notes} onChange={set('notes')} />}</Field>
      <ErrorBox error={error} title="Revisa" />
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onDone}>Cancelar</Button><Button type="submit" loading={saving}>Guardar</Button></div>
    </form>
  );
}

function RegisterPayment({ r, date, onDone }: { r: RecurringExpense; date: IsoDate; onDone: () => void }) {
  const [amount, setAmount] = useState(toDecimalString(r.amount));
  const [when, setWhen] = useState<string>(todayIso() < date ? todayIso() : date);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <p className="text-sm">Registrar el pago de <strong>{r.name}</strong>. Puedes ajustar el importe real (no cambia la plantilla).</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Importe">{(id) => <Input id={id} value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Field label="Fecha">{(id) => <Input id={id} type="date" value={when} onChange={(e) => setWhen(e.target.value)} />}</Field>
      </div>
      <ErrorBox error={err} />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>Cancelar</Button>
        <Button onClick={() => {
          const c = parseUserAmount(amount);
          if (!c || !isIsoDate(when)) return setErr('Revisa importe y fecha.');
          enqueueTransaction({
            clientId: newUuid(), type: r.transactionType, accountId: r.accountId, amount: c as Cents, currency: r.currency, occurredOn: when as IsoDate,
            description: r.name, categoryId: r.categoryId, classificationSource: r.categoryId ? 'user' : null, recurringExpenseId: r.id,
            entryMode: 'recurring', source: 'recurring',
          });
          onDone();
        }}>Registrar</Button>
      </div>
    </div>
  );
}

export function RecurringPage() {
  const qc = useQueryClient();
  const rec = useRecurring();
  const txs = useTransactions();
  const { accountName, categoryName } = useLookups();
  const [form, setForm] = useState<{ initial?: RecurringExpense } | null>(null);
  const [paying, setPaying] = useState<{ r: RecurringExpense; date: IsoDate } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const today = todayIso();
  const list = rec.data ?? [];
  const upcoming = useMemo(() => pendingOccurrences(list, txs.data, { from: addDays(today, -10), to: addDays(today, 45) }), [list, txs.data, today]);

  async function setStatus(r: RecurringExpense, status: RecurringStatus) {
    try { await saveRecurring({ id: r.id, clientId: r.clientId, status }); await qc.invalidateQueries({ queryKey: ['recurring'] }); }
    catch (e) { setErr(toAppError(e).message); }
  }

  if (rec.isLoading) return <Loading />;
  return (
    <div className="space-y-5">
      <PageHeader title="Gastos recurrentes" subtitle="Plantillas para proyectar. Un gasto pausado o cancelado no aparece en las proyecciones."
        actions={<Button onClick={() => setForm({})}>+ Nuevo gasto recurrente</Button>} />
      <ErrorBox error={err} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Total mensual (activos)" value={<Money value={totalMonthlyRecurring(list)} />} />
        <Stat label="Activos" value={list.filter((r) => r.status === 'active').length} hint={`${list.filter((r) => r.status === 'paused').length} pausados`} />
        <Stat label="Próximos 45 días" value={<Money value={upcoming.filter((o) => o.date >= today).reduce((t, o) => t + o.amount, 0) as Cents} />} />
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="text-left text-xs text-muted"><tr><th className="py-2">Nombre</th><th>Cuenta</th><th>Frecuencia</th><th>Día(s)</th><th className="text-right">Importe</th><th className="text-right">Equiv. mensual</th><th>Estado</th><th></th></tr></thead>
          <tbody className="divide-y divide-line">
            {list.map((r) => (
              <tr key={r.id}>
                <td className="py-2"><div className="font-medium">{r.name}</div><div className="text-xs text-muted">{categoryName(r.categoryId)}</div></td>
                <td>{accountName(r.accountId)}</td>
                <td>{RECURRING_FREQUENCY_LABEL[r.frequency]}</td>
                <td>{r.weekday !== null ? WEEKDAYS[r.weekday] : r.dayTo && r.dayTo !== r.dayFrom ? `${r.dayFrom}–${r.dayTo}` : r.dayFrom}</td>
                <td className="text-right"><Money value={r.amount} /></td>
                <td className="text-right text-muted"><Money value={monthlyEquivalent(r)} /></td>
                <td><Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge></td>
                <td className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={() => setForm({ initial: r })}>Editar</Button>
                  {r.status === 'active' && <Button size="sm" variant="ghost" onClick={() => void setStatus(r, 'paused')}>Pausar</Button>}
                  {r.status !== 'active' && <Button size="sm" variant="ghost" onClick={() => void setStatus(r, 'active')}>Reactivar</Button>}
                  {r.status !== 'cancelled' && <Button size="sm" variant="ghost" onClick={() => void setStatus(r, 'cancelled')}>Cancelar</Button>}
                  <Button size="sm" variant="ghost" onClick={() => {
                    if (confirm(`¿Eliminar "${r.name}"? Los movimientos ya registrados se conservan.`)) void softDeleteRecurring(r.id).then(() => qc.invalidateQueries({ queryKey: ['recurring'] })).catch((e) => setErr(toAppError(e).message));
                  }}>Eliminar</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && <p className="p-6 text-center text-sm text-muted">No hay gastos recurrentes.</p>}
      </Card>
      <Card>
        <CardTitle hint="Ocurrencias sin un pago registrado vinculado">Próximos y pendientes</CardTitle>
        <ul className="divide-y divide-line text-sm">
          {upcoming.map((o) => {
            const r = list.find((x) => x.id === o.recurringId)!;
            return (
              <li key={`${o.recurringId}-${o.date}`} className="flex items-center justify-between gap-3 py-2">
                <span>
                  <span className="font-medium">{o.name}</span> · {formatDateEs(o.date)}{o.dateTo !== o.date && `–${formatDateEs(o.dateTo)}`}
                  {o.date < today && <Badge tone="warn">¿pagado?</Badge>}
                </span>
                <span className="flex items-center gap-2"><Money value={o.amount} /><Button size="sm" variant="secondary" onClick={() => setPaying({ r, date: o.date })}>Registrar pago</Button></span>
              </li>
            );
          })}
          {!upcoming.length && <li className="py-3 text-muted">Nada pendiente en este período.</li>}
        </ul>
      </Card>
      <Modal open={form !== null} onClose={() => setForm(null)} title={form?.initial ? 'Editar gasto recurrente' : 'Nuevo gasto recurrente'} wide>
        {form && <RecurringForm initial={form.initial} onDone={() => setForm(null)} />}
      </Modal>
      <Modal open={paying !== null} onClose={() => setPaying(null)} title="Registrar pago">
        {paying && <RegisterPayment r={paying.r} date={paying.date} onDone={() => setPaying(null)} />}
      </Modal>
      <p className="text-xs text-muted">Equivalente mensual: semanal × 52/12, cada 2 semanas × 26/12, bimestral ÷ 2, trimestral ÷ 3, anual ÷ 12. Total del mes: {formatMoney(totalMonthlyRecurring(list))}.</p>
    </div>
  );
}
