import { useMemo, useState } from 'react';
import { Badge, Button, Card, Input, Loading, Modal, Money, PageHeader, Select, cx } from '@/components/ui';
import { TransactionForm } from '@/components/TransactionForm';
import { TransactionDetail } from '@/components/TransactionDetail';
import { AiBadge } from '@/components/TransactionList';
import { useCycles, useTransactions, type UiTransaction } from '@/hooks/useFinance';
import { useLookups } from '@/hooks/useLookups';
import { formatDateEs } from '@/domain/dates';
import { sum, formatMoney } from '@/domain/money';
import { TRANSACTION_TYPES, TRANSACTION_TYPE_LABEL, type TransactionType } from '@/domain/types';

type SortKey = 'occurredOn' | 'amount' | 'description';
const RECON_LABEL = { unreconciled: 'No conciliado', reconciled: 'Conciliado', disputed: 'En disputa' } as const;
const SOURCE_SHORT: Record<string, string> = { manual: 'Manual', pdf_import: 'PDF', recurring: 'Recurrente', reconciliation: 'Conciliación', android: 'Android', api: 'API', bank_sync: 'Banco' };

export function JournalPage() {
  const txs = useTransactions();
  const cycles = useCycles();
  const { accounts, categories, accountName, categoryName } = useLookups();
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [account, setAccount] = useState('');
  const [category, setCategory] = useState('');
  const [type, setType] = useState<'' | TransactionType>('');
  const [cycle, setCycle] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'occurredOn', dir: -1 });
  const [selected, setSelected] = useState<UiTransaction | null>(null);
  const [adding, setAdding] = useState(false);
  const [limit, setLimit] = useState(200);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const cyc = cycles.data?.find((c) => c.id === cycle);
    const list = txs.data.filter((t) => {
      if (term && !`${t.description} ${t.originalNote ?? ''} ${t.normalizedDescription ?? ''}`.toLowerCase().includes(term)) return false;
      if (from && t.occurredOn < from) return false;
      if (to && t.occurredOn > to) return false;
      if (account && t.accountId !== account && t.toAccountId !== account) return false;
      if (category && (category === '__none' ? t.categoryId !== null : t.categoryId !== category)) return false;
      if (type && t.type !== type) return false;
      if (cyc && (t.occurredOn < cyc.periodStart || t.occurredOn > cyc.statementDate || (t.accountId !== cyc.accountId && t.toAccountId !== cyc.accountId))) return false;
      return true;
    });
    return list.sort((a, b) => {
      const k = sort.key;
      const va = a[k], vb = b[k];
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
  }, [txs.data, q, from, to, account, category, type, cycle, cycles.data, sort]);

  const th = (key: SortKey, label: string, cls = '') => (
    <th className={cx('cursor-pointer select-none px-3 py-2 font-medium', cls)} onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : -1 }))}>
      {label}{sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
    </th>
  );

  if (txs.isLoading) return <Loading />;
  return (
    <div>
      <PageHeader title="Diario de transacciones" subtitle={`${filtered.length} movimiento(s) · total filtrado ${formatMoney(sum(filtered.map((t) => t.amount)))}`}
        actions={<Button onClick={() => setAdding(true)}>+ Nuevo</Button>} />
      <Card className="mb-4">
        <div className="grid gap-2 sm:grid-cols-4 lg:grid-cols-8">
          <Input placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} className="sm:col-span-2" />
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Desde" />
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Hasta" />
          <Select value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Cuenta">
            <option value="">Todas las cuentas</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Categoría">
            <option value="">Todas las categorías</option><option value="__none">Sin categoría</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select value={type} onChange={(e) => setType(e.target.value as TransactionType | '')} aria-label="Tipo">
            <option value="">Todos los tipos</option>{TRANSACTION_TYPES.map((t) => <option key={t} value={t}>{TRANSACTION_TYPE_LABEL[t]}</option>)}
          </Select>
          <Select value={cycle} onChange={(e) => setCycle(e.target.value)} aria-label="Ciclo de tarjeta">
            <option value="">Cualquier ciclo</option>
            {(cycles.data ?? []).map((c) => <option key={c.id} value={c.id}>Ciclo al {formatDateEs(c.statementDate)}</option>)}
          </Select>
        </div>
      </Card>

      <Card className="overflow-x-auto p-0 sm:p-0">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="border-b border-line bg-slate-50 text-xs text-muted">
            <tr>
              {th('occurredOn', 'Fecha')}
              {th('description', 'Descripción')}
              <th className="px-3 py-2 font-medium">Cuenta</th>
              <th className="px-3 py-2 font-medium">Tipo</th>
              <th className="px-3 py-2 font-medium">Categoría</th>
              {th('amount', 'Importe', 'text-right')}
              <th className="px-3 py-2 font-medium">Conciliación</th>
              <th className="px-3 py-2 font-medium">Origen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {filtered.slice(0, limit).map((t) => (
              <tr key={t.id} onClick={() => setSelected(t)} className="cursor-pointer hover:bg-brand-50/50">
                <td className="whitespace-nowrap px-3 py-2 tabular">{formatDateEs(t.occurredOn)}</td>
                <td className="max-w-[260px] px-3 py-2">
                  <div className="truncate">{t.description}</div>
                  <div className="flex gap-1">{t.source === 'bank_sync' && <Badge tone="info" title="Sincronizado automáticamente desde el banco">banco</Badge>}{t.pendingSync && <Badge tone={t.syncError ? 'neg' : 'warn'}>{t.syncError ? 'error' : 'pendiente'}</Badge>}<AiBadge t={t} /></div>
                </td>
                <td className="whitespace-nowrap px-3 py-2">{accountName(t.accountId)}{t.toAccountId && <span className="text-muted"> → {accountName(t.toAccountId)}</span>}</td>
                <td className="whitespace-nowrap px-3 py-2">{TRANSACTION_TYPE_LABEL[t.type]}</td>
                <td className="whitespace-nowrap px-3 py-2">{categoryName(t.categoryId)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right"><Money value={t.amount} /></td>
                <td className="px-3 py-2"><Badge tone={t.reconciliationStatus === 'reconciled' ? 'pos' : t.reconciliationStatus === 'disputed' ? 'neg' : 'neutral'}>{RECON_LABEL[t.reconciliationStatus]}</Badge></td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-muted">{SOURCE_SHORT[t.source] ?? t.source} · {t.entryMode}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <p className="p-6 text-center text-sm text-muted">No hay movimientos con esos filtros.</p>}
        {filtered.length > limit && <div className="p-3 text-center"><Button variant="ghost" onClick={() => setLimit((l) => l + 200)}>Mostrar más</Button></div>}
      </Card>

      <Modal open={selected !== null} onClose={() => setSelected(null)} title="Detalle del movimiento">
        {selected && <TransactionDetail t={selected} onClose={() => setSelected(null)} />}
      </Modal>
      <Modal open={adding} onClose={() => setAdding(false)} title="Nuevo movimiento">
        {adding && <TransactionForm onDone={() => setAdding(false)} />}
      </Modal>
    </div>
  );
}
