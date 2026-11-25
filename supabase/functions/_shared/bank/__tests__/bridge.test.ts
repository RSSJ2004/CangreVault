// PRUEBAS con un `fetch` FALSO (doble de prueba): verifican que el cliente respeta el
// contrato OpenAPI oficial de Bridge. No contactan a Bridge ni usan datos reales.
import { describe, expect, it } from 'vitest';
import { BridgeProvider, mapBridgeTransaction } from '../bridge';
import { ProviderError, decimalToCents, listAllTransactions } from '../provider';

type Call = { url: string; init?: RequestInit };
function fakeFetch(responses: ((url: string) => Response)[]) {
  const calls: Call[] = [];
  let i = 0;
  const f = async (url: string, init?: RequestInit) => { calls.push({ url, init }); const r = responses[Math.min(i++, responses.length - 1)]!; return r(url); };
  return { f, calls };
}
const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const status = (s: number, headers: Record<string, string> = {}) => () => new Response('{"error":"x"}', { status: s, headers });
const noSleep = async () => undefined;

describe('Bridge: autenticación y endpoints', () => {
  it('envía la clave de API y el scoped token en los headers documentados', async () => {
    const { f, calls } = fakeFetch([ok({ accounts: [] })]);
    await new BridgeProvider({ apiKey: 'sk_test', fetch: f }).listAccounts('con_1', 'brdg_st_x');
    const h = calls[0]!.init!.headers as Record<string, string>;
    expect(calls[0]!.url).toBe('https://api.bridge.com.do/connections/con_1/accounts');
    expect(h.Authorization).toBe('Bearer sk_test');
    expect(h['X-Scoped-Token']).toBe('brdg_st_x');
  });

  it('las operaciones administrativas NO envían el scoped token', async () => {
    const { f, calls } = fakeFetch([() => new Response(null, { status: 204 })]);
    await new BridgeProvider({ apiKey: 'k', fetch: f }).revokeConnection('con_9');
    expect(calls[0]!.init!.method).toBe('DELETE');
    expect((calls[0]!.init!.headers as Record<string, string>)['X-Scoped-Token']).toBeUndefined();
  });

  it('mapea cuentas de depósito y crédito con balances en centavos exactos', async () => {
    const { f } = fakeFetch([ok({ accounts: [
      { id: 'acc_1', connectionId: 'con_1', type: 'depository', name: 'Ahorros', lastFour: '1234', currency: 'DOP', balance: { current: 5034.62, available: 5034.62 }, lastTransactionRefresh: 'txr_1' },
      { id: 'acc_2', connectionId: 'con_1', type: 'credit', name: 'Visa', lastFour: '5678', currency: 'DOP', balance: { current: -1847.15, available: 6152.85, limit: 8000 } },
    ] })]);
    const [dep, cred] = await new BridgeProvider({ apiKey: 'k', fetch: f }).listAccounts('con_1', 't');
    expect(dep).toMatchObject({ type: 'depository', balanceCurrent: 503462, lastTransactionRefresh: 'txr_1' });
    expect(cred).toMatchObject({ type: 'credit', balanceCurrent: -184715, balanceAvailable: 615285, balanceLimit: 800000 });
  });

  it('una cuenta sin permiso de balances no inventa saldos', async () => {
    const { f } = fakeFetch([ok({ accounts: [{ id: 'a', connectionId: 'c', type: 'depository', name: 'X', lastFour: '1', currency: 'DOP' }] })]);
    const [a] = await new BridgeProvider({ apiKey: 'k', fetch: f }).listAccounts('c', 't');
    expect(a!.balanceCurrent).toBeNull();
  });

  it('consulta incremental con refreshedSince y fecha inicial con date[gte]', async () => {
    const { f, calls } = fakeFetch([ok({ transactions: [], pagination: { hasMore: false, nextCursor: null } })]);
    const p = new BridgeProvider({ apiKey: 'k', fetch: f });
    await p.listTransactions('acc_1', 't', { refreshedSince: 'txr_9', dateFrom: '2026-01-01' });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/accounts/acc_1/transactions');
    expect(u.searchParams.get('refreshedSince')).toBe('txr_9');
    expect(u.searchParams.get('date[gte]')).toBe('2026-01-01');
  });
});

describe('Bridge: paginación', () => {
  it('recorre todas las páginas con el cursor', async () => {
    const tx = (id: string) => ({ id, accountId: 'a', amount: -1, date: '2026-11-01', description: 'x', status: 'posted', transactionRefresh: 'r' });
    const { f, calls } = fakeFetch([
      ok({ transactions: [tx('t1'), tx('t2')], pagination: { hasMore: true, nextCursor: 'c2' } }),
      ok({ transactions: [tx('t3')], pagination: { hasMore: false, nextCursor: null } }),
    ]);
    const all = await listAllTransactions(new BridgeProvider({ apiKey: 'k', fetch: f }), 'a', 't', {});
    expect(all.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(new URL(calls[1]!.url).searchParams.get('cursor')).toBe('c2');
  });

  it('detecta un cursor repetido (evita bucles infinitos)', async () => {
    const { f } = fakeFetch([ok({ transactions: [], pagination: { hasMore: true, nextCursor: 'same' } })]);
    await expect(listAllTransactions(new BridgeProvider({ apiKey: 'k', fetch: f }), 'a', 't', {})).rejects.toThrow(/cursor/);
  });
});

describe('Bridge: errores y reintentos', () => {
  it('reintenta 429 respetando Retry-After y luego tiene éxito', async () => {
    const waits: number[] = [];
    const { f, calls } = fakeFetch([status(429, { 'Retry-After': '2' }), status(503), ok({ connections: [] })]);
    await new BridgeProvider({ apiKey: 'k', fetch: f, sleep: async (ms) => { waits.push(ms); } }).listConnections('t');
    expect(calls).toHaveLength(3);
    expect(waits[0]).toBe(2000);
  });

  it('403 → requiere reautorización; 401 → error de configuración; no reintenta', async () => {
    const p403 = new BridgeProvider({ apiKey: 'k', fetch: fakeFetch([status(403)]).f, sleep: noSleep });
    await expect(p403.listAccounts('c', 't')).rejects.toMatchObject({ kind: 'reauth' });
    const p401 = new BridgeProvider({ apiKey: 'k', fetch: fakeFetch([status(401)]).f, sleep: noSleep });
    await expect(p401.whoami()).rejects.toMatchObject({ kind: 'config' });
  });

  it('agota reintentos ante 500 persistente', async () => {
    const { f, calls } = fakeFetch([status(500)]);
    await expect(new BridgeProvider({ apiKey: 'k', fetch: f, sleep: noSleep, maxRetries: 2 }).listConnections('t')).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(3);
  });

  it('rechaza configuración sin clave de API', () => {
    expect(() => new BridgeProvider({ apiKey: '' })).toThrow(/BRIDGE_API_KEY/);
  });

  it('rechaza transacciones con estado o fecha inválidos', () => {
    expect(() => mapBridgeTransaction({ id: 't', amount: 1, date: '2026-01-01', status: 'weird', description: 'x' })).toThrow();
    expect(() => mapBridgeTransaction({ id: 't', amount: 1, date: 'ayer', status: 'posted', description: 'x' })).toThrow();
  });
});

describe('decimalToCents', () => {
  it('convierte sin errores de coma flotante', () => {
    expect(decimalToCents(0.1 + 0.2)).toBe(30);
    expect(decimalToCents(-2450)).toBe(-245000);
    expect(decimalToCents(1530.005)).toBe(153001);
    expect(decimalToCents(-0.01)).toBe(-1);
    expect(() => decimalToCents('12')).toThrow();
  });
});
