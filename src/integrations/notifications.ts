/**
 * Notificaciones del navegador para recordatorios (solo con la app abierta).
 * Se registra qué recordatorios ya se notificaron para no repetirlos el mismo día.
 */
import type { Reminder } from '@/domain/reminders';

const KEY = 'cangrevault.notifications';
const SENT = 'cangrevault.notified';

export function notificationsEnabled(): boolean {
  try {
    return typeof Notification !== 'undefined' && Notification.permission === 'granted' && localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export async function setNotificationsEnabled(on: boolean): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  try {
    if (!on) { localStorage.setItem(KEY, '0'); return false; }
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    localStorage.setItem(KEY, perm === 'granted' ? '1' : '0');
    return perm === 'granted';
  } catch {
    return false;
  }
}

export function notifyReminders(reminders: Reminder[], today: string) {
  if (!notificationsEnabled()) return;
  let sent: Record<string, string> = {};
  try { sent = JSON.parse(localStorage.getItem(SENT) ?? '{}') as Record<string, string>; } catch { sent = {}; }
  for (const r of reminders) {
    if (r.severity === 'info' || sent[r.id] === today) continue;
    try { new Notification(r.title, { body: r.detail, tag: r.id }); } catch { /* algunos navegadores móviles requieren service worker */ }
    sent[r.id] = today;
  }
  try { localStorage.setItem(SENT, JSON.stringify(sent)); } catch { /* ignore */ }
}
