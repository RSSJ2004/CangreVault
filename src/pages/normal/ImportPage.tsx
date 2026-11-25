import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardTitle, ErrorBox, Field, Input, Notice, PageHeader, Select, cx } from '@/components/ui';
import { useCycles, useTransactions } from '@/hooks/useFinance';
import { useLookups, categoryKindForType } from '@/hooks/useLookups';
import { extractPdfText, sha256Hex, type ExtractedPdf } from '@/integrations/pdf/extractText';
import { parseStatementText, PARSER_NAME, PARSER_VERSION, type ParseResult } from '@/integrations/pdf/banreservasParser';
import { noOcr } from '@/integrations/pdf/ocr';
import { checkDuplicates, dedupeKey, type DuplicateCheck } from '@/domain/dedupe';
import { formatMoney, parseUserAmount, toDecimalString, sum, type Cents } from '@/domain/money';
import { formatDateEs, isIsoDate, todayIso, type IsoDate } from '@/domain/dates';
import { TRANSACTION_TYPE_LABEL, TYPES_REQUIRING_DESTINATION, type Transaction, type TransactionType, type Account } from '@/domain/types';
import { createImportBatch, findImportsByHash, insertTransactions, saveCycle } from '@/repositories/finance';
import { requireSupabase, newUuid } from '@/lib/supabase';
import { toAppError } from '@/lib/errors';

interface EditableRow {
  ref: string; include: boolean; occurredOn: string; description: string; amountText: string; type: TransactionType;
  direction: 'debit' | 'credit'; categoryId: string; counterAccountId: string; bankReference: string | null; confidence: string; rawLine: string;
}

const TYPES_FOR: Record<'asset' | 'card', TransactionType[]> = {
  asset: ['INCOME', 'EXPENSE', 'TRANSFER', 'CARD_PAYMENT', 'SAVINGS_CONTRIBUTION', 'INVESTMENT', 'REFUND'],
  card: ['CARD_PURCHASE', 'EXPENSE', 'CARD_PAYMENT', 'REFUND'],
};

/** Convierte una fila revisada en transacción según la cuenta del estado. */
function toTransaction(r: EditableRow, account: Account): { from: string; to: string | null } {
  const needsCounter = TYPES_REQUIRING_DESTINATION.has(r.type) || (r.type === 'INVESTMENT' && r.counterAccountId);
  if (!needsCounter) return { from: account.id, to: null };
  if (account.kind === 'credit_card' && r.type === 'CARD_PAYMENT') return { from: r.counterAccountId, to: account.id };
  return r.direction === 'credit' ? { from: r.counterAccountId, to: account.id } : { from: account.id, to: r.counterAccountId || null };
}

export default function ImportPage() {
  const qc = useQueryClient();
  const { accounts, categories, categoryBySlug } = useLookups();
  const txs = useTransactions();
  const cycles = useCycles();
  const [accountId, setAccountId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pdf, setPdf] = useState<ExtractedPdf | null>(null);
  const [hash, setHash] = useState('');
  const [prior, setPrior] = useState<Record<string, unknown>[]>([]);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [saveCycleToo, setSaveCycleToo] = useState(true);
  const [done, setDone] = useState<string | null>(null);
  const account = accounts.find((a) => a.id === accountId) ?? null;
  const kind = account?.kind === 'credit_card' ? 'card' : 'asset';

  const dupes: DuplicateCheck[] = useMemo(() => {
    if (!account) return [];
    return checkDuplicates(rows.map((r) => ({
      accountId: account.id, occurredOn: (isIsoDate(r.occurredOn) ? r.occurredOn : todayIso()) as IsoDate,
      amount: parseUserAmount(r.amountText) ?? (0 as Cents), description: r.description, bankReference: r.bankReference,
    })), txs.data.filter((t) => !t.pendingSync));
  }, [rows, account, txs.data]);

  async function read() {
    if (!file || !account) return;
    setBusy(true); setError(null); setParsed(null); setRows([]); setDone(null);
    try {
      const buf = await file.arrayBuffer();
      const h = await sha256Hex(buf);
      setHash(h);
      setPrior(await findImportsByHash(h).catch(() => []));
      const ex = await extractPdfText(buf);
      setPdf(ex);
      if (ex.looksScanned) return;
      const res = parseStatementText(ex.pages, { fallbackYear: Number(todayIso().slice(0, 4)) });
      setParsed(res);
      const firstCard = accounts.find((a) => a.kind === 'credit_card' && a.id !== account.id);
      const firstDebit = accounts.find((a) => a.kind === 'checking' && a.id !== account.id);
      const firstSavings = accounts.find((a) => a.kind === 'savings' && a.id !== account.id);
      const initial = res.rows.map((r) => {
        let type = r.suggestedType;
        if (account.kind === 'credit_card' && !TYPES_FOR.card.includes(type)) type = r.direction === 'credit' ? 'REFUND' : 'CARD_PURCHASE';
        if (account.kind !== 'credit_card' && type === 'CARD_PURCHASE') type = 'EXPENSE';
        const counter = type === 'CARD_PAYMENT' ? (account.kind === 'credit_card' ? firstDebit : firstCard)
          : type === 'SAVINGS_CONTRIBUTION' ? firstSavings : undefined;
        return {
          ref: r.ref, include: true, occurredOn: r.occurredOn, description: r.description, amountText: toDecimalString(r.amount), type,
          direction: r.direction, categoryId: categoryBySlug(r.categorySlug)?.id ?? '', counterAccountId: counter?.id ?? '',
          bankReference: r.bankReference, confidence: r.confidence, rawLine: r.rawLine,
        };
      });
      // Duplicados exactos o probables se desmarcan para revisión manual (no se descartan).
      const d = checkDuplicates(initial.map((r) => ({ accountId: account.id, occurredOn: r.occurredOn, amount: parseUserAmount(r.amountText)!, description: r.description, bankReference: r.bankReference })),
        txs.data.filter((t) => !t.pendingSync));
      setRows(initial.map((r, i) => ({ ...r, include: d[i]!.level === 'none' })));
    } catch (e) {
      setError(`No se pudo leer el PDF: ${toAppError(e).message}`);
    } finally {
      setBusy(false);
    }
  }

  const upd = (i: number, p: Partial<EditableRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const selected = rows.filter((r) => r.include);
  const invalid = selected.filter((r) => !isIsoDate(r.occurredOn) || !parseUserAmount(r.amountText) || !r.description.trim()
    || (TYPES_REQUIRING_DESTINATION.has(r.type) && !r.counterAccountId));

  async function confirm() {
    if (!account || !parsed || !file) return;
    if (invalid.length) { setError(`${invalid.length} fila(s) seleccionadas tienen datos incompletos (fecha, importe, descripción o cuenta contraparte).`); return; }
    setBusy(true); setError(null);
    const batchClientId = newUuid();
    let batchId: string | null = null;
    try {
      const h = parsed.header;
      batchId = await createImportBatch({
        client_id: batchClientId, account_id: account.id, file_name: file.name.slice(0, 255), file_sha256: hash, file_size_bytes: file.size,
        page_count: pdf?.pageCount ?? null, detected_account_type: h.accountType, statement_period_start: h.periodStart, statement_period_end: h.periodEnd,
        parser_name: PARSER_NAME, parser_version: PARSER_VERSION, status: 'confirmed', rows_total: rows.length, rows_imported: 0, rows_skipped: 0,
        warnings: parsed.warnings,
      });
      const list = selected.map((r) => {
        const { from, to } = toTransaction(r, account);
        const amount = parseUserAmount(r.amountText)!;
        const catKind = categoryKindForType(r.type);
        const t: Partial<Transaction> & { clientId: string } = {
          clientId: newUuid(), type: r.type, accountId: from, toAccountId: to, amount, currency: account.currency, occurredOn: r.occurredOn as IsoDate,
          description: r.description.trim().slice(0, 300), categoryId: catKind && r.categoryId ? r.categoryId : null,
          classificationSource: catKind && r.categoryId ? 'rules' : null, importBatchId: batchId!, importRowRef: `${file.name.slice(0, 120)}#${r.ref}`,
          bankReference: r.bankReference, dedupeKey: dedupeKey({ accountId: account.id, occurredOn: r.occurredOn as IsoDate, amount, description: r.description, bankReference: r.bankReference }),
          entryMode: 'import', source: 'pdf_import',
        };
        return t;
      });
      let inserted = 0;
      for (let i = 0; i < list.length; i += 200) inserted += await insertTransactions(list.slice(i, i + 200));
      await requireSupabase().from('import_batches').update({ rows_imported: inserted, rows_skipped: rows.length - inserted }).eq('id', batchId);

      let cycleMsg = '';
      if (saveCycleToo && account.kind === 'credit_card' && h.statementDate && h.dueDate && h.statementBalance !== null && h.minimumPayment !== null && h.fullPayment !== null) {
        const exists = (cycles.data ?? []).some((c) => c.accountId === account.id && c.statementDate === h.statementDate);
        if (!exists) {
          await saveCycle({ clientId: newUuid(), accountId: account.id, periodStart: h.periodStart ?? h.statementDate, statementDate: h.statementDate, dueDate: h.dueDate,
            previousBalance: h.previousBalance, statementBalance: h.statementBalance, minimumPayment: h.minimumPayment, fullPayment: h.fullPayment, source: 'pdf_import' }, batchId);
          cycleMsg = ' También se registró el ciclo de la tarjeta.';
        }
      }
      await qc.invalidateQueries();
      setDone(`Importados ${inserted} movimiento(s); ${rows.length - inserted} no importados.${cycleMsg}`);
      setRows([]); setParsed(null); setFile(null);
    } catch (e) {
      if (batchId) await requireSupabase().from('import_batches').update({ status: 'failed' }).eq('id', batchId).then(() => undefined, () => undefined);
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  }

  const h = parsed?.header;
  const typeMismatch = h && account && h.accountType !== 'unknown' && (h.accountType === 'credit_card') !== (account.kind === 'credit_card');

  return (
    <div className="space-y-5">
      <PageHeader title="Importar estado de cuenta (PDF)" subtitle="Nada se guarda sin tu revisión y confirmación." />
      <Card>
        <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
          <Field label="1. Cuenta del estado">{(id) => <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">— Selecciona —</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
          <Field label="2. Archivo PDF">{(id) => <Input id={id} type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}</Field>
          <Button disabled={!file || !account} loading={busy && !parsed} onClick={() => void read()}>3. Leer archivo</Button>
        </div>
        <p className="mt-3 text-xs text-muted">El archivo se procesa en tu navegador; no se sube a ningún servidor. Se guarda su huella (SHA-256) para detectar reimportaciones.</p>
      </Card>
      <ErrorBox error={error} />
      {done && <Notice tone="ok">{done}</Notice>}
      {prior.length > 0 && <Notice tone="warn">Este mismo archivo ya se importó antes ({prior.map((p) => String(p.file_name)).join(', ')}). Revisa los duplicados con cuidado.</Notice>}
      {pdf?.looksScanned && (
        <Notice tone="warn">
          Este PDF no contiene texto extraíble (parece escaneado o una imagen). {noOcr.available ? '' : 'El reconocimiento óptico (OCR) aún no está disponible. '}
          Descarga el estado de cuenta digital desde la banca en línea o registra los movimientos manualmente. Ver docs/OCR_STRATEGY.md.
        </Notice>
      )}

      {parsed && h && (
        <Card>
          <CardTitle hint={`Intérprete ${PARSER_NAME} v${PARSER_VERSION} · ${pdf?.pageCount} página(s)`}>Datos generales detectados</CardTitle>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div><dt className="text-xs text-muted">Tipo de cuenta</dt><dd>{{ checking: 'Débito / corriente', savings: 'Ahorro', credit_card: 'Tarjeta de crédito', unknown: 'No identificado' }[h.accountType]}</dd></div>
            <div><dt className="text-xs text-muted">Período</dt><dd>{h.periodStart ? formatDateEs(h.periodStart) : '—'} – {h.periodEnd ? formatDateEs(h.periodEnd) : '—'}</dd></div>
            {h.statementDate && <div><dt className="text-xs text-muted">Fecha de corte</dt><dd>{formatDateEs(h.statementDate)}</dd></div>}
            {h.dueDate && <div><dt className="text-xs text-muted">Fecha límite</dt><dd>{formatDateEs(h.dueDate)}</dd></div>}
            {h.statementBalance !== null && <div><dt className="text-xs text-muted">Saldo al corte</dt><dd>{formatMoney(h.statementBalance)}</dd></div>}
            {h.minimumPayment !== null && <div><dt className="text-xs text-muted">Pago mínimo</dt><dd>{formatMoney(h.minimumPayment)}</dd></div>}
            {h.fullPayment !== null && <div><dt className="text-xs text-muted">Pago de contado</dt><dd>{formatMoney(h.fullPayment)}</dd></div>}
            {h.creditLimit !== null && <div><dt className="text-xs text-muted">Límite</dt><dd>{formatMoney(h.creditLimit)}</dd></div>}
          </dl>
          {typeMismatch && <div className="mt-3"><Notice tone="warn">El tipo detectado no coincide con la cuenta seleccionada. Verifica que elegiste la cuenta correcta.</Notice></div>}
          {parsed.warnings.map((w) => <p key={w} className="mt-2 text-sm text-amber-800">⚠ {w}</p>)}
          {account?.kind === 'credit_card' && h.statementDate && h.dueDate && h.fullPayment !== null && (
            <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={saveCycleToo} onChange={(e) => setSaveCycleToo(e.target.checked)} /> Registrar también este ciclo de la tarjeta (fechas, mínimo y contado)</label>
          )}
          <details className="mt-3 text-xs"><summary className="cursor-pointer text-muted">Ver texto extraído</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-50 p-2">{pdf?.pages.map((p, i) => `--- Página ${i + 1} ---\n${p.join('\n')}`).join('\n')}</pre>
          </details>
        </Card>
      )}

      {rows.length > 0 && account && (
        <Card className="p-0 sm:p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 p-4">
            <div className="text-sm">
              <strong>{selected.length}</strong> de {rows.length} seleccionados · {formatMoney(sum(selected.map((r) => parseUserAmount(r.amountText) ?? (0 as Cents))))}
              {dupes.some((d) => d.level !== 'none') && <span className="ml-2 text-amber-800">· {dupes.filter((d) => d.level !== 'none').length} posible(s) duplicado(s) desmarcados para revisión</span>}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setRows((rs) => rs.map((r) => ({ ...r, include: true })))}>Marcar todos</Button>
              <Button size="sm" variant="secondary" onClick={() => setRows((rs) => rs.map((r) => ({ ...r, include: false })))}>Desmarcar todos</Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-sm">
              <thead className="border-y border-line bg-slate-50 text-left text-xs text-muted">
                <tr><th className="p-2"></th><th className="p-2">Fecha</th><th className="p-2">Descripción</th><th className="p-2 text-right">Importe</th><th className="p-2">E/S</th><th className="p-2">Tipo</th><th className="p-2">Categoría</th><th className="p-2">Contraparte</th><th className="p-2">Revisión</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r, i) => {
                  const d = dupes[i];
                  const ck = categoryKindForType(r.type);
                  const needsCounter = TYPES_REQUIRING_DESTINATION.has(r.type);
                  return (
                    <tr key={r.ref} className={cx(!r.include && 'opacity-60', d?.level === 'exact' && 'bg-red-50/60', d?.level === 'probable' && 'bg-amber-50/60')} title={r.rawLine}>
                      <td className="p-2"><input type="checkbox" checked={r.include} onChange={(e) => upd(i, { include: e.target.checked })} aria-label="Incluir" /></td>
                      <td className="p-2"><Input type="date" value={r.occurredOn} onChange={(e) => upd(i, { occurredOn: e.target.value })} className="w-36 py-1" /></td>
                      <td className="p-2"><Input value={r.description} onChange={(e) => upd(i, { description: e.target.value })} className="w-full min-w-48 py-1" /></td>
                      <td className="p-2"><Input value={r.amountText} onChange={(e) => upd(i, { amountText: e.target.value })} className="w-28 py-1 text-right" /></td>
                      <td className="p-2"><Badge tone={r.direction === 'credit' ? 'pos' : 'neg'}>{r.direction === 'credit' ? 'entra' : 'sale'}</Badge></td>
                      <td className="p-2"><Select value={r.type} onChange={(e) => upd(i, { type: e.target.value as TransactionType })} className="py-1">
                        {TYPES_FOR[kind].map((t) => <option key={t} value={t}>{TRANSACTION_TYPE_LABEL[t]}</option>)}</Select></td>
                      <td className="p-2">{ck ? <Select value={r.categoryId} onChange={(e) => upd(i, { categoryId: e.target.value })} className="py-1">
                        <option value="">—</option>{categories.filter((c) => c.kind === ck).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select> : <span className="text-xs text-muted">n/a</span>}</td>
                      <td className="p-2">{needsCounter || r.type === 'INVESTMENT' ? <Select value={r.counterAccountId} onChange={(e) => upd(i, { counterAccountId: e.target.value })} className="py-1">
                        <option value="">—</option>{accounts.filter((a) => a.id !== account.id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select> : <span className="text-xs text-muted">—</span>}</td>
                      <td className="p-2 text-xs">
                        {d?.level === 'exact' && <Badge tone="neg" title={d.reason ?? ''}>duplicado</Badge>}
                        {d?.level === 'probable' && <Badge tone="warn" title={d.reason ?? ''}>posible duplicado</Badge>}
                        {d?.sameBatchIndex !== null && d?.sameBatchIndex !== undefined && <Badge tone="info">repetido en archivo</Badge>}
                        {r.confidence === 'low' && <Badge tone="warn">dirección dudosa</Badge>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="text-xs text-muted">Pasa el cursor sobre una fila para ver la línea original. Dos compras legítimas pueden tener el mismo importe y fecha: revisa antes de descartar.</p>
            <Button loading={busy} disabled={!selected.length} onClick={() => void confirm()}>Confirmar e importar {selected.length}</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
