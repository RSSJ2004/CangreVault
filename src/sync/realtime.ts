/**
 * Suscripción Realtime (Postgres Changes). Supabase aplica RLS a los eventos, de modo
 * que cada usuario solo recibe cambios de sus propias filas. Al recibir un cambio se
 * invalidan las consultas afectadas para releer desde la base de datos (fuente de verdad).
 */
import type { QueryClient } from '@tanstack/react-query';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

export const TABLE_QUERY_KEYS: Record<string, string[][]> = {
  profiles: [['profile'], ['incomeHistory']],
  accounts: [['accounts'], ['serverBalances']],
  categories: [['categories']],
  income_sources: [['incomeSources']],
  transactions: [['transactions'], ['serverBalances']],
  recurring_expenses: [['recurring']],
  savings_goals: [['goals']],
  savings_contributions: [['contributions']],
  credit_card_cycles: [['cycles']],
  import_batches: [['imports']],
  reconciliation_records: [['reconciliations'], ['serverBalances']],
};

export type RealtimeStatus = 'connecting' | 'connected' | 'disconnected' | 'unavailable';

export function subscribeRealtime(userId: string, qc: QueryClient, onStatus: (s: RealtimeStatus) => void): () => void {
  if (!supabase) {
    onStatus('unavailable');
    return () => undefined;
  }
  let channel: RealtimeChannel = supabase.channel(`cv-user-${userId}`);
  for (const table of Object.keys(TABLE_QUERY_KEYS)) {
    channel = channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table, filter: `user_id=eq.${userId}` },
      () => {
        for (const key of TABLE_QUERY_KEYS[table] ?? []) void qc.invalidateQueries({ queryKey: key });
      },
    );
  }
  onStatus('connecting');
  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') onStatus('connected');
    else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') onStatus('disconnected');
  });
  return () => {
    void supabase?.removeChannel(channel);
  };
}
