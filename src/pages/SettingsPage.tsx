import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardTitle, ErrorBox, Field, Input, Loading, Modal, Money, Notice, PageHeader, Select } from '@/components/ui';
import { useAccounts, useCategories, useIncomeHistory, useIncomeSources, useProfile } from '@/hooks/useFinance';
import { useAuth } from '@/auth/AuthProvider';
import { useAppState } from '@/state/AppState';
import * as repo from '@/repositories/finance';
import { formatMoney, parseUserAmount, percentOf, toDecimalString } from '@/domain/money';
import { formatDateEs, isIsoDate, todayIso, type IsoDate } from '@/domain/dates';
import { ACCOUNT_KINDS, ACCOUNT_KIND_LABEL, PAY_FREQUENCY_LABEL, type Account, type AccountKind, type CategoryKind, type IncomeFrequency, type IncomeSource, type PayFrequency } from '@/domain/types';
import { newUuid } from '@/lib/supabase';
import { toAppError } from '@/lib/errors';
import { notificationsEnabled, setNotificationsEnabled } from '@/integrations/notifications';

function SalarySection() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const profile = useProfile();
  const history = useIncomeHistory();
  const accounts = useAccounts();
  const p = profile.data;
  const [f, setF] = useState({ amount: '', freq: 'monthly' as PayFrequency, days: '', from: todayIso() as string, account: '', name: '', ef: '3' });
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (p) setF({ amount: toDecimalString(p.salaryAmount), freq: p.salaryFrequency, days: p.salaryPayDays.join(', '), from: todayIso(),
      account: p.salaryAccountId ?? '', name: p.displayName ?? '', ef: String(p.emergencyFundMonths) });
  }, [p]);
  if (!p) return <Loading />;
  return (
    <Card>
      <CardTitle hint="Parámetro de planificación: no crea movimientos. Cada cambio queda en el historial.">Sueldo e ingresos</CardTitle>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Nombre a mostrar">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Sueldo neto (RD$)" hint={parseUserAmount(f.amount) ? formatMoney(parseUserAmount(f.amount)!) : undefined}>{(id) => <Input id={id} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />}</Field>
        <Field label="Frecuencia de pago">{(id) => <Select id={id} value={f.freq} onChange={(e) => setF({ ...f, freq: e.target.value as PayFrequency })}>
          {Object.entries(PAY_FREQUENCY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
        <Field label="Día(s) de cobro" hint="Ej.: 15, 30">{(id) => <Input id={id} value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} />}</Field>
        <Field label="Vigente desde">{(id) => <Input id={id} type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />}</Field>
        <Field label="Cuenta donde cobras">{(id) => <Select id={id} value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })}>
          <option value="">—</option>{(accounts.data ?? []).filter((a) => !a.isLiability).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
        <Field label="Meses para fondo de emergencia">{(id) => <Input id={id} inputMode="numeric" value={f.ef} onChange={(e) => setF({ ...f, ef: e.target.value })} />}</Field>
      </div>
      <ErrorBox error={err} />
      {msg && <Notice tone="ok">{msg}</Notice>}
      <div className="mt-3 flex justify-end">
        <Button onClick={async () => {
          setErr(null); setMsg(null);
          const amt = f.amount.trim() === '0' ? parseUserAmount('0.00') ?? (0 as never) : parseUserAmount(f.amount);
          const days = f.days.split(/[,\s]+/).filter(Boolean).map(Number);
          if (amt === null || days.some((d) => !Number.isInteger(d) || d < 1 || d > 31) || !isIsoDate(f.from)) return setErr('Revisa importe, días (1–31) y fecha.');
          try {
            await repo.updateProfile(user!.id, { displayName: f.name.trim() || null, salaryAmount: amt, salaryFrequency: f.freq, salaryPayDays: days,
              salaryEffectiveFrom: f.from as IsoDate, salaryAccountId: f.account || null, emergencyFundMonths: Math.min(24, Math.max(1, Number(f.ef) || 3)) });
            await qc.invalidateQueries({ queryKey: ['profile'] });
            await qc.invalidateQueries({ queryKey: ['incomeHistory'] });
            setMsg('Guardado. Las proyecciones ya usan el nuevo valor.');
          } catch (e) { setErr(toAppError(e).message); }
        }}>Guardar</Button>
      </div>
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer font-medium">Historial de cambios del sueldo</summary>
        <ul className="mt-2 divide-y divide-line">
          {(history.data ?? []).map((h) => (
            <li key={h.id} className="flex justify-between py-1.5 text-xs">
              <span>{new Date(h.changedAt).toLocaleString('es-DO')} · vigente {h.effectiveFrom ? formatDateEs(h.effectiveFrom) : '—'}</span>
              <span>{h.oldAmount !== null ? `${formatMoney(h.oldAmount)} → ` : ''}<strong>{formatMoney(h.newAmount)}</strong> ({PAY_FREQUENCY_LABEL[h.newFrequency as PayFrequency] ?? h.newFrequency})</span>
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

function IncomeSourcesSection() {
  const qc = useQueryClient();
  const list = useIncomeSources();
  const [edit, setEdit] = useState<Partial<IncomeSource> | null>(null);
  const [amount, setAmount] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const FREQ: Record<IncomeFrequency, string> = { one_time: 'Una vez', weekly: 'Semanal', biweekly: 'Cada 2 semanas', semimonthly: 'Quincenal', monthly: 'Mensual', yearly: 'Anual' };
  return (
    <Card>
      <CardTitle hint="Ingresos adicionales previstos (para proyecciones)" action={<Button size="sm" variant="secondary" onClick={() => { setEdit({ frequency: 'monthly', isActive: true, startDate: todayIso() }); setAmount(''); }}>+ Agregar</Button>}>Ingresos adicionales</CardTitle>
      <ul className="divide-y divide-line text-sm">
        {(list.data ?? []).map((i) => (
          <li key={i.id} className="flex items-center justify-between py-2">
            <span>{i.name} <span className="text-xs text-muted">· {FREQ[i.frequency]}</span> {!i.isActive && <Badge>inactivo</Badge>}</span>
            <span className="flex items-center gap-2"><Money value={i.amount} />
              <Button size="sm" variant="ghost" onClick={() => { setEdit(i); setAmount(toDecimalString(i.amount)); }}>Editar</Button>
              <Button size="sm" variant="ghost" onClick={() => void repo.softDeleteIncomeSource(i.id).then(() => qc.invalidateQueries({ queryKey: ['incomeSources'] }))}>Eliminar</Button></span>
          </li>
        ))}
        {!(list.data ?? []).length && <li className="py-2 text-muted">Ninguno.</li>}
      </ul>
      <Modal open={edit !== null} onClose={() => setEdit(null)} title="Ingreso adicional">
        {edit && (
          <div className="space-y-3">
            <Field label="Nombre">{(id) => <Input id={id} value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Importe">{(id) => <Input id={id} value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
              <Field label="Frecuencia">{(id) => <Select id={id} value={edit.frequency} onChange={(e) => setEdit({ ...edit, frequency: e.target.value as IncomeFrequency })}>
                {Object.entries(FREQ).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.isActive ?? true} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} /> Activo</label>
            <ErrorBox error={err} />
            <div className="flex justify-end"><Button onClick={async () => {
              const a = parseUserAmount(amount);
              if (!edit.name?.trim() || !a) return setErr('Nombre e importe son obligatorios.');
              try {
                await repo.saveIncomeSource({ ...edit, clientId: edit.clientId ?? newUuid(), name: edit.name.trim(), amount: a });
                await qc.invalidateQueries({ queryKey: ['incomeSources'] });
                setEdit(null); setErr(null);
              } catch (e) { setErr(toAppError(e).message); }
            }}>Guardar</Button></div>
          </div>
        )}
      </Modal>
    </Card>
  );
}

function AccountForm({ initial, onDone }: { initial?: Account; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: initial?.name ?? '', institution: initial?.institution ?? '', kind: (initial?.kind ?? 'checking') as AccountKind, currency: initial?.currency ?? 'DOP',
    opening: initial ? toDecimalString(initial.openingBalance) : '', openingDate: initial?.openingBalanceDate ?? todayIso(),
    limit: initial?.creditLimit != null ? toDecimalString(initial.creditLimit) : '', rate: initial?.annualInterestRatePct?.toString() ?? '',
    sday: initial?.statementDay?.toString() ?? '', dday: initial?.paymentDueDay?.toString() ?? '', alert: initial?.utilizationAlertPct?.toString() ?? '30',
    last4: initial?.last4 ?? '', archived: initial?.isArchived ?? false,
  });
  const [err, setErr] = useState<string | null>(null);
  const card = f.kind === 'credit_card';
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const limitC = parseUserAmount(f.limit);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nombre">{(id) => <Input id={id} value={f.name} onChange={set('name')} />}</Field>
        <Field label="Institución">{(id) => <Input id={id} value={f.institution} onChange={set('institution')} />}</Field>
        <Field label="Tipo">{(id) => <Select id={id} value={f.kind} disabled={Boolean(initial)} onChange={set('kind')}>{ACCOUNT_KINDS.map((k) => <option key={k} value={k}>{ACCOUNT_KIND_LABEL[k]}</option>)}</Select>}</Field>
        <Field label="Moneda" hint="Una cuenta por moneda (p. ej. tarjeta multimoneda: crea una cuenta USD aparte).">{(id) => <Select id={id} value={f.currency} disabled={Boolean(initial)} onChange={set('currency')}><option>DOP</option><option>USD</option><option>EUR</option></Select>}</Field>
        <Field label={card ? 'Deuda inicial' : 'Saldo inicial'} hint="Cambiarlo recalcula el saldo actual.">{(id) => <Input id={id} value={f.opening} inputMode="decimal" onChange={set('opening')} />}</Field>
        <Field label="Saldo a la fecha" hint="Solo cuentan movimientos desde esta fecha.">{(id) => <Input id={id} type="date" value={f.openingDate} onChange={set('openingDate')} />}</Field>
        <Field label="Últimos 4 dígitos (opcional)">{(id) => <Input id={id} value={f.last4} maxLength={4} inputMode="numeric" onChange={set('last4')} />}</Field>
      </div>
      {card && (
        <div className="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-3">
          <Field label="Límite de crédito">{(id) => <Input id={id} value={f.limit} inputMode="decimal" onChange={set('limit')} />}</Field>
          <Field label="Tasa anual (%)">{(id) => <Input id={id} value={f.rate} inputMode="decimal" onChange={set('rate')} />}</Field>
          <Field label="Alerta de utilización (%)" hint={limitC ? `= ${formatMoney(percentOf(limitC, Number(f.alert) || 30))}` : undefined}>{(id) => <Input id={id} value={f.alert} inputMode="decimal" onChange={set('alert')} />}</Field>
          <Field label="Día de corte (referencia)">{(id) => <Input id={id} value={f.sday} inputMode="numeric" onChange={set('sday')} />}</Field>
          <Field label="Día límite de pago (referencia)">{(id) => <Input id={id} value={f.dday} inputMode="numeric" onChange={set('dday')} />}</Field>
          <p className="self-end text-xs text-muted">Si el estado de cuenta indica otras fechas, regístralo en Tarjeta: las fechas reales prevalecen.</p>
        </div>
      )}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.archived} onChange={(e) => setF({ ...f, archived: e.target.checked })} /> Archivada (oculta en formularios)</label>
      <ErrorBox error={err} />
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onDone}>Cancelar</Button><Button onClick={async () => {
        const opening = f.opening.trim() === '' || f.opening.trim() === '0' ? parseUserAmount('0.00') ?? (0 as never) : parseUserAmount(f.opening);
        const dayOk = (d: string) => !d || (Number(d) >= 1 && Number(d) <= 31);
        if (!f.name.trim() || opening === null || !isIsoDate(f.openingDate)) return setErr('Revisa nombre, saldo inicial y fecha.');
        if (card && (!dayOk(f.sday) || !dayOk(f.dday))) return setErr('Los días deben estar entre 1 y 31.');
        if (f.last4 && !/^\d{4}$/.test(f.last4)) return setErr('Últimos 4 dígitos inválidos.');
        try {
          await repo.saveAccount({
            id: initial?.id, clientId: initial?.clientId ?? newUuid(), name: f.name, institution: f.institution.trim() || null, kind: f.kind, currency: f.currency,
            openingBalance: opening, openingBalanceDate: f.openingDate as IsoDate, isArchived: f.archived, last4: f.last4 || null,
            ...(card ? { creditLimit: limitC, annualInterestRatePct: f.rate ? Number(f.rate) : null, statementDay: f.sday ? Number(f.sday) : null,
              paymentDueDay: f.dday ? Number(f.dday) : null, utilizationAlertPct: Number(f.alert) || 30 } : {}),
          });
          await qc.invalidateQueries({ queryKey: ['accounts'] });
          onDone();
        } catch (e) { setErr(toAppError(e).message); }
      }}>Guardar</Button></div>
    </div>
  );
}

function AccountsSection() {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const [edit, setEdit] = useState<{ initial?: Account } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card>
      <CardTitle action={<Button size="sm" variant="secondary" onClick={() => setEdit({})}>+ Agregar cuenta</Button>}>Cuentas y productos</CardTitle>
      <ErrorBox error={err} />
      <ul className="divide-y divide-line text-sm">
        {(accounts.data ?? []).map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>{a.name} <span className="text-xs text-muted">· {ACCOUNT_KIND_LABEL[a.kind]} · {a.currency}{a.institution ? ` · ${a.institution}` : ''}</span> {a.isArchived && <Badge>archivada</Badge>}</span>
            <span>
              <Button size="sm" variant="ghost" onClick={() => setEdit({ initial: a })}>Editar</Button>
              <Button size="sm" variant="ghost" onClick={() => {
                if (confirm(`¿Eliminar "${a.name}"? Sus movimientos se conservan en el historial pero la cuenta dejará de mostrarse.`))
                  void repo.softDeleteAccount(a.id).then(() => qc.invalidateQueries({ queryKey: ['accounts'] })).catch((e) => setErr(toAppError(e).message));
              }}>Eliminar</Button>
            </span>
          </li>
        ))}
      </ul>
      <Modal open={edit !== null} onClose={() => setEdit(null)} title={edit?.initial ? 'Editar cuenta' : 'Nueva cuenta'} wide>
        {edit && <AccountForm initial={edit.initial} onDone={() => setEdit(null)} />}
      </Modal>
    </Card>
  );
}

function CategoriesSection() {
  const qc = useQueryClient();
  const cats = useCategories();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CategoryKind>('expense');
  const [err, setErr] = useState<string | null>(null);
  const LABEL: Record<CategoryKind, string> = { income: 'Ingreso', expense: 'Gasto', savings: 'Ahorro' };
  return (
    <Card>
      <CardTitle>Categorías</CardTitle>
      <div className="mb-3 flex flex-wrap gap-2">
        <Input placeholder="Nueva categoría" value={name} onChange={(e) => setName(e.target.value)} className="w-48" />
        <Select value={kind} onChange={(e) => setKind(e.target.value as CategoryKind)} className="w-36">{Object.entries(LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        <Button variant="secondary" onClick={async () => {
          if (!name.trim()) return;
          try { await repo.saveCategory({ clientId: newUuid(), name: name.trim(), kind }); setName(''); setErr(null); await qc.invalidateQueries({ queryKey: ['categories'] }); }
          catch (e) { setErr(toAppError(e).message); }
        }}>Agregar</Button>
      </div>
      <ErrorBox error={err} />
      <div className="grid gap-x-6 sm:grid-cols-3">
        {(['income', 'expense', 'savings'] as const).map((k) => (
          <div key={k}>
            <h3 className="mb-1 text-xs font-semibold uppercase text-muted">{LABEL[k]}</h3>
            <ul className="text-sm">
              {(cats.data ?? []).filter((c) => c.kind === k).map((c) => (
                <li key={c.id} className="group flex justify-between py-0.5">{c.name}
                  <button className="text-xs text-muted opacity-0 group-hover:opacity-100 hover:text-red-700" onClick={() => {
                    if (confirm(`¿Eliminar la categoría "${c.name}"? Los movimientos existentes la conservan.`)) void repo.softDeleteCategory(c.id).then(() => qc.invalidateQueries({ queryKey: ['categories'] }));
                  }}>eliminar</button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

function PreferencesSection() {
  const { mode, setMode } = useAppState();
  const { signOut, user } = useAuth();
  const [notif, setNotif] = useState(notificationsEnabled());
  const supported = typeof Notification !== 'undefined';
  return (
    <Card>
      <CardTitle>Preferencias</CardTitle>
      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between gap-3"><span>Modo de la aplicación</span>
          <Select value={mode} onChange={(e) => setMode(e.target.value as 'simple' | 'normal')} className="w-40"><option value="simple">Simple</option><option value="normal">Normal</option></Select></div>
        <div className="flex items-center justify-between gap-3">
          <span>Notificaciones del navegador para recordatorios<br /><span className="text-xs text-muted">Solo mientras la app esté abierta. Las notificaciones push con la app cerrada llegarán con Android.</span></span>
          <Button size="sm" variant="secondary" disabled={!supported} onClick={async () => setNotif(await setNotificationsEnabled(!notif))}>{!supported ? 'No soportado' : notif ? 'Desactivar' : 'Activar'}</Button>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-line pt-3"><span className="text-muted">{user?.email}</span><Button size="sm" variant="secondary" onClick={() => void signOut()}>Cerrar sesión</Button></div>
      </div>
    </Card>
  );
}

export function SettingsPage() {
  return (
    <div className="space-y-5">
      <PageHeader title="Configuración financiera" actions={<Link to="/bancos" className="text-sm font-medium text-brand-700 underline-offset-2 hover:underline">Conexiones bancarias →</Link>} />
      <SalarySection />
      <AccountsSection />
      <IncomeSourcesSection />
      <CategoriesSection />
      <PreferencesSection />
    </div>
  );
}
