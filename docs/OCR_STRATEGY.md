# Estrategia OCR para estados de cuenta escaneados

**Estado:** no implementado. El importador detecta PDFs sin texto (menos de ~40 caracteres por
página) e informa a la persona.

## Opciones evaluadas

| Opción | Privacidad | Calidad | Coste | Recomendación |
|---|---|---|---|---|
| tesseract.js (WASM en navegador) | Alta: el documento no sale del dispositivo | Buena con 300 dpi; tablas requieren post-proceso | Gratis; ~10 MB de modelos | **Web** |
| ML Kit Text Recognition (Android, on-device) | Alta | Muy buena | Gratis | **Android** |
| OCR en la nube (Edge Function + proveedor) | Baja: el estado de cuenta sale a un tercero | Muy buena | Pago por página | Solo con consentimiento explícito |

## Plan
1. Renderizar cada página con pdf.js a un canvas (≥ 2× escala).
2. Ejecutar el proveedor que implemente `OcrProvider` (`src/integrations/pdf/ocr.ts`).
3. Reconstruir líneas con las cajas delimitadoras (misma agrupación por coordenada Y que el extractor de texto).
4. Pasar las líneas al mismo `parseStatementText`; marcar todas las filas con confianza baja.
5. Vista previa obligatoria (como hoy), con aviso de que el texto proviene de OCR.
