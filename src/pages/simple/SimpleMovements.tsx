import { useMemo, useState } from 'react';
import { Card, Input, Loading, Modal, PageHeader } from '@/components/ui';
import { SimpleTransactionList } from '@/components/TransactionList';
import { TransactionDetail } from '@/components/TransactionDetail';
import { useTransactions, type UiTransaction } from '@/hooks/useFinance';
import { monthLabelEs, startOfMonth } from '@/domain/dates';

export function SimpleMovements() {
  const txs = useTransactions();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<UiTransaction | null>(null);
  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = txs.data.filter((t) => !term || t.description.toLowerCase().includes(term) || (t.originalNote ?? '').toLowerCase().includes(term));
    const map = new Map<string, UiTransaction[]>();
    for (const t of list) {
      const k = startOfMonth(t.occurredOn);
      map.set(k, [...(map.get(k) ?? []), t]);
    }
    return [...map.entries()];
  }, [txs.data, q]);
  if (txs.isLoading) return <Loading />;
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Mis movimientos" subtitle="Todo lo que entró y salió, por mes." />
      <Input placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} className="mb-4" />
      {groups.map(([month, list]) => (
        <Card key={month} className="mb-4">
          <h2 className="text-sm font-semibold capitalize">{monthLabelEs(month as never)}</h2>
          <SimpleTransactionList items={list} onSelect={setSelected} />
        </Card>
      ))}
      {!groups.length && <p className="text-center text-sm text-muted">No hay movimientos.</p>}
      <Modal open={selected !== null} onClose={() => setSelected(null)} title="Detalle">
        {selected && <TransactionDetail t={selected} simple onClose={() => setSelected(null)} />}
      </Modal>
    </div>
  );
}
