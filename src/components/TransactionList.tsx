import { Badge, Money, cx } from '@/components/ui';
import type { UiTransaction } from '@/hooks/useFinance';
import { useLookups } from '@/hooks/useLookups';
import { formatDateEs } from '@/domain/dates';
import { simpleFlowDirection } from '@/domain/ledger';
import { TRANSACTION_TYPE_LABEL } from '@/domain/types';
import { neg } from '@/domain/money';

export function AiBadge({ t }: { t: UiTransaction }) {
  if (t.aiStatus === 'suggested') return <Badge tone="ai" title="La IA propuso una clasificación pendiente de tu revisión">Sugerencia IA</Badge>;
  if (t.aiStatus === 'pending' || t.aiStatus === 'processing') return <Badge tone="neutral" title="Esperando clasificación">IA pendiente</Badge>;
  if (t.aiStatus === 'failed') return <Badge tone="warn">IA no disponible</Badge>;
  return null;
}

/** Lista legible para el Modo Simple: verde si entra, naranja si sale, gris si es movimiento interno. */
export function SimpleTransactionList({ items, onSelect }: { items: UiTransaction[]; onSelect?: (t: UiTransaction) => void }) {
  const { accountName, categoryName } = useLookups();
  return (
    <ul className="divide-y divide-line">
      {items.map((t) => {
        const dir = simpleFlowDirection(t);
        const internal = dir === 'internal';
        return (
          <li key={t.id}>
            <button type="button" onClick={() => onSelect?.(t)} className="flex w-full items-center gap-3 py-3 text-left">
              <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
                dir === 'in' ? 'bg-emerald-50 text-emerald-700' : dir === 'out' ? 'bg-orange-50 text-orange-700' : 'bg-slate-100 text-slate-600')}>
                {dir === 'in' ? '↓' : dir === 'out' ? '↑' : '⇄'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{t.description}</span>
                <span className="block truncate text-xs text-muted">
                  {formatDateEs(t.occurredOn)} · {internal ? `${accountName(t.accountId)} → ${accountName(t.toAccountId)}` : `${accountName(t.accountId)}${t.categoryId ? ` · ${categoryName(t.categoryId)}` : ''}`}
                </span>
                <span className="mt-0.5 flex gap-1">
                  {t.pendingSync && <Badge tone={t.syncError ? 'neg' : 'warn'}>{t.syncError ? 'Error al sincronizar' : 'Pendiente de sincronizar'}</Badge>}
                  {internal && <Badge>{TRANSACTION_TYPE_LABEL[t.type]}</Badge>}
                  <AiBadge t={t} />
                </span>
              </span>
              <Money value={dir === 'out' ? neg(t.amount) : t.amount} tone={internal ? 'none' : 'auto'} sign={dir === 'in'} className="text-sm font-semibold" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
