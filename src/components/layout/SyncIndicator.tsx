import { useState } from 'react';
import { useAppState } from '@/state/AppState';
import { discardOutboxItem, retryOutboxItem } from '@/sync/outbox';
import { Button, Modal, cx } from '@/components/ui';
import { formatMoney } from '@/domain/money';

/** Estado REAL de sincronización: red del navegador, canal Realtime y cola local. */
export function SyncIndicator({ dark, compact }: { dark?: boolean; compact?: boolean }) {
  const { online, realtime, outbox, flush } = useAppState();
  const [open, setOpen] = useState(false);
  const failed = outbox.filter((o) => o.status === 'failed').length;
  const pending = outbox.length - failed;

  let label = 'Sincronizado';
  let dot = 'bg-emerald-400';
  if (!online) { label = 'Sin conexión'; dot = 'bg-slate-400'; }
  else if (failed) { label = `${failed} con error`; dot = 'bg-red-500'; }
  else if (pending) { label = `${pending} pendiente(s)`; dot = 'bg-amber-400'; }
  else if (realtime !== 'connected') { label = realtime === 'connecting' ? 'Conectando…' : 'Tiempo real inactivo'; dot = 'bg-amber-400'; }

  return (
    <>
      <button onClick={() => setOpen(true)} className={cx('inline-flex items-center gap-2 rounded-md text-xs', dark ? 'text-brand-100' : 'text-muted')} title="Estado de sincronización">
        <span className={cx('h-2 w-2 rounded-full', dot)} />
        {!compact && label}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Sincronización">
        <ul className="space-y-1 text-sm">
          <li>Red: <strong>{online ? 'conectado' : 'sin conexión'}</strong></li>
          <li>Tiempo real (Supabase Realtime): <strong>{realtime === 'connected' ? 'activo' : realtime}</strong></li>
          <li>Cambios locales pendientes de enviar: <strong>{outbox.length}</strong></li>
        </ul>
        <p className="mt-3 text-xs text-muted">
          Los movimientos se guardan primero en este dispositivo con un identificador único y se envían al servidor;
          si no hay conexión se reintentan automáticamente sin duplicarse. Tiempo real solo avisa de cambios ya guardados
          en otros dispositivos o sesiones.
        </p>
        {outbox.length > 0 && (
          <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
            {outbox.map((o) => (
              <li key={o.clientId} className="flex items-start justify-between gap-3 p-3 text-sm">
                <div>
                  <div className="font-medium">{o.payload.description} · {o.payload.amount !== undefined ? formatMoney(o.payload.amount) : ''}</div>
                  <div className={cx('text-xs', o.status === 'failed' ? 'text-red-700' : 'text-muted')}>{o.lastError ?? 'En cola'}</div>
                </div>
                {o.status === 'failed' && (
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" variant="secondary" onClick={() => retryOutboxItem(o.clientId)}>Reintentar</Button>
                    <Button size="sm" variant="danger" onClick={() => discardOutboxItem(o.clientId)}>Descartar</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex justify-end"><Button variant="secondary" onClick={() => void flush()}>Sincronizar ahora</Button></div>
      </Modal>
    </>
  );
}
