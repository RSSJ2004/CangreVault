/**
 * Dinero con precisión exacta: se representa como un entero de CENTAVOS.
 * Nunca se opera con importes en coma flotante. La conversión desde/hacia
 * `numeric(14,2)` de PostgreSQL se hace con cadenas decimales ("24240.00").
 */
declare const CentsBrand: unique symbol;
export type Cents = number & { readonly [CentsBrand]: true };

const MAX_CENTS = 99_999_999_999_999; // numeric(14,2)

export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Importe inválido en centavos: ${value}`);
  }
  if (Math.abs(value) > MAX_CENTS) {
    throw new RangeError('Importe fuera de rango para numeric(14,2)');
  }
  return value as Cents;
}

export const ZERO = 0 as Cents;

/** Convierte una cadena decimal canónica ("-1234.5", "24240.00") a centavos sin pasar por float. */
export function fromDecimalString(input: string): Cents {
  const s = input.trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,2})\d*)?$/.exec(s);
  if (!m) throw new RangeError(`Cadena decimal inválida: "${input}"`);
  const [, sign, intPart, frac = ''] = m;
  const extra = s.split('.')[1]?.slice(2) ?? '';
  if (extra.length > 0 && /[1-9]/.test(extra)) {
    throw new RangeError(`Más de 2 decimales no permitidos: "${input}"`);
  }
  const value = Number(intPart) * 100 + Number(frac.padEnd(2, '0'));
  return cents(sign ? -value : value);
}

/**
 * Valor recibido de PostgREST para una columna numeric. Puede llegar como string
 * (recomendado, exacto) o como number JSON. Para numeric(14,2) un number JSON
 * se convierte exactamente redondeando a 2 decimales.
 */
export function fromDb(value: string | number | null | undefined): Cents {
  if (value === null || value === undefined) return ZERO;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('Importe no finito');
    return fromDecimalString(value.toFixed(2));
  }
  return fromDecimalString(value);
}

export function fromDbNullable(value: string | number | null | undefined): Cents | null {
  return value === null || value === undefined ? null : fromDb(value);
}

/** Cadena decimal para enviar a la base de datos: 2453 -> "24.53". */
export function toDecimalString(c: Cents): string {
  const neg = c < 0;
  const abs = Math.abs(c);
  const int = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${int}.${frac}`;
}

/**
 * Interpreta lo que escribe una persona: "24,240", "RD$1,530.00", "850", "1.200,50",
 * "5 mil", "2.5k". Devuelve null si no hay un número reconocible.
 * Convención RD: coma = miles, punto = decimales. Se acepta formato europeo
 * cuando es inequívoco (p. ej. "1.200,50").
 */
export function parseUserAmount(raw: string): Cents | null {
  let s = raw.trim().toLowerCase().replace(/rd\$|us\$|\$|dop|pesos?/g, '').replace(/\s+/g, ' ').trim();
  let multiplier = 1;
  const mult = /^(.*?)(?:\s*(mil|k))$/.exec(s);
  if (mult?.[1]) {
    s = mult[1].trim();
    multiplier = 1000;
  }
  s = s.replace(/\s/g, '');
  if (!/^-?[\d.,]+$/.test(s)) return null;
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // El separador que aparece último es el decimal.
    normalized = lastDot > lastComma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (lastComma >= 0) {
    // Solo comas: si hay exactamente 1-2 dígitos tras la última coma y es una sola coma => decimal ("12,5")
    const after = s.length - lastComma - 1;
    const commas = (s.match(/,/g) ?? []).length;
    normalized = commas === 1 && after > 0 && after <= 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (lastDot >= 0) {
    const after = s.length - lastDot - 1;
    const dots = (s.match(/\./g) ?? []).length;
    normalized = dots === 1 && after <= 2 ? s : s.replace(/\./g, '');
  } else {
    normalized = s;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(normalized) && !/^\d+\.$/.test(normalized)) return null;
  const base = fromDecimalString(normalized.replace(/\.$/, ''));
  const result = base * multiplier;
  if (result === 0) return null;
  return cents(neg ? -result : result);
}

export function add(...values: Cents[]): Cents {
  let total = 0;
  for (const v of values) total += v;
  return cents(total);
}

export function sub(a: Cents, b: Cents): Cents {
  return cents(a - b);
}

export function neg(a: Cents): Cents {
  return cents(-a);
}

export function abs(a: Cents): Cents {
  return cents(Math.abs(a));
}

export function sum(values: Iterable<Cents>): Cents {
  let total = 0;
  for (const v of values) total += v;
  return cents(total);
}

export function max(a: Cents, b: Cents): Cents {
  return (a > b ? a : b);
}

export function min(a: Cents, b: Cents): Cents {
  return (a < b ? a : b);
}

/** Redondeo "half away from zero" de una fracción racional num/den a entero. */
function roundRatio(num: number, den: number): number {
  const q = num / den;
  // Usamos aritmética entera cuando es segura para evitar errores de coma flotante en el .5
  if (Number.isSafeInteger(num) && Number.isSafeInteger(den)) {
    const sign = Math.sign(num) * Math.sign(den);
    const n = Math.abs(num);
    const d = Math.abs(den);
    const whole = Math.floor(n / d);
    const rem = n - whole * d;
    return sign * (rem * 2 >= d ? whole + 1 : whole);
  }
  return Math.round(q);
}

/**
 * Aplica un porcentaje expresado como cadena o número con hasta 4 decimales
 * (p. ej. 60, "30", 2.5) con redondeo al centavo.
 */
export function percentOf(amount: Cents, pct: number | string): Cents {
  const pctScaled = Math.round(Number(pct) * 10_000); // 4 decimales
  return cents(roundRatio(amount * pctScaled, 100 * 10_000));
}

/** Multiplica por un factor racional (num/den) con redondeo al centavo. */
export function mulRatio(amount: Cents, num: number, den: number): Cents {
  return cents(roundRatio(amount * num, den));
}

/** Divide en partes enteras de centavos (la suma de partes == total). */
export function allocate(amount: Cents, parts: number): Cents[] {
  if (parts <= 0 || !Number.isInteger(parts)) throw new RangeError('parts debe ser entero positivo');
  const base = Math.trunc(amount / parts);
  let remainder = amount - base * parts;
  const step = Math.sign(remainder);
  return Array.from({ length: parts }, () => {
    if (remainder !== 0) {
      remainder -= step;
      return cents(base + step);
    }
    return cents(base);
  });
}

/** Porcentaje a/b con 2 decimales (número, solo para mostrar). */
export function ratioPct(a: Cents, b: Cents): number {
  if (b === 0) return 0;
  return Math.round((a / b) * 10_000) / 100;
}

/** "RD$24,240.00" (o "-RD$1,530.00"). Determinista, sin depender del locale del navegador. */
export function formatMoney(c: Cents, currency = 'DOP', opts: { sign?: boolean } = {}): string {
  const prefix = currency === 'DOP' ? 'RD$' : currency === 'USD' ? 'US$' : `${currency} `;
  const absVal = Math.abs(c);
  const int = Math.floor(absVal / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(absVal % 100).padStart(2, '0');
  const sign = c < 0 ? '-' : opts.sign && c > 0 ? '+' : '';
  return `${sign}${prefix}${int}.${frac}`;
}

/** Número para Excel (unidades, no centavos). Se usa SOLO al escribir celdas. */
export function toUnits(c: Cents): number {
  return c / 100;
}
