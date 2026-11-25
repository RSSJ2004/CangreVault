/**
 * Cola local de escrituras pendientes ("outbox").
 *
 * - Cada movimiento nuevo recibe un client_id (UUID) en el dispositivo.
 * - Se guarda primero en localStorage y luego se envía con UPSERT por client_id,
 *   así un reintento nunca duplica la transacción (idempotencia).
 * - Si no hay red, queda "pendiente" y se reintenta al recuperar la conexión.
 * - Si el servidor la rechaza por reglas (no por red), queda "fallida" con el
 *   mensaje, para que la persona la corrija o la descarte. Nada se pierde en silencio.
 *
 * Realtime NO sustituye a esta cola: Realtime solo notifica cambios ya guardados.
 */
import type { Transaction } from '@/domain/types';
import { upsertTransaction } from '@/repositories/finance';
import { toAppError } from '@/lib/errors';

export interface OutboxItem {
  clientId: string;
  kind: 'transaction.upsert';
  payload: Partial<Transaction> & { clientId: string };
  createdAt: string;
  attempts: number;
  status: 'pending' | 'failed';
  lastError: string | null;
  /** Ejecutar normalización IA tras sincronizar (entradas del Modo Simple). */
  requestAi: boolean;
}

type Listener = (items: OutboxItem[]) => void;

let userKey: string | null = null;
let items: OutboxItem[] = [];
const listeners = new Set<Listener>();
let flushing: Promise<void> | null = null;
let onSynced: ((tx: Transaction, item: OutboxItem) => void) | null = null;

function storageKey() {
  return userKey ? `cangrevault.outbox.${userKey}` : null;
}

function persist() {
  const k = storageKey();
  if (!k) return;
  try {
    localStorage.setItem(k, JSON.stringify(items));
  } catch {
    // Almacenamiento lleno o bloqueado: la cola sigue en memoria durante la sesión.
  }
  listeners.forEach((l) => l([...items]));
}

export function initOutbox(userId: string | null, synced: typeof onSynced) {
  userKey = userId;
  onSynced = synced;
  items = [];
  const k = storageKey();
  if (k) {
    try {
      const raw = localStorage.getItem(k);
      items = raw ? (JSON.parse(raw) as OutboxItem[]) : [];
    } catch {
      items = [];
    }
  }
  listeners.forEach((l) => l([...items]));
}

export function subscribeOutbox(l: Listener): () => void {
  listeners.add(l);
  l([...items]);
  return () => listeners.delete(l);
}

export function getOutbox(): OutboxItem[] {
  return [...items];
}

export function enqueueTransaction(payload: OutboxItem['payload'], opts: { requestAi?: boolean } = {}): OutboxItem {
  const existing = items.find((i) => i.clientId === payload.clientId);
  const item: OutboxItem = existing ?? {
    clientId: payload.clientId, kind: 'transaction.upsert', payload, createdAt: new Date().toISOString(),
    attempts: 0, status: 'pending', lastError: null, requestAi: Boolean(opts.requestAi),
  };
  if (existing) {
    existing.payload = payload;
    existing.status = 'pending';
    existing.lastError = null;
  } else {
    items.push(item);
  }
  persist();
  void flushOutbox();
  return item;
}

export function discardOutboxItem(clientId: string) {
  items = items.filter((i) => i.clientId !== clientId);
  persist();
}

export function retryOutboxItem(clientId: string) {
  const it = items.find((i) => i.clientId === clientId);
  if (it) {
    it.status = 'pending';
    it.lastError = null;
    persist();
    void flushOutbox();
  }
}

export function flushOutbox(): Promise<void> {
  if (flushing) return flushing;
  // Importante: `flushing` se limpia en .finally() DESPUÉS de asignarse. Si se limpiara
  // dentro del cuerpo async, con la cola vacía el cuerpo terminaría de forma síncrona
  // antes de la asignación y quedaría una promesa resuelta bloqueando futuros envíos.
  flushing = runFlush().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function runFlush(): Promise<void> {
  for (const item of [...items]) {
    if (item.status !== 'pending') continue;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
    item.attempts += 1;
    try {
      const saved = await upsertTransaction(item.payload);
      items = items.filter((i) => i.clientId !== item.clientId);
      persist();
      onSynced?.(saved, item);
    } catch (err) {
      const e = toAppError(err);
      if (e.isNetwork) {
        item.lastError = 'Sin conexión: se enviará automáticamente.';
        persist();
        break;
      }
      item.status = 'failed';
      item.lastError = e.message;
      persist();
    }
  }
}

let started = false;
export function startOutboxAutoFlush() {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('online', () => void flushOutbox());
  window.setInterval(() => void flushOutbox(), 30_000);
}
