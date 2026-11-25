# Edge Functions

Ambas funciones: `POST`, `Authorization: Bearer <JWT del usuario>` (`verify_jwt = true`), CORS
habilitado. Usan la clave **anon** + el JWT del usuario, así que todo acceso a datos pasa por RLS.
Nunca usan `service_role`.

Secretos: `GROQ_API_KEY` (obligatorio para IA), `GROQ_MODEL` (por defecto
`llama-3.3-70b-versatile`), `ALLOWED_ORIGIN` (opcional, por defecto `*`).

## `normalize-simple-entry`

Clasifica una nota del Modo Simple **ya guardada**.

Petición:
```json
{ "transaction_id": "8f6c…-uuid" }
```
Respuesta 200:
```json
{
  "status": "suggested",            // suggested | skipped | failed
  "engine": "groq",                 // groq | rules
  "suggestion": {
    "engine": "groq", "model": "llama-3.3-70b-versatile",
    "category_slug": "electricity", "category_id": "uuid",
    "normalized_description": "Pago de electricidad",
    "account_id": null, "confidence": 0.92, "rationale": "Menciona luz"
  },
  "message": "opcional"
}
```
Errores: `400` (UUID inválido / JSON), `401` (sin sesión), `405`, `500`.

Garantías:
1. Solo procesa filas `entry_mode = 'simple'` con `ai_status` `pending` o `failed`
   (bloqueo optimista → `processing`). Si no, responde `skipped`. Llamarla varias veces es seguro.
2. Solo escribe `ai_status`, `ai_suggestion`, `ai_processed_at`, `ai_error`.
   **Nunca** importe, fecha, cuenta, categoría confirmada ni nuevas filas.
3. `category_slug`/`account_id` se validan contra las categorías/cuentas del usuario; los números
   que la IA añada a la descripción y no estén en la nota original se eliminan.
4. Sin Groq o si falla: reglas por palabras clave (`_shared/keywordRules.ts`, las mismas de la web).
5. La persona acepta (`ai_status = accepted`, `classification_source = 'ai'`) o descarta (`rejected`).

## `financial-advisor`

Petición:
```json
{
  "question": "¿Qué pasa si solo pago el mínimo?",
  "mode": "simple",
  "snapshot": { "dinero_disponible": "32090.00", "tarjetas": [ … ] },
  "history": [{ "role": "user", "content": "…" }, { "role": "assistant", "content": "…" }]
}
```
Respuesta 200:
```json
{
  "answer": "…texto con citas [cc_minimum_vs_full_payment]…",
  "sources": [{ "slug": "cc_minimum_vs_full_payment", "title": "…", "content_type": "general_principle",
                "source_reference": "…", "source_url": "https://…", "verified": false }],
  "model": "llama-3.3-70b-versatile",
  "disclaimer": "Orientación educativa…"
}
```
Errores: `400`, `401`, `413` (instantánea > 12 KB), `502` (Groq falló), `503` (Groq no
configurado; incluye `sources` relevantes como respaldo).

Recuperación de conocimiento determinística por palabras clave/tema (`_shared/sanitize.ts →
rankKnowledge`), filtrada por público (`simple`/`normal`/`all`). El prompt obliga a usar solo los
números de la instantánea, citar las entradas, distinguir información oficial / principio general /
recomendación orientativa, mencionar si la fuente está pendiente de verificación y no prometer
resultados de calificación crediticia.

## Despliegue

```bash
npx supabase functions deploy normalize-simple-entry
npx supabase functions deploy financial-advisor
npx deno check supabase/functions/*/index.ts   # verificación de tipos
```
