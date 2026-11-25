import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Money, Notice, ErrorBox, Select } from '@/components/ui';
import { TransactionForm } from './TransactionForm';
import type { UiTransaction } from '@/hooks/useFinance';
import { useLookups } from '@/hooks/useLookups';
import { listTransactionAudit, softDeleteTransaction, updateTransaction } from '@/repositories/finance';
import { requestNormalization } from '@/integrations/ai/aiClient';
import { discardOutboxItem } from '@/sync/outbox';
import { formatDateEs } from '@/domain/dates';
import { TRANSACTION_TYPE_LABEL, type ReconciliationStatus } from '@/domain/types';
import { toAppError } from '@/lib/errors';

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Manual', pdf_import: 'Importado de PDF', recurring: 'Recurrente', reconciliation: 'Conciliación', android: 'Android', api: 'API',
};

export function TransactionDetail({ t, onClose, simple }: { t: UiTransaction; onClose: () => void; simple?: boolean }) {
  const qc = useQueryClient();
  const { accountName, categoryName, categories } = useLookups();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isPending = t.id.startsWith('pending:');
  const audit = useQuery({ queryKey: ['audit', t.id], queryFn: () => listTransactionAudit(t.id), enabled: !isPending && !simple });

  const refresh = () => qc.invalidateQueries({ queryKey: ['transactions'] });
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try { await fn(); await refresh(); } catch (e) { setError(toAppError(e).message); } finally { setBusy(false); }
  }

  if (editing) return <TransactionForm initial={t} onDone={() => { setEditing(false); onClose(); }} />;

  const s = t.aiSuggestion;
  const suggestedCategory = s?.categoryId ? categories.find((c) => c.id === s.categoryId) : null;

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-base font-semibold">{t.description}</div>
          <div className="text-muted">{formatDateEs(t.occurredOn, 'long')} · {TRANSACTION_TYPE_LABEL[t.type]}</div>
        </div>
        <Money value={t.amount} className="text-lg font-semibold" />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        <dt className="text-muted">Cuenta</dt><dd>{accountName(t.accountId)}</dd>
        {t.toAccountId && (<><dt className="text-muted">Destino</dt><dd>{accountName(t.toAccountId)}</dd></>)}
        <dt className="text-muted">Categoría</dt>
        <dd>{categoryName(t.categoryId)} {t.classificationSource && <Badge tone={t.classificationSource === 'ai' ? 'ai' : 'neutral'}>{t.classificationSource === 'user' ? 'confirmada por ti' : t.classificationSource === 'rules' ? 'reglas automáticas' : 'IA aceptada'}</Badge>}</dd>
        <dt className="text-muted">Origen</dt><dd>{SOURCE_LABEL[t.source] ?? t.source} · modo {t.entryMode}</dd>
        {!simple && (<><dt className="text-muted">Conciliación</dt><dd>
          <Select value={t.reconciliationStatus} disabled={isPending || busy} className="py-1"
            onChange={(e) => void run(() => updateTransaction(t.id, { reconciliationStatus: e.target.value as ReconciliationStatus }))}>
            <option value="unreconciled">No conciliado</option><option value="reconciled">Conciliado</option><option value="disputed">En disputa</option>
          </Select></dd></>)}
        {t.originalNote && (<><dt className="text-muted">Nota original</dt><dd className="italic">“{t.originalNote}”</dd></>)}
        {!simple && <><dt className="text-muted">Versión</dt><dd>{t.version}</dd></>}
      </dl>

      {t.aiStatus === 'suggested' && s && (
        <div className="rounded-lg border border-violet-200 bg-violet-50 p-3">
          <div className="mb-1 flex items-center gap-2 font-medium text-violet-900">Sugerencia ({s.engine === 'groq' ? `IA · ${s.model ?? 'Groq'}` : 'reglas'}) <Badge tone="ai">no confirmada</Badge></div>
          <ul className="text-violet-900">
            {suggestedCategory && <li>Categoría: <strong>{suggestedCategory.name}</strong></li>}
            {s.normalizedDescription && <li>Descripción: <strong>{s.normalizedDescription}</strong></li>}
            {s.rationale && <li className="text-xs opacity-80">{s.rationale}</li>}
          </ul>
          <p className="mt-1 text-xs text-violet-800">La IA nunca modifica importe, fecha ni cuenta.</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" loading={busy} onClick={() => void run(() => updateTransaction(t.id, {
              categoryId: suggestedCategory?.id ?? t.categoryId, normalizedDescription: s.normalizedDescription ?? null,
              classificationSource: suggestedCategory ? 'ai' : t.classificationSource, aiStatus: 'accepted',
            }))}>Aceptar</Button>
            <Button size="sm" variant="secondary" onClick={() => void run(() => updateTransaction(t.id, { aiStatus: 'rejected' }))}>Descartar</Button>
          </div>
        </div>
      )}
      {(t.aiStatus === 'pending' || t.aiStatus === 'failed') && !isPending && (
        <Notice>La clasificación automática está {t.aiStatus === 'pending' ? 'pendiente' : 'no disponible'}.{' '}
          <button className="font-medium underline" onClick={() => void run(() => requestNormalization(t.id))}>Intentar ahora</button>
        </Notice>
      )}
      {t.pendingSync && <Notice tone="warn">{t.syncError ? `No se pudo guardar en el servidor: ${t.syncError}` : 'Guardado en este dispositivo; se enviará al servidor al haber conexión.'}</Notice>}
      <ErrorBox error={error} title="No se pudo completar" />

      {!simple && !isPending && (audit.data?.length ?? 0) > 0 && (
        <details className="rounded-lg border border-line p-3">
          <summary className="cursor-pointer font-medium">Historial de cambios ({audit.data!.length})</summary>
          <ul className="mt-2 space-y-1 text-xs text-muted">
            {audit.data!.map((a) => (
              <li key={String(a.id)}>{new Date(String(a.changed_at)).toLocaleString('es-DO')} · {String(a.action)} · {(a.changed_fields as string[]).join(', ')}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
        {isPending ? (
          t.syncError && <Button variant="danger" onClick={() => { discardOutboxItem(t.clientId); onClose(); }}>Descartar</Button>
        ) : (
          <>
            <Button variant="danger" loading={busy} onClick={() => {
              if (confirm('¿Eliminar este movimiento? Quedará registrado en el historial (eliminación lógica).')) void run(softDeleteTransaction.bind(null, t.id)).then(onClose);
            }}>Eliminar</Button>
            <Button variant="secondary" onClick={() => setEditing(true)}>Editar</Button>
          </>
        )}
        <Button onClick={onClose}>Cerrar</Button>
      </div>
    </div>
  );
}
