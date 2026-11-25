/**
 * Conexiones bancarias (agregador Bridge). El navegador NUNCA llama a la API de Bridge:
 * solo abre el widget oficial Bridge Connect (donde la persona escribe sus credenciales,
 * fuera de CangreVault) y entrega el resultado a la Edge Function bank-sync.
 */
import { requireSupabase } from '@/lib/supabase';

export type BankAction =
  | { action: 'config' }
  | { action: 'register'; connectionId: string; scopedToken?: string }
  | { action: 'sync'; connectionId?: string }
  | { action: 'reclassify' }
  | { action: 'revoke'; connectionId: string }
  | { action: 'resolve'; rawId: string; decision: 'ignore' }
  | { action: 'resolve'; rawId: string; decision: 'link_existing'; transactionId: string }
  | { action: 'resolve'; rawId: string; decision: 'create'; type: string; counterAccountId?: string | null; categoryId?: string | null };

export async function bankAction<T = Record<string, unknown>>(body: BankAction): Promise<T> {
  const { data, error } = await requireSupabase().functions.invoke<T>('bank-sync', { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      const payload = (await ctx.json().catch(() => null)) as { error?: string } | null;
      if (payload?.error) throw new Error(payload.error);
    }
    if (/Failed to send|FunctionsFetchError|404/i.test(error.message)) {
      throw new Error('La función bank-sync no está desplegada en Supabase todavía.');
    }
    throw error;
  }
  return data as T;
}

// ------------------------------------------------------------------ Bridge Connect
interface BridgeConnectSuccess {
  connectionId: string;
  institution?: { id?: string; name?: string };
  accounts?: unknown[];
  scopedToken?: string;
}
interface BridgeConnectInstance { open(): void }
declare global {
  interface Window {
    BridgeConnect?: { init(opts: Record<string, unknown>): BridgeConnectInstance };
  }
}

const SCRIPT_SRC = 'https://static.bridge.com.do/connect/bridge-connect.js';
let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.BridgeConnect) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => (window.BridgeConnect ? resolve() : reject(new Error('Bridge Connect no se inicializó')));
    s.onerror = () => { loading = null; reject(new Error('No se pudo cargar Bridge Connect. Revisa tu conexión.')); };
    document.body.appendChild(s);
  });
  return loading;
}

export const bridgeApplicationId = (import.meta.env.VITE_BRIDGE_APPLICATION_ID as string | undefined)?.trim() || null;

/**
 * Abre el widget oficial. Con `connectionId` reautoriza una conexión existente.
 * Resuelve con el resultado del widget, o null si la persona lo cerró.
 */
export async function openBridgeConnect(opts: { userId: string; connectionId?: string }): Promise<BridgeConnectSuccess | null> {
  if (!bridgeApplicationId) throw new Error('Falta VITE_BRIDGE_APPLICATION_ID en la configuración del sitio.');
  await loadScript();
  return new Promise((resolve) => {
    const bc = window.BridgeConnect!.init({
      applicationId: bridgeApplicationId,
      externalUserId: opts.userId,
      ...(opts.connectionId ? { connectionId: opts.connectionId } : {}),
      onSuccess: (r: BridgeConnectSuccess) => resolve(r),
      onExit: () => resolve(null),
    });
    bc.open();
  });
}
