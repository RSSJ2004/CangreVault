// Orquestación de una sincronización: proveedor → movimientos originales → clasificación
// → movimientos de CangreVault. Independiente de Supabase gracias a la interfaz Store
// (la Edge Function la implementa con PostgREST; las pruebas, en memoria).
import { type BankProvider, type ProviderAccount, type ProviderTransaction, ProviderError, listAllTransactions } from './provider.ts';
import { type CategoryRef, type ClassifyRow, type CreateDecision, type ExistingTx, classifyBankRows, stableUuid } from './classify.ts';

export interface ConnectionRow {
  id: string;
  userId: string;
  provider: 'bridge';
  providerConnectionId: string;
  status: 'active' | 'error' | 'reauth_required' | 'revoked';
  consecutiveFailures: number;
}

export interface ExternalAccountRow {
  id: string;
  providerAccountId: string;
  providerType: 'depository' | 'credit';
  currency: string;
  accountId: string | null;
  syncEnabled: boolean;
  syncFrom: string | null;
  lastTransactionRefresh: string | null;
}

export interface ConnectionPatch {
  status?: ConnectionRow['status'];
  lastSyncedAt?: string;
  lastSyncStatus?: 'ok' | 'partial' | 'error';
  lastError?: string | null;
  consecutiveFailures?: number;
  institutionId?: string | null;
  institutionName?: string | null;
  revokedAt?: string | null;
}

export interface RunSummary {
  status: 'ok' | 'partial' | 'error';
  accountsSeen: number;
  providerRows: number;
  transactionsCreated: number;
  needsReview: number;
  error: string | null;
}

export interface Store {
  updateConnection(connectionId: string, patch: ConnectionPatch): Promise<void>;
  upsertExternalAccount(conn: ConnectionRow, a: ProviderAccount, syncedAt: string): Promise<ExternalAccountRow>;
  setAccountRefreshCursor(externalAccountId: string, cursor: string | null): Promise<void>;
  upsertProviderTransactions(conn: ConnectionRow, ext: ExternalAccountRow, txs: ProviderTransaction[]): Promise<void>;
  /** Filas a (re)clasificar: sin decisión del usuario y no contabilizadas, o anuladas tras contabilizarse. */
  loadClassifyRows(userId: string): Promise<ClassifyRow[]>;
  loadExistingTransactions(userId: string, accountIds: string[], fromDate: string): Promise<ExistingTx[]>;
  loadCategories(userId: string): Promise<CategoryRef[]>;
  /** Inserta idempotentemente (client_id) y devuelve el id del movimiento. */
  insertTransaction(userId: string, clientId: string, d: CreateDecision): Promise<string>;
  setRawStatus(userId: string, rawIds: string[], status: string, reason: string | null, transactionId: string | null): Promise<void>;
  startRun(conn: ConnectionRow, trigger: 'connect' | 'manual' | 'scheduled' | 'webhook'): Promise<string>;
  finishRun(runId: string, s: RunSummary): Promise<void>;
}

export const DEFAULT_HISTORY_DAYS = 90;
const CLIENT_NS = 'cangrevault-bank';

function addDays(iso: string, n: number) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

export function messageOf(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 900);
}

/** Clasifica y contabiliza todo lo pendiente del usuario (también se usa tras vincular una cuenta). */
export async function applyClassification(store: Store, userId: string, today: string): Promise<{ created: number; review: number }> {
  const rows = await store.loadClassifyRows(userId);
  if (!rows.length) return { created: 0, review: 0 };
  const accountIds = [...new Set(rows.map((r) => r.accountId).filter((x): x is string => Boolean(x)))];
  const minDate = rows.reduce((m, r) => (r.occurredOn < m ? r.occurredOn : m), today);
  const [existing, categories] = await Promise.all([
    store.loadExistingTransactions(userId, accountIds, addDays(minDate, -7)),
    store.loadCategories(userId),
  ]);
  const decisions = classifyBankRows(rows, existing, categories);
  let created = 0, review = 0;
  for (const d of decisions) {
    if (d.action === 'create') {
      const clientId = await stableUuid(CLIENT_NS, `${userId}:${d.key}`);
      const txId = await store.insertTransaction(userId, clientId, d);
      await store.setRawStatus(userId, d.rawIds, 'linked', null, txId);
      created++;
    } else {
      await store.setRawStatus(userId, d.rawIds, d.status, d.reason, null);
      if (d.status === 'needs_review') review++;
    }
  }
  return { created, review };
}

export async function syncConnection(opts: {
  provider: BankProvider; store: Store; conn: ConnectionRow; scopedToken: string;
  trigger: 'connect' | 'manual' | 'scheduled' | 'webhook'; now?: Date;
}): Promise<RunSummary> {
  const { provider, store, conn, scopedToken, trigger } = opts;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);
  const runId = await store.startRun(conn, trigger);
  const summary: RunSummary = { status: 'ok', accountsSeen: 0, providerRows: 0, transactionsCreated: 0, needsReview: 0, error: null };
  const errors: string[] = [];

  try {
    const remote = await provider.getConnection(conn.providerConnectionId);
    if (remote.revokedAt) {
      await store.updateConnection(conn.id, { status: 'revoked', revokedAt: remote.revokedAt, lastSyncedAt: nowIso, lastSyncStatus: 'error', lastError: 'La conexión fue revocada en el proveedor.' });
      summary.status = 'error'; summary.error = 'La conexión fue revocada en el proveedor.';
      await store.finishRun(runId, summary);
      return summary;
    }
    const accounts = await provider.listAccounts(conn.providerConnectionId, scopedToken);
    summary.accountsSeen = accounts.length;
    for (const a of accounts) {
      const ext = await store.upsertExternalAccount(conn, a, nowIso);
      if (!ext.syncEnabled) continue;
      try {
        const txs = await listAllTransactions(provider, a.id, scopedToken, ext.lastTransactionRefresh
          ? { refreshedSince: ext.lastTransactionRefresh }
          : { dateFrom: ext.syncFrom ?? addDays(today, -DEFAULT_HISTORY_DAYS) });
        await store.upsertProviderTransactions(conn, ext, txs);
        summary.providerRows += txs.length;
        // El cursor solo avanza cuando todo lo anterior quedó guardado.
        await store.setAccountRefreshCursor(ext.id, a.lastTransactionRefresh ?? ext.lastTransactionRefresh);
      } catch (e) {
        if (e instanceof ProviderError && (e.kind === 'reauth' || e.kind === 'config')) throw e;
        errors.push(`${a.name}: ${messageOf(e)}`);
      }
    }
    const r = await applyClassification(store, conn.userId, today);
    summary.transactionsCreated = r.created;
    summary.needsReview = r.review;
    summary.status = errors.length ? 'partial' : 'ok';
    summary.error = errors.length ? errors.join(' · ').slice(0, 900) : null;
    await store.updateConnection(conn.id, {
      status: 'active', lastSyncedAt: nowIso, lastSyncStatus: summary.status, lastError: summary.error,
      consecutiveFailures: errors.length ? conn.consecutiveFailures + 1 : 0,
      institutionId: remote.institutionId, institutionName: remote.institutionName,
    });
  } catch (e) {
    summary.status = 'error';
    summary.error = messageOf(e);
    const status = e instanceof ProviderError && e.kind === 'reauth' ? 'reauth_required' : 'error';
    await store.updateConnection(conn.id, {
      status, lastSyncedAt: nowIso, lastSyncStatus: 'error', lastError: summary.error, consecutiveFailures: conn.consecutiveFailures + 1,
    });
  }
  await store.finishRun(runId, summary);
  return summary;
}
