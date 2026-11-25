/**
 * Estado global de la app: modo (Simple/Normal), estado de sincronización,
 * cola offline y conexión Realtime. Los datos financieros viven en React Query.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/auth/AuthProvider';
import { initOutbox, startOutboxAutoFlush, subscribeOutbox, flushOutbox, type OutboxItem } from '@/sync/outbox';
import { subscribeRealtime, type RealtimeStatus } from '@/sync/realtime';
import { requestNormalization } from '@/integrations/ai/aiClient';
import { updateProfile } from '@/repositories/finance';

export type Mode = 'simple' | 'normal';

interface AppStateValue {
  mode: Mode;
  setMode: (m: Mode) => void;
  online: boolean;
  realtime: RealtimeStatus;
  outbox: OutboxItem[];
  flush: () => Promise<void>;
}

const Ctx = createContext<AppStateValue | null>(null);
const MODE_KEY = 'cangrevault.mode';

function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'normal' ? 'normal' : 'simple';
  } catch {
    return 'simple';
  }
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [mode, setModeState] = useState<Mode>(readMode);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [realtime, setRealtime] = useState<RealtimeStatus>('connecting');
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    initOutbox(user?.id ?? null, (tx, item) => {
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['serverBalances'] });
      if (item.requestAi && tx.aiStatus === 'pending') {
        // Normalización IA en segundo plano. Si falla, el registro queda "pending" y se puede reintentar.
        void requestNormalization(tx.id)
          .catch(() => undefined)
          .finally(() => void qc.invalidateQueries({ queryKey: ['transactions'] }));
      }
    });
    startOutboxAutoFlush();
    const unsub = subscribeOutbox(setOutbox);
    if (user) void flushOutbox();
    return unsub;
  }, [user, qc]);

  useEffect(() => {
    if (!user) return;
    return subscribeRealtime(user.id, qc, setRealtime);
  }, [user, qc]);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* preferencia solo local */
    }
    if (user) void updateProfile(user.id, { preferredMode: m }).catch(() => undefined);
  }, [user]);

  const value = useMemo(() => ({ mode, setMode, online, realtime, outbox, flush: flushOutbox }), [mode, setMode, online, realtime, outbox]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAppState(): AppStateValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAppState fuera de AppStateProvider');
  return v;
}
