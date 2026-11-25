import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Field, Input, Notice, Select, Textarea, cx } from '@/components/ui';
import { useLookups } from '@/hooks/useLookups';
import { parseSimpleEntry } from '@/domain/naturalLanguage';
import { parseUserAmount, formatMoney, toDecimalString, type Cents } from '@/domain/money';
import { isIsoDate, todayIso, type IsoDate } from '@/domain/dates';
import { validateTransactionDraft } from '@/domain/ledger';
import type { Transaction, TransactionType } from '@/domain/types';
import { enqueueTransaction } from '@/sync/outbox';
import { newUuid } from '@/lib/supabase';
import { createWebSpeechInput } from '@/integrations/speech';

type SimpleKind = 'income' | 'expense' | 'card_payment' | 'savings' | 'transfer';
const KIND_TYPE: Record<SimpleKind, TransactionType> = {
  income: 'INCOME', expense: 'EXPENSE', card_payment: 'CARD_PAYMENT', savings: 'SAVINGS_CONTRIBUTION', transfer: 'TRANSFER',
};
const OUT_KINDS: { k: SimpleKind; label: string }[] = [
  { k: 'expense', label: 'Gasté / pagué algo' },
  { k: 'card_payment', label: 'Pagué la tarjeta' },
  { k: 'savings', label: 'Pasé al ahorro' },
  { k: 'transfer', label: 'Pasé a otra cuenta' },
];

const EXAMPLES = {
  in: ['Recibí 24,240 de mi trabajo', 'Me pagaron 2,000 de una venta'],
  out: ['Pagué 850 de luz', 'Compré comida por 1,500', 'Pasé 1,200 al ahorro', 'Pagué la tarjeta 2,000'],
};

export function SimpleEntry({ direction, onDone }: { direction: 'in' | 'out'; onDone: (msg: string) => void }) {
  const { accounts, categories, categoryBySlug } = useLookups();
  const live = accounts.filter((a) => !a.isArchived);
  const today = todayIso();
  const [note, setNote] = useState('');
  const [kind, setKind] = useState<SimpleKind>(direction === 'in' ? 'income' : 'expense');
  const [amountText, setAmountText] = useState('');
  const [accountId, setAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [date, setDate] = useState<string>(today);
  const [categoryId, setCategoryId] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [listening, setListening] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const speech = useMemo(() => createWebSpeechInput(), []);

  const parsed = useMemo(
    () => parseSimpleEntry(note, live, today, { forcedDirection: direction }),
    [note, live, today, direction],
  );

  // Rellena los campos con la interpretación mientras la persona no los haya editado.
  useEffect(() => {
    if (!note.trim()) return;
    if (!touched.kind && parsed.intent) {
      const map: Record<string, SimpleKind> = { income: 'income', expense: 'expense', card_purchase: 'expense', card_payment: 'card_payment', savings_transfer: 'savings', transfer: 'transfer' };
      const k = map[parsed.intent];
      if (k && (direction === 'in') === (k === 'income')) setKind(k);
    }
    if (!touched.amount) setAmountText(parsed.amount ? toDecimalString(parsed.amount) : '');
    if (!touched.account && parsed.accountId) setAccountId(parsed.accountId);
    if (!touched.toAccount && parsed.toAccountId) setToAccountId(parsed.toAccountId);
    if (!touched.date) setDate(parsed.occurredOn);
    if (!touched.category) setCategoryId(categoryBySlug(parsed.categorySlug)?.id ?? '');
  }, [parsed, note, touched, categoryBySlug, direction]);

  useEffect(() => {
    if (!accountId && live[0]) setAccountId((live.find((a) => a.kind === 'checking') ?? live[0]).id);
  }, [accountId, live]);

  const type: TransactionType = (() => {
    const base = KIND_TYPE[kind];
    const acc = live.find((a) => a.id === accountId);
    if (base === 'EXPENSE' && acc?.kind === 'credit_card') return 'CARD_PURCHASE';
    return base;
  })();
  const needsDest = type === 'CARD_PAYMENT' || type === 'SAVINGS_CONTRIBUTION' || type === 'TRANSFER';
  const destOptions = live.filter((a) => a.id !== accountId && (
    type === 'CARD_PAYMENT' ? a.kind === 'credit_card' : type === 'SAVINGS_CONTRIBUTION' ? a.kind === 'savings' || a.kind === 'investment' : true));
  const sourceOptions = live.filter((a) => (type === 'CARD_PAYMENT' || kind === 'income' || needsDest ? a.kind !== 'credit_card' : true));
  const amount = parseUserAmount(amountText);
  const catKind = type === 'INCOME' ? 'income' : type === 'EXPENSE' || type === 'CARD_PURCHASE' ? 'expense' : type === 'SAVINGS_CONTRIBUTION' ? 'savings' : null;

  function toggleVoice() {
    if (listening) {
      stopRef.current?.();
      setListening(false);
      return;
    }
    setListening(true);
    stopRef.current = speech.start(
      (text, final) => { setNote(text); if (final) setListening(false); },
      (msg) => { setErrors([msg]); setListening(false); },
    );
  }

  function save() {
    const draft = {
      type, accountId: accountId || null, toAccountId: needsDest ? toAccountId || null : null, amount,
      occurredOn: isIsoDate(date) ? (date as IsoDate) : null,
      description: note.trim() ? parsed.description : kind === 'income' ? 'Entrada de dinero' : 'Salida de dinero',
    };
    const v = validateTransactionDraft(draft, live);
    if (v.length) {
      setErrors(v.map((e) => e.message));
      return;
    }
    const acc = live.find((a) => a.id === accountId)!;
    const fromRules = !touched.category && categoryId !== '' && parsed.categorySlug !== null;
    const payload: Partial<Transaction> & { clientId: string } = {
      clientId: newUuid(), type, accountId, toAccountId: draft.toAccountId, amount: amount as Cents, currency: acc.currency,
      occurredOn: draft.occurredOn!, description: draft.description.slice(0, 300), originalNote: note.trim() || null,
      categoryId: catKind && categoryId ? categoryId : null,
      classificationSource: catKind && categoryId ? (fromRules ? 'rules' : 'user') : null,
      entryMode: 'simple', source: 'manual',
      // El registro se guarda primero; la IA solo propone clasificación después.
      aiStatus: note.trim() ? 'pending' : 'none',
    };
    enqueueTransaction(payload, { requestAi: Boolean(note.trim()) });
    onDone(`${kind === 'income' ? 'Entrada' : 'Salida'} de ${formatMoney(amount!)} guardada.`);
  }

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="simple-note" className="text-sm font-medium">Escríbelo como lo dirías</label>
        <div className="mt-1.5 flex gap-2">
          <Textarea id="simple-note" rows={2} autoFocus value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={EXAMPLES[direction][0]} className="text-base" />
          {speech.supported && (
            <button type="button" onClick={toggleVoice} aria-pressed={listening}
              className={cx('shrink-0 rounded-lg border px-3 text-lg', listening ? 'border-red-300 bg-red-50 text-red-700' : 'border-line bg-white')}
              title="Dictar por voz">{listening ? '■' : '🎤'}</button>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {EXAMPLES[direction].map((ex) => (
            <button key={ex} type="button" onClick={() => { setNote(ex); setTouched({}); }} className="rounded-full bg-brand-50 px-2.5 py-1 text-xs text-brand-800 hover:bg-brand-100">{ex}</button>
          ))}
        </div>
        {note.trim() && parsed.amountCandidates.length > 1 && !touched.amount && (
          <p className="mt-2 text-xs text-amber-800">Encontré varios números; usé {formatMoney(parsed.amountCandidates[0]!)}. Corrígelo si no es el importe.</p>
        )}
      </div>

      {direction === 'out' && (
        <div className="grid grid-cols-2 gap-2">
          {OUT_KINDS.map((o) => (
            <button key={o.k} type="button" onClick={() => { setKind(o.k); setTouched((t) => ({ ...t, kind: true })); }}
              className={cx('rounded-lg border px-3 py-2 text-left text-sm', kind === o.k ? 'border-brand-500 bg-brand-50 font-medium text-brand-800' : 'border-line bg-white')}>
              {o.label}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="¿Cuánto? (RD$)">
          {(id) => <Input id={id} inputMode="decimal" value={amountText} className="text-lg font-semibold"
            onChange={(e) => { setAmountText(e.target.value); setTouched((t) => ({ ...t, amount: true })); }} placeholder="0.00" />}
        </Field>
        <Field label="¿Cuándo?">
          {(id) => <Input id={id} type="date" value={date} onChange={(e) => { setDate(e.target.value); setTouched((t) => ({ ...t, date: true })); }} />}
        </Field>
        <Field label={needsDest ? '¿De qué cuenta?' : kind === 'income' ? '¿A qué cuenta entró?' : '¿De dónde salió?'} className={needsDest ? '' : 'col-span-2'}>
          {(id) => (
            <Select id={id} value={accountId} onChange={(e) => { setAccountId(e.target.value); setTouched((t) => ({ ...t, account: true })); }}>
              {sourceOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          )}
        </Field>
        {needsDest && (
          <Field label="¿A qué cuenta?">
            {(id) => (
              <Select id={id} value={toAccountId} onChange={(e) => { setToAccountId(e.target.value); setTouched((t) => ({ ...t, toAccount: true })); }}>
                <option value="">— Elige —</option>
                {destOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            )}
          </Field>
        )}
        {catKind && (
          <Field label="Categoría (opcional)" className="col-span-2">
            {(id) => (
              <Select id={id} value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setTouched((t) => ({ ...t, category: true })); }}>
                <option value="">Sin categoría</option>
                {categories.filter((c) => c.kind === catKind).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            )}
          </Field>
        )}
      </div>

      {needsDest && (
        <Notice>
          {type === 'CARD_PAYMENT' ? 'Pagar la tarjeta reduce tu deuda. No cuenta como gasto nuevo: el gasto se contó cuando compraste.'
            : 'Mover dinero entre tus cuentas no es un gasto: tu dinero total sigue igual.'}
        </Notice>
      )}
      {errors.length > 0 && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{errors.map((e) => <div key={e}>{e}</div>)}</div>}
      <Button size="lg" variant={direction === 'in' ? 'income' : 'expense'} className="w-full" onClick={save}>
        Guardar {amount ? formatMoney(amount) : ''}
      </Button>
      <p className="text-center text-xs text-muted">Se guarda en tu dispositivo al instante y se sincroniza. Si hay asistente IA, solo sugerirá la categoría; nunca cambia el importe.</p>
    </div>
  );
}
