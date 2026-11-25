/**
 * Edge Function: bank-sync — conexión bancaria automática mediante un agregador (Bridge).
 *
 * Contrato (docs/EDGE_FUNCTIONS.md):
 *   POST, Authorization: Bearer <JWT del usuario>
 *     { action: "config" }                                  → { configured, environment, applicationId }
 *     { action: "register", connectionId, scopedToken? }    → confirma con Bridge, guarda y sincroniza
 *     { action: "sync", connectionId? }                     → sincronización manual
 *     { action: "reclassify" }                              → reevalúa tras vincular cuentas
 *     { action: "resolve", rawId, decision, ... }           → decide un movimiento en revisión
 *     { action: "revoke", connectionId }                    → revoca en Bridge y marca revocada
 *   POST, header x-bank-sync-secret: <BANK_SYNC_CRON_SECRET>, { action: "scheduled" }
 *     → sincroniza todas las conexiones activas (pg_cron + pg_net; ver BANK_INTEGRATION_REPORT).
 *
 * Seguridad:
 *  - Clave de API de Bridge y clave de cifrado SOLO en secretos de Edge Functions.
 *  - El scoped token se cifra (AES-GCM, ligado al user_id) antes de guardarse.
 *  - Única función que usa service_role (escritura de tablas bancarias y lectura de
 *    credenciales); todas las consultas filtran por el user_id autenticado.
 *  - Nunca recibe ni guarda usuario/contraseña del banco: eso ocurre en Bridge Connect.
 *  - Bridge no documenta webhooks: no se expone un endpoint de webhook sin un esquema
 *    de firma verificable. La automatización usa la sincronización programada.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, errorResponse, json, UUID_RE } from '../_shared/http.ts';
import { userClient } from '../_shared/supabaseClient.ts';
import { BridgeProvider } from '../_shared/bank/bridge.ts';
import { ProviderError } from '../_shared/bank/provider.ts';
import { decryptToken, encryptToken, importKey } from '../_shared/bank/crypto.ts';
import { SupabaseStore, mapConnection } from '../_shared/bank/supabaseStore.ts';
import { applyClassification, messageOf, syncConnection, type ConnectionRow } from '../_shared/bank/sync.ts';
import { stableUuid } from '../_shared/bank/classify.ts';

type Row = Record<string, unknown>;
const PROVIDER = 'bridge';
const CONNECTION_RE = /^[A-Za-z0-9_-]{3,120}$/;

function provider() {
  return new BridgeProvider({ apiKey: Deno.env.get('BRIDGE_API_KEY') ?? '', baseUrl: Deno.env.get('BRIDGE_API_BASE') ?? undefined });
}
function adminClient(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
}
const aad = (userId: string, env: string) => `cangrevault:${PROVIDER}:${env}:${userId}`;

async function saveToken(db: SupabaseClient, userId: string, env: string, token: string) {
  const key = await importKey(Deno.env.get('BANK_TOKEN_ENCRYPTION_KEY'));
  const { ciphertext, iv } = await encryptToken(key, token, aad(userId, env));
  const { error } = await db.from('bank_provider_credentials').upsert({ user_id: userId, provider: PROVIDER, environment: env, token_ciphertext: ciphertext, token_iv: iv },
    { onConflict: 'user_id,provider,environment' });
  if (error) throw new Error('No se pudo guardar la credencial cifrada');
}

async function loadToken(db: SupabaseClient, userId: string, env: string): Promise<string | null> {
  const { data, error } = await db.from('bank_provider_credentials').select('token_ciphertext, token_iv')
    .eq('user_id', userId).eq('provider', PROVIDER).eq('environment', env).maybeSingle();
  if (error) throw new Error('No se pudo leer la credencial');
  if (!data) return null;
  const key = await importKey(Deno.env.get('BANK_TOKEN_ENCRYPTION_KEY'));
  return decryptToken(key, data.token_ciphertext, data.token_iv, aad(userId, env));
}

async function runSync(db: SupabaseClient, conn: Row, trigger: 'connect' | 'manual' | 'scheduled') {
  const c: ConnectionRow = mapConnection(conn);
  const store = new SupabaseStore(db);
  const token = await loadToken(db, c.userId, String(conn.environment));
  if (!token) {
    await store.updateConnection(c.id, { status: 'reauth_required', lastError: 'No hay token de acceso guardado: reconecta el banco.' });
    return { status: 'error', error: 'No hay token de acceso guardado: reconecta el banco.' };
  }
  return syncConnection({ provider: provider(), store, conn: c, scopedToken: token, trigger });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return errorResponse(405, 'Método no permitido');
  let body: Row;
  try { body = await req.json(); } catch { return errorResponse(400, 'JSON inválido'); }
  const db = adminClient();

  // ---- Sincronización programada (sin usuario): secreto compartido con pg_cron.
  const cronSecret = Deno.env.get('BANK_SYNC_CRON_SECRET');
  const given = req.headers.get('x-bank-sync-secret');
  if (body.action === 'scheduled') {
    if (!cronSecret || !given || given !== cronSecret) return errorResponse(401, 'No autorizado');
    const { data } = await db.from('bank_connections').select('*').in('status', ['active', 'error']).is('deleted_at', null).limit(500);
    const results = [];
    for (const conn of (data ?? []) as Row[]) {
      try { results.push({ id: conn.id, ...(await runSync(db, conn, 'scheduled')) }); }
      catch (e) { results.push({ id: conn.id, status: 'error', error: messageOf(e) }); }
    }
    return json({ synced: results.length, results: results.map((r) => ({ id: r.id, status: (r as Row).status })) });
  }

  // ---- Acciones del usuario autenticado.
  const ctx = await userClient(req);
  if (!ctx) return errorResponse(401, 'No autenticado');
  const userId = ctx.user.id;

  try {
    switch (body.action) {
      case 'config': {
        if (!Deno.env.get('BRIDGE_API_KEY') || !Deno.env.get('BANK_TOKEN_ENCRYPTION_KEY')) return json({ configured: false, environment: null });
        const who = await provider().whoami();
        return json({ configured: true, environment: who.environment, applicationId: who.applicationId });
      }

      case 'register': {
        const connectionId = body.connectionId;
        if (typeof connectionId !== 'string' || !CONNECTION_RE.test(connectionId)) return errorResponse(400, 'connectionId inválido');
        const p = provider();
        const app = await p.whoami();
        let token = typeof body.scopedToken === 'string' && body.scopedToken.length > 10 ? body.scopedToken : null;
        if (token) {
          // El token debe pertenecer a ESTE usuario (externalUserId = id de Supabase).
          const who = await p.whoami(token);
          if (who.user?.externalUserId && who.user.externalUserId !== userId) return errorResponse(403, 'El token de Bridge pertenece a otro usuario');
        } else {
          token = await loadToken(db, userId, app.environment);
          if (!token) return errorResponse(409, 'Bridge no devolvió un token y no hay uno guardado. Revoca la conexión en Bridge y vuelve a conectar.');
        }
        // La conexión se considera real SOLO si Bridge la lista para este token.
        const conns = await p.listConnections(token);
        const remote = conns.find((c) => c.id === connectionId);
        if (!remote) return errorResponse(403, 'Bridge no confirmó esta conexión para tu usuario');
        if (remote.revokedAt) return errorResponse(409, 'La conexión está revocada en Bridge');
        if (body.scopedToken) await saveToken(db, userId, app.environment, token);
        const { data: up, error } = await db.from('bank_connections').upsert({
          user_id: userId, provider: PROVIDER, provider_connection_id: connectionId, environment: app.environment,
          institution_id: remote.institutionId, institution_name: remote.institutionName, status: 'active', revoked_at: null, deleted_at: null,
          last_error: null, consecutive_failures: 0,
        }, { onConflict: 'provider,provider_connection_id' }).select('*');
        if (error || !up?.[0]) throw new Error('No se pudo registrar la conexión');
        if (up[0].user_id !== userId) return errorResponse(403, 'La conexión pertenece a otro usuario');
        const summary = await runSync(db, up[0], 'connect');
        return json({ connection: { id: up[0].id, institution: remote.institutionName, environment: app.environment }, summary });
      }

      case 'sync': {
        let q = db.from('bank_connections').select('*').eq('user_id', userId).neq('status', 'revoked').is('deleted_at', null);
        if (body.connectionId !== undefined) {
          if (typeof body.connectionId !== 'string' || !UUID_RE.test(body.connectionId)) return errorResponse(400, 'connectionId inválido');
          q = q.eq('id', body.connectionId);
        }
        const { data } = await q;
        const out = [];
        for (const conn of (data ?? []) as Row[]) out.push({ id: conn.id, summary: await runSync(db, conn, 'manual') });
        return json({ results: out });
      }

      case 'reclassify': {
        const r = await applyClassification(new SupabaseStore(db), userId, new Date().toISOString().slice(0, 10));
        return json(r);
      }

      case 'resolve': {
        const rawId = body.rawId;
        if (typeof rawId !== 'string' || !UUID_RE.test(rawId)) return errorResponse(400, 'rawId inválido');
        const { data: raw } = await db.from('bank_provider_transactions').select('*, ext:external_account_id(account_id, currency)')
          .eq('id', rawId).eq('user_id', userId).maybeSingle();
        if (!raw) return errorResponse(404, 'Movimiento no encontrado');
        if (raw.transaction_id && raw.provider_status !== 'void') return errorResponse(409, 'Este movimiento ya está registrado');
        const set = (patch: Row) => db.from('bank_provider_transactions').update(patch).eq('id', rawId).eq('user_id', userId);

        if (body.decision === 'ignore') { await set({ review_status: 'ignored', review_reason: 'Descartado por ti.' }); return json({ ok: true }); }

        const abs = Math.abs(Math.round(Number(raw.amount) * 100));
        if (body.decision === 'link_existing') {
          if (typeof body.transactionId !== 'string' || !UUID_RE.test(body.transactionId)) return errorResponse(400, 'transactionId inválido');
          const { data: tx } = await db.from('transactions').select('id, amount').eq('id', body.transactionId).eq('user_id', userId).is('deleted_at', null).maybeSingle();
          if (!tx) return errorResponse(404, 'Movimiento de CangreVault no encontrado');
          if (Math.round(Number(tx.amount) * 100) !== abs) return errorResponse(422, 'Los importes no coinciden: no se pueden vincular');
          await set({ review_status: 'linked', review_reason: 'Vinculado por ti a un movimiento existente.', transaction_id: tx.id });
          return json({ ok: true });
        }

        if (body.decision === 'create') {
          const ext = raw.ext as Row | null;
          if (!ext?.account_id) return errorResponse(409, 'Vincula primero la cuenta bancaria');
          const type = String(body.type);
          const allowed = ['INCOME', 'EXPENSE', 'CARD_PURCHASE', 'REFUND', 'TRANSFER', 'SAVINGS_CONTRIBUTION', 'CARD_PAYMENT'];
          if (!allowed.includes(type)) return errorResponse(400, 'Tipo no permitido');
          const needsCounter = ['TRANSFER', 'SAVINGS_CONTRIBUTION', 'CARD_PAYMENT'].includes(type);
          const counter = typeof body.counterAccountId === 'string' && UUID_RE.test(body.counterAccountId) ? body.counterAccountId : null;
          if (needsCounter && !counter) return errorResponse(400, 'Indica la otra cuenta del movimiento');
          const outflow = Number(raw.amount) < 0;
          const from = needsCounter ? (outflow ? ext.account_id : counter) : ext.account_id;
          const to = needsCounter ? (outflow ? counter : ext.account_id) : null;
          const categoryId = typeof body.categoryId === 'string' && UUID_RE.test(body.categoryId) ? body.categoryId : null;
          const clientId = await stableUuid('cangrevault-bank', `${userId}:resolve:${raw.provider_transaction_id}`);
          // El trigger validate_transaction aplica todas las reglas contables (tipo/cuenta/moneda).
          const { data: tx, error } = await db.from('transactions').upsert({
            user_id: userId, client_id: clientId, type, account_id: from, to_account_id: to, amount: (abs / 100).toFixed(2), currency: raw.currency,
            occurred_on: raw.occurred_on, description: String(raw.description).slice(0, 300), category_id: categoryId,
            classification_source: categoryId ? 'user' : null, bank_reference: raw.reference, dedupe_key: `bank:resolve:${raw.provider_transaction_id}`.slice(0, 200),
            entry_mode: 'import', source: 'bank_sync', ai_status: 'none',
          }, { onConflict: 'client_id' }).select('id');
          if (error || !tx?.[0]) return errorResponse(422, error?.message ?? 'No se pudo registrar');
          await set({ review_status: 'linked', review_reason: 'Clasificado por ti.', transaction_id: tx[0].id });
          return json({ ok: true, transactionId: tx[0].id });
        }
        return errorResponse(400, 'Decisión desconocida');
      }

      case 'revoke': {
        if (typeof body.connectionId !== 'string' || !UUID_RE.test(body.connectionId)) return errorResponse(400, 'connectionId inválido');
        const { data: conn } = await db.from('bank_connections').select('*').eq('id', body.connectionId).eq('user_id', userId).maybeSingle();
        if (!conn) return errorResponse(404, 'Conexión no encontrada');
        try { await provider().revokeConnection(String(conn.provider_connection_id)); }
        catch (e) { if (!(e instanceof ProviderError && e.kind === 'not_found')) throw e; }
        await db.from('bank_connections').update({ status: 'revoked', revoked_at: new Date().toISOString(), last_error: null }).eq('id', conn.id).eq('user_id', userId);
        await db.from('bank_external_accounts').update({ sync_enabled: false }).eq('connection_id', conn.id).eq('user_id', userId);
        // Sin conexiones activas del mismo entorno, se destruye el token cifrado.
        const { count } = await db.from('bank_connections').select('id', { count: 'exact', head: true })
          .eq('user_id', userId).eq('environment', conn.environment).neq('status', 'revoked');
        if (!count) await db.from('bank_provider_credentials').delete().eq('user_id', userId).eq('provider', PROVIDER).eq('environment', conn.environment);
        return json({ ok: true });
      }

      default:
        return errorResponse(400, 'Acción desconocida');
    }
  } catch (e) {
    if (e instanceof ProviderError) {
      const status = e.kind === 'config' ? 503 : e.kind === 'reauth' ? 403 : e.kind === 'rate_limited' ? 429 : 502;
      return errorResponse(status, e.message, e.kind);
    }
    console.error('bank-sync', messageOf(e));
    return errorResponse(500, messageOf(e));
  }
});
