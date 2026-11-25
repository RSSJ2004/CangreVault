// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const upsert = vi.fn();
vi.mock('@/repositories/finance', () => ({ upsertTransaction: (p: unknown) => upsert(p) }));

const { initOutbox, enqueueTransaction, flushOutbox, getOutbox, retryOutboxItem } = await import('../outbox');

const payload = (clientId: string) => ({ clientId, type: 'EXPENSE' as const, accountId: 'a', amount: 100 as never, description: 'x' });

describe('cola offline (outbox)', () => {
  beforeEach(() => {
    localStorage.clear();
    upsert.mockReset();
    initOutbox('user-1', null);
  });

  it('envía inmediatamente y vacía la cola (también tras un flush con cola vacía)', async () => {
    await flushOutbox(); // cola vacía: no debe bloquear envíos posteriores
    upsert.mockResolvedValue({ id: 's1', aiStatus: 'none' });
    enqueueTransaction(payload('c1'));
    await flushOutbox();
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(getOutbox()).toEqual([]);
  });

  it('sin red: conserva el registro como pendiente y lo reintenta después', async () => {
    upsert.mockRejectedValueOnce(Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' }));
    enqueueTransaction(payload('c2'));
    await flushOutbox();
    expect(getOutbox()[0]).toMatchObject({ clientId: 'c2', status: 'pending' });
    expect(JSON.parse(localStorage.getItem('cangrevault.outbox.user-1')!)).toHaveLength(1);
    upsert.mockResolvedValueOnce({ id: 's2', aiStatus: 'none' });
    await flushOutbox();
    expect(getOutbox()).toEqual([]);
    // Ambos intentos usaron el MISMO client_id: el upsert es idempotente en el servidor.
    expect(upsert.mock.calls.map((c) => (c[0] as { clientId: string }).clientId)).toEqual(['c2', 'c2']);
  });

  it('rechazo por reglas: queda "fallida" con el mensaje y no se pierde', async () => {
    upsert.mockRejectedValueOnce({ code: '23514', message: 'Una compra con tarjeta debe registrarse en una cuenta de tipo tarjeta de crédito' });
    enqueueTransaction(payload('c3'));
    await flushOutbox();
    expect(getOutbox()[0]).toMatchObject({ status: 'failed' });
    expect(getOutbox()[0]!.lastError).toMatch(/tarjeta/);
    upsert.mockResolvedValueOnce({ id: 's3', aiStatus: 'none' });
    retryOutboxItem('c3');
    await flushOutbox();
    expect(getOutbox()).toEqual([]);
  });

  it('persiste entre recargas', async () => {
    upsert.mockRejectedValue(Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' }));
    enqueueTransaction(payload('c4'));
    await flushOutbox();
    initOutbox('user-1', null);
    expect(getOutbox().map((i) => i.clientId)).toEqual(['c4']);
    initOutbox('user-2', null);
    expect(getOutbox()).toEqual([]); // aislado por usuario
  });
});
