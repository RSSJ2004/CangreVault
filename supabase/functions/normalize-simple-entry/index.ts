/**
 * Edge Function: normalize-simple-entry
 *
 * Contrato (docs/EDGE_FUNCTIONS.md):
 *   POST { "transaction_id": "<uuid>" }   Authorization: Bearer <JWT del usuario>
 *   200  { status: "suggested" | "skipped" | "failed", engine: "groq" | "rules", suggestion: {...} | null, message? }
 *
 * Reglas:
 *  - La transacción YA existe (se guardó antes de llamar). No se crea ninguna otra.
 *  - Solo escribe ai_status, ai_suggestion, ai_processed_at y ai_error.
 *  - Nunca modifica importe, fecha, cuenta ni categoría confirmada: solo PROPONE.
 *  - Las categorías/cuentas sugeridas se validan contra las del usuario (vía RLS).
 *  - Si Groq no está configurado o falla, se usan reglas determinísticas.
 */
import { corsHeaders, errorResponse, json, UUID_RE } from '../_shared/http.ts';
import { userClient } from '../_shared/supabaseClient.ts';
import { groqChat, groqConfigured, groqModel } from '../_shared/groq.ts';
import { matchCategorySlug } from '../_shared/keywordRules.ts';
import { sanitizeDescription } from '../_shared/sanitize.ts';

const KIND_FOR_TYPE: Record<string, string | null> = {
  INCOME: 'income', EXPENSE: 'expense', CARD_PURCHASE: 'expense', REFUND: 'expense', SAVINGS_CONTRIBUTION: 'savings', INVESTMENT: 'savings',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return errorResponse(405, 'Método no permitido');

  const ctx = await userClient(req);
  if (!ctx) return errorResponse(401, 'No autenticado');
  const { client } = ctx;

  let body: { transaction_id?: unknown };
  try { body = await req.json(); } catch { return errorResponse(400, 'JSON inválido'); }
  const id = body.transaction_id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) return errorResponse(400, 'transaction_id debe ser un UUID');

  // Bloqueo optimista: solo una ejecución pasa de pending/failed a processing.
  const { data: claimed, error: claimErr } = await client.from('transactions')
    .update({ ai_status: 'processing' })
    .eq('id', id).eq('entry_mode', 'simple').in('ai_status', ['pending', 'failed']).is('deleted_at', null)
    .select('id, type, description, original_note, account_id, category_id, ai_status');
  if (claimErr) return errorResponse(500, 'No se pudo leer la transacción');
  const tx = claimed?.[0];
  if (!tx) return json({ status: 'skipped', engine: 'rules', suggestion: null, message: 'No hay nada pendiente para este movimiento' });

  const [{ data: cats }, { data: accs }] = await Promise.all([
    client.from('categories').select('id, name, slug, kind').is('deleted_at', null),
    client.from('accounts').select('id, name, kind').is('deleted_at', null),
  ]);
  const wantedKind = KIND_FOR_TYPE[tx.type] ?? null;
  const allowedCats = (cats ?? []).filter((c) => c.slug && (!wantedKind || c.kind === wantedKind));
  const note: string = tx.original_note ?? tx.description;

  const rulesSlug = matchCategorySlug(note);
  const rulesCat = allowedCats.find((c) => c.slug === rulesSlug) ?? null;
  let suggestion: Record<string, unknown> = {
    engine: 'rules', category_slug: rulesCat?.slug ?? null, category_id: rulesCat?.id ?? null,
    normalized_description: null, account_id: null, confidence: rulesCat ? 0.6 : null, model: null, rationale: rulesCat ? 'Coincidencia de palabras clave' : null,
  };
  let aiError: string | null = null;

  if (groqConfigured() && wantedKind) {
    try {
      const system = [
        'Eres un clasificador de movimientos financieros personales en República Dominicana (pesos RD$).',
        'Responde SOLO un objeto JSON con las claves: category_slug, normalized_description, account_id, confidence, rationale.',
        'category_slug: uno de la lista dada o null si no estás seguro. account_id: uno de la lista dada o null.',
        'normalized_description: descripción breve y clara en español (máx. 60 caracteres), SIN importes ni fechas.',
        'confidence: número entre 0 y 1. rationale: una frase corta.',
        'NUNCA inventes importes, fechas, cuentas ni categorías fuera de las listas.',
      ].join(' ');
      const user = JSON.stringify({
        nota: note.slice(0, 500),
        tipo_movimiento: tx.type,
        categorias_permitidas: allowedCats.map((c) => ({ slug: c.slug, nombre: c.name })),
        cuentas: (accs ?? []).map((a) => ({ id: a.id, nombre: a.name, tipo: a.kind })),
      });
      const raw = await groqChat([{ role: 'system', content: system }, { role: 'user', content: user }], { json: true, maxTokens: 300 });
      const out = JSON.parse(raw) as Record<string, unknown>;
      const cat = allowedCats.find((c) => c.slug === out.category_slug) ?? null;
      const acc = (accs ?? []).find((a) => a.id === out.account_id) ?? null;
      const conf = typeof out.confidence === 'number' ? Math.max(0, Math.min(1, out.confidence)) : null;
      suggestion = {
        engine: 'groq', model: groqModel(),
        category_slug: cat?.slug ?? null, category_id: cat?.id ?? null,
        normalized_description: sanitizeDescription(out.normalized_description, note),
        account_id: acc?.id ?? null, confidence: conf,
        rationale: typeof out.rationale === 'string' ? out.rationale.slice(0, 200) : null,
      };
    } catch (e) {
      aiError = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    }
  } else if (!groqConfigured()) {
    aiError = 'Groq no configurado: se usaron reglas locales';
  }

  const hasSomething = Boolean(suggestion.category_id || suggestion.normalized_description);
  const status = hasSomething ? 'suggested' : 'failed';
  const { error: updErr } = await client.from('transactions').update({
    ai_status: status, ai_suggestion: suggestion, ai_processed_at: new Date().toISOString(), ai_error: aiError,
  }).eq('id', id);
  if (updErr) return errorResponse(500, 'No se pudo guardar la sugerencia');

  return json({ status, engine: suggestion.engine, suggestion: hasSomething ? suggestion : null, message: aiError ?? undefined });
});

