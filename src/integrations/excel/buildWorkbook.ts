/**
 * Exportación a Excel (.xlsx real) con ExcelJS.
 * Las hojas de resumen usan FÓRMULAS (SUMIFS, SUBTOTAL, porcentajes) sobre el
 * diario, de modo que el archivo sigue funcionando si se edita fuera de la app:
 * cambiar las fechas del período en el Resumen recalcula todo.
 */
import ExcelJS from 'exceljs';
import { toUnits } from '@/domain/money';
import { parts, type IsoDate } from '@/domain/dates';
import {
  ACCOUNT_KIND_LABEL, LIQUID_ASSET_KINDS, TRANSACTION_TYPE_LABEL,
  type Account, type Category, type DatePeriod, type SavingsContribution, type SavingsGoal, type Transaction,
} from '@/domain/types';

export const SHEETS = { summary: 'Resumen_Estado_Mayor', journal: 'Diario_Transacciones', savings: 'Ahorros_e_Inversion' } as const;
const MONEY = '"RD$"#,##0.00;-"RD$"#,##0.00';
const PCT = '0.0%';
const DATE = 'dd/mm/yyyy';
const J = `'${SHEETS.journal}'`;
const RECON = { unreconciled: 'No conciliado', reconciled: 'Conciliado', disputed: 'En disputa' } as const;

function xlDate(d: IsoDate): Date {
  const p = parts(d);
  return new Date(Date.UTC(p.y, p.m - 1, p.d));
}

function header(ws: ExcelJS.Worksheet, row: number, values: string[]) {
  const r = ws.getRow(row);
  values.forEach((v, i) => {
    const c = r.getCell(i + 1);
    c.value = v;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3D3A' } };
    c.alignment = { vertical: 'middle', wrapText: true };
  });
  r.height = 20;
}

function title(ws: ExcelJS.Worksheet, text: string, sub?: string) {
  ws.getCell('A1').value = text;
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF0B3D3A' } };
  if (sub) {
    ws.getCell('A2').value = sub;
    ws.getCell('A2').font = { italic: true, size: 9, color: { argb: 'FF5B6B69' } };
  }
}

function section(ws: ExcelJS.Worksheet, row: number, text: string) {
  const c = ws.getCell(row, 1);
  c.value = text;
  c.font = { bold: true, size: 12, color: { argb: 'FF0B3D3A' } };
}

export interface WorkbookInput {
  period: DatePeriod;
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  goals: SavingsGoal[];
  contributions: SavingsContribution[];
  generatedAt: Date;
  ownerLabel?: string;
}

/** Nombres únicos para usar como criterio en SUMIFS. */
function uniqueNames(accounts: Account[]): Map<string, string> {
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const a of accounts) {
    const n = seen.get(a.name) ?? 0;
    seen.set(a.name, n + 1);
    out.set(a.id, n === 0 ? a.name : `${a.name} (${n + 1})`);
  }
  return out;
}

export function buildWorkbook(input: WorkbookInput): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CangreVault';
  wb.created = input.generatedAt;
  const accounts = input.accounts.filter((a) => !a.deletedAt);
  const names = uniqueNames(accounts);
  const accName = (id: string | null) => (id ? names.get(id) ?? 'Cuenta eliminada' : '');
  const accById = new Map(accounts.map((a) => [a.id, a]));
  const catName = new Map(input.categories.map((c) => [c.id, c.name]));
  const txs = input.transactions.filter((t) => !t.deletedAt).sort((a, b) => (a.occurredOn < b.occurredOn ? -1 : 1));

  const summary = wb.addWorksheet(SHEETS.summary, { views: [{ showGridLines: false }] });
  const journal = wb.addWorksheet(SHEETS.journal, { views: [{ state: 'frozen', ySplit: 1 }] });
  const savings = wb.addWorksheet(SHEETS.savings, { views: [{ showGridLines: false }] });

  // ------------------------------------------------------------------ Diario
  const jCols = [
    ['Fecha', 12], ['Descripción', 38], ['Cuenta', 26], ['Cuenta destino', 26], ['Tipo', 20], ['Importe', 15], ['Categoría', 22],
    ['Conciliación', 15], ['Origen', 14], ['Dirección ajuste', 15], ['Cuenta es pasivo', 14], ['Destino es pasivo', 14],
    ['Efecto en cuenta', 16], ['Efecto en destino', 16], ['ID', 38],
  ] as const;
  header(journal, 1, jCols.map((c) => c[0]));
  jCols.forEach((c, i) => (journal.getColumn(i + 1).width = c[1]));
  txs.forEach((t, i) => {
    const r = i + 2;
    const from = accById.get(t.accountId);
    const to = t.toAccountId ? accById.get(t.toAccountId) : undefined;
    const row = journal.getRow(r);
    row.values = [
      xlDate(t.occurredOn), t.description, accName(t.accountId), accName(t.toAccountId), TRANSACTION_TYPE_LABEL[t.type], toUnits(t.amount),
      t.categoryId ? catName.get(t.categoryId) ?? 'Categoría eliminada' : 'Sin categoría', RECON[t.reconciliationStatus], t.source,
      t.adjustmentDirection === 'increase' ? 'Aumentar' : t.adjustmentDirection === 'decrease' ? 'Disminuir' : '',
      from?.isLiability ? 'Sí' : 'No', to ? (to.isLiability ? 'Sí' : 'No') : '',
    ];
    row.getCell(13).value = { formula: `IF(E${r}="Ajuste de saldo",IF(J${r}="Aumentar",F${r},-F${r}),IF(OR(E${r}="Ingreso",E${r}="Devolución"),F${r},-F${r})*IF(K${r}="Sí",-1,1))` };
    row.getCell(14).value = { formula: `IF(D${r}="",0,IF(L${r}="Sí",-F${r},F${r}))` };
    row.getCell(15).value = t.id;
  });
  const lastJ = Math.max(2, txs.length + 1);
  journal.getColumn(1).numFmt = DATE;
  for (const c of [6, 13, 14]) journal.getColumn(c).numFmt = MONEY;
  journal.autoFilter = { from: { row: 1, column: 1 }, to: { row: lastJ, column: jCols.length } };
  const totRow = journal.getRow(lastJ + 2);
  totRow.getCell(5).value = 'Total visible (filtro)';
  totRow.getCell(5).font = { bold: true };
  totRow.getCell(6).value = { formula: `SUBTOTAL(9,F2:F${lastJ})` };
  totRow.getCell(6).numFmt = MONEY;
  totRow.getCell(6).font = { bold: true };

  // ------------------------------------------------------------------ Resumen
  title(summary, 'Resumen — Estado Mayor', `Generado ${input.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC${input.ownerLabel ? ` · ${input.ownerLabel}` : ''}. Cambia las fechas para recalcular.`);
  summary.getColumn(1).width = 34;
  for (const c of [2, 3, 4, 5, 6]) summary.getColumn(c).width = 18;
  summary.getColumn(7).width = 12;
  summary.getColumn(8).width = 10;
  summary.getCell('A3').value = 'Desde';
  summary.getCell('B3').value = xlDate(input.period.from);
  summary.getCell('A4').value = 'Hasta';
  summary.getCell('B4').value = xlDate(input.period.to);
  for (const a of ['B3', 'B4']) {
    summary.getCell(a).numFmt = DATE;
    summary.getCell(a).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4DD' } };
  }
  const inPeriod = `${J}!$A:$A,">="&$B$3,${J}!$A:$A,"<="&$B$4`;
  const byType = (label: string) => `SUMIFS(${J}!$F:$F,${J}!$E:$E,"${label}",${inPeriod})`;

  section(summary, 6, 'Estado de resultados del período');
  header(summary, 7, ['Concepto', 'Importe', '% de ingresos']);
  const lines: [string, string][] = [
    ['Ingresos', byType('Ingreso')],
    ['Gastos (incluye compras con tarjeta)', `${byType('Gasto')}+${byType('Compra con tarjeta')}`],
    ['(−) Devoluciones', byType('Devolución')],
    ['Gastos netos', 'B9-B10'],
    ['Ahorro e inversión', `${byType('Aporte a ahorro')}+${byType('Inversión')}`],
    ['Resultado (ingresos − gastos netos)', 'B8-B11'],
    ['Excedente no asignado', 'B13-B12'],
  ];
  lines.forEach(([label, f], i) => {
    const r = 8 + i;
    summary.getCell(r, 1).value = label;
    summary.getCell(r, 2).value = { formula: f };
    summary.getCell(r, 2).numFmt = MONEY;
    summary.getCell(r, 3).value = { formula: `IF($B$8=0,0,B${r}/$B$8)` };
    summary.getCell(r, 3).numFmt = PCT;
    if (label.startsWith('Resultado') || label.startsWith('Gastos netos')) summary.getRow(r).font = { bold: true };
  });
  summary.getCell('A15').value = 'Las transferencias entre cuentas propias y los pagos de tarjeta no son ingresos ni gastos.';
  summary.getCell('A15').font = { italic: true, size: 9, color: { argb: 'FF5B6B69' } };

  section(summary, 17, 'Resumen por cuenta (saldo calculado al día de hoy)');
  header(summary, 18, ['Cuenta', 'Tipo', 'Saldo inicial', 'Fecha saldo inicial', 'Movimientos', 'Saldo calculado', 'Naturaleza', 'Líquido']);
  const accStart = 19;
  accounts.forEach((a, i) => {
    const r = accStart + i;
    const row = summary.getRow(r);
    row.values = [names.get(a.id)!, ACCOUNT_KIND_LABEL[a.kind], toUnits(a.openingBalance), xlDate(a.openingBalanceDate)];
    row.getCell(5).value = { formula: `SUMIFS(${J}!$M:$M,${J}!$C:$C,A${r},${J}!$A:$A,">="&D${r})+SUMIFS(${J}!$N:$N,${J}!$D:$D,A${r},${J}!$A:$A,">="&D${r})` };
    row.getCell(6).value = { formula: `C${r}+E${r}` };
    row.getCell(7).value = a.isLiability ? 'Pasivo' : 'Activo';
    row.getCell(8).value = LIQUID_ASSET_KINDS.has(a.kind) ? 'Sí' : 'No';
    for (const c of [3, 5, 6]) row.getCell(c).numFmt = MONEY;
    row.getCell(4).numFmt = DATE;
  });
  const accEnd = Math.max(accStart, accStart + accounts.length - 1);
  const nwRow = accEnd + 2;
  const nw: [string, string][] = [
    ['Activos líquidos (débito + ahorro + efectivo)', `SUMIFS(F${accStart}:F${accEnd},H${accStart}:H${accEnd},"Sí")`],
    ['Deudas (tarjetas y otras obligaciones)', `SUMIFS(F${accStart}:F${accEnd},G${accStart}:G${accEnd},"Pasivo")`],
    ['Patrimonio líquido neto', `B${nwRow}-B${nwRow + 1}`],
  ];
  nw.forEach(([label, f], i) => {
    summary.getCell(nwRow + i, 1).value = label;
    summary.getCell(nwRow + i, 2).value = { formula: f };
    summary.getCell(nwRow + i, 2).numFmt = MONEY;
  });
  summary.getRow(nwRow + 2).font = { bold: true };
  summary.getCell(nwRow + 3, 1).value = 'El límite de crédito disponible no se suma al patrimonio.';
  summary.getCell(nwRow + 3, 1).font = { italic: true, size: 9, color: { argb: 'FF5B6B69' } };

  const catRow0 = nwRow + 5;
  section(summary, catRow0, 'Gastos por categoría (período)');
  header(summary, catRow0 + 1, ['Categoría', 'Gasto neto', '% del gasto']);
  const expenseCats = new Set<string>();
  for (const t of txs) {
    if (t.type === 'EXPENSE' || t.type === 'CARD_PURCHASE' || t.type === 'REFUND') {
      expenseCats.add(t.categoryId ? catName.get(t.categoryId) ?? 'Categoría eliminada' : 'Sin categoría');
    }
  }
  const catList = [...expenseCats].sort((a, b) => a.localeCompare(b, 'es'));
  const cStart = catRow0 + 2;
  catList.forEach((name, i) => {
    const r = cStart + i;
    const crit = (label: string) => `SUMIFS(${J}!$F:$F,${J}!$G:$G,$A${r},${J}!$E:$E,"${label}",${inPeriod})`;
    summary.getCell(r, 1).value = name;
    summary.getCell(r, 2).value = { formula: `${crit('Gasto')}+${crit('Compra con tarjeta')}-${crit('Devolución')}` };
    summary.getCell(r, 2).numFmt = MONEY;
    summary.getCell(r, 3).value = { formula: `IF($B$11=0,0,B${r}/$B$11)` };
    summary.getCell(r, 3).numFmt = PCT;
  });
  const cEnd = cStart + Math.max(0, catList.length - 1);
  if (catList.length) {
    summary.getCell(cEnd + 1, 1).value = 'Total';
    summary.getCell(cEnd + 1, 2).value = { formula: `SUM(B${cStart}:B${cEnd})` };
    summary.getCell(cEnd + 1, 2).numFmt = MONEY;
    summary.getRow(cEnd + 1).font = { bold: true };
  }

  // ------------------------------------------------------------------ Ahorros
  title(savings, 'Ahorros e inversión', 'Progreso de metas calculado con fórmulas sobre la tabla de aportaciones (columnas J–N).');
  header(savings, 3, ['Meta', 'Objetivo', 'Fecha objetivo', 'Aportado', 'Faltante', 'Progreso', 'Fondo de emergencia']);
  [26, 15, 14, 15, 15, 11, 12].forEach((w, i) => (savings.getColumn(i + 1).width = w));
  savings.getColumn(8).width = 3;
  savings.getColumn(9).width = 3;
  const goals = input.goals.filter((g) => !g.deletedAt);
  const goalNames = new Map<string, string>();
  goals.forEach((g, i) => goalNames.set(g.id, goals.slice(0, i).some((x) => x.name === g.name) ? `${g.name} (${i + 1})` : g.name));
  goals.forEach((g, i) => {
    const r = 4 + i;
    const row = savings.getRow(r);
    row.getCell(1).value = goalNames.get(g.id)!;
    row.getCell(2).value = toUnits(g.targetAmount);
    row.getCell(3).value = g.targetDate ? xlDate(g.targetDate) : 'Sin fecha';
    row.getCell(4).value = { formula: `SUMIFS($N:$N,$K:$K,A${r})` };
    row.getCell(5).value = { formula: `MAX(0,B${r}-D${r})` };
    row.getCell(6).value = { formula: `IF(B${r}=0,0,MIN(1,D${r}/B${r}))` };
    row.getCell(7).value = g.isEmergencyFund ? 'Sí' : 'No';
    for (const c of [2, 4, 5]) row.getCell(c).numFmt = MONEY;
    row.getCell(3).numFmt = DATE;
    row.getCell(6).numFmt = PCT;
  });
  const gEnd = 4 + Math.max(0, goals.length - 1);
  const sRow = gEnd + 2;
  const sumLines: [string, string][] = [
    ['Total aportado a metas', `SUM(D4:D${gEnd})`],
    ['Ahorro e inversión del período (Resumen)', `'${SHEETS.summary}'!B12`],
    ['Saldo en cuentas de ahorro', `SUMIFS('${SHEETS.summary}'!F:F,'${SHEETS.summary}'!B:B,"Ahorro")`],
    ['Saldo en cuentas de inversión', `SUMIFS('${SHEETS.summary}'!F:F,'${SHEETS.summary}'!B:B,"Inversión")`],
  ];
  sumLines.forEach(([label, f], i) => {
    savings.getCell(sRow + i, 1).value = label;
    savings.getCell(sRow + i, 2).value = { formula: f };
    savings.getCell(sRow + i, 2).numFmt = MONEY;
  });

  const contribHeaderCol = 10; // J
  ['Fecha', 'Meta', 'Tipo', 'Importe', 'Importe con signo'].forEach((h, i) => {
    const c = savings.getCell(3, contribHeaderCol + i);
    c.value = h;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3D3A' } };
    savings.getColumn(contribHeaderCol + i).width = [12, 26, 12, 15, 17][i]!;
  });
  const contribs = input.contributions.filter((c) => !c.deletedAt && goalNames.has(c.goalId)).sort((a, b) => (a.contributedOn < b.contributedOn ? -1 : 1));
  contribs.forEach((c, i) => {
    const r = 4 + i;
    savings.getCell(r, 10).value = xlDate(c.contributedOn);
    savings.getCell(r, 10).numFmt = DATE;
    savings.getCell(r, 11).value = goalNames.get(c.goalId)!;
    savings.getCell(r, 12).value = c.kind === 'withdrawal' ? 'Retiro' : 'Aporte';
    savings.getCell(r, 13).value = toUnits(c.amount);
    savings.getCell(r, 13).numFmt = MONEY;
    savings.getCell(r, 14).value = { formula: `IF(L${r}="Retiro",-M${r},M${r})` };
    savings.getCell(r, 14).numFmt = MONEY;
  });
  if (contribs.length) savings.autoFilter = { from: { row: 3, column: 10 }, to: { row: 3 + contribs.length, column: 14 } };

  return wb;
}

export async function workbookToBlob(wb: ExcelJS.Workbook): Promise<Blob> {
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
