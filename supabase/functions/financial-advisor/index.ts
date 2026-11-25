/**
 * Edge Function: financial-advisor
 *
 * Contrato (docs/EDGE_FUNCTIONS.md):
 *   POST { question: string, mode: "simple"|"normal", snapshot: object, history?: [{role, content}] }
 *   200  { answer, sources: [{slug,title,content_type,source_reference,source_url,verified}], model, disclaimer }
 *   503  { error } si Groq no está configurado (se incluyen las fuentes relevantes como respaldo)
 *
 * El asesor responde SOLO con: (a) la instantánea financiera del propio usuario y
 * (b) la base de conocimiento curada (ai_knowledge_base). No hace scraping.
 */
import { corsHeaders, errorResponse, json } from '../_shared/http.ts';
import { userClient } from '../_shared/supabaseClient.ts';
import { groqChat, groqConfigured, groqModel, type ChatMessage } from '../_shared/groq.ts';
import { rankKnowledge, type KbEntry } from '../_shared/sanitize.ts';

const DISCLAIMER = 'Orientación educativa basada en tus datos y en fuentes citadas. No sustituye asesoría financiera, legal ni las condiciones de tu contrato con el banco.';

function contentTypeLabel(t: string): string {
  return t === 'official' ? 'INFORMACIÓN OFICIAL' : t === 'general_principle' ? 'PRINCIPIO GENERAL' : 'RECOMENDACIÓN ORIENTATIVA';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return errorResponse(405, 'Método no permitido');
  const ctx = await userClient(req);
  if (!ctx) return errorResponse(401, 'No autenticado');

  let body: { question?: unknown; mode?: unknown; snapshot?: unknown; history?: unknown };
  try { body = await req.json(); } catch { return errorResponse(400, 'JSON inválido'); }
  const question = typeof body.question === 'string' ? body.question.trim().slice(0, 1000) : '';
  if (question.length < 3) return errorResponse(400, 'Escribe una pregunta');
  const mode = body.mode === 'normal' ? 'normal' : 'simple';
  const snapshotStr = JSON.stringify(body.snapshot ?? {});
  if (snapshotStr.length > 12_000) return errorResponse(413, 'Instantánea demasiado grande');
  const history: ChatMessage[] = Array.isArray(body.history)
    ? (body.history as { role?: unknown; content?: unknown }[])
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-6)
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: (m.content as string).slice(0, 2000) }))
    : [];

  const { data: kbRows, error: kbErr } = await ctx.client.from('ai_knowledge_base')
    .select('slug, title, topic, target_audience, content_type, principle_summary, actionable_tip, source_reference, source_url, verification_date, keywords')
    .eq('is_active', true);
  if (kbErr) return errorResponse(500, 'No se pudo leer la base de conocimiento');
  const relevant = rankKnowledge(question, (kbRows ?? []) as KbEntry[], mode);
  const sources = relevant.map((e) => ({
    slug: e.slug, title: e.title, content_type: e.content_type, source_reference: e.source_reference, source_url: e.source_url,
    verified: Boolean(e.verification_date),
  }));

  if (!groqConfigured()) {
    return json({ error: 'El asesor IA no está configurado (falta GROQ_API_KEY en los secretos de Supabase).', sources }, 503);
  }

  const kbText = relevant.length
    ? relevant.map((e) => `[${e.slug}] (${contentTypeLabel(e.content_type)}${e.verification_date ? `, verificado ${e.verification_date}` : ', PENDIENTE DE VERIFICACIÓN'}) ${e.title}\nResumen: ${e.principle_summary}\nConsejo: ${e.actionable_tip}\nFuente: ${e.source_reference}`).join('\n\n')
    : '(No hay entradas relevantes en la base de conocimiento para esta pregunta.)';

  const style = mode === 'simple'
    ? 'Usa lenguaje muy sencillo, frases cortas, sin términos contables (di "lo que entra" y "lo que sale"). Máximo 150 palabras.'
    : 'Puedes usar términos contables (estado de resultados, patrimonio, utilización, conciliación). Sé preciso y estructurado. Máximo 300 palabras.';

  const system = [
    'Eres el asesor financiero educativo de CangreVault para una persona en República Dominicana (moneda RD$).',
    style,
    'REGLAS ESTRICTAS:',
    '1. Usa SOLO los números de la INSTANTÁNEA del usuario. No inventes importes, fechas, tasas ni movimientos. Si falta un dato, dilo.',
    '2. Para conceptos y consejos usa SOLO la BASE DE CONOCIMIENTO y cita la clave entre corchetes, p. ej. [cc_minimum_vs_full_payment].',
    '3. Indica si cada consejo es INFORMACIÓN OFICIAL, PRINCIPIO GENERAL o RECOMENDACIÓN ORIENTATIVA. Si la fuente está pendiente de verificación, menciónalo.',
    '4. Nunca prometas resultados en la calificación crediticia ni garantices rendimientos.',
    '5. No recomiendes productos financieros específicos. Si la pregunta excede tu alcance, sugiere consultar al banco o a ProUsuario.',
    '6. Responde en español.',
  ].join('\n');

  const userMsg = `INSTANTÁNEA (datos reales del usuario, montos en RD$):\n${snapshotStr}\n\nBASE DE CONOCIMIENTO:\n${kbText}\n\nPREGUNTA: ${question}`;
  try {
    const answer = await groqChat([{ role: 'system', content: system }, ...history, { role: 'user', content: userMsg }], { maxTokens: 700, temperature: 0.2 });
    return json({ answer, sources, model: groqModel(), disclaimer: DISCLAIMER });
  } catch (e) {
    return json({ error: `El servicio de IA no respondió: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`, sources }, 502);
  }
});
