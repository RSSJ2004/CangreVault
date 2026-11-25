/**
 * Intérprete de estados de cuenta Banreservas a partir del TEXTO extraído del PDF.
 *
 * IMPORTANTE: este intérprete fue construido con heurísticas generales (fechas,
 * importes con formato dominicano, palabras clave habituales) y con textos de
 * ejemplo SINTÉTICOS. No se ha validado con un estado de cuenta real; por eso
 * siempre produce una vista previa editable y nunca guarda sin confirmación.
 * Para afinarlo, proporciona un estado anonimizado y agrega su texto como fixture.
 */
import { normalizeText } from '@shared/keywordRules';
import { matchCategorySlug } from '@shared/keywordRules';
import { parseUserAmount, type Cents } from '@/domain/money';
import { fromParts, isIsoDate, type IsoDate } from '@/domain/dates';
import type { TransactionType } from '@/domain/types';

export const PARSER_NAME = 'banreservas-text';
export const PARSER_VERSION = '0.1.0';

export type DetectedAccountType = 'checking' | 'savings' | 'credit_card' | 'unknown';

export interface StatementHeader {
  accountType: DetectedAccountType;
  periodStart: IsoDate | null;
  periodEnd: IsoDate | null;
  statementDate: IsoDate | null;
  dueDate: IsoDate | null;
  minimumPayment: Cents | null;
  fullPayment: Cents | null;
  statementBalance: Cents | null;
  previousBalance: Cents | null;
  creditLimit: Cents | null;
  accountLast4: string | null;
}

export interface ParsedRow {
  ref: string;
  rawLine: string;
  occurredOn: IsoDate;
  postedOn: IsoDate | null;
  description: string;
  amount: Cents;
  direction: 'debit' | 'credit';
  balanceAfter: Cents | null;
  bankReference: string | null;
  suggestedType: TransactionType;
  categorySlug: string | null;
  confidence: 'high' | 'medium' | 'low';
}

export interface ParseResult {
  header: StatementHeader;
  rows: ParsedRow[];
  warnings: string[];
  unparsedLines: number;
}

const MONTHS: Record<string, number> = {
  ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12,
};

const DATE_RE = String.raw`(\d{1,2})[\/\-.](\d{1,2}|[A-Za-z]{3})(?:[\/\-.](\d{2,4}))?`;
const AMOUNT_RE = String.raw`-?\(?(?:RD\$|US\$|\$)?\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})\)?(?:\s?(?:CR|DB|-))?`;

function toIso(d: string, m: string, y: string | undefined, fallbackYear: number, refMonth?: number): IsoDate | null {
  const day = Number(d);
  const month = /^\d+$/.test(m) ? Number(m) : MONTHS[m.toLowerCase()] ?? NaN;
  let year = y ? Number(y.length === 2 ? `20${y}` : y) : fallbackYear;
  if (!y && refMonth && month > refMonth) year -= 1; // movimientos de diciembre en estado de enero
  const iso = fromParts(year, month, day);
  return isIsoDate(iso) ? iso : null;
}

function parseAmountToken(tok: string): { value: Cents; negative: boolean } | null {
  const t = tok.trim();
  const negative = /^-|\(.*\)|\bCR$|-$/.test(t.replace(/\s/g, ' '));
  const clean = t.replace(/[()]/g, '').replace(/\s?(CR|DB)$/i, '').replace(/-$/, '').replace(/^-/, '');
  const v = parseUserAmount(clean);
  return v === null ? null : { value: v, negative };
}

export function detectAccountType(text: string): DetectedAccountType {
  const n = normalizeText(text);
  if (/tarjeta de credito|limite de credito|pago minimo|pago de contado|fecha limite de pago/.test(n)) return 'credit_card';
  if (/cuenta de ahorro|cuenta ahorro|ahorros/.test(n)) return 'savings';
  if (/cuenta corriente|cuenta de cheques|cuenta de debito|tarjeta de debito/.test(n)) return 'checking';
  return 'unknown';
}

function findAmountAfter(lines: string[], labels: RegExp): Cents | null {
  for (const line of lines) {
    const n = normalizeText(line);
    if (!labels.test(n)) continue;
    const m = line.match(new RegExp(AMOUNT_RE, 'g'));
    if (m?.length) {
      const a = parseAmountToken(m[m.length - 1]!);
      if (a) return a.value;
    }
  }
  return null;
}

function findDateAfter(lines: string[], labels: RegExp, year: number): IsoDate | null {
  for (const line of lines) {
    if (!labels.test(normalizeText(line))) continue;
    const m = new RegExp(DATE_RE).exec(line);
    if (m) return toIso(m[1]!, m[2]!, m[3], year);
  }
  return null;
}

export function parseHeader(lines: string[], fallbackYear: number): StatementHeader {
  const text = lines.join('\n');
  let periodStart: IsoDate | null = null;
  let periodEnd: IsoDate | null = null;
  for (const line of lines) {
    const n = normalizeText(line);
    if (/(periodo|desde|del)/.test(n)) {
      const all = [...line.matchAll(new RegExp(DATE_RE, 'g'))];
      if (all.length >= 2) {
        periodStart = toIso(all[0]![1]!, all[0]![2]!, all[0]![3], fallbackYear);
        periodEnd = toIso(all[1]![1]!, all[1]![2]!, all[1]![3], fallbackYear);
        break;
      }
    }
  }
  const last4 = /(?:\*{2,}|x{2,}|terminada en|no\.?\s*)\s*(\d{4})\b/i.exec(text)?.[1] ?? null;
  return {
    accountType: detectAccountType(text),
    periodStart,
    periodEnd,
    statementDate: findDateAfter(lines, /fecha de corte|fecha corte/, fallbackYear) ?? periodEnd,
    dueDate: findDateAfter(lines, /fecha limite de pago|fecha limite|pagar antes de|fecha de pago/, fallbackYear),
    minimumPayment: findAmountAfter(lines, /pago minimo/),
    fullPayment: findAmountAfter(lines, /pago de contado|pago contado|pago total/),
    statementBalance: findAmountAfter(lines, /saldo al corte|balance al corte|saldo actual|saldo final|balance final/),
    previousBalance: findAmountAfter(lines, /saldo anterior|balance anterior/),
    creditLimit: findAmountAfter(lines, /limite de credito/),
    accountLast4: last4,
  };
}

const CREDIT_WORDS = /\b(deposito|credito|transferencia recibida|recibida|nomina|pago recibido|su pago|pago gracias|abono|devolucion|reverso|intereses ganados)\b/;
const CARD_PAYMENT_WORDS = /\b(pago tarjeta|pago tc|pago a tarjeta|pago de tarjeta|pago visa|pago mastercard)\b/;
const FEE_WORDS = /\b(comision|cargo por|cargo servicio|mantenimiento|impuesto|itbis|dgii)\b/;

function suggestType(accountType: DetectedAccountType, direction: 'debit' | 'credit', desc: string): TransactionType {
  const n = normalizeText(desc);
  if (accountType === 'credit_card') {
    if (direction === 'credit') return /\bpago\b|su pago|abono/.test(n) ? 'CARD_PAYMENT' : 'REFUND';
    return /interes|comision|cargo/.test(n) ? 'EXPENSE' : 'CARD_PURCHASE';
  }
  if (direction === 'credit') return /devolucion|reverso/.test(n) ? 'REFUND' : 'INCOME';
  if (CARD_PAYMENT_WORDS.test(n)) return 'CARD_PAYMENT';
  if (/\bahorro\b/.test(n) && /transf/.test(n)) return 'SAVINGS_CONTRIBUTION';
  return 'EXPENSE';
}

/**
 * Interpreta líneas de texto. `pages` = líneas por página (orden de lectura).
 */
export function parseStatementText(pages: string[][], opts: { fallbackYear: number }): ParseResult {
  const allLines = pages.flat();
  const header = parseHeader(allLines, opts.fallbackYear);
  const refYear = Number((header.periodEnd ?? header.statementDate ?? `${opts.fallbackYear}`).slice(0, 4));
  const refMonth = header.periodEnd ? Number(header.periodEnd.slice(5, 7)) : undefined;
  const warnings: string[] = [];
  const rows: ParsedRow[] = [];
  let unparsed = 0;
  let prevBalance: Cents | null = header.previousBalance;
  const lineRe = new RegExp(String.raw`^\s*${DATE_RE}\s+(?:${DATE_RE}\s+)?(.*?)\s+((?:${AMOUNT_RE}\s*){1,3})\s*$`);

  pages.forEach((lines, p) => {
    lines.forEach((line, l) => {
      const m = lineRe.exec(line);
      if (!m) {
        if (/^\s*\d{1,2}[\/\-.]/.test(line)) unparsed++;
        return;
      }
      const occurredOn = toIso(m[1]!, m[2]!, m[3], refYear, refMonth);
      const postedOn = m[4] ? toIso(m[4], m[5]!, m[6], refYear, refMonth) : null;
      let description = m[7]!.trim();
      const amountTokens = m[8]!.match(new RegExp(AMOUNT_RE, 'g')) ?? [];
      const amounts = amountTokens.map(parseAmountToken).filter((a): a is NonNullable<typeof a> => a !== null);
      if (!occurredOn || !amounts.length || !description) { unparsed++; return; }
      if (/^(saldo anterior|balance anterior|saldo inicial)/i.test(normalizeText(description))) return;

      const refMatch = /\b(?:ref|referencia|aut|no)\.?\s*:?\s*([A-Z0-9]{5,})\b/i.exec(description) ?? /\b(\d{6,})\b/.exec(description);
      const bankReference = refMatch?.[1] ?? null;

      let amount = amounts[0]!;
      let balanceAfter: Cents | null = null;
      let direction: 'debit' | 'credit';
      let confidence: ParsedRow['confidence'] = 'medium';

      if (amounts.length >= 2) {
        // Último importe = balance. Si hay 3: débito, crédito, balance (uno suele ser 0.00).
        balanceAfter = amounts[amounts.length - 1]!.value;
        if (amounts.length === 3) {
          const [deb, cred] = amounts as [typeof amount, typeof amount];
          amount = deb.value > 0 ? deb : cred;
          direction = deb.value > 0 ? 'debit' : 'credit';
          confidence = 'high';
        } else if (prevBalance !== null) {
          const delta = balanceAfter - prevBalance;
          if (delta === amount.value) { direction = 'credit'; confidence = 'high'; }
          else if (delta === -amount.value) { direction = 'debit'; confidence = 'high'; }
          else { direction = amount.negative ? 'credit' : CREDIT_WORDS.test(normalizeText(description)) ? 'credit' : 'debit'; confidence = 'low'; }
        } else {
          direction = CREDIT_WORDS.test(normalizeText(description)) ? 'credit' : 'debit';
        }
        prevBalance = balanceAfter;
      } else {
        const n = normalizeText(description);
        if (amount.negative) direction = 'credit';
        else if (header.accountType === 'credit_card') direction = /\bpago\b|su pago|abono|devolucion|reverso|credito/.test(n) ? 'credit' : 'debit';
        else direction = CREDIT_WORDS.test(n) ? 'credit' : 'debit';
        confidence = amount.negative || CREDIT_WORDS.test(n) || FEE_WORDS.test(n) ? 'medium' : 'low';
      }

      description = description.replace(/\s{2,}/g, ' ').slice(0, 300);
      const suggestedType = suggestType(header.accountType, direction, description);
      const n = normalizeText(description);
      rows.push({
        ref: `p${p + 1}-l${l + 1}`,
        rawLine: line.slice(0, 500),
        occurredOn,
        postedOn,
        description,
        amount: amount.value,
        direction,
        balanceAfter,
        bankReference,
        suggestedType,
        categorySlug: FEE_WORDS.test(n) ? (/interes/.test(n) ? 'card_interest' : 'bank_fees') : /interes/.test(n) && header.accountType === 'credit_card' ? 'card_interest' : matchCategorySlug(description),
        confidence,
      });
    });
  });

  if (header.accountType === 'unknown') warnings.push('No se pudo identificar el tipo de cuenta; selecciónalo manualmente.');
  if (!rows.length) warnings.push('No se reconocieron movimientos. El formato puede ser distinto al esperado: revisa el texto extraído.');
  if (unparsed > 0) warnings.push(`${unparsed} línea(s) con fecha no pudieron interpretarse; revísalas en el texto extraído.`);
  if (rows.some((r) => r.confidence === 'low')) warnings.push('Algunos movimientos tienen dirección (entrada/salida) dudosa: verifícalos.');
  return { header, rows, warnings, unparsedLines: unparsed };
}
