/**
 * Extracción de texto de PDF en el navegador con pdf.js (Mozilla).
 * Reconstruye líneas agrupando fragmentos por su coordenada vertical.
 * Si el PDF no contiene texto (escaneado), lo informa: ver docs/OCR_STRATEGY.md.
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface ExtractedPdf {
  pages: string[][];
  pageCount: number;
  charCount: number;
  /** true si el PDF parece escaneado (sin texto extraíble). */
  looksScanned: boolean;
}

interface TextItemLike { str: string; transform: number[]; width: number }

export async function extractPdfText(data: ArrayBuffer): Promise<ExtractedPdf> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  const pages: string[][] = [];
  let charCount = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items = (content.items as unknown[]).filter((it): it is TextItemLike => typeof (it as TextItemLike).str === 'string');
    const rows = new Map<number, TextItemLike[]>();
    for (const it of items) {
      if (!it.str.trim()) continue;
      const y = Math.round(it.transform[5]! / 2) * 2; // tolerancia de 2pt
      const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
      rows.set(key, [...(rows.get(key) ?? []), it]);
      charCount += it.str.length;
    }
    const lines = [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, its]) => {
        its.sort((a, b) => a.transform[4]! - b.transform[4]!);
        let out = '';
        let lastEnd = -Infinity;
        for (const it of its) {
          const x = it.transform[4]!;
          out += (out && x - lastEnd > 3 ? '  ' : out ? ' ' : '') + it.str.trim();
          lastEnd = x + it.width;
        }
        return out.replace(/\s{3,}/g, '  ').trim();
      })
      .filter(Boolean);
    pages.push(lines);
  }
  return { pages, pageCount: doc.numPages, charCount, looksScanned: charCount < 40 * Math.max(1, doc.numPages) };
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
