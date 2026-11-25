// Reglas contables de la sincronización bancaria (docs/DECISIONS.md). Datos sintéticos.
import { describe, expect, it } from 'vitest';
import { type CategoryRef, type ClassifyRow, classifyBankRows, stableUuid } from '../classify';

const cats: CategoryRef[] = [
  { id: 'cat-salary', slug: 'salary', kind: 'income' }, { id: 'cat-groceries', slug: 'groceries', kind: 'expense' },
  { id: 'cat-telecom', slug: 'telecom', kind: 'expense' }, { id: 'cat-savings', slug: 'savings', kind: 'savings' },
];
let n = 0;
const debit = { externalAccountId: 'ext-debit', providerType: 'depository' as const, accountId: 'acc-debit', accountKind: 'checking' as const };
const savings = { externalAccountId: 'ext-sav', providerType: 'depository' as const, accountId: 'acc-sav', accountKind: 'savings' as const };
const card = { externalAccountId: 'ext-card', providerType: 'credit' as const, accountId: 'acc-card', accountKind: 'credit_card' as const };
const row = (acc: typeof debit | typeof savings | typeof card, amount: number, description: string, extra: Partial<ClassifyRow> = {}): ClassifyRow => ({
  rawId: `raw-${++n}`, providerTransactionId: `txn_${n}`, currency: 'DOP', occurredOn: '2026-11-20', reference: null, status: 'posted',
  syncFrom: null, linkedTransactionId: null, amount, description, ...acc, ...extra,
});

describe('clasificación de movimientos bancarios', () => {
  it('nómina en cuenta de depósito = ingreso con categoría salario', () => {
    const [d] = classifyBankRows([row(debit, 2424000, 'DEPOSITO NOMINA EMPRESA')], [], cats);
    expect(d).toMatchObject({ action: 'create', type: 'INCOME', amount: 2424000, accountId: 'acc-debit', categoryId: 'cat-salary' });
  });

  it('compra con tarjeta = gasto (CARD_PURCHASE) con importe positivo', () => {
    const [d] = classifyBankRows([row(card, -245000, 'SUPERMERCADO NACIONAL')], [], cats);
    expect(d).toMatchObject({ action: 'create', type: 'CARD_PURCHASE', amount: 245000, accountId: 'acc-card', categoryId: 'cat-groceries' });
  });

  it('pago de tarjeta con ambos lados conectados = UN solo CARD_PAYMENT, nunca un segundo gasto', () => {
    const out = row(debit, -320000, 'PAGO TARJETA VISA');
    const inn = row(card, 320000, 'SU PAGO GRACIAS', { occurredOn: '2026-11-21' });
    const ds = classifyBankRows([out, inn], [], cats);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ action: 'create', type: 'CARD_PAYMENT', accountId: 'acc-debit', toAccountId: 'acc-card', amount: 320000, rawIds: [out.rawId, inn.rawId] });
    expect(ds.some((d) => d.action === 'create' && (d.type === 'EXPENSE' || d.type === 'CARD_PURCHASE'))).toBe(false);
  });

  it('transferencia entre cuentas propias = TRANSFER/aporte, no ingreso ni gasto', () => {
    const ds = classifyBankRows([row(debit, -500000, 'TRANSFERENCIA'), row(savings, 500000, 'TRANSFERENCIA RECIBIDA')], [], cats);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ type: 'SAVINGS_CONTRIBUTION', accountId: 'acc-debit', toAccountId: 'acc-sav' });
  });

  it('pago de tarjeta sin el lado de la tarjeta conectado → revisión (no se cuenta como gasto)', () => {
    const [d] = classifyBankRows([row(debit, -320000, 'PAGO TARJETA VISA')], [], cats);
    expect(d).toMatchObject({ action: 'status', status: 'needs_review' });
  });

  it('transferencia de un solo lado → revisión', () => {
    expect(classifyBankRows([row(debit, 100000, 'TRANSFERENCIA DE JUAN')], [], cats)[0]).toMatchObject({ status: 'needs_review' });
    expect(classifyBankRows([row(debit, -100000, 'TRANSF A TERCERO')], [], cats)[0]).toMatchObject({ status: 'needs_review' });
  });

  it('devoluciones se identifican como REFUND en tarjeta y en cuenta', () => {
    expect(classifyBankRows([row(card, 50000, 'DEVOLUCION AMAZON')], [], cats)[0]).toMatchObject({ type: 'REFUND', accountId: 'acc-card' });
    expect(classifyBankRows([row(debit, 50000, 'REVERSO CARGO')], [], cats)[0]).toMatchObject({ type: 'REFUND', accountId: 'acc-debit' });
  });

  it('pago recibido en la tarjeta desde cuenta no conectada → revisión', () => {
    expect(classifyBankRows([row(card, 100000, 'PAGO RECIBIDO')], [], cats)[0]).toMatchObject({ status: 'needs_review' });
  });

  it('pendientes y anulados no se contabilizan', () => {
    const ds = classifyBankRows([row(debit, -1000, 'X', { status: 'pending' }), row(debit, -1000, 'Y', { status: 'void' })], [], cats);
    expect(ds.map((d) => d.action === 'status' && d.status)).toEqual(['pending_bank', 'void']);
  });

  it('anulado después de contabilizarse → revisión, sin recrear', () => {
    const ds = classifyBankRows([row(debit, -1000, 'X', { status: 'void', linkedTransactionId: 'tx-1' })], [], cats);
    expect(ds).toEqual([expect.objectContaining({ action: 'status', status: 'needs_review' })]);
  });

  it('ya contabilizado → no se vuelve a crear (idempotente)', () => {
    expect(classifyBankRows([row(debit, -1000, 'X', { linkedTransactionId: 'tx-1' })], [], cats)).toEqual([]);
  });

  it('cuenta sin vincular → espera vínculo', () => {
    const ds = classifyBankRows([row({ ...debit, accountId: null, accountKind: null } as never, -1000, 'X')], [], cats);
    expect(ds[0]).toMatchObject({ status: 'unlinked_account' });
  });

  it('movimientos anteriores al saldo inicial no se duplican', () => {
    const ds = classifyBankRows([row(debit, -1000, 'X', { occurredOn: '2026-01-01', syncFrom: '2026-02-01' })], [], cats);
    expect(ds[0]).toMatchObject({ status: 'ignored' });
  });

  it('posible duplicado de un movimiento manual/PDF → revisión con referencia', () => {
    const ds = classifyBankRows([row(debit, -153000, 'ALTICE DOMINICANA')],
      [{ id: 'tx-manual', accountId: 'acc-debit', toAccountId: null, amount: 153000, occurredOn: '2026-11-19', source: 'manual', description: 'Altice' }], cats);
    expect(ds[0]).toMatchObject({ status: 'needs_review', duplicateOf: 'tx-manual' });
  });

  it('un movimiento creado por la propia sincronización no cuenta como duplicado', () => {
    const ds = classifyBankRows([row(debit, -153000, 'ALTICE')],
      [{ id: 'tx-bank', accountId: 'acc-debit', toAccountId: null, amount: 153000, occurredOn: '2026-11-20', source: 'bank_sync', description: 'Altice' }], cats);
    expect(ds[0]).toMatchObject({ action: 'create', type: 'EXPENSE', categoryId: 'cat-telecom' });
  });

  it('dos contrapartes igual de probables → revisión, sin adivinar', () => {
    const ds = classifyBankRows([row(debit, -1000, 'T', { occurredOn: '2026-11-20' }), row(savings, 1000, 'A', { occurredOn: '2026-11-21' }),
      row(card, 1000, 'B', { occurredOn: '2026-11-19' })], [], cats);
    expect(ds[0]).toMatchObject({ status: 'needs_review' });
    expect(ds.filter((d) => d.action === 'create')).toHaveLength(0);
  });

  it('las claves de cada hecho son estables entre ejecuciones', async () => {
    const a = row(debit, -1000, 'X');
    const d1 = classifyBankRows([a], [], cats)[0]!;
    const d2 = classifyBankRows([{ ...a }], [], cats)[0]!;
    expect(d1.action === 'create' && d2.action === 'create' && d1.key === d2.key).toBe(true);
    const u = await stableUuid('ns', 'k');
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await stableUuid('ns', 'k')).toBe(u);
    expect(await stableUuid('ns', 'k2')).not.toBe(u);
  });
});
