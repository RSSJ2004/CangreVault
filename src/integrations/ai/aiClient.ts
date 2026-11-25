/**
 * Cliente de las Edge Functions de IA. La clave de Groq vive SOLO en el servidor
 * (secreto de Supabase); el navegador envía su JWT y RLS limita lo que la función ve.
 */
import { requireSupabase } from '@/lib/supabase';

export interface NormalizeResult {
  status: 'suggested' | 'skipped' | 'failed';
  engine: 'groq' | 'rules';
  suggestion: Record<string, unknown> | null;
  message?: string;
}

export async function requestNormalization(transactionId: string): Promise<NormalizeResult> {
  const { data, error } = await requireSupabase().functions.invoke<NormalizeResult>('normalize-simple-entry', {
    body: { transaction_id: transactionId },
  });
  if (error) throw error;
  return data!;
}

export interface AdvisorAnswer {
  answer: string;
  sources: { slug: string; title: string; content_type: string; source_reference: string; source_url: string | null; verified: boolean }[];
  model: string;
  disclaimer: string;
}

export async function askAdvisor(body: {
  question: string;
  mode: 'simple' | 'normal';
  snapshot: Record<string, unknown>;
  history?: { role: 'user' | 'assistant'; content: string }[];
}): Promise<AdvisorAnswer> {
  const { data, error } = await requireSupabase().functions.invoke<AdvisorAnswer>('financial-advisor', { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      const payload = (await ctx.json().catch(() => null)) as { error?: string } | null;
      if (payload?.error) throw new Error(payload.error);
    }
    throw error;
  }
  return data!;
}
