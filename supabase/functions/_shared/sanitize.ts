/**
 * Saneamiento de la salida de IA (sin dependencias: lo usan Deno y las pruebas en Node).
 */

/** Elimina de la descripción cualquier número que no estuviera en la nota original (la IA no puede inventar importes). */
export function sanitizeDescription(desc: unknown, original: string): string | null {
  if (typeof desc !== 'string') return null;
  const allowed = new Set((original.match(/\d[\d.,]*/g) ?? []).map((n) => n.replace(/[.,]/g, '')));
  const cleaned = desc
    .replace(/\d[\d.,]*/g, (n) => (allowed.has(n.replace(/[.,]/g, '')) ? n : ''))
    .replace(/(rd\$|us\$|\$)(?=\s|$)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned.length >= 2 ? cleaned : null;
}

export interface KbEntry {
  slug: string;
  title: string;
  topic: string;
  target_audience: string;
  content_type: string;
  principle_summary: string;
  actionable_tip: string;
  source_reference: string;
  source_url: string | null;
  verification_date: string | null;
  keywords: string[];
}

const TOPIC_HINTS: Record<string, string[]> = {
  credit_card: ['tarjeta', 'corte', 'minimo', 'contado', 'credito', 'limite', 'interes', 'utilizacion', 'estado de cuenta'],
  budgeting: ['presupuesto', 'organizar', 'gasto', 'gastos', 'excedente', 'sobra', 'dinero'],
  emergency_fund: ['emergencia', 'imprevisto', 'fondo'],
  debt_management: ['deuda', 'deudas', 'pagar', 'reclamacion', 'prestamo'],
  investing_basics: ['invertir', 'inversion', 'rendimiento', 'certificado', 'riesgo'],
  accounting_basics: ['estado de resultados', 'patrimonio', 'conciliar', 'conciliacion', 'contable', 'balance'],
};

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Recupera las entradas más relevantes por coincidencia de palabras (determinístico, sin embeddings). */
export function rankKnowledge(question: string, entries: KbEntry[], mode: 'simple' | 'normal', limit = 5): KbEntry[] {
  const q = ` ${norm(question)} `;
  const scored = entries
    .filter((e) => e.target_audience === 'all' || e.target_audience === mode)
    .map((e) => {
      let score = 0;
      for (const k of e.keywords) if (q.includes(norm(k))) score += 3;
      for (const h of TOPIC_HINTS[e.topic] ?? []) if (q.includes(h)) score += 1;
      for (const w of norm(e.title).split(/\W+/)) if (w.length > 4 && q.includes(` ${w}`)) score += 1;
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.e);
}
