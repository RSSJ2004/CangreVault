import { describe, expect, it } from 'vitest';
import {
  allocate, cents, formatMoney, fromDb, fromDecimalString, parseUserAmount, percentOf, toDecimalString, sum,
} from '../money';

describe('money', () => {
  it('convierte cadenas decimales exactas sin float', () => {
    expect(fromDecimalString('6462.61')).toBe(646261);
    expect(fromDecimalString('-0.10')).toBe(-10);
    expect(fromDecimalString('24240')).toBe(2424000);
    expect(fromDecimalString('1.5')).toBe(150);
    expect(fromDecimalString('1.500')).toBe(150);
    expect(() => fromDecimalString('1.555')).toThrow();
    expect(() => fromDecimalString('abc')).toThrow();
  });

  it('evita el clásico error 0.1 + 0.2', () => {
    expect(sum([fromDb(0.1), fromDb(0.2)])).toBe(30);
    expect(toDecimalString(sum([fromDb('0.10'), fromDb('0.20')]))).toBe('0.30');
  });

  it('lee numeric de PostgREST como string o number', () => {
    expect(fromDb('1530.00')).toBe(153000);
    expect(fromDb(1530)).toBe(153000);
    expect(fromDb(6462.61)).toBe(646261);
    expect(fromDb(null)).toBe(0);
  });

  it('serializa para la base de datos', () => {
    expect(toDecimalString(cents(646261))).toBe('6462.61');
    expect(toDecimalString(cents(-5))).toBe('-0.05');
    expect(toDecimalString(cents(0))).toBe('0.00');
  });

  it('formatea RD$ con separadores', () => {
    expect(formatMoney(cents(2424000))).toBe('RD$24,240.00');
    expect(formatMoney(cents(-153000))).toBe('-RD$1,530.00');
    expect(formatMoney(cents(5))).toBe('RD$0.05');
    expect(formatMoney(cents(100), 'USD')).toBe('US$1.00');
  });

  it('interpreta importes escritos por personas', () => {
    expect(parseUserAmount('24,240')).toBe(2424000);
    expect(parseUserAmount('RD$1,530.00')).toBe(153000);
    expect(parseUserAmount('850')).toBe(85000);
    expect(parseUserAmount('1.200,50')).toBe(120050);
    expect(parseUserAmount('1.200')).toBe(120000);
    expect(parseUserAmount('12,5')).toBe(1250);
    expect(parseUserAmount('5 mil')).toBe(500000);
    expect(parseUserAmount('2.5k')).toBe(250000);
    expect(parseUserAmount('hola')).toBeNull();
    expect(parseUserAmount('0')).toBeNull();
  });

  it('calcula porcentajes con redondeo al centavo', () => {
    expect(percentOf(cents(800000), 30)).toBe(240000); // 30% de 8,000 = 2,400
    expect(percentOf(cents(1), 50)).toBe(1); // 0.005 -> 0.01 (half away from zero)
    expect(percentOf(cents(-1), 50)).toBe(-1);
  });

  it('reparte sin perder centavos', () => {
    const parts = allocate(cents(1000), 3);
    expect(parts).toEqual([334, 333, 333]);
    expect(sum(parts)).toBe(1000);
  });
});
