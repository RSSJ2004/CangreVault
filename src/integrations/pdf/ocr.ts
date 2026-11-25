/**
 * Estrategia OCR (pendiente de implementación — ver docs/OCR_STRATEGY.md).
 * La interfaz está definida para poder enchufar un proveedor sin tocar la UI:
 *  - Web: tesseract.js (WASM, local, sin enviar el documento a terceros).
 *  - Android: ML Kit Text Recognition (on-device).
 * Hasta entonces, el importador informa que el PDF no tiene texto extraíble.
 */
export interface OcrProvider {
  readonly name: string;
  readonly available: boolean;
  recognize(file: ArrayBuffer): Promise<string[][]>;
}

export const noOcr: OcrProvider = {
  name: 'none',
  available: false,
  recognize: () => Promise.reject(new Error('OCR no disponible todavía. Descarga el estado de cuenta en PDF digital desde la banca en línea.')),
};
