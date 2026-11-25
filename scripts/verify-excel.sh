#!/usr/bin/env bash
# Genera un Excel de muestra, lo recalcula con LibreOffice (headless) y comprueba
# que las FÓRMULAS producen los mismos números que el motor financiero.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
EXCEL_OUT="$OUT/sample.xlsx" npx vitest run src/integrations/excel >/dev/null
soffice --headless --calc --convert-to xlsx:"Calc MS Excel 2007 XML" --outdir "$OUT/recalc" "$OUT/sample.xlsx" >/dev/null 2>&1
python3 -I "$ROOT/scripts/check_excel_values.py" "$OUT/recalc/sample.xlsx"
