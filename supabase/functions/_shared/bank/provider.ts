// Abstracción de proveedor bancario (agregador). CangreVault depende de ESTA interfaz,
// no de Bridge: otro agregador se añade implementando BankProvider.
// Código puro (sin Deno.*) para poder probarlo con Vitest y usarlo en Edge Functions.

export type ProviderEnvironment = 'sandbox' | 'production';

export interface ProviderConnection {
  id: string;
  institutionId: string | null;
  institutionName: string | null;
  createdAt: string | null;
  revokedAt: string | null;
}

export interface ProviderAccount {
  id: string;
  connectionId: string;
  type: 'depository' | 'credit';
  name: string;
  lastFour: string | null;
  currency: string;
  /** Centavos con el signo del proveedor; null si la conexión no comparte balances. */
  balanceCurrent: number | null;
  balanceAvailable: number | null;
  balanceLimit: number | null;
  lastTransactionRefresh: string | null;
}

export interface ProviderTransaction {
  id: string;
  accountId: string;
  /** Centavos con el signo del proveedor: negativo = sale dinero / cargo. */
  amount: number;
  date: string;
  description: string;
  reference: string | null;
  status: 'pending' | 'posted' | 'void';
  transactionRefresh: string | null;
  raw: unknown;
}

export interface TransactionQuery {
  refreshedSince?: string | null;
  dateFrom?: string | null;
  cursor?: string | null;
  limit?: number;
}

export interface TransactionPage {
  transactions: ProviderTransaction[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ProviderIdentity {
  environment: ProviderEnvironment;
  applicationId: string;
  user: { id: string; externalUserId: string | null } | null;
}

export type ProviderErrorKind = 'config' | 'reauth' | 'not_found' | 'rate_limited' | 'unavailable' | 'invalid_response';

export class ProviderError extends Error {
  constructor(public kind: ProviderErrorKind, message: string, public status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface BankProvider {
  readonly name: 'bridge';
  whoami(scopedToken?: string): Promise<ProviderIdentity>;
  listConnections(scopedToken: string): Promise<ProviderConnection[]>;
  getConnection(connectionId: string): Promise<ProviderConnection>;
  listAccounts(connectionId: string, scopedToken: string): Promise<ProviderAccount[]>;
  listTransactions(accountId: string, scopedToken: string, q: TransactionQuery): Promise<TransactionPage>;
  revokeConnection(connectionId: string): Promise<void>;
}

/** Recorre todas las páginas (cursor) con un tope de seguridad. */
export async function listAllTransactions(
  provider: BankProvider, accountId: string, scopedToken: string, q: Omit<TransactionQuery, 'cursor'>, maxPages = 50,
): Promise<ProviderTransaction[]> {
  const out: ProviderTransaction[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const page = await provider.listTransactions(accountId, scopedToken, { ...q, cursor });
    out.push(...page.transactions);
    if (!page.hasMore || !page.nextCursor) return out;
    if (page.nextCursor === cursor) throw new ProviderError('invalid_response', 'El proveedor repitió el cursor de paginación');
    cursor = page.nextCursor;
  }
  throw new ProviderError('invalid_response', `Se alcanzó el máximo de ${maxPages} páginas; la sincronización continuará en la próxima ejecución`);
}

/**
 * Número decimal del proveedor (JSON) → centavos enteros, sin errores de coma flotante
 * acumulados: se redondea a 2 decimales en base 10 antes de convertir.
 */
export function decimalToCents(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ProviderError('invalid_response', `Importe inválido del proveedor: ${String(v)}`);
  const s = v.toFixed(2);
  const neg = s.startsWith('-');
  const [i, f] = (neg ? s.slice(1) : s).split('.');
  const c = Number(i) * 100 + Number(f);
  if (!Number.isSafeInteger(c)) throw new ProviderError('invalid_response', 'Importe fuera de rango');
  return neg ? -c : c;
}

export function centsToDecimal(c: number): string {
  const neg = c < 0;
  const a = Math.abs(c);
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
