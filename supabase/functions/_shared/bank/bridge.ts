// Implementación de BankProvider para Bridge (https://docs.bridge.com.do).
// Contrato tomado de la especificación OpenAPI oficial (versión 2024-01-01):
//   Authorization: Bearer <API key>        (identifica la aplicación; sandbox o producción)
//   X-Scoped-Token: <token del usuario>    (descifra los datos de ese usuario)
//   GET    /whoami
//   GET    /connections                     (scoped)
//   GET    /connections/{id}
//   DELETE /connections/{id}                (204)
//   GET    /connections/{id}/accounts       (scoped)
//   GET    /accounts/{id}/transactions      (scoped; cursor, limit, refreshedSince, date[gte])
// Bridge no documenta webhooks ni límites de peticiones: se reintenta con espera
// exponencial ante 429/5xx respetando Retry-After.
import {
  type BankProvider, type ProviderAccount, type ProviderConnection, type ProviderIdentity, type ProviderTransaction,
  type TransactionPage, type TransactionQuery, ProviderError, decimalToCents,
} from './provider.ts';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type Obj = Record<string, unknown>;

export interface BridgeOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: Fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const BRIDGE_DEFAULT_BASE_URL = 'https://api.bridge.com.do';

const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);

function req(o: unknown, field: string): Obj {
  if (!o || typeof o !== 'object') throw new ProviderError('invalid_response', `Respuesta sin ${field}`);
  return o as Obj;
}

export function mapBridgeConnection(c: unknown): ProviderConnection {
  const o = req(c, 'connection');
  const inst = (o.institution ?? {}) as Obj;
  const id = str(o.id);
  if (!id) throw new ProviderError('invalid_response', 'Conexión sin id');
  return { id, institutionId: str(inst.id), institutionName: str(inst.name), createdAt: str(o.createdAt), revokedAt: str(o.revokedAt) };
}

export function mapBridgeAccount(a: unknown): ProviderAccount {
  const o = req(a, 'account');
  const id = str(o.id);
  const type = o.type;
  if (!id || (type !== 'depository' && type !== 'credit')) throw new ProviderError('invalid_response', `Cuenta inválida del proveedor (${String(type)})`);
  const bal = (o.balance ?? null) as Obj | null;
  const opt = (v: unknown) => (v === undefined || v === null ? null : decimalToCents(v));
  const currency = str(o.currency)?.toUpperCase() ?? 'DOP';
  if (!/^[A-Z]{3}$/.test(currency)) throw new ProviderError('invalid_response', `Moneda inválida: ${currency}`);
  return {
    id, connectionId: str(o.connectionId) ?? '', type, name: str(o.name) ?? 'Cuenta', lastFour: str(o.lastFour), currency,
    balanceCurrent: bal ? opt(bal.current) : null, balanceAvailable: bal ? opt(bal.available) : null, balanceLimit: bal ? opt(bal.limit) : null,
    lastTransactionRefresh: str(o.lastTransactionRefresh),
  };
}

export function mapBridgeTransaction(t: unknown): ProviderTransaction {
  const o = req(t, 'transaction');
  const id = str(o.id);
  const status = o.status;
  const date = str(o.date)?.slice(0, 10) ?? null;
  if (!id || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ProviderError('invalid_response', 'Transacción sin id o fecha válida');
  if (status !== 'pending' && status !== 'posted' && status !== 'void') throw new ProviderError('invalid_response', `Estado desconocido: ${String(status)}`);
  return {
    id, accountId: str(o.accountId) ?? '', amount: decimalToCents(o.amount), date, description: (str(o.description) ?? '').trim() || 'Movimiento bancario',
    reference: str(o.reference), status, transactionRefresh: str(o.transactionRefresh), raw: t,
  };
}

export class BridgeProvider implements BankProvider {
  readonly name = 'bridge' as const;
  private base: string;
  private f: Fetch;
  private retries: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private opts: BridgeOptions) {
    if (!opts.apiKey) throw new ProviderError('config', 'Falta la clave de API de Bridge (BRIDGE_API_KEY)');
    this.base = (opts.baseUrl ?? BRIDGE_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.f = opts.fetch ?? ((i, init) => fetch(i, init));
    this.retries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async call(method: string, path: string, scopedToken?: string): Promise<Obj | null> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.opts.apiKey}`, Accept: 'application/json' };
    if (scopedToken) headers['X-Scoped-Token'] = scopedToken;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.f(`${this.base}${path}`, { method, headers });
      } catch (e) {
        if (attempt < this.retries) { await this.sleep(500 * 2 ** attempt); continue; }
        throw new ProviderError('unavailable', `No se pudo contactar al proveedor: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.status === 204) return null;
      if (res.ok) {
        try { return (await res.json()) as Obj; } catch { throw new ProviderError('invalid_response', 'Respuesta no JSON del proveedor', res.status); }
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
        const ra = Number(res.headers.get('Retry-After'));
        await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 500 * 2 ** attempt);
        continue;
      }
      // Nunca se incluye el cuerpo completo ni credenciales en el mensaje.
      if (res.status === 401) throw new ProviderError('config', 'Bridge rechazó la clave de API (401). Revisa BRIDGE_API_KEY y el entorno.', 401);
      if (res.status === 403) throw new ProviderError('reauth', 'Bridge rechazó el acceso a los datos de esta conexión (403). Hay que reconectar.', 403);
      if (res.status === 404) throw new ProviderError('not_found', 'El proveedor no encontró el recurso (404).', 404);
      if (res.status === 429) throw new ProviderError('rate_limited', 'Límite de peticiones del proveedor alcanzado; se reintentará más tarde.', 429);
      throw new ProviderError('unavailable', `Error del proveedor (${res.status}).`, res.status);
    }
  }

  async whoami(scopedToken?: string): Promise<ProviderIdentity> {
    const r = req(await this.call('GET', '/whoami', scopedToken), 'whoami');
    const app = req(r.application, 'application');
    const env = app.environment === 'PRODUCTION' ? 'production' : app.environment === 'SANDBOX' ? 'sandbox' : null;
    if (!env) throw new ProviderError('invalid_response', 'Entorno de aplicación desconocido');
    const u = r.user as Obj | undefined;
    return { environment: env, applicationId: str(app.id) ?? '', user: u ? { id: str(u.id) ?? '', externalUserId: str(u.externalUserId) } : null };
  }

  async listConnections(scopedToken: string): Promise<ProviderConnection[]> {
    const r = req(await this.call('GET', '/connections', scopedToken), 'connections');
    if (!Array.isArray(r.connections)) throw new ProviderError('invalid_response', 'Lista de conexiones inválida');
    return r.connections.map(mapBridgeConnection);
  }

  async getConnection(connectionId: string): Promise<ProviderConnection> {
    const r = req(await this.call('GET', `/connections/${encodeURIComponent(connectionId)}`), 'connection');
    return mapBridgeConnection(r.connection);
  }

  async listAccounts(connectionId: string, scopedToken: string): Promise<ProviderAccount[]> {
    const r = req(await this.call('GET', `/connections/${encodeURIComponent(connectionId)}/accounts`, scopedToken), 'accounts');
    if (!Array.isArray(r.accounts)) throw new ProviderError('invalid_response', 'Lista de cuentas inválida');
    return r.accounts.map(mapBridgeAccount);
  }

  async listTransactions(accountId: string, scopedToken: string, q: TransactionQuery): Promise<TransactionPage> {
    const p = new URLSearchParams();
    if (q.cursor) p.set('cursor', q.cursor);
    if (q.refreshedSince) p.set('refreshedSince', q.refreshedSince);
    if (q.dateFrom) p.set('date[gte]', q.dateFrom);
    p.set('limit', String(Math.min(1000, Math.max(1, q.limit ?? 500))));
    const r = req(await this.call('GET', `/accounts/${encodeURIComponent(accountId)}/transactions?${p}`, scopedToken), 'transactions');
    if (!Array.isArray(r.transactions)) throw new ProviderError('invalid_response', 'Lista de transacciones inválida');
    const pg = (r.pagination ?? {}) as Obj;
    return { transactions: r.transactions.map(mapBridgeTransaction), hasMore: pg.hasMore === true, nextCursor: str(pg.nextCursor) };
  }

  async revokeConnection(connectionId: string): Promise<void> {
    await this.call('DELETE', `/connections/${encodeURIComponent(connectionId)}`);
  }
}
