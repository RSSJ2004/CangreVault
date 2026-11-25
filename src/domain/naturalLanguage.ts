/**
 * Interpretación determinística de notas del Modo Simple.
 * "Recibí 24,240 de mi trabajo" · "Pagué 850 de luz" · "Pasé 1,200 al ahorro" · "Compré comida por 1,500"
 *
 * El resultado es una PROPUESTA que la persona confirma en el formulario antes de
 * guardar. Nunca se inventan importes: si no hay un número claro, amount = null.
 */
import { detectIntent, matchCategorySlug, normalizeText, type Intent } from '@shared/keywordRules';
import { type Cents, parseUserAmount } from './money';
import { type IsoDate, addDays, clampedDate, parts, addMonths } from './dates';
import type { Account, TransactionType, Uuid } from './types';

export interface ParsedEntry {
  amount: Cents | null;
  /** Todos los números candidatos encontrados (para que la UI pida aclaración si hay varios). */
  amountCandidates: Cents[];
  intent: Intent | null;
  direction: 'in' | 'out' | null;
  type: TransactionType | null;
  accountId: Uuid | null;
  toAccountId: Uuid | null;
  categorySlug: string | null;
  occurredOn: IsoDate;
  description: string;
  confidence: 'high' | 'medium' | 'low';
}

const AMOUNT_RE = /(?:rd\$|us\$|\$)?\s*\d[\d.,]*(?:\s*(?:mil|k)\b)?/gi;

export function extractAmounts(text: string): Cents[] {
  const found: Cents[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const raw = m[0];
    // Ignora fechas tipo "15/03" o "el 15" cuando van precedidas de "el día"
    const before = text.slice(Math.max(0, (m.index ?? 0) - 7), m.index).toLowerCase();
    if (/(\bel|d[ií]a)\s*$/.test(before)) continue;
    const v = parseUserAmount(raw.replace(/\s+/g, ' '));
    if (v !== null && v > 0) found.push(v);
  }
  return found;
}

export function extractDate(text: string, today: IsoDate): IsoDate {
  const n = normalizeText(text);
  if (/\banteayer\b/.test(n)) return addDays(today, -2);
  if (/\bayer\b/.test(n)) return addDays(today, -1);
  const m = /\bel (?:dia )?(\d{1,2})\b/.exec(n);
  if (m) {
    const day = Number(m[1]);
    if (day >= 1 && day <= 31) {
      const { y, m: mo } = parts(today);
      const candidate = clampedDate(y, mo, day);
      if (candidate <= today) return candidate;
      const prev = parts(addMonths(clampedDate(y, mo, 1), -1));
      return clampedDate(prev.y, prev.m, day);
    }
  }
  return today;
}

function pickAccount(accounts: readonly Account[], kinds: Account['kind'][], preferredId?: Uuid | null): Account | null {
  const live = accounts.filter((a) => !a.deletedAt && !a.isArchived);
  if (preferredId) {
    const pref = live.find((a) => a.id === preferredId && kinds.includes(a.kind));
    if (pref) return pref;
  }
  return live.filter((a) => kinds.includes(a.kind)).sort((a, b) => a.sortOrder - b.sortOrder)[0] ?? null;
}

function cleanDescription(text: string): string {
  const s = text.replace(AMOUNT_RE, ' ').replace(/\s+/g, ' ').replace(/\s+(de|por|en|a|al)\s*$/i, '').trim();
  const d = s.length ? s : text.trim();
  return d.charAt(0).toUpperCase() + d.slice(1);
}

export function parseSimpleEntry(
  text: string,
  accounts: readonly Account[],
  today: IsoDate,
  opts: { defaultAccountId?: Uuid | null; forcedDirection?: 'in' | 'out' } = {},
): ParsedEntry {
  const amounts = extractAmounts(text);
  let intent = detectIntent(text);
  if (opts.forcedDirection === 'in' && intent !== 'income') intent = intent === null || intent === 'expense' ? 'income' : intent;
  if (opts.forcedDirection === 'out' && intent === 'income') intent = 'expense';
  if (!intent && opts.forcedDirection) intent = opts.forcedDirection === 'in' ? 'income' : 'expense';

  const categorySlug = matchCategorySlug(text);
  const daily = pickAccount(accounts, ['checking', 'cash'], opts.defaultAccountId);
  let type: TransactionType | null = null;
  let accountId: Uuid | null = null;
  let toAccountId: Uuid | null = null;
  let direction: 'in' | 'out' | null = null;

  switch (intent) {
    case 'income':
      type = 'INCOME'; direction = 'in'; accountId = daily?.id ?? null; break;
    case 'expense':
      type = 'EXPENSE'; direction = 'out'; accountId = daily?.id ?? null; break;
    case 'card_purchase': {
      const card = pickAccount(accounts, ['credit_card']);
      type = card ? 'CARD_PURCHASE' : 'EXPENSE'; direction = 'out'; accountId = card?.id ?? daily?.id ?? null; break;
    }
    case 'card_payment': {
      const card = pickAccount(accounts, ['credit_card']);
      type = 'CARD_PAYMENT'; direction = 'out'; accountId = daily?.id ?? null; toAccountId = card?.id ?? null; break;
    }
    case 'savings_transfer': {
      const sav = pickAccount(accounts, ['savings']);
      type = 'SAVINGS_CONTRIBUTION'; direction = 'out'; accountId = daily?.id ?? null; toAccountId = sav?.id ?? null; break;
    }
    case 'transfer':
      type = 'TRANSFER'; direction = 'out'; accountId = daily?.id ?? null; break;
    default:
      break;
  }

  const amount = amounts.length >= 1 ? amounts[0]! : null;
  const confidence: ParsedEntry['confidence'] =
    amounts.length === 1 && intent && accountId ? 'high' : amount && intent ? 'medium' : 'low';

  return {
    amount,
    amountCandidates: amounts,
    intent,
    direction,
    type,
    accountId,
    toAccountId,
    categorySlug: type === 'SAVINGS_CONTRIBUTION' ? (categorySlug === 'emergency_fund' ? 'emergency_fund' : 'savings') : categorySlug,
    occurredOn: extractDate(text, today),
    description: cleanDescription(text),
    confidence,
  };
}
