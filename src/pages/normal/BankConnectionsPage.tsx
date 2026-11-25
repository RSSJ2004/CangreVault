import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardTitle, EmptyState, ErrorBox, Input, Loading, Money, Notice, PageHeader, Select, cx } from '@/components/ui';
import { useAuth } from '@/auth/AuthProvider';
import { useBankData, useFinancialSnapshot, useTransactions } from '@/hooks/useFinance';
import { useLookups } from '@/hooks/useLookups';
import { linkBankAccount, type BankConnection, type BankExternalAccount, type BankProviderTx } from '@/repositories/finance';
import { bankAction, bridgeApplicationId, openBridgeConnect } from '@/integrations/bank/bankClient';
import { formatDateEs, isIsoDate, type IsoDate } from '@/domain/dates';
import { cents, formatMoney, ZERO } from '@/domain/money';
import { ACCOUNT_KIND_LABEL, type Account } from '@/domain/types';
import { toAppError } from '@/lib/errors';

const STATUS: Record<BankConnection['status'], { label: string; tone: 'pos' | 'warn' | 'neg' | 'neutral' }> = {
  active: { label: 'Conectada', tone: 'pos' }, error: { label: 'Con errores', tone: 'neg' },
  reauth_required: { label: 'Requiere reautorizar', tone: 'warn' }, revoked: { label: 'Desconectada', tone: 'neutral' },
};
const RESOLVE_TYPES: { v: string; l: string; counter?: boolean; dir?: 'in' | 'out' | 'any'; card?: boolean }[] = [
  { v: 'EXPENSE', l: 'Gasto', dir: 'out' }, { v: 'INCOME', l: 'Ingreso', dir: 'in' }, { v: 'REFUND', l: 'Devolución', dir: 'in' },
  { v: 'CARD_PURCHASE', l: 'Compra con tarjeta', dir: 'out', card: true },
  { v: 'TRANSFER', l: 'Transferencia entre mis cuentas', counter: true, dir: 'any' },
  { v: 'SAVINGS_CONTRIBUTION', l: 'Pasé a mi ahorro', counter: true, dir: 'out' },
  { v: 'CARD_PAYMENT', l: 'Pago de tarjeta', counter: true, dir: 'any' },
];
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-DO', { dateStyle: 'medium', timeStyle: 'short' }) : 'nunca');

function compatible(ext: BankExternalAccount, a: Account) {
  if (a.isArchived || a.currency !== ext.currency) return false;
  return ext.providerType === 'credit' ? a.kind === 'credit_card' : ['checking', 'savings', 'cash', 'investment', 'other_asset'].includes(a.kind);
}

function ReviewRow({ r, ext, accounts, onDone }: { r: BankProviderTx; ext: BankExternalAccount | undefined; accounts: Account[]; onDone: () => Promise<void> }) {
  const { categories } = useLookups();
  const txs = useTransactions();
  const out = r.amount < 0;
  const isCard = ext?.providerType === 'credit';
  const options = RESOLVE_TYPES.filter((o) => (o.dir === 'any' || (o.dir === 'out') === out) && (isCard ? o.v !== 'EXPENSE' && o.v !== 'INCOME' && o.v !== 'SAVINGS_CONTRIBUTION' : !o.card));
  const [type, setType] = useState(''); // sin valor por defecto: la persona decide qué fue
  const [counter, setCounter] = useState('');
  const [category, setCategory] = useState('');
  const [existing, setExisting] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const opt = RESOLVE_TYPES.find((o) => o.v === type);
  const catKind = type === 'INCOME' ? 'income' : type === 'EXPENSE' || type === 'CARD_PURCHASE' ? 'expense' : type === 'SAVINGS_CONTRIBUTION' ? 'savings' : null;
  const abs = Math.abs(r.amount);
  const candidates = useMemo(() => txs.data.filter((t) => !t.pendingSync && t.amount === abs && Math.abs(Date.parse(t.occurredOn) - Date.parse(r.occurredOn)) <= 5 * 86_400_000).slice(0, 8), [txs.data, abs, r.occurredOn]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); await onDone(); } catch (e) { setErr(toAppError(e).message); } finally { setBusy(false); }
  }

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{r.description}</div>
          <div className="text-xs text-muted">{formatDateEs(r.occurredOn)} · {ext?.name ?? 'Cuenta'}{ext?.lastFour ? ` ••${ext.lastFour}` : ''}</div>
        </div>
        <Money value={cents(r.amount)} currency={r.currency} tone="auto" sign className="text-sm font-semibold" />
      </div>
      {r.reviewReason && <p className="text-xs text-amber-800">{r.reviewReason}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Tipo" value={type} onChange={(e) => setType(e.target.value)} className="w-auto py-1.5">
          <option value="">¿Qué fue este movimiento?</option>
          {options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
        </Select>
        {opt?.counter && (
          <Select aria-label="Otra cuenta" value={counter} onChange={(e) => setCounter(e.target.value)} className="w-auto py-1.5">
            <option value="">{out ? '¿Hacia qué cuenta?' : '¿Desde qué cuenta?'}</option>
            {accounts.filter((a) => a.id !== ext?.accountId && !a.isArchived && a.currency === r.currency).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        )}
        {catKind && (
          <Select aria-label="Categoría" value={category} onChange={(e) => setCategory(e.target.value)} className="w-auto py-1.5">
            <option value="">Sin categoría</option>
            {categories.filter((c) => c.kind === catKind).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        )}
        <Button size="sm" loading={busy} disabled={!type || (opt?.counter && !counter)}
          onClick={() => void run(() => bankAction({ action: 'resolve', rawId: r.id, decision: 'create', type, counterAccountId: counter || null, categoryId: category || null }))}>
          Registrar
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => bankAction({ action: 'resolve', rawId: r.id, decision: 'ignore' }))}>Descartar</Button>
      </div>
      {candidates.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">¿Ya lo registraste?</span>
          <Select aria-label="Movimiento existente" value={existing} onChange={(e) => setExisting(e.target.value)} className="w-auto py-1 text-xs">
            <option value="">Elige el movimiento…</option>
            {candidates.map((t) => <option key={t.id} value={t.id}>{formatDateEs(t.occurredOn)} · {t.description} · {formatMoney(t.amount, t.currency)}</option>)}
          </Select>
          <Button size="sm" variant="secondary" disabled={!existing || busy}
            onClick={() => void run(() => bankAction({ action: 'resolve', rawId: r.id, decision: 'link_existing', transactionId: existing }))}>Vincular</Button>
        </div>
      )}
      <ErrorBox error={err} title="No se pudo aplicar" />
    </li>
  );
}

export function BankConnectionsPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const bank = useBankData();
  const { snapshot: s, loading } = useFinancialSnapshot();
  const config = useQuery({ queryKey: ['bankConfig'], queryFn: () => bankAction<{ configured: boolean; environment: string | null }>({ action: 'config' }), retry: false, staleTime: 300_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const refresh = async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['bank'] }), qc.invalidateQueries({ queryKey: ['transactions'] })]); };
  async function run(key: string, fn: () => Promise<string | void>) {
    setBusy(key); setError(null); setInfo(null);
    try { const msg = await fn(); if (msg) setInfo(msg); await refresh(); } catch (e) { setError(toAppError(e).message); } finally { setBusy(null); }
  }

  const connect = (reconnect?: BankConnection) => run(reconnect ? `re-${reconnect.id}` : 'connect', async () => {
    const r = await openBridgeConnect({ userId: user!.id, connectionId: reconnect?.providerConnectionId });
    if (!r) return 'Conexión cancelada. No se guardó nada.';
    if (reconnect) {
      await bankAction({ action: 'sync', connectionId: reconnect.id });
      return 'Conexión reautorizada y sincronizada.';
    }
    const res = await bankAction<{ connection: { institution: string | null }; summary: { transactionsCreated: number; needsReview: number } }>(
      { action: 'register', connectionId: r.connectionId, scopedToken: r.scopedToken });
    return `${res.connection.institution ?? 'Banco'} conectado y confirmado por el proveedor. ${res.summary.transactionsCreated} movimiento(s) registrados, ${res.summary.needsReview} por revisar. Vincula cada cuenta bancaria con su cuenta de CangreVault.`;
  });

  if (bank.isLoading || loading) return <Loading />;
  const data = bank.data ?? { connections: [], accounts: [], pending: [], runs: [] };
  const extById = new Map(data.accounts.map((a) => [a.id, a]));
  const review = data.pending.filter((p) => p.reviewStatus === 'needs_review');
  const pendingBank = data.pending.filter((p) => p.reviewStatus === 'pending_bank');
  const unlinked = data.pending.filter((p) => p.reviewStatus === 'unlinked_account');
  const configured = config.data?.configured === true && Boolean(bridgeApplicationId);
  const live = data.connections.filter((c) => c.status !== 'revoked');

  return (
    <div className="space-y-5">
      <PageHeader title="Conexiones bancarias" subtitle="Movimientos y balances directamente desde tu banco, mediante el agregador autorizado Bridge."
        actions={<Button loading={busy === 'connect'} disabled={!configured || busy !== null} onClick={() => void connect()}>+ Conectar banco</Button>} />

      <Notice>
        Tus credenciales del banco se escriben en la ventana oficial de Bridge, nunca en CangreVault. Aquí solo se guarda un token
        de acceso de lectura, cifrado. La disponibilidad de <strong>Banreservas</strong> depende de Bridge: si no aparece en la lista de bancos,
        sigue usando <em>Importar PDF</em>.
      </Notice>
      {!configured && (
        <Notice tone="warn">
          {config.isLoading ? 'Comprobando la configuración…'
            : config.error ? `No se pudo consultar la integración: ${toAppError(config.error).message.replace(/\.?$/, '.')}`
              : !bridgeApplicationId ? 'Falta VITE_BRIDGE_APPLICATION_ID en las variables del sitio (Cloudflare).'
                : 'La integración no está configurada en el servidor (faltan BRIDGE_API_KEY o BANK_TOKEN_ENCRYPTION_KEY en los secretos de Supabase).'}
{' '}Mientras tanto, el botón de conexión está desactivado.
        </Notice>
      )}
      {config.data?.environment === 'sandbox' && <Notice tone="warn">Modo <strong>sandbox</strong> de Bridge: los datos son de prueba, no de tu banco real.</Notice>}
      <ErrorBox error={error} title="No se pudo completar" />
      {info && <Notice tone="ok">{info}</Notice>}
      <ErrorBox error={bank.error} title="No se pudieron cargar las conexiones" />

      {live.length === 0 && data.connections.length === 0 && (
        <EmptyState title="Aún no hay bancos conectados">
          Al conectar, Bridge te pedirá elegir tu banco y autorizar tus cuentas. Luego vinculas cada cuenta bancaria con su cuenta en CangreVault.
        </EmptyState>
      )}

      {data.connections.map((c) => {
        const accs = data.accounts.filter((a) => a.connectionId === c.id);
        return (
          <Card key={c.id}>
            <CardTitle
              hint={`Última sincronización: ${when(c.lastSyncedAt)}${c.environment === 'sandbox' ? ' · sandbox' : ''}`}
              action={c.status !== 'revoked' ? (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" loading={busy === `sync-${c.id}`} disabled={busy !== null}
                    onClick={() => void run(`sync-${c.id}`, async () => { await bankAction({ action: 'sync', connectionId: c.id }); return 'Sincronización terminada.'; })}>Sincronizar</Button>
                  <Button size="sm" variant="secondary" loading={busy === `re-${c.id}`} disabled={busy !== null || !configured} onClick={() => void connect(c)}>Reautorizar</Button>
                  <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => {
                    if (confirm('¿Desconectar este banco? Se revoca el acceso en Bridge. Los movimientos ya registrados se conservan.'))
                      void run(`rv-${c.id}`, async () => { await bankAction({ action: 'revoke', connectionId: c.id }); return 'Banco desconectado.'; });
                  }}>Desconectar</Button>
                </div>
              ) : undefined}>
              <span className="flex items-center gap-2">{c.institutionName ?? 'Banco'} <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge></span>
            </CardTitle>
            {c.lastError && <div className="mb-3"><Notice tone="warn">{c.lastError}</Notice></div>}
            {accs.length === 0 ? <p className="text-sm text-muted">El proveedor aún no devolvió cuentas para esta conexión.</p> : (
              <ul className="divide-y divide-line">
                {accs.map((a) => {
                  const linked = s.accounts.find((x) => x.id === a.accountId);
                  const ours = linked ? s.balances.get(linked.id)?.balance ?? ZERO : null;
                  // Bridge reporta la deuda de tarjeta como negativa; CangreVault la guarda positiva.
                  const bankComparable = a.balanceCurrent === null ? null : a.providerType === 'credit' ? cents(-a.balanceCurrent) : cents(a.balanceCurrent);
                  const diff = ours !== null && bankComparable !== null ? bankComparable - ours : null;
                  return (
                    <li key={a.id} className="grid gap-3 py-3 md:grid-cols-[1fr_auto] md:items-center">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{a.name}{a.lastFour && <span className="text-muted"> ••{a.lastFour}</span>}
                          <span className="ml-2 text-xs text-muted">{a.providerType === 'credit' ? 'Tarjeta de crédito' : 'Cuenta de depósito'} · {a.currency}</span></div>
                        <div className="mt-0.5 text-xs text-muted">
                          {a.balanceCurrent === null ? 'Balance no compartido por el proveedor'
                            : a.providerType === 'credit'
                              ? <>Deuda según el banco <Money value={cents(Math.abs(a.balanceCurrent))} currency={a.currency} />{a.balanceAvailable !== null && <> · disponible <Money value={cents(a.balanceAvailable)} currency={a.currency} /></>}{a.balanceLimit !== null && <> · límite <Money value={cents(a.balanceLimit)} currency={a.currency} /></>}</>
                              : <>Saldo según el banco <Money value={cents(a.balanceCurrent)} currency={a.currency} />{a.balanceAvailable !== null && a.balanceAvailable !== a.balanceCurrent && <> · disponible <Money value={cents(a.balanceAvailable)} currency={a.currency} /></>}</>}
                          {a.balanceUpdatedAt && <> · {when(a.balanceUpdatedAt)}</>}
                        </div>
                        {diff !== null && diff !== 0 && (
                          <div className="mt-1 text-xs text-amber-800">
                            CangreVault calcula <Money value={ours!} currency={a.currency} /> ({diff > 0 ? '+' : ''}{formatMoney(cents(diff), a.currency)} de diferencia).
                            Puede deberse a pendientes, movimientos en revisión o un saldo inicial distinto: concilia la cuenta si persiste.
                          </div>
                        )}
                        {diff === 0 && <div className="mt-1 text-xs text-pos">Coincide con el saldo calculado por CangreVault.</div>}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Select aria-label={`Cuenta de CangreVault para ${a.name}`} value={a.accountId ?? ''} className="w-56 py-1.5" disabled={busy !== null || c.status === 'revoked'}
                          onChange={(e) => {
                            const id = e.target.value || null;
                            const target = s.accounts.find((x) => x.id === id);
                            void run(`link-${a.id}`, async () => {
                              await linkBankAccount(a.id, { accountId: id, syncFrom: target ? (a.syncFrom ?? target.openingBalanceDate) : a.syncFrom });
                              if (id) { const r = await bankAction<{ created: number; review: number }>({ action: 'reclassify' }); return `Cuenta vinculada. ${r.created} movimiento(s) registrados, ${r.review} por revisar.`; }
                              return 'Cuenta desvinculada: sus nuevos movimientos no se registrarán.';
                            });
                          }}>
                          <option value="">Sin vincular</option>
                          {s.accounts.filter((x) => compatible(a, x)).map((x) => <option key={x.id} value={x.id}>{x.name} ({ACCOUNT_KIND_LABEL[x.kind]})</option>)}
                        </Select>
                        {linked && (
                          <label className="flex items-center gap-1 text-xs text-muted">Desde
                            <Input type="date" className="w-36 py-1" value={a.syncFrom ?? ''} disabled={busy !== null}
                              title="Los movimientos anteriores ya están incluidos en el saldo inicial y no se registran"
                              onChange={(e) => { const v = e.target.value; if (isIsoDate(v)) void run(`from-${a.id}`, async () => { await linkBankAccount(a.id, { syncFrom: v as IsoDate }); await bankAction({ action: 'reclassify' }); }); }} />
                          </label>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        );
      })}

      {(review.length > 0 || pendingBank.length > 0 || unlinked.length > 0) && (
        <Card>
          <CardTitle hint="Movimientos del banco que necesitan tu decisión antes de contarse. Nada ambiguo se registra solo.">
            Por revisar ({review.length})
          </CardTitle>
          {review.length === 0 ? <p className="text-sm text-muted">Nada pendiente de decisión.</p> : (
            <ul className="divide-y divide-line">
              {review.map((r) => <ReviewRow key={r.id} r={r} ext={extById.get(r.externalAccountId)} accounts={s.accounts} onDone={refresh} />)}
            </ul>
          )}
          {pendingBank.length > 0 && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-muted">Pendientes en el banco ({pendingBank.length}) — se registrarán cuando el banco los contabilice</summary>
              <ul className="mt-2 divide-y divide-line">
                {pendingBank.map((p) => (
                  <li key={p.id} className="flex justify-between gap-3 py-1.5 text-xs"><span className="truncate">{formatDateEs(p.occurredOn)} · {p.description}</span>
                    <Money value={cents(p.amount)} currency={p.currency} tone="auto" sign /></li>
                ))}
              </ul>
            </details>
          )}
          {unlinked.length > 0 && <p className="mt-3 text-xs text-muted">{unlinked.length} movimiento(s) esperan que vincules su cuenta bancaria.</p>}
        </Card>
      )}

      {data.runs.length > 0 && (
        <Card>
          <CardTitle hint="Cada ejecución queda registrada (manual, programada o al conectar).">Historial de sincronización</CardTitle>
          <ul className="divide-y divide-line text-sm">
            {data.runs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{when(r.startedAt)} <span className="text-xs text-muted">· {{ connect: 'al conectar', manual: 'manual', scheduled: 'programada', webhook: 'webhook' }[r.trigger] ?? r.trigger}</span></span>
                <span className="flex items-center gap-2 text-xs">
                  {r.transactionsCreated} nuevos · {r.needsReview} por revisar
                  <Badge tone={r.status === 'ok' ? 'pos' : r.status === 'running' ? 'neutral' : r.status === 'partial' ? 'warn' : 'neg'}>
                    {{ ok: 'correcta', partial: 'parcial', error: 'error', running: 'en curso' }[r.status] ?? r.status}
                  </Badge>
                </span>
                {r.error && <p className={cx('w-full text-xs', r.status === 'error' ? 'text-red-700' : 'text-amber-800')}>{r.error}</p>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
