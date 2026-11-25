import { useEffect } from 'react';
import { useFinancialSnapshot } from '@/hooks/useFinance';
import { notifyReminders } from '@/integrations/notifications';

/** Envía notificaciones del navegador (si la persona las activó) para recordatorios importantes. */
export function ReminderNotifier() {
  const { snapshot, loading } = useFinancialSnapshot();
  useEffect(() => {
    if (!loading) notifyReminders(snapshot.reminders, snapshot.today);
  }, [loading, snapshot.reminders, snapshot.today]);
  return null;
}
