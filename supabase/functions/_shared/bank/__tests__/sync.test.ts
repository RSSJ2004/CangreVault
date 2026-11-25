// PRUEBAS de orquestación con un PROVEEDOR FALSO y un STORE EN MEMORIA (dobles de
// prueba). Verifican idempotencia, cursores incrementales, errores y revocación.
// La integración contra Bridge real se prueba desde el sandbox (ver BANK_INTEGRATION_REPORT).
import { describe, expect, it } from 'vitest';
import { type BankProvider, type ProviderAccount, type ProviderTransaction, ProviderError } from '../provider';
import { type ConnectionRow, type ExternalAccountRow, type Store, syncConnection } from '../sync';
import type { ClassifyRow, CreateDecision } from '../classify';
import { decryptToken, encryptToken, importKey } from '../crypto';

const USER = 'user-1';

class FakeProvider implements BankProvider {
  readonly name = 'bridge' as const;
  revoked: string | null = null;
  fail: ProviderError | null = null;
  calls: { accountId: string; refreshedSince?: string | null; dateFrom?: string | null }[] = [];
  constructor(public accounts: ProviderAccount[], public txs: Record<string, ProviderTransaction[]>) {}
  async whoami() { return { environment: 'sandbox' as const, applicationId: 'app', user: null }; }
  async listConnections() { return []; }
  async getConnection(id: string) { return { id, institutionId: 'inst_x', institutionName: 'Banco de prueba', createdAt: null, revokedAt: this.revoked }; }
  async listAccounts() { if (this.fail) throw this.fail; return this.accounts; }
  async listTransactions(accountId: string, _t: string, q: { refreshedSince?: string | null; dateFrom?: string | null }) {
    this.calls.push({ accountId, refreshedSince: q.refreshedSince, dateFrom: q.dateFrom });
    return { transactions: this.txs[accountId] ?? [], hasMore: false, nextCursor: null };
  }
  async revokeConnection() { this.revoked = '2026-11-25T00:00:00Z'; }
}

class MemoryStore implements Store {
  conn: Record<string, unknown> = {};
  ext = new Map<string, ExternalAccountRow & { name: string; balance: number | null }>();
  raw = new Map<string, { id: string; ext: string; t: ProviderTransaction; status: string; reason: string | null; txId: string | null }>();
  txs = new Map<string, CreateDecision & { id: string }>();
  runs: unknown[] = [];
  links: Record<string, { accountId: string; kind: string }> = {};
  async updateConnection(_id: string, p: object) { Object.assign(this.conn, p); }
  async upsertExternalAccount(_c: ConnectionRow, a: ProviderAccount) {
    const prev = this.ext.get(a.id);
    const link = this.links[a.id];
    const row = { id: prev?.id ?? `ext-${a.id}`, providerAccountId: a.id, providerType: a.type, currency: a.currency, accountId: link?.accountId ?? null,
      syncEnabled: true, syncFrom: null, lastTransactionRefresh: prev?.lastTransactionRefresh ?? null, name: a.name, balance: a.balanceCurrent };
    this.ext.set(a.id, row);
    return row;
  }
  async setAccountRefreshCursor(extId: string, c: string | null) { for (const e of this.ext.values()) if (e.id === extId) e.lastTransactionRefresh = c; }
  async upsertProviderTransactions(_c: ConnectionRow, ext: ExternalAccountRow, txs: ProviderTransaction[]) {
    for (const t of txs) {
      const k = `${ext.id}|${t.id}`;
      const prev = this.raw.get(k);
      this.raw.set(k, { id: prev?.id ?? `raw-${t.id}`, ext: ext.id, t, status: prev?.status ?? 'unlinked_account', reason: prev?.reason ?? null, txId: prev?.txId ?? null });
    }
  }
  async loadClassifyRows(): Promise<ClassifyRow[]> {
    const extById = new Map([...this.ext.values()].map((e) => [e.id, e]));
    return [...this.raw.values()].filter((r) => r.status !== 'ignored' && (!r.txId || r.t.status === 'void')).map((r) => {
      const e = extById.get(r.ext)!;
      const link = Object.entries(this.links).find(([pid]) => pid === e.providerAccountId)?.[1];
      return { rawId: r.id, providerTransactionId: r.t.id, externalAccountId: e.id, providerType: e.providerType, accountId: e.accountId,
        accountKind: (link?.kind ?? null) as never, currency: e.currency, amount: r.t.amount, occurredOn: r.t.date, description: r.t.description,
        reference: r.t.reference, status: r.t.status, syncFrom: null, linkedTransactionId: r.txId };
    });
  }
  async loadExistingTransactions() { return []; }
  async loadCategories() { return []; }
  async insertTransaction(_u: string, clientId: string, d: CreateDecision) {
    if (!this.txs.has(clientId)) this.txs.set(clientId, { ...d, id: `tx-${clientId}` });
    return this.txs.get(clientId)!.id;
  }
  async setRawStatus(_u: string, ids: string[], status: string, reason: string | null, txId: string | null) {
    for (const r of this.raw.values()) if (ids.includes(r.id)) Object.assign(r, { status, reason, txId });
  }
  async startRun() { this.runs.push({}); return `run-${this.runs.length}`; }
  async finishRun(_id: string, s: object) { Object.assign(this.runs[this.runs.length - 1] as object, s); }
}

const conn: ConnectionRow = { id: 'c1', userId: USER, provider: 'bridge', providerConnectionId: 'con_1', status: 'active', consecutiveFailures: 0 };
const acc = (id: string, type: 'depository' | 'credit', refresh: string): ProviderAccount => ({
  id, connectionId: 'con_1', type, name: id, lastFour: '0000', currency: 'DOP', balanceCurrent: 100, balanceAvailable: null, balanceLimit: null, lastTransactionRefresh: refresh,
});
const tx = (id: string, accountId: string, amount: number, description: string, status: ProviderTransaction['status'] = 'posted'): ProviderTransaction => ({
  id, accountId, amount, date: '2026-11-20', description, reference: null, status, transactionRefresh: 'txr_1', raw: {},
});

function setup() {
  const provider = new FakeProvider([acc('acc_dep', 'depository', 'txr_1'), acc('acc_card', 'credit', 'txr_1')], {
    acc_dep: [tx('t1', 'acc_dep', 2424000, 'NOMINA'), tx('t2', 'acc_dep', -320000, 'PAGO TARJETA'), tx('t3', 'acc_dep', -5000, 'COLMADO', 'pending')],
    acc_card: [tx('t4', 'acc_card', -245000, 'SUPERMERCADO'), tx('t5', 'acc_card', 320000, 'SU PAGO')],
  });
  const store = new MemoryStore();
  store.links = { acc_dep: { accountId: 'acc-debit', kind: 'checking' }, acc_card: { accountId: 'acc-card', kind: 'credit_card' } };
  return { provider, store };
}

describe('sincronización', () => {
  it('sincroniza cuentas, crea un hecho por evento y deja pendientes fuera', async () => {
    const { provider, store } = setup();
    const s = await syncConnection({ provider, store, conn, scopedToken: 't', trigger: 'connect', now: new Date('2026-11-25T12:00:00Z') });
    expect(s).toMatchObject({ status: 'ok', accountsSeen: 2, providerRows: 5, transactionsCreated: 3 });
    const types = [...store.txs.values()].map((t) => t.type).sort();
    expect(types).toEqual(['CARD_PAYMENT', 'CARD_PURCHASE', 'INCOME']);
    expect([...store.raw.values()].find((r) => r.t.id === 't3')!.status).toBe('pending_bank');
    expect(store.conn).toMatchObject({ status: 'active', lastSyncStatus: 'ok', institutionName: 'Banco de prueba' });
  });

  it('es idempotente: una segunda sincronización no duplica movimientos', async () => {
    const { provider, store } = setup();
    await syncConnection({ provider, store, conn, scopedToken: 't', trigger: 'manual' });
    await syncConnection({ provider, store, conn, scopedToken: 't', trigger: 'manual' });
    expect(store.txs.size).toBe(3);
  });

  it('usa el cursor incremental después de la primera sincronización', async () => {
    const { provider, store } = setup();
    await syncConnection({ provider, store, conn, scopedToken: 't', trigger: 'manual', now: new Date('2026-11-25T00:00:00Z') });
    expect(provider.calls[0]).toMatchObject({ dateFrom: '2026-08-27', refreshedSince: undefined });
    await syncConnection({ provider, store, conn, scopedToken: 't', trigger: 'manual' });
    expect(provider.calls[2]).toMatchObject({ refreshedSince: 'txr_1' });
  });

  it('un pendiente que el banco contabiliza después se registra una sola vez', async () => {
    const { provider, store } = setup();
    await syncConnection({ provider, store, conn, scopedToken: 't', trigger: 'manual' });
    provider.txs.acc_dep = [tx('t3', 'acc_dep', -5000, 'COLMADO', 'posted')];
    await syncConnection({ provider, store, conn, scopedToken: 't', trigger: 'manual' });
    await syncConnection({ provider, store, conn, scopedToken: 't', trigger: 'manual' });
    expect([...store.txs.values()].filter((t) => t.rawIds.includes('raw-t3'))).toHaveLength(1);
  });

  it('scoped token rechazado → reautorización requerida, sin crear nada', async () => {
    const { provider, store } = setup();
    provider.fail = new ProviderError('reauth', 'Bridge rechazó el acceso (403)', 403);
    const s = await syncConnection({ provider, store, conn, scopedToken: 't', trigger: 'scheduled' });
    expect(s.status).toBe('error');
    expect(store.conn).toMatchObject({ status: 'reauth_required', consecutiveFailures: 1 });
    expect(store.txs.size).toBe(0);
  });

  it('error temporal → estado error con mensaje, y se recupera en el siguiente intento', async () => {
    const { provider, store } = setup();
    provider.fail = new ProviderError('unavailable', 'Error del proveedor (503).', 503);
    await syncConnection({ provider, store, conn, scopedToken: 't', trigger: 'scheduled' });
    expect(store.conn).toMatchObject({ status: 'error', lastError: 'Error del proveedor (503).' });
    provider.fail = null;
    const s = await syncConnection({ provider, store, conn: { ...conn, consecutiveFailures: 1 }, scopedToken: 't', trigger: 'scheduled' });
    expect(s.status).toBe('ok');
    expect(store.conn).toMatchObject({ status: 'active', consecutiveFailures: 0, lastError: null });
  });

  it('conexión revocada en el proveedor → se marca revocada y no se sincroniza', async () => {
    const { provider, store } = setup();
    await provider.revokeConnection();
    const s = await syncConnection({ provider, store, conn, scopedToken: 't', trigger: 'scheduled' });
    expect(s.status).toBe('error');
    expect(store.conn).toMatchObject({ status: 'revoked' });
    expect(provider.calls).toHaveLength(0);
  });

  it('cuentas sin vincular no generan movimientos hasta que se vinculan', async () => {
    const { provider, store } = setup();
    store.links = {};
    const s = await syncConnection({ provider, store, conn, scopedToken: 't', trigger: 'connect' });
    expect(s.transactionsCreated).toBe(0);
    expect([...store.raw.values()].filter((r) => r.status === 'unlinked_account')).toHaveLength(4);
  });
});

describe('cifrado del token', () => {
  it('cifra y descifra; el texto cifrado de un usuario no sirve para otro', async () => {
    const key = await importKey(btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
    const enc = await encryptToken(key, 'brdg_st_secreto', 'user-a');
    expect(enc.ciphertext).not.toContain('secreto');
    expect(await decryptToken(key, enc.ciphertext, enc.iv, 'user-a')).toBe('brdg_st_secreto');
    await expect(decryptToken(key, enc.ciphertext, enc.iv, 'user-b')).rejects.toBeTruthy();
  });

  it('rechaza claves con longitud incorrecta o ausentes', async () => {
    await expect(importKey(undefined)).rejects.toThrow(/BANK_TOKEN_ENCRYPTION_KEY/);
    await expect(importKey(btoa('corta'))).rejects.toThrow(/32 bytes/);
  });
});
