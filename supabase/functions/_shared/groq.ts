// Cliente mínimo de la API de Groq (compatible con OpenAI Chat Completions).
// La clave vive en el secreto GROQ_API_KEY de Supabase, nunca en el navegador.
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export function groqConfigured(): boolean {
  return Boolean(Deno.env.get('GROQ_API_KEY'));
}

export function groqModel(): string {
  return Deno.env.get('GROQ_MODEL') ?? 'llama-3.3-70b-versatile';
}

export async function groqChat(messages: ChatMessage[], opts: { json?: boolean; maxTokens?: number; temperature?: number } = {}): Promise<string> {
  const key = Deno.env.get('GROQ_API_KEY');
  if (!key) throw new Error('GROQ_API_KEY no configurada');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: groqModel(),
        messages,
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens ?? 600,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Groq ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Respuesta de Groq sin contenido');
    return content;
  } finally {
    clearTimeout(timeout);
  }
}
