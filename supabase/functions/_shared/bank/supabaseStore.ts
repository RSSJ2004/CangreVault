// Store de sincronización sobre Supabase con service_role. TODA consulta filtra por
// user_id explícitamente (service_role omite RLS) y las reglas contables siguen
// aplicándose por el trigger validate_transaction de la base de datos.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { ProviderAccount, ProviderTransaction } from './provider.ts';
import { centsToDecimal } from './provider.ts';
import type { CategoryRef, ClassifyRow, CreateDecision, ExistingTx, InternalKind } from './classify.ts';
import type { ConnectionPatch, ConnectionRow, ExternalAccountRow, RunSummary, Store } from './sync.ts';

type Row = Record<string, unknown>;
const cents = (v: unknown) => Math.round(Number(v) * 100);
const money = (c: number | null) => (c === null ? null : centsToDecimal(c));

function check<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

export function mapConnection(r: Row): ConnectionRow {
  return { id: String(r.id), userId: String(r.user_id), provider: 'bridge', providerConnectionId: String(r.provider_connection_id),
    status: r.status as ConnectionRow['status'], consecutiveFailures: Number(r.consecutive_failures ?? 0) };
}

function mapExt(r: Row): ExternalAccountRow {
  return { id: String(r.id), providerAccountId: String(r.provider_account_id), providerType: r.provider_type as 'depository' | 'credit',
    currency: String(r.currency), accountId: (r.account_id as string | null) ?? null, syncEnabled: Boolean(r.sync_enabled),
    syncFrom: (r.sync_from as string | null) ?? null, lastTransactionRefresh: (r.last_transaction_refresh as string | null) ?? null };
}

export class SupabaseStore implements Store {
  constructor(private db: SupabaseClient) {}

  async updateConnection(id: string, p: ConnectionPatch) {
    const row: Row = {};
    if (p.status !== undefined) row.status = p.status;
    if (p.lastSyncedAt !== undefined) row.last_synced_at = p.lastSyncedAt;
    if (p.lastSyncStatus !== undefined) row.last_sync_status = p.lastSyncStatus;
    if (p.lastError !== undefined) row.last_error = p.lastError;
    if (p.consecutiveFailures !== undefined) row.consecutive_failures = p.consecutiveFailures;
    if (p.institutionId !== undefined) row.institution_id = p.institutionId;
    if (p.institutionName !== undefined) row.institution_name = p.institutionName;
    if (p.revokedAt !== undefined) row.revoked_at = p.revokedAt;
    check(await this.db.from('bank_connections').update(row).eq('id', id));
  }

  async upsertExternalAccount(conn: ConnectionRow, a: ProviderAccount, syncedAt: string) {
    const balance = a.balanceCurrent === null ? {} : {
      balance_current: money(a.balanceCurrent), balance_available: money(a.balanceAvailable), balance_limit: money(a.balanceLimit), balance_updated_at: syncedAt,
    };
    const rows = check(await this.db.from('bank_external_accounts').upsert({
      user_id: conn.userId, connection_id: conn.id, provider_account_id: a.id, provider_type: a.type, name: a.name.slice(0, 200),
      last_four: a.lastFour?.slice(-8) ?? null, currency: a.currency, deleted_at: null, ...balance,
    }, { onConflict: 'connection_id,provider_account_id' }).select('*')) as Row[];
    return mapExt(rows[0]!);
  }

  async setAccountRefreshCursor(id: string, cursor: string | null) {
    check(await this.db.from('bank_external_accounts').update({ last_transaction_refresh: cursor }).eq('id', id));
  }

  async upsertProviderTransactions(conn: ConnectionRow, ext: ExternalAccountRow, txs: ProviderTransaction[]) {
    for (let i = 0; i < txs.length; i += 200) {
      const chunk = txs.slice(i, i + 200).map((t) => ({
        user_id: conn.userId, external_account_id: ext.id, provider_transaction_id: t.id, amount: centsToDecimal(t.amount), currency: ext.currency,
        occurred_on: t.date, description: t.description.slice(0, 500), reference: t.reference, provider_status: t.status,
        transaction_refresh: t.transactionRefresh, raw: t.raw ?? {},
      }));
      // review_status/transaction_id no se envían: una actualización del banco no borra la decisión tomada.
      check(await this.db.from('bank_provider_transactions').upsert(chunk, { onConflict: 'external_account_id,provider_transaction_id' }));
    }
  }

  async loadClassifyRows(userId: string): Promise<ClassifyRow[]> {
    const [raw, exts] = await Promise.all([
      this.db.from('bank_provider_transactions').select('*').eq('user_id', userId).neq('review_status', 'ignored').limit(5000),
      this.db.from('bank_external_accounts').select('*, accounts:account_id(kind, deleted_at)').eq('user_id', userId).is('deleted_at', null),
    ]);
    const extById = new Map((check(exts) as Row[]).map((e) => [String(e.id), e]));
    return (check(raw) as Row[])
      .filter((r) => !r.transaction_id || r.provider_status === 'void')
      .filter((r) => extById.has(String(r.external_account_id)))
      .map((r) => {
        const e = extById.get(String(r.external_account_id))!;
        const acc = e.accounts as Row | null;
        const linked = e.sync_enabled && e.account_id && acc && !acc.deleted_at;
        return {
          rawId: String(r.id), providerTransactionId: String(r.provider_transaction_id), externalAccountId: String(e.id),
          providerType: e.provider_type as 'depository' | 'credit', accountId: linked ? String(e.account_id) : null,
          accountKind: linked ? (acc!.kind as InternalKind) : null, currency: String(r.currency), amount: cents(r.amount),
          occurredOn: String(r.occurred_on), description: String(r.description), reference: (r.reference as string | null) ?? null,
          status: r.provider_status as ClassifyRow['status'], syncFrom: (e.sync_from as string | null) ?? null,
          linkedTransactionId: (r.transaction_id as string | null) ?? null,
        };
      });
  }

  async loadExistingTransactions(userId: string, accountIds: string[], fromDate: string): Promise<ExistingTx[]> {
    if (!accountIds.length) return [];
    const ids = accountIds.join(',');
    const rows = check(await this.db.from('transactions').select('id, account_id, to_account_id, amount, occurred_on, source, description')
      .eq('user_id', userId).is('deleted_at', null).gte('occurred_on', fromDate)
      .or(`account_id.in.(${ids}),to_account_id.in.(${ids})`).limit(5000)) as Row[];
    return rows.map((r) => ({ id: String(r.id), accountId: String(r.account_id), toAccountId: (r.to_account_id as string | null) ?? null,
      amount: cents(r.amount), occurredOn: String(r.occurred_on), source: String(r.source), description: String(r.description) }));
  }

  async loadCategories(userId: string): Promise<CategoryRef[]> {
    const rows = check(await this.db.from('categories').select('id, slug, kind').eq('user_id', userId).is('deleted_at', null)) as Row[];
    return rows.map((r) => ({ id: String(r.id), slug: (r.slug as string | null) ?? null, kind: r.kind as CategoryRef['kind'] }));
  }

  async insertTransaction(userId: string, clientId: string, d: CreateDecision): Promise<string> {
    const existing = check(await this.db.from('transactions').select('id').eq('client_id', clientId).eq('user_id', userId).limit(1)) as Row[];
    if (existing[0]) return String(existing[0].id);
    const rows = check(await this.db.from('transactions').insert({
      user_id: userId, client_id: clientId, type: d.type, account_id: d.accountId, to_account_id: d.toAccountId,
      amount: centsToDecimal(d.amount), currency: d.currency, occurred_on: d.occurredOn, description: d.description.slice(0, 300),
      category_id: d.categoryId, classification_source: d.categoryId ? 'rules' : null, bank_reference: d.reference?.slice(0, 120) ?? null,
      dedupe_key: `bank:${d.key}`.slice(0, 200), entry_mode: 'import', source: 'bank_sync', ai_status: 'none',
    }).select('id')) as Row[];
    return String(rows[0]!.id);
  }

  async setRawStatus(userId: string, ids: string[], status: string, reason: string | null, txId: string | null) {
    check(await this.db.from('bank_provider_transactions').update({ review_status: status, review_reason: reason, transaction_id: txId })
      .eq('user_id', userId).in('id', ids));
  }

  async startRun(conn: ConnectionRow, trigger: string) {
    const rows = check(await this.db.from('bank_sync_runs').insert({ user_id: conn.userId, connection_id: conn.id, trigger }).select('id')) as Row[];
    return String(rows[0]!.id);
  }

  async finishRun(id: string, s: RunSummary) {
    check(await this.db.from('bank_sync_runs').update({
      finished_at: new Date().toISOString(), status: s.status, accounts_seen: s.accountsSeen, provider_rows: s.providerRows,
      transactions_created: s.transactionsCreated, needs_review: s.needsReview, error: s.error,
    }).eq('id', id));
  }
}
