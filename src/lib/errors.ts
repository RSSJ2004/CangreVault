/** Convierte errores de PostgREST/Postgres/red en mensajes comprensibles en español. */
export interface AppError {
  message: string;
  isNetwork: boolean;
  code?: string;
}

export function toAppError(err: unknown): AppError {
  if (err && typeof err === 'object') {
    const e = err as { message?: string; code?: string; details?: string; name?: string; status?: number };
    const msg = e.message ?? 'Error desconocido';
    const isNetwork =
      e.name === 'TypeError' && /fetch|network|load failed/i.test(msg) ||
      /Failed to fetch|NetworkError|network request failed|ERR_INTERNET_DISCONNECTED/i.test(msg) ||
      e.status === 0;
    switch (e.code) {
      case '23505': return { message: 'Este registro ya existe (posible duplicado).', isNetwork: false, code: e.code };
      case '23503': return { message: msg.includes('violates') ? 'Referencia inválida a otra cuenta o registro.' : msg, isNetwork: false, code: e.code };
      case '23514': return { message: msg.includes('violates check constraint') ? 'Los datos no cumplen las reglas contables.' : msg, isNetwork: false, code: e.code };
      case '42501': return { message: 'No tienes permiso para esta operación.', isNetwork: false, code: e.code };
      case 'PGRST301': return { message: 'Tu sesión expiró. Vuelve a iniciar sesión.', isNetwork: false, code: e.code };
      default: return { message: msg, isNetwork, code: e.code };
    }
  }
  return { message: String(err), isNetwork: false };
}
