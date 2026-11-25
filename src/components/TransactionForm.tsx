import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Field, Input, Notice, Select, Textarea, ErrorBox } from '@/components/ui';
import { categoryKindForType, useLookups } from '@/hooks/useLookups';
import { useRecurring, useTransactions } from '@/hooks/useFinance';
import { validateTransactionDraft, type ValidationError } from '@/domain/ledger';
import { parseUserAmount, toDecimalString, formatMoney, sum, type Cents } from '@/domain/money';
import { isIsoDate, todayIso, type IsoDate } from '@/domain/dates';
import { TRANSACTION_TYPES, TRANSACTION_TYPE_LABEL, TYPES_REQUIRING_DESTINATION, type Transaction, type TransactionType } from '@/domain/types';
import { enqueueTransaction } from '@/sync/outbox';
import { updateTransaction } from '@/repositories/finance';
import { newUuid } from '@/lib/supabase';
import { toAppError } from '@/lib/errors';

const TYPE_HELP: Record<TransactionType, string> = {
  INCOME: 'Dinero que entra (sueldo, ventas). Aumenta el saldo de la cuenta.',
  EXPENSE: 'Dinero que sale por un consumo o servicio. Reduce el saldo.',
  TRANSFER: 'Mover dinero entre tus cuentas. No es ingreso ni gasto.',
  CARD_PURCHASE: 'Compra con la tarjeta de crédito: aumenta la deuda y cuenta como gasto.',
  CARD_PAYMENT: 'Pago a la tarjeta desde otra cuenta: reduce la deuda. NO es un gasto nuevo.',
  SAVINGS_CONTRIBUTION: 'Pasar dinero a tu cuenta de ahorro. No es un gasto.',
  INVESTMENT: 'Dinero destinado a inversión. No es un gasto.',
  REFUND: 'Devolución de una compra. Vincúlala al movimiento original si puedes.',
  ADJUSTMENT: 'Corrige el saldo cuando no coincide con el banco. Queda identificado y auditado.',
};

export function TransactionForm({ initial, onDone, defaultType = 'EXPENSE' }: {
  initial?: Transaction | null;
  onDone: () => void;
  defaultType?: TransactionType;
}) {
  const qc = useQueryClient();
  const { accounts, categories } = useLookups();
  const recurring = useRecurring();
  const txs = useTransactions();
  const live = accounts.filter((a) => !a.isArchived);
  const [type, setType] = useState<TransactionType>(initial?.type ?? defaultType);
  const [accountId, setAccountId] = useState<string>(initial?.accountId ?? live[0]?.id ?? '');
  const [toAccountId, setToAccountId] = useState<string>(initial?.toAccountId ?? '');
  const [amountText, setAmountText] = useState(initial ? toDecimalString(initial.amount) : '');
  const [date, setDate] = useState<string>(initial?.occurredOn ?? todayIso());
  const [description, setDescription] = useState(initial?.description ?? '');
  const [categoryId, setCategoryId] = useState<string>(initial?.categoryId ?? '');
  const [direction, setDirection] = useState<'increase' | 'decrease'>(initial?.adjustmentDirection ?? 'increase');
  const [relatedId, setRelatedId] = useState<string>(initial?.relatedTransactionId ?? '');
  const [recurringId, setRecurringId] = useState<string>(initial?.recurringExpenseId ?? '');
  const [note, setNote] = useState(initial?.originalNote ?? '');
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [serverError, setServerError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const amount = parseUserAmount(amountText);
  const catKind = categoryKindForType(type);
  const needsDest = TYPES_REQUIRING_DESTINATION.has(type) || type === 'INVESTMENT';
  const refundables = useMemo(
    () => (txs.data ?? []).filter((t) => !t.pendingSync && (t.type === 'EXPENSE' || t.type === 'CARD_PURCHASE') && t.accountId === accountId).slice(0, 100),
    [txs.data, accountId],
  );
  const original = refundables.find((t) => t.id === relatedId) ?? null;
  const alreadyRefunded = sum((txs.data ?? []).filter((t) => t.type === 'REFUND' && t.relatedTransactionId === relatedId && t.id !== initial?.id).map((t) => t.amount));
  const err = (f: string) => errors.find((e) => e.field === f)?.message ?? null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    const draft = {
      type, accountId: accountId || null, toAccountId: needsDest && toAccountId ? toAccountId : null,
      amount, occurredOn: isIsoDate(date) ? (date as IsoDate) : null, description,
      adjustmentDirection: type === 'ADJUSTMENT' ? direction : null, relatedTransactionId: type === 'REFUND' && relatedId ? relatedId : null,
    };
    const v = validateTransactionDraft(draft, accounts, { originalForRefund: original, alreadyRefunded });
    setErrors(v);
    if (v.length) return;
    const acc = accounts.find((a) => a.id === accountId)!;
    const payload: Partial<Transaction> = {
      type, accountId, toAccountId: draft.toAccountId, amount: amount as Cents, currency: acc.currency, occurredOn: draft.occurredOn!,
      description: description.trim(), categoryId: catKind && categoryId ? categoryId : null,
      classificationSource: catKind && categoryId ? 'user' : null, adjustmentDirection: draft.adjustmentDirection,
      relatedTransactionId: draft.relatedTransactionId, recurringExpenseId: recurringId || null, originalNote: note.trim() || null,
    };
    setSaving(true);
    try {
      if (initial && !initial.id.startsWith('pending:')) {
        await updateTransaction(initial.id, payload);
        await qc.invalidateQueries({ queryKey: ['transactions'] });
      } else {
        enqueueTransaction({ ...payload, clientId: initial?.clientId ?? newUuid(), entryMode: 'normal', source: 'manual' });
      }
      onDone();
    } catch (ex) {
      setServerError(toAppError(ex).message);
    } finally {
      setSaving(false);
    }
  }

  if (!live.length) return <Notice tone="warn">Primero crea al menos una cuenta en Configuración.</Notice>;

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field label="Tipo de movimiento" hint={TYPE_HELP[type]}>
        {(id) => (
          <Select id={id} value={type} onChange={(e) => { setType(e.target.value as TransactionType); setCategoryId(''); }}>
            {TRANSACTION_TYPES.map((t) => <option key={t} value={t}>{TRANSACTION_TYPE_LABEL[t]}</option>)}
          </Select>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={needsDest ? 'Cuenta de origen' : 'Cuenta'} error={err('accountId')}>
          {(id) => (
            <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {live.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          )}
        </Field>
        {needsDest && (
          <Field label={type === 'INVESTMENT' ? 'Cuenta destino (opcional)' : 'Cuenta destino'} error={err('toAccountId')}>
            {(id) => (
              <Select id={id} value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>
                <option value="">— Selecciona —</option>
                {live.filter((a) => a.id !== accountId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            )}
          </Field>
        )}
        <Field label="Importe (RD$)" error={err('amount')} hint={amount ? formatMoney(amount) : 'Ej.: 1,530.00'}>
          {(id) => <Input id={id} inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="0.00" autoComplete="off" />}
        </Field>
        <Field label="Fecha" error={err('occurredOn')}>
          {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
        </Field>
      </div>
      <Field label="Descripción" error={err('description')}>
        {(id) => <Input id={id} value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} placeholder="Ej.: Altice internet" />}
      </Field>
      {catKind && (
        <Field label="Categoría">
          {(id) => (
            <Select id={id} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Sin categoría</option>
              {categories.filter((c) => c.kind === catKind).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          )}
        </Field>
      )}
      {type === 'ADJUSTMENT' && (
        <Field label="Dirección del ajuste" error={err('adjustmentDirection')} hint="En tarjetas, «aumentar» significa aumentar la deuda.">
          {(id) => (
            <Select id={id} value={direction} onChange={(e) => setDirection(e.target.value as 'increase' | 'decrease')}>
              <option value="increase">Aumentar saldo</option>
              <option value="decrease">Disminuir saldo</option>
            </Select>
          )}
        </Field>
      )}
      {type === 'REFUND' && (
        <Field label="Movimiento original (recomendado)" error={err('relatedTransactionId')}
          hint={original ? `Original ${formatMoney(original.amount)} · ya devuelto ${formatMoney(alreadyRefunded)}` : undefined}>
          {(id) => (
            <Select id={id} value={relatedId} onChange={(e) => setRelatedId(e.target.value)}>
              <option value="">— Sin vincular —</option>
              {refundables.map((t) => <option key={t.id} value={t.id}>{t.occurredOn} · {t.description} · {formatMoney(t.amount)}</option>)}
            </Select>
          )}
        </Field>
      )}
      {(type === 'EXPENSE' || type === 'CARD_PURCHASE') && (recurring.data ?? []).length > 0 && (
        <Field label="¿Corresponde a un gasto recurrente?" hint="Vincularlo evita que siga apareciendo como pendiente este mes.">
          {(id) => (
            <Select id={id} value={recurringId} onChange={(e) => setRecurringId(e.target.value)}>
              <option value="">No</option>
              {(recurring.data ?? []).filter((r) => r.accountId === accountId).map((r) => <option key={r.id} value={r.id}>{r.name} ({formatMoney(r.amount)})</option>)}
            </Select>
          )}
        </Field>
      )}
      <Field label="Nota (opcional)">
        {(id) => <Textarea id={id} rows={2} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />}
      </Field>
      {initial?.reconciliationStatus === 'reconciled' && (
        <Notice tone="warn">Este movimiento está conciliado. La base de datos impedirá cambiar importe, cuenta, fecha o tipo sin desconciliarlo primero.</Notice>
      )}
      <ErrorBox error={serverError} title="No se pudo guardar" />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>Cancelar</Button>
        <Button type="submit" loading={saving}>{initial ? 'Guardar cambios' : 'Registrar'}</Button>
      </div>
    </form>
  );
}
