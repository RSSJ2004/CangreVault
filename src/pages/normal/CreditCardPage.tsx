import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardTitle, ErrorBox, Field, Input, Loading, Modal, Money, Notice, PageHeader, ProgressBar, Select, Stat } from '@/components/ui';
import { useCycles, useFinancialSnapshot } from '@/hooks/useFinance';
import { saveCycle, softDeleteCycle } from '@/repositories/finance';
import { formatDateEs, isIsoDate, type IsoDate } from '@/domain/dates';
import { formatMoney, parseUserAmount, toDecimalString, ZERO, type Cents } from '@/domain/money';
import { payoffMonths } from '@/domain/creditCard';
import type { Account, CreditCardCycle } from '@/domain/types';
import { newUuid } from '@/lib/supabase';
import { toAppError } from '@/lib/errors';

function CycleForm({ card, initial, onDone }: { card: Account; initial?: CreditCardCycle; onDone: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({
    periodStart: initial?.periodStart ?? '', statementDate: initial?.statementDate ?? '', dueDate: initial?.dueDate ?? '',
    statementBalance: initial ? toDecimalString(initial.statementBalance) : '', minimumPayment: initial ? toDecimalString(initial.minimumPayment) : '',
    fullPayment: initial ? toDecimalString(initial.fullPayment) : '', interest: initial?.interestCharged ? toDecimalString(initial.interestCharged) : '',
    rate: initial?.annualRatePct?.toString() ?? card.annualInterestRatePct?.toString() ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const amt = (s: string, req: boolean) => { const c = s.trim() === '0' ? (0 as Cents) : parseUserAmount(s); if (req && c === null) throw new Error('Revisa los importes'); return c; };
    try {
      if (![v.periodStart, v.statementDate, v.dueDate].every(isIsoDate)) throw new Error('Completa las tres fechas.');
      if (v.dueDate <= v.statementDate) throw new Error('La fecha límite debe ser posterior al corte.');
      if (v.periodStart > v.statementDate) throw new Error('El inicio del período debe ser anterior al corte.');
      setSaving(true);
      await saveCycle({
        id: initial?.id, clientId: initial?.clientId ?? newUuid(), accountId: card.id, periodStart: v.periodStart as IsoDate,
        statementDate: v.statementDate as IsoDate, dueDate: v.dueDate as IsoDate, statementBalance: amt(v.statementBalance, true)!,
        minimumPayment: amt(v.minimumPayment, true)!, fullPayment: amt(v.fullPayment, true)!, interestCharged: amt(v.interest, false),
        annualRatePct: v.rate ? Number(v.rate) : null, source: initial?.source ?? 'manual',
      });
      await qc.invalidateQueries({ queryKey: ['cycles'] });
      onDone();
    } catch (ex) {
      setError(toAppError(ex).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Notice>Copia los datos tal como aparecen en tu estado de cuenta. Las fechas pueden cambiar cada mes.</Notice>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Inicio del período">{(id) => <Input id={id} type="date" value={v.periodStart} onChange={set('periodStart')} />}</Field>
        <Field label="Fecha de corte">{(id) => <Input id={id} type="date" value={v.statementDate} onChange={set('statementDate')} />}</Field>
        <Field label="Fecha límite de pago">{(id) => <Input id={id} type="date" value={v.dueDate} onChange={set('dueDate')} />}</Field>
        <Field label="Saldo al corte (deuda total)">{(id) => <Input id={id} inputMode="decimal" value={v.statementBalance} onChange={set('statementBalance')} placeholder="p. ej. 6,462.61" />}</Field>
        <Field label="Pago mínimo">{(id) => <Input id={id} inputMode="decimal" value={v.minimumPayment} onChange={set('minimumPayment')} placeholder="p. ej. 250.00" />}</Field>
        <Field label="Pago de contado">{(id) => <Input id={id} inputMode="decimal" value={v.fullPayment} onChange={set('fullPayment')} placeholder="p. ej. 6,462.61" />}</Field>
        <Field label="Intereses cobrados (opcional)">{(id) => <Input id={id} inputMode="decimal" value={v.interest} onChange={set('interest')} />}</Field>
        <Field label="Tasa anual % del estado">{(id) => <Input id={id} inputMode="decimal" value={v.rate} onChange={set('rate')} />}</Field>
      </div>
      <ErrorBox error={error} title="No se pudo guardar" />
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onDone}>Cancelar</Button><Button type="submit" loading={saving}>Guardar ciclo</Button></div>
    </form>
  );
}

export function CreditCardPage() {
  const { snapshot: s, loading } = useFinancialSnapshot();
  const cycles = useCycles();
  const qc = useQueryClient();
  const [cardId, setCardId] = useState<string>('');
  const [form, setForm] = useState<{ initial?: CreditCardCycle } | null>(null);
  const [payment, setPayment] = useState('1,000');
  if (loading) return <Loading />;
  if (!s.cards.length) return <><PageHeader title="Tarjeta de crédito" /><Notice>No tienes tarjetas de crédito configuradas. Agrégala en Configuración → Cuentas.</Notice></>;
  const entry = s.cards.find((c) => c.account.id === cardId) ?? s.cards[0]!;
  const { account: card, summary } = entry;
  const u = summary.utilization;
  const last = summary.lastStatement;
  const cardCycles = (cycles.data ?? []).filter((c) => c.accountId === card.id).sort((a, b) => (a.statementDate < b.statementDate ? 1 : -1));
  const debt = s.balances.get(card.id)?.balance ?? ZERO;
  const payCents = parseUserAmount(payment);
  const months = payCents && card.annualInterestRatePct !== null && debt > 0 ? payoffMonths(debt, card.annualInterestRatePct, payCents) : null;

  return (
    <div className="space-y-5">
      <PageHeader title="Tarjeta de crédito" subtitle={card.institution ?? undefined}
        actions={<>
          {s.cards.length > 1 && <Select value={card.id} onChange={(e) => setCardId(e.target.value)} className="w-auto">{s.cards.map((c) => <option key={c.account.id} value={c.account.id}>{c.account.name}</option>)}</Select>}
          <Button onClick={() => setForm({})}>+ Registrar estado de cuenta</Button>
        </>} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Deuda actual" value={<Money value={debt} />} tone={debt > 0 ? 'neg' : undefined} hint="Calculada con tus movimientos" />
        <Stat label="Límite de crédito" value={u ? <Money value={u.limit} /> : '—'} />
        <Stat label="Crédito disponible" value={u ? <Money value={u.available} /> : '—'} hint="No es dinero tuyo: no suma al patrimonio" />
        <Stat label="Utilización" value={u ? `${u.utilizationPct}%` : '—'} tone={u?.alertTriggered ? 'warn' : undefined} hint={u ? `Alerta al ${u.alertPct}% (${formatMoney(u.alertAmount)})` : undefined} />
      </div>
      {u && (
        <Card>
          <ProgressBar pct={u.utilizationPct} tone={u.overLimit ? 'neg' : u.alertTriggered ? 'warn' : 'brand'} marker={u.alertPct} />
          <p className="mt-2 text-xs text-muted">
            La marca indica tu alerta configurable ({u.alertPct}% de {formatMoney(u.limit)} = {formatMoney(u.alertAmount)}).
            Mantener la utilización baja es una referencia orientativa; ningún porcentaje garantiza un resultado en tu historial crediticio.
          </p>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle hint={last ? `Fuente: ${last.source === 'pdf_import' ? 'PDF importado' : 'registrado manualmente'}` : 'Sin estado registrado: fechas estimadas con tu configuración'}>Último estado de cuenta</CardTitle>
          {last ? (
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-muted">Período</dt><dd>{formatDateEs(last.periodStart)} – {formatDateEs(last.statementDate)}</dd>
              <dt className="text-muted">Fecha de corte</dt><dd>{formatDateEs(last.statementDate)} <span className="text-xs text-muted">(cierre del ciclo)</span></dd>
              <dt className="text-muted">Fecha límite de pago</dt><dd className="font-medium">{formatDateEs(last.dueDate)}</dd>
              <dt className="text-muted">Deuda total al corte</dt><dd><Money value={last.statementBalance} /></dd>
              <dt className="text-muted">Pago mínimo</dt><dd><Money value={last.minimumPayment} /></dd>
              <dt className="text-muted">Pago de contado</dt><dd><Money value={last.fullPayment} /></dd>
              <dt className="text-muted">Pagos desde el corte</dt><dd><Money value={summary.paymentsSinceStatement} tone="pos" /></dd>
              <dt className="text-muted">Pendiente para contado</dt><dd className="font-semibold"><Money value={summary.pendingForFullPayment ?? ZERO} /></dd>
              <dt className="text-muted">Pendiente para mínimo</dt><dd><Money value={summary.pendingForMinimumPayment ?? ZERO} /></dd>
            </dl>
          ) : (
            <Notice tone="warn">Registra el estado de cuenta para conocer el pago mínimo y de contado reales. No los estimamos para evitar errores.</Notice>
          )}
          {summary.daysToDue !== null && summary.dueDate && (
            <p className="mt-3 text-sm">Faltan <strong>{summary.daysToDue}</strong> día(s) para la fecha límite ({formatDateEs(summary.dueDate)}){summary.dueDateEstimated && <Badge>estimada</Badge>}.</p>
          )}
        </Card>
        <Card>
          <CardTitle hint={summary.openCycle?.fromStatement ? undefined : 'Fechas estimadas con los días configurados; confírmalas en tu estado de cuenta'}>Ciclo actual (después del corte)</CardTitle>
          {summary.openCycle && (
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-muted">Desde</dt><dd>{formatDateEs(summary.openCycle.periodStart)}</dd>
              <dt className="text-muted">Próximo corte</dt><dd>{formatDateEs(summary.openCycle.statementDate)}</dd>
              <dt className="text-muted">Su fecha límite</dt><dd>{summary.openCycle.dueDate ? formatDateEs(summary.openCycle.dueDate) : '—'}</dd>
              <dt className="text-muted">Consumos posteriores al corte</dt><dd><Money value={summary.purchasesSinceStatement} tone="neg" /></dd>
            </dl>
          )}
          {summary.estimatedMonthlyInterest !== null && (
            <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              <p>Si esta deuda se financia, el interés aproximado de un mes sería <strong>{formatMoney(summary.estimatedMonthlyInterest)}</strong> (tasa anual {card.annualInterestRatePct}% ÷ 12).</p>
              <p className="mt-1 text-xs">Estimación referencial: el banco calcula con saldos diarios y las condiciones de tu contrato.</p>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-xs">Pagando</span>
                <Input value={payment} onChange={(e) => setPayment(e.target.value)} className="w-28 py-1" inputMode="decimal" />
                <span className="text-xs">al mes: {months === null ? 'el pago no cubre los intereses, la deuda no baja' : `≈ ${months} mes(es) para saldarla`}</span>
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card>
        <CardTitle>Historial de ciclos</CardTitle>
        {cardCycles.length === 0 ? <p className="text-sm text-muted">Sin ciclos registrados.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs text-muted"><tr><th className="py-1">Corte</th><th>Límite</th><th className="text-right">Saldo</th><th className="text-right">Mínimo</th><th className="text-right">Contado</th><th></th></tr></thead>
              <tbody className="divide-y divide-line">
                {cardCycles.map((c) => (
                  <tr key={c.id}>
                    <td className="py-2">{formatDateEs(c.statementDate)}</td><td>{formatDateEs(c.dueDate)}</td>
                    <td className="text-right"><Money value={c.statementBalance} /></td><td className="text-right"><Money value={c.minimumPayment} /></td>
                    <td className="text-right"><Money value={c.fullPayment} /></td>
                    <td className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => setForm({ initial: c })}>Editar</Button>
                      <Button size="sm" variant="ghost" onClick={() => { if (confirm('¿Eliminar este ciclo?')) void softDeleteCycle(c.id).then(() => qc.invalidateQueries({ queryKey: ['cycles'] })); }}>Eliminar</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted">
          Fecha de corte: cierre del ciclo. Fecha límite: último día para pagar según el emisor. Los consumos posteriores al corte aparecerán en el próximo estado.
          Configura el límite, la tasa y los días de referencia en Configuración → Cuentas.
        </p>
      </Card>

      <Modal open={form !== null} onClose={() => setForm(null)} title="Estado de cuenta de la tarjeta" wide>
        {form && <CycleForm card={card} initial={form.initial} onDone={() => setForm(null)} />}
      </Modal>
    </div>
  );
}
