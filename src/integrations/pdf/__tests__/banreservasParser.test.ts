/**
 * Fixtures SINTÉTICOS: imitan la estructura típica de un estado de cuenta
 * (fechas, descripciones, importes y balance) pero NO son copias de documentos
 * reales de Banreservas. Cuando se disponga de un estado real anonimizado,
 * agregarlo aquí como fixture adicional.
 */
import { describe, expect, it } from 'vitest';
import { detectAccountType, parseStatementText } from '../banreservasParser';

const cardStatement = [[
  'ESTADO DE CUENTA TARJETA DE CREDITO VISA',
  'Tarjeta terminada en 4321',
  'Periodo: 01/02/2026 al 28/02/2026',
  'Fecha de corte: 28/02/2026',
  'Fecha limite de pago: 21/03/2026',
  'Limite de credito RD$ 8,000.00',
  'Saldo anterior 1,000.00',
  'Pago minimo RD$ 250.00',
  'Pago de contado RD$ 6,462.61',
  'Saldo al corte 6,462.61',
  'FECHA  FECHA POST  DESCRIPCION  MONTO',
  '03/02  04/02  SUPERMERCADO NACIONAL AUT 123456  1,500.00',
  '10/02  10/02  SU PAGO GRACIAS  1,000.00 CR',
  '15/02  16/02  ALTICE DOMINICANA  1,530.00',
  '20/02  20/02  DEVOLUCION TIENDA X  200.00 CR',
  '27/02  27/02  INTERESES FINANCIAMIENTO  132.61',
  'Linea sin movimiento',
]];

const debitStatement = [[
  'BANRESERVAS ESTADO DE CUENTA CORRIENTE',
  'Desde 01/01/2026 hasta 31/01/2026',
  'Saldo anterior 5,000.00',
  '15/01/2026  DEPOSITO NOMINA EMPRESA  12,120.00  17,120.00',
  '16/01/2026  PAGO TC VISA  2,000.00  15,120.00',
  '20/01/2026  COMISION MANTENIMIENTO  150.00  14,970.00',
  '31/01/2026  EDESUR PAGO FACTURA  850.00  14,120.00',
]];

describe('detección del tipo de cuenta', () => {
  it('detecta tarjeta, ahorro y corriente', () => {
    expect(detectAccountType('PAGO MINIMO RD$ 250')).toBe('credit_card');
    expect(detectAccountType('Cuenta de Ahorro No. 123')).toBe('savings');
    expect(detectAccountType('CUENTA CORRIENTE')).toBe('checking');
    expect(detectAccountType('hola')).toBe('unknown');
  });
});

describe('estado de tarjeta (sintético)', () => {
  const r = parseStatementText(cardStatement, { fallbackYear: 2026 });
  it('extrae datos generales sin inventar', () => {
    expect(r.header).toMatchObject({
      accountType: 'credit_card', periodStart: '2026-02-01', periodEnd: '2026-02-28', statementDate: '2026-02-28', dueDate: '2026-03-21',
      minimumPayment: 25000, fullPayment: 646261, statementBalance: 646261, creditLimit: 800000, previousBalance: 100000, accountLast4: '4321',
    });
  });
  it('extrae movimientos con fecha, importe, dirección y tipo sugerido', () => {
    expect(r.rows.map((x) => [x.occurredOn, x.amount, x.direction, x.suggestedType])).toEqual([
      ['2026-02-03', 150000, 'debit', 'CARD_PURCHASE'],
      ['2026-02-10', 100000, 'credit', 'CARD_PAYMENT'],
      ['2026-02-15', 153000, 'debit', 'CARD_PURCHASE'],
      ['2026-02-20', 20000, 'credit', 'REFUND'],
      ['2026-02-27', 13261, 'debit', 'EXPENSE'], // intereses: gasto en la tarjeta (sube la deuda), categoría card_interest
    ]);
    expect(r.rows[0]!.postedOn).toBe('2026-02-04');
    expect(r.rows[0]!.bankReference).toBe('123456');
    expect(r.rows[0]!.categorySlug).toBe('groceries');
    expect(r.rows[2]!.categorySlug).toBe('telecom');
    expect(r.rows[4]!.categorySlug).toBe('card_interest');
    expect(r.rows[0]!.ref).toBe('p1-l12');
  });
});

describe('estado de cuenta corriente (sintético)', () => {
  const r = parseStatementText(debitStatement, { fallbackYear: 2026 });
  it('usa el balance para decidir entrada/salida con confianza alta', () => {
    expect(r.header.accountType).toBe('checking');
    expect(r.rows.map((x) => [x.amount, x.direction, x.suggestedType, x.confidence])).toEqual([
      [1212000, 'credit', 'INCOME', 'high'],
      [200000, 'debit', 'CARD_PAYMENT', 'high'],
      [15000, 'debit', 'EXPENSE', 'high'],
      [85000, 'debit', 'EXPENSE', 'high'],
    ]);
    expect(r.rows[2]!.categorySlug).toBe('bank_fees');
    expect(r.rows[3]!.categorySlug).toBe('electricity');
    expect(r.rows[3]!.balanceAfter).toBe(1412000);
  });
  it('avisa cuando no reconoce nada', () => {
    const empty = parseStatementText([['texto sin movimientos']], { fallbackYear: 2026 });
    expect(empty.rows).toEqual([]);
    expect(empty.warnings.join(' ')).toMatch(/No se reconocieron/);
  });
  it('infiere el año anterior para diciembre en un estado de enero', () => {
    const r2 = parseStatementText([['Periodo 15/12/2025 al 14/01/2026', '20/12  COMPRA X  100.00', '05/01  COMPRA Y  50.00']], { fallbackYear: 2026 });
    expect(r2.rows.map((x) => x.occurredOn)).toEqual(['2025-12-20', '2026-01-05']);
  });
});
