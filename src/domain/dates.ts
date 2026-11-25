/**
 * Fechas contables como cadenas ISO 8601 "YYYY-MM-DD" (sin hora ni zona).
 * Toda la aritmética se hace en UTC para evitar desplazamientos por zona horaria.
 * La zona de referencia del usuario es America/Santo_Domingo (UTC-4, sin horario de verano).
 */
declare const IsoDateBrand: unique symbol;
export type IsoDate = string & { readonly [IsoDateBrand]: true };

export const DEFAULT_TIME_ZONE = 'America/Santo_Domingo';

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: string): s is IsoDate {
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const [, y, mo, d] = m.map(Number) as [number, number, number, number];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

export function isoDate(s: string): IsoDate {
  if (!isIsoDate(s)) throw new RangeError(`Fecha ISO inválida: "${s}"`);
  return s;
}

export function parts(d: IsoDate): { y: number; m: number; d: number } {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return { y, m, d: day };
}

export function fromParts(y: number, m: number, d: number): IsoDate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` as IsoDate;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Día `day` del mes, ajustado al último día si el mes es más corto (p. ej. 30 en febrero -> 28/29). */
export function clampedDate(y: number, m: number, day: number): IsoDate {
  return fromParts(y, m, Math.min(day, daysInMonth(y, m)));
}

function toUtc(d: IsoDate): number {
  const { y, m, d: day } = parts(d);
  return Date.UTC(y, m - 1, day);
}

function fromUtc(ms: number): IsoDate {
  const dt = new Date(ms);
  return fromParts(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(d: IsoDate, n: number): IsoDate {
  return fromUtc(toUtc(d) + n * 86_400_000);
}

/** Suma meses conservando el día cuando existe; si no, usa el último día del mes. */
export function addMonths(d: IsoDate, n: number): IsoDate {
  const { y, m, d: day } = parts(d);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return clampedDate(ny, nm, day);
}

export function diffDays(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtc(a) - toUtc(b)) / 86_400_000);
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a < b ? a : b;
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a > b ? a : b;
}

export function startOfMonth(d: IsoDate): IsoDate {
  const { y, m } = parts(d);
  return fromParts(y, m, 1);
}

export function endOfMonth(d: IsoDate): IsoDate {
  const { y, m } = parts(d);
  return fromParts(y, m, daysInMonth(y, m));
}

export function isBetween(d: IsoDate, from: IsoDate, to: IsoDate): boolean {
  return d >= from && d <= to;
}

/** 0 = domingo … 6 = sábado */
export function weekday(d: IsoDate): number {
  return new Date(toUtc(d)).getUTCDay();
}

/** Fecha de hoy en la zona horaria indicada (por defecto República Dominicana). */
export function todayIso(timeZone = DEFAULT_TIME_ZONE, now: Date = new Date()): IsoDate {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return isoDate(fmt.format(now));
}

const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTHS_ES_LONG = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export function formatDateEs(d: IsoDate, style: 'short' | 'long' = 'short'): string {
  const { y, m, d: day } = parts(d);
  return style === 'short'
    ? `${String(day).padStart(2, '0')}/${MONTHS_ES[m - 1]}/${y}`
    : `${day} de ${MONTHS_ES_LONG[m - 1]} de ${y}`;
}

export function monthLabelEs(d: IsoDate): string {
  const { y, m } = parts(d);
  return `${MONTHS_ES_LONG[m - 1]} ${y}`;
}

export { MONTHS_ES, MONTHS_ES_LONG };
