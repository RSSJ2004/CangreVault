"""Valida los valores recalculados del Excel de muestra (ver verify-excel.sh)."""
import sys
from openpyxl import load_workbook

wb = load_workbook(sys.argv[1], data_only=True)
s = wb["Resumen_Estado_Mayor"]
sv = wb["Ahorros_e_Inversion"]
j = wb["Diario_Transacciones"]

def v(ws, addr):
    val = ws[addr].value
    return round(float(val), 2) if isinstance(val, (int, float)) else val

expected = {
    # Estado de resultados de marzo (el gasto de abril queda fuera)
    ("S", "B8"): 24240.00,          # ingresos
    ("S", "B9"): 850 + 1500,        # gastos + compras con tarjeta
    ("S", "B10"): 300.00,           # devoluciones
    ("S", "B11"): 2050.00,          # gastos netos
    ("S", "B12"): 1200.00,          # ahorro
    ("S", "B13"): 22190.00,         # resultado
    ("S", "B14"): 20990.00,         # excedente no asignado
    # Saldos por cuenta (débito, ahorro, tarjeta)
    ("S", "F19"): 10000 + 24240 - 850 - 1200 - 1000 - 999,
    ("S", "F20"): 1200.00,
    ("S", "F21"): 1500 - 1000 - 300 + 10,
    # Patrimonio
    ("S", "B23"): 30191.00 + 1200,     # débito + ahorro
    ("S", "B24"): 210.00,
    ("S", "B25"): 31391.00 - 210,
    # Metas
    ("V", "D4"): 1000.00,
    ("V", "E4"): 29000.00,
}
sheets = {"S": s, "V": sv}
errors = []
for (sh, addr), exp in expected.items():
    got = v(sheets[sh], addr)
    if got != round(float(exp), 2):
        errors.append(f"{sh}!{addr}: esperado {exp}, obtenido {got}")
pct = s["C11"].value
if pct is None or abs(pct - 2050 / 24240) > 1e-6:
    errors.append(f"porcentaje gastos/ingresos incorrecto: {pct}")
if errors:
    print("✘ Excel con valores incorrectos:\n  " + "\n  ".join(errors))
    sys.exit(1)
print("✔ Fórmulas del Excel recalculadas por LibreOffice coinciden con el motor financiero")
print(f"  Ingresos {v(s,'B8')}, gastos netos {v(s,'B11')}, resultado {v(s,'B13')}, patrimonio líquido {v(s,'B25')}")
