import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Card, Field, Input, Notice, Select, ErrorBox } from '@/components/ui';
import { completeOnboarding } from '@/repositories/finance';
import { newUuid } from '@/lib/supabase';
import { parseUserAmount, toDecimalString, formatMoney, percentOf } from '@/domain/money';
import { todayIso } from '@/domain/dates';
import { ACCOUNT_KIND_LABEL, type AccountKind, type PayFrequency, PAY_FREQUENCY_LABEL } from '@/domain/types';
import { toAppError } from '@/lib/errors';
import { useAppState } from '@/state/AppState';

interface DraftAccount {
  clientId: string; name: string; institution: string; kind: AccountKind; openingBalance: string; openingBalanceDate: string;
  creditLimit: string; rate: string; statementDay: string; dueDay: string; alertPct: string; isSalary: boolean;
}
interface DraftRecurring { clientId: string; name: string; amount: string; accountRef: string; type: 'EXPENSE' | 'CARD_PURCHASE'; dayFrom: string; dayTo: string; categorySlug: string }

const today = todayIso();

/** Valores de REFERENCIA del primer usuario (editables). No se guardan saldos inventados: el saldo inicial lo escribe la persona. */
function referenceAccounts(): DraftAccount[] {
  const base = { institution: 'Banreservas', openingBalance: '', openingBalanceDate: today, creditLimit: '', rate: '', statementDay: '', dueDay: '', alertPct: '30', isSalary: false };
  return [
    { ...base, clientId: newUuid(), name: 'Débito Banreservas', kind: 'checking', isSalary: true },
    { ...base, clientId: newUuid(), name: 'Ahorro Visa Banreservas', kind: 'savings' },
    { ...base, clientId: newUuid(), name: 'Crédito Visa Multimonedas Banreservas', kind: 'credit_card', creditLimit: '8,000.00', rate: '60', statementDay: '30', dueDay: '21' },
  ];
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { setMode } = useAppState();
  const [step, setStep] = useState(0);
  const [salary, setSalary] = useState('24,240.00');
  const [frequency, setFrequency] = useState<PayFrequency>('monthly');
  const [payDays, setPayDays] = useState('');
  const [accounts, setAccounts] = useState<DraftAccount[]>(referenceAccounts);
  const [recurring, setRecurring] = useState<DraftRecurring[]>(() => [
    { clientId: newUuid(), name: 'Altice', amount: '1,530.00', accountRef: '0', type: 'EXPENSE', dayFrom: '21', dayTo: '23', categorySlug: 'telecom' },
    { clientId: newUuid(), name: 'Cargo mensual en tarjeta', amount: '1,250.00', accountRef: '2', type: 'CARD_PURCHASE', dayFrom: '', dayTo: '', categorySlug: 'subscriptions' },
  ]);
  const [mode, setModeLocal] = useState<'simple' | 'normal'>('simple');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const upd = (i: number, p: Partial<DraftAccount>) => setAccounts((a) => a.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const updR = (i: number, p: Partial<DraftRecurring>) => setRecurring((a) => a.map((x, j) => (j === i ? { ...x, ...p } : x)));

  function validate(): string | null {
    if (!parseUserAmount(salary) && salary.trim() !== '0') return 'Revisa el importe del sueldo.';
    const days = payDays.split(/[,\s]+/).filter(Boolean).map(Number);
    if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 31)) return 'Los días de cobro deben estar entre 1 y 31.';
    for (const a of accounts) {
      if (!a.name.trim()) return 'Todas las cuentas necesitan nombre.';
      if (a.openingBalance.trim() && parseUserAmount(a.openingBalance) === null && a.openingBalance.trim() !== '0') return `Saldo inicial inválido en ${a.name}.`;
      if (a.kind === 'credit_card') {
        for (const [v, l] of [[a.statementDay, 'corte'], [a.dueDay, 'límite de pago']] as const) {
          if (v && (Number(v) < 1 || Number(v) > 31)) return `Día de ${l} inválido en ${a.name}.`;
        }
      }
    }
    for (const r of recurring) {
      if (!r.name.trim() || !parseUserAmount(r.amount)) return `Revisa el gasto recurrente "${r.name || 'sin nombre'}".`;
      if (!r.dayFrom || Number(r.dayFrom) < 1 || Number(r.dayFrom) > 31) return `Indica el día del mes para "${r.name}".`;
      if (!accounts[Number(r.accountRef)]) return `Selecciona la cuenta de "${r.name}".`;
      if (r.type === 'CARD_PURCHASE' && accounts[Number(r.accountRef)]?.kind !== 'credit_card') return `"${r.name}" es un cargo con tarjeta: asígnalo a una tarjeta de crédito.`;
    }
    return null;
  }

  async function finish() {
    const v = validate();
    if (v) { setError(v); return; }
    setSaving(true);
    setError(null);
    const money = (s: string) => { const c = parseUserAmount(s); return c === null ? '0.00' : toDecimalString(c); };
    const payload = {
      salary_amount: money(salary),
      salary_frequency: frequency,
      salary_pay_days: payDays.split(/[,\s]+/).filter(Boolean).map(Number),
      preferred_mode: mode,
      accounts: accounts.map((a, i) => ({
        client_id: a.clientId, name: a.name.trim(), institution: a.institution.trim() || null, kind: a.kind,
        opening_balance: money(a.openingBalance), opening_balance_date: a.openingBalanceDate, sort_order: i,
        is_salary_account: a.isSalary,
        ...(a.kind === 'credit_card' ? {
          credit_limit: a.creditLimit ? money(a.creditLimit) : null, annual_interest_rate_pct: a.rate ? Number(a.rate) : null,
          statement_day: a.statementDay ? Number(a.statementDay) : null, payment_due_day: a.dueDay ? Number(a.dueDay) : null,
          utilization_alert_pct: Number(a.alertPct || 30),
        } : {}),
      })),
      recurring_expenses: recurring.map((r) => ({
        client_id: r.clientId, name: r.name.trim(), amount: money(r.amount), account_client_id: accounts[Number(r.accountRef)]!.clientId,
        transaction_type: r.type, day_from: Number(r.dayFrom), day_to: r.dayTo ? Number(r.dayTo) : null, category_slug: r.categorySlug || null,
      })),
    };
    try {
      await completeOnboarding(payload);
      setMode(mode);
      await qc.invalidateQueries();
      navigate(mode === 'simple' ? '/simple' : '/dashboard', { replace: true });
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setSaving(false);
    }
  }

  const steps = ['Ingresos', 'Cuentas', 'Gastos fijos', 'Modo'];
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="font-display text-3xl text-brand-900">Configuremos tu cuaderno financiero</h1>
      <p className="mt-1 text-sm text-muted">Los valores precargados son una <strong>referencia</strong> editable. Puedes cambiarlos ahora o después en Configuración.</p>
      <ol className="mt-5 flex gap-2 text-xs">
        {steps.map((s, i) => (
          <li key={s} className={`flex-1 rounded-full py-1.5 text-center ${i === step ? 'bg-brand-700 text-white' : i < step ? 'bg-brand-100 text-brand-800' : 'bg-slate-100 text-muted'}`}>{i + 1}. {s}</li>
        ))}
      </ol>

      <Card className="mt-5">
        {step === 0 && (
          <div className="space-y-4">
            <Notice>El sueldo se guarda como <strong>parámetro de planificación</strong>, no como un movimiento. Cuando cobres, registra la entrada real.</Notice>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Sueldo neto (RD$)" hint={parseUserAmount(salary) ? formatMoney(parseUserAmount(salary)!) : undefined}>
                {(id) => <Input id={id} value={salary} inputMode="decimal" onChange={(e) => setSalary(e.target.value)} />}
              </Field>
              <Field label="Frecuencia">
                {(id) => <Select id={id} value={frequency} onChange={(e) => setFrequency(e.target.value as PayFrequency)}>
                  {Object.entries(PAY_FREQUENCY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </Select>}
              </Field>
              <Field label="Día(s) habitual(es) de cobro" hint="Ej.: 30 o 15, 30">
                {(id) => <Input id={id} value={payDays} onChange={(e) => setPayDays(e.target.value)} placeholder="30" />}
              </Field>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <Notice tone="warn">Escribe el <strong>saldo real</strong> de cada cuenta a la fecha indicada (tu app o estado de cuenta). Si lo dejas vacío se usará 0 y podrás corregirlo con una conciliación.</Notice>
            {accounts.map((a, i) => (
              <div key={a.clientId} className="rounded-lg border border-line p-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Nombre">{(id) => <Input id={id} value={a.name} onChange={(e) => upd(i, { name: e.target.value })} />}</Field>
                  <Field label="Tipo">{(id) => <Select id={id} value={a.kind} onChange={(e) => upd(i, { kind: e.target.value as AccountKind })}>
                    {Object.entries(ACCOUNT_KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
                  <Field label="Institución">{(id) => <Input id={id} value={a.institution} onChange={(e) => upd(i, { institution: e.target.value })} />}</Field>
                  <Field label={a.kind === 'credit_card' ? 'Deuda actual (RD$)' : 'Saldo actual (RD$)'}>
                    {(id) => <Input id={id} value={a.openingBalance} inputMode="decimal" placeholder="0.00" onChange={(e) => upd(i, { openingBalance: e.target.value })} />}
                  </Field>
                  <Field label="Saldo a la fecha">{(id) => <Input id={id} type="date" value={a.openingBalanceDate} onChange={(e) => upd(i, { openingBalanceDate: e.target.value })} />}</Field>
                  {a.kind !== 'credit_card' && (
                    <label className="flex items-center gap-2 self-end pb-2 text-sm">
                      <input type="radio" name="salaryAcc" checked={a.isSalary} onChange={() => setAccounts((all) => all.map((x, j) => ({ ...x, isSalary: j === i })))} />
                      Aquí cobro mi sueldo
                    </label>
                  )}
                </div>
                {a.kind === 'credit_card' && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-5">
                    <Field label="Límite (RD$)">{(id) => <Input id={id} value={a.creditLimit} onChange={(e) => upd(i, { creditLimit: e.target.value })} />}</Field>
                    <Field label="Tasa anual %">{(id) => <Input id={id} value={a.rate} inputMode="decimal" onChange={(e) => upd(i, { rate: e.target.value })} />}</Field>
                    <Field label="Día de corte">{(id) => <Input id={id} value={a.statementDay} inputMode="numeric" onChange={(e) => upd(i, { statementDay: e.target.value })} />}</Field>
                    <Field label="Día límite de pago">{(id) => <Input id={id} value={a.dueDay} inputMode="numeric" onChange={(e) => upd(i, { dueDay: e.target.value })} />}</Field>
                    <Field label="Alerta de uso %" hint={parseUserAmount(a.creditLimit) ? `= ${formatMoney(percentOf(parseUserAmount(a.creditLimit)!, Number(a.alertPct || 30)))}` : undefined}>
                      {(id) => <Input id={id} value={a.alertPct} inputMode="numeric" onChange={(e) => upd(i, { alertPct: e.target.value })} />}
                    </Field>
                  </div>
                )}
                <div className="mt-2 text-right"><Button variant="ghost" size="sm" onClick={() => setAccounts((all) => all.filter((_, j) => j !== i))}>Quitar</Button></div>
              </div>
            ))}
            <Button variant="secondary" onClick={() => setAccounts((a) => [...a, { clientId: newUuid(), name: 'Efectivo', institution: '', kind: 'cash', openingBalance: '', openingBalanceDate: today, creditLimit: '', rate: '', statementDay: '', dueDay: '', alertPct: '30', isSalary: false }])}>
              + Agregar cuenta (efectivo, otro banco…)
            </Button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <p className="text-sm text-muted">Estos gastos se usan para proyectar tu excedente. Podrás pausarlos o cancelarlos cuando quieras.</p>
            {recurring.map((r, i) => (
              <div key={r.clientId} className="grid gap-3 rounded-lg border border-line p-4 sm:grid-cols-6">
                <Field label="Nombre" className="sm:col-span-2">{(id) => <Input id={id} value={r.name} onChange={(e) => updR(i, { name: e.target.value })} />}</Field>
                <Field label="Importe">{(id) => <Input id={id} value={r.amount} onChange={(e) => updR(i, { amount: e.target.value })} />}</Field>
                <Field label="Cuenta" className="sm:col-span-2">{(id) => <Select id={id} value={r.accountRef} onChange={(e) => {
                  const acc = accounts[Number(e.target.value)];
                  updR(i, { accountRef: e.target.value, type: acc?.kind === 'credit_card' ? 'CARD_PURCHASE' : 'EXPENSE' });
                }}>
                  {accounts.map((a, j) => <option key={a.clientId} value={j}>{a.name}</option>)}</Select>}</Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Día desde">{(id) => <Input id={id} value={r.dayFrom} inputMode="numeric" placeholder="1-31" onChange={(e) => updR(i, { dayFrom: e.target.value })} />}</Field>
                  <Field label="hasta">{(id) => <Input id={id} value={r.dayTo} inputMode="numeric" onChange={(e) => updR(i, { dayTo: e.target.value })} />}</Field>
                </div>
                <div className="sm:col-span-6 text-right"><Button variant="ghost" size="sm" onClick={() => setRecurring((all) => all.filter((_, j) => j !== i))}>Quitar</Button></div>
              </div>
            ))}
            <Button variant="secondary" onClick={() => setRecurring((a) => [...a, { clientId: newUuid(), name: '', amount: '', accountRef: '0', type: 'EXPENSE', dayFrom: '', dayTo: '', categorySlug: '' }])}>+ Agregar gasto fijo</Button>
          </div>
        )}

        {step === 3 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {([
              ['simple', 'Modo Simple', 'Como un cuaderno: “entró dinero / salió dinero”. Ideal si no quieres términos contables.'],
              ['normal', 'Modo Normal', 'Dashboard, diario, estado de resultados, tarjeta, conciliación y análisis.'],
            ] as const).map(([k, t, d]) => (
              <button key={k} type="button" onClick={() => setModeLocal(k)}
                className={`rounded-xl border p-4 text-left ${mode === k ? 'border-brand-500 bg-brand-50' : 'border-line'}`}>
                <div className="font-semibold">{t}</div><p className="mt-1 text-sm text-muted">{d}</p>
              </button>
            ))}
            <p className="text-xs text-muted sm:col-span-2">Ambos modos usan exactamente los mismos datos. Puedes cambiar en cualquier momento.</p>
          </div>
        )}
      </Card>

      {error && <div className="mt-4"><ErrorBox error={error} title="Revisa los datos" /></div>}
      <div className="mt-5 flex justify-between">
        <Button variant="secondary" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>Atrás</Button>
        {step < 3 ? <Button onClick={() => setStep((s) => s + 1)}>Continuar</Button> : <Button loading={saving} onClick={() => void finish()}>Terminar configuración</Button>}
      </div>
    </div>
  );
}
