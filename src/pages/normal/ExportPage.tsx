import { useState } from 'react';
import { Button, Card, ErrorBox, Field, Input, Notice, PageHeader } from '@/components/ui';
import { useAccounts, useCategories, useContributions, useGoals, useTransactionsQuery } from '@/hooks/useFinance';
import { buildWorkbook, workbookToBlob, SHEETS } from '@/integrations/excel/buildWorkbook';
import { endOfMonth, isIsoDate, startOfMonth, todayIso, type IsoDate } from '@/domain/dates';
import { useAuth } from '@/auth/AuthProvider';

export default function ExportPage() {
  const { user } = useAuth();
  const accounts = useAccounts();
  const txs = useTransactionsQuery();
  const cats = useCategories();
  const goals = useGoals();
  const contribs = useContributions();
  const today = todayIso();
  const [from, setFrom] = useState<string>(startOfMonth(today));
  const [to, setTo] = useState<string>(endOfMonth(today));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = accounts.data && txs.data && cats.data && goals.data && contribs.data;

  async function download() {
    if (!ready || !isIsoDate(from) || !isIsoDate(to)) return;
    setBusy(true); setError(null);
    try {
      const wb = buildWorkbook({
        period: { from: from as IsoDate, to: to as IsoDate }, accounts: accounts.data!, categories: cats.data!, transactions: txs.data!,
        goals: goals.data!, contributions: contribs.data!, generatedAt: new Date(), ownerLabel: user?.email ?? undefined,
      });
      const blob = await workbookToBlob(wb);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `CangreVault_${today}.xlsx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Exportar a Excel" subtitle="Archivo .xlsx real, editable sin la aplicación." />
      <Card>
        <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
          <Field label="Desde">{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="Hasta">{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
          <Button onClick={() => void download()} loading={busy} disabled={!ready}>Descargar Excel</Button>
        </div>
        <ErrorBox error={error} />
      </Card>
      <Card>
        <h2 className="mb-2 text-sm font-semibold">Contenido del archivo</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li><strong>{SHEETS.summary}</strong>: estado de resultados del período con <code>SUMIFS</code>, porcentajes, saldo por cuenta, patrimonio líquido y gastos por categoría. Cambia las fechas (celdas amarillas) y todo se recalcula.</li>
          <li><strong>{SHEETS.journal}</strong>: todos los movimientos con filtros, formato RD$#,##0.00, fechas y columnas de efecto por cuenta calculadas con fórmulas.</li>
          <li><strong>{SHEETS.savings}</strong>: metas con aportado, faltante y progreso por fórmula, y la tabla de aportaciones.</li>
        </ul>
        <Notice><span className="text-xs">El diario incluye todos los movimientos (no solo los del período) para que los saldos por cuenta sean correctos; el período solo afecta al estado de resultados y a las categorías.</span></Notice>
      </Card>
    </div>
  );
}
