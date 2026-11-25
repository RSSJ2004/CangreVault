import { describe, expect, it } from 'vitest';
import { addMonths, clampedDate, diffDays, isIsoDate, todayIso } from '../dates';
import { D } from './fixtures';

describe('dates', () => {
  it('valida fechas ISO reales', () => {
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-13-01')).toBe(false);
  });
  it('ajusta el día 30 en febrero', () => {
    expect(clampedDate(2026, 2, 30)).toBe('2026-02-28');
    expect(clampedDate(2028, 2, 30)).toBe('2028-02-29');
  });
  it('suma meses conservando fin de mes', () => {
    expect(addMonths(D('2026-01-31'), 1)).toBe('2026-02-28');
    expect(addMonths(D('2026-12-15'), 1)).toBe('2027-01-15');
    expect(addMonths(D('2026-03-15'), -3)).toBe('2025-12-15');
  });
  it('diferencia de días', () => {
    expect(diffDays(D('2026-03-01'), D('2026-02-28'))).toBe(1);
  });
  it('hoy en Santo Domingo (UTC-4)', () => {
    // 2026-11-26 02:00 UTC = 2026-11-25 22:00 en RD
    expect(todayIso('America/Santo_Domingo', new Date('2026-11-26T02:00:00Z'))).toBe('2026-11-25');
  });
});
