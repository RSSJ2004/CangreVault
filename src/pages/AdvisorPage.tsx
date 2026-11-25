import { useMemo, useState } from 'react';
import { Badge, Button, Card, CardTitle, Loading, Notice, PageHeader, Textarea } from '@/components/ui';
import { useFinancialSnapshot, useKnowledge, useGoals, useContributions } from '@/hooks/useFinance';
import { useAppState } from '@/state/AppState';
import { askAdvisor, type AdvisorAnswer } from '@/integrations/ai/aiClient';
import { toDecimalString, ZERO } from '@/domain/money';
import { goalProgress } from '@/domain/savingsGoals';
import { ACCOUNT_KIND_LABEL, type KnowledgeEntry } from '@/domain/types';

const TYPE_BADGE: Record<string, { label: string; tone: 'info' | 'neutral' | 'warn' }> = {
  official: { label: 'Información oficial', tone: 'info' },
  general_principle: { label: 'Principio general', tone: 'neutral' },
  guidance: { label: 'Recomendación orientativa', tone: 'warn' },
};
const TOPIC: Record<string, string> = {
  credit_card: 'Tarjeta de crédito', budgeting: 'Presupuesto', emergency_fund: 'Fondo de emergencia',
  debt_management: 'Deudas', investing_basics: 'Inversión (básico)', accounting_basics: 'Contabilidad personal',
};
const QUICK = {
  simple: ['¿Cómo organizo mi dinero este mes?', '¿Qué pasa si solo pago el mínimo de la tarjeta?', '¿Cómo empiezo un fondo de emergencia?'],
  normal: ['Interpreta mi estado de resultados del mes', '¿Cómo proyecto mi ahorro a 6 meses?', '¿Cómo leo el estado de cuenta de la tarjeta?', '¿Cuál es mi utilización y qué significa?'],
};

interface Msg { role: 'user' | 'assistant'; content: string; meta?: AdvisorAnswer | { error: string; sources?: AdvisorAnswer['sources'] } }

function KnowledgeCard({ e }: { e: KnowledgeEntry }) {
  const b = TYPE_BADGE[e.contentType]!;
  return (
    <div className="rounded-lg border border-line p-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5"><span className="font-medium">{e.title}</span><Badge tone={b.tone}>{b.label}</Badge>
        {e.verificationDate ? <Badge tone="pos">verificado {e.verificationDate}</Badge> : <Badge>pendiente de verificación</Badge>}</div>
      <p className="mt-1 text-muted">{e.principleSummary}</p>
      <p className="mt-1"><strong>Consejo:</strong> {e.actionableTip}</p>
      <p className="mt-1 text-xs text-muted">Fuente: {e.sourceReference}{e.sourceUrl && <> · <a className="underline" href={e.sourceUrl} target="_blank" rel="noreferrer">{new URL(e.sourceUrl).hostname}</a></>}</p>
    </div>
  );
}

export function AdvisorPage() {
  const { mode } = useAppState();
  const { snapshot: s, loading, profile } = useFinancialSnapshot();
  const kb = useKnowledge();
  const goals = useGoals();
  const contribs = useContributions();
  const [q, setQ] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [topic, setTopic] = useState('');

  // Instantánea compacta con los datos REALES del usuario (montos como cadenas decimales exactas).
  const snapshot = useMemo(() => ({
    fecha: s.today,
    dinero_disponible: toDecimalString(s.available),
    cuentas: s.accounts.map((a) => ({ nombre: a.name, tipo: ACCOUNT_KIND_LABEL[a.kind], saldo: toDecimalString(s.balances.get(a.id)?.balance ?? ZERO) })),
    patrimonio_liquido_neto: toDecimalString(s.netWorth.liquidNetWorth),
    mes_actual: { ingresos: toDecimalString(s.monthStatement.income), gastos: toDecimalString(s.monthStatement.expenses),
      ahorro: toDecimalString(s.monthStatement.savings), resultado: toDecimalString(s.monthStatement.result),
      top_gastos: s.monthStatement.expensesByCategory.slice(0, 5).map((l) => ({ categoria: l.name, monto: toDecimalString(l.amount), pct: l.pctOfTotal })) },
    sueldo_mensual_configurado: toDecimalString(s.salaryMonthly),
    gastos_recurrentes_mensuales: toDecimalString(s.recurringMonthly),
    excedente_estimado: toDecimalString(s.estimatedSurplus),
    tarjetas: s.cards.map(({ account, summary }) => ({
      nombre: account.name, limite: summary.utilization ? toDecimalString(summary.utilization.limit) : null,
      deuda: summary.utilization ? toDecimalString(summary.utilization.debt) : null, utilizacion_pct: summary.utilization?.utilizationPct ?? null,
      tasa_anual_pct: account.annualInterestRatePct, fecha_limite: summary.dueDate, fecha_limite_estimada: summary.dueDateEstimated,
      pendiente_pago_contado: summary.pendingForFullPayment !== null ? toDecimalString(summary.pendingForFullPayment) : 'sin estado registrado',
      pendiente_pago_minimo: summary.pendingForMinimumPayment !== null ? toDecimalString(summary.pendingForMinimumPayment) : 'sin estado registrado',
    })),
    metas: (goals.data ?? []).map((g) => { const p = goalProgress(g, contribs.data ?? [], s.today); return { nombre: g.name, objetivo: toDecimalString(g.targetAmount), ahorrado: toDecimalString(p.saved), fecha: g.targetDate }; }),
    fondo_emergencia_meses_objetivo: profile?.emergencyFundMonths ?? 3,
    recordatorios: s.reminders.slice(0, 5).map((r) => r.title),
  }), [s, goals.data, contribs.data, profile]);

  async function send(question: string) {
    if (!question.trim() || busy) return;
    const history = msgs.map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { role: 'user', content: question }]);
    setQ('');
    setBusy(true);
    try {
      const res = await askAdvisor({ question, mode, snapshot, history });
      setMsgs((m) => [...m, { role: 'assistant', content: res.answer, meta: res }]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMsgs((m) => [...m, { role: 'assistant', content: '', meta: { error: msg } }]);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading />;
  const kbList = (kb.data ?? []).filter((e) => (!topic || e.topic === topic) && (e.targetAudience === 'all' || e.targetAudience === mode));

  return (
    <div className="space-y-5">
      <PageHeader title="Asesor financiero" subtitle={mode === 'simple' ? 'Pregúntame con tus palabras.' : 'Análisis basado en tus datos y en fuentes citadas.'} />
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <div className="space-y-3">
            {msgs.length === 0 && (
              <Notice>
                El asesor usa tus datos reales de CangreVault y una base de conocimiento curada (Superintendencia de Bancos, ProUsuario, BCRD y principios generales).
                Cada consejo indica si es información oficial, principio general o recomendación orientativa. No predice tu calificación crediticia.
              </Notice>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-brand-700 px-4 py-2 text-sm text-white' : 'max-w-[95%] rounded-2xl rounded-bl-sm bg-slate-100 px-4 py-3 text-sm'}>
                {m.meta && 'error' in m.meta ? (
                  <div>
                    <p className="text-red-800">{m.meta.error}</p>
                    <p className="mt-1 text-xs text-muted">Mientras tanto, consulta la biblioteca de la derecha: contiene el mismo conocimiento verificable.</p>
                  </div>
                ) : <div className="whitespace-pre-wrap">{m.content}</div>}
                {m.meta && 'sources' in m.meta && m.meta.sources && m.meta.sources.length > 0 && (
                  <div className="mt-2 border-t border-slate-200 pt-2 text-xs text-muted">
                    Fuentes consultadas: {m.meta.sources.map((src) => `${src.title} (${TYPE_BADGE[src.content_type]?.label ?? src.content_type}${src.verified ? '' : ', pendiente de verificación'})`).join(' · ')}
                  </div>
                )}
                {m.meta && 'disclaimer' in m.meta && <p className="mt-1 text-[11px] text-muted">{m.meta.disclaimer} · Modelo: {m.meta.model}</p>}
              </div>
            ))}
            {busy && <p className="text-sm text-muted">Pensando…</p>}
          </div>
          <div className="mt-4 flex flex-wrap gap-1.5">
            {QUICK[mode].map((x) => <button key={x} onClick={() => void send(x)} className="rounded-full bg-brand-50 px-3 py-1 text-xs text-brand-800 hover:bg-brand-100">{x}</button>)}
          </div>
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(q); }}>
            <Textarea rows={2} value={q} maxLength={1000} onChange={(e) => setQ(e.target.value)} placeholder="Escribe tu pregunta…"
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(q); } }} />
            <Button type="submit" loading={busy}>Enviar</Button>
          </form>
        </Card>
        <Card className="lg:col-span-2">
          <CardTitle hint="Funciona aunque la IA no esté disponible">Biblioteca de conocimiento</CardTitle>
          <div className="mb-3 flex flex-wrap gap-1">
            <button onClick={() => setTopic('')} className={`rounded-full px-2.5 py-1 text-xs ${!topic ? 'bg-brand-700 text-white' : 'bg-slate-100'}`}>Todo</button>
            {Object.entries(TOPIC).map(([k, l]) => <button key={k} onClick={() => setTopic(k)} className={`rounded-full px-2.5 py-1 text-xs ${topic === k ? 'bg-brand-700 text-white' : 'bg-slate-100'}`}>{l}</button>)}
          </div>
          <div className="max-h-[560px] space-y-2 overflow-y-auto">{kbList.map((e) => <KnowledgeCard key={e.id} e={e} />)}</div>
        </Card>
      </div>
    </div>
  );
}
