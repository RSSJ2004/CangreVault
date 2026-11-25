/**
 * Abstracción de dictado por voz. En la web usa la Web Speech API cuando el
 * navegador la ofrece (Chrome/Edge/Android). En la app Android (Fase 2) se
 * implementará la misma interfaz con SpeechRecognizer nativo; el texto resultante
 * pasa por el mismo intérprete de notas del Modo Simple.
 */
export interface SpeechInput {
  readonly supported: boolean;
  start(onText: (text: string, final: boolean) => void, onError: (msg: string) => void): () => void;
}

type Recognition = {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void;
};

export function createWebSpeechInput(lang = 'es-DO'): SpeechInput {
  const w = typeof window !== 'undefined' ? (window as unknown as Record<string, unknown>) : {};
  const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => Recognition) | undefined;
  return {
    supported: Boolean(Ctor),
    start(onText, onError) {
      if (!Ctor) {
        onError('Tu navegador no soporta dictado por voz.');
        return () => undefined;
      }
      const r = new Ctor();
      r.lang = lang;
      r.interimResults = true;
      r.continuous = false;
      r.onresult = (e) => {
        let text = '';
        let final = false;
        for (let i = 0; i < e.results.length; i++) {
          text += e.results[i]![0]!.transcript;
          final = e.results[i]!.isFinal;
        }
        onText(text, final);
      };
      r.onerror = (e) => onError(e.error === 'not-allowed' ? 'Permiso de micrófono denegado.' : `Error de dictado: ${e.error}`);
      r.start();
      return () => r.stop();
    },
  };
}
