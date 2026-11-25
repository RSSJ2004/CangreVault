import { Card, PageHeader } from '@/components/ui';

const GUIDE: { title: string; body: string[] }[] = [
  { title: '1. Configura tus cuentas', body: [
    'Ve a Configuración → Cuentas. Cada producto financiero es una cuenta: débito, ahorro, tarjeta de crédito, efectivo u otros bancos.',
    'Escribe el saldo real a una fecha (saldo inicial). Desde esa fecha, la app calcula el saldo sumando tus movimientos.',
    'En la tarjeta configura límite, tasa anual, día de corte y día límite de pago de referencia. Si un mes cambian, registra el estado de cuenta: sus fechas prevalecen.',
    'Para la tarjeta multimoneda, crea una cuenta separada por cada moneda (RD$ y US$).',
  ] },
  { title: '2. Edita tu sueldo', body: [
    'Configuración → Sueldo e ingresos. El sueldo es un parámetro para proyectar; no crea movimientos.',
    'Cada cambio queda en el historial con su fecha de vigencia. Cuando cobres, registra la entrada real («Entró dinero» o un Ingreso).',
  ] },
  { title: '3. Agrega gastos recurrentes', body: [
    'Gastos recurrentes → Nuevo. Indica importe, cuenta, frecuencia y día o rango de días (p. ej. Altice del 21 al 23).',
    'Pausa, reactiva, cancela o elimina cuando quieras. Un gasto pausado o cancelado no aparece en las proyecciones.',
    'Cambiar un gasto recurrente no altera los movimientos ya registrados. Usa «Registrar pago» para crear el movimiento real vinculado.',
  ] },
  { title: '4. Registra movimientos', body: [
    'Modo Simple: toca ENTRÓ DINERO o SALIÓ DINERO y escríbelo como lo dirías: «Pagué 850 de luz». La app interpreta importe, cuenta y categoría; tú confirmas antes de guardar.',
    'Modo Normal: elige el tipo exacto (ingreso, gasto, compra con tarjeta, pago de tarjeta, transferencia, aporte a ahorro, inversión, devolución o ajuste).',
    'Pagar la tarjeta NO es un gasto nuevo: el gasto se contó cuando compraste. Pasar dinero al ahorro tampoco es un gasto.',
  ] },
  { title: '5. Usa los dos modos', body: [
    'Ambos modos muestran exactamente los mismos datos. Cambia de modo con el selector Simple/Normal; nunca se duplican registros.',
  ] },
  { title: '6. Importa estados de cuenta PDF', body: [
    'Importar PDF → elige la cuenta y el archivo. El PDF se procesa en tu navegador.',
    'Revisa la vista previa: puedes editar cada fila, cambiar el tipo y la categoría, y desmarcar duplicados. Nada se guarda hasta que confirmas.',
    'Si el PDF es escaneado (imagen), no tiene texto extraíble: descarga la versión digital desde la banca en línea.',
    'El intérprete de Banreservas aún no se ha validado con un estado real: revisa con atención y reporta diferencias.',
  ] },
  { title: '7. Exporta a Excel', body: [
    'Exportar Excel genera un .xlsx con tres hojas: Resumen_Estado_Mayor, Diario_Transacciones y Ahorros_e_Inversion.',
    'Los totales son fórmulas (SUMIFS): si cambias las fechas del resumen o editas el diario en Excel, todo se recalcula.',
  ] },
  { title: '8. Interpreta los datos', body: [
    'Dinero disponible: suma de débito, ahorro y efectivo. Patrimonio líquido neto: eso menos lo que debes. El crédito disponible no es dinero tuyo.',
    'Estado de resultados: ingresos − gastos = resultado. Lo que envías a ahorro sale del resultado y deja el «excedente no asignado».',
    'Utilización de tarjeta: deuda ÷ límite. La alerta del 30% es una referencia orientativa, no una garantía de nada.',
    'Conciliación: compara tu saldo con el del banco. Si difieren, busca la causa antes de crear un ajuste.',
  ] },
  { title: '9. Qué hace la IA', body: [
    'Al registrar una nota en Modo Simple, el movimiento se guarda primero. Después la IA (Groq) propone categoría y una descripción ordenada.',
    'La IA nunca cambia importes, fechas ni cuentas, y no crea movimientos. Sus propuestas aparecen como «Sugerencia IA» hasta que las aceptas o descartas.',
    'Sin conexión o sin IA configurada se usan reglas por palabras clave.',
    'El asesor responde con tus datos y una base de conocimiento con fuentes citadas, indicando si es información oficial, principio general u orientación.',
  ] },
  { title: '10. Cómo funciona la sincronización', body: [
    'Cada movimiento nuevo recibe un identificador único en tu dispositivo y se guarda localmente antes de enviarse. Si no hay internet, queda pendiente y se envía solo al volver la conexión, sin duplicarse.',
    'Los cambios hechos en otra sesión o dispositivo llegan en tiempo real. El indicador de sincronización (punto de color) muestra el estado real.',
    'La futura app Android usará la misma base de datos y las mismas reglas.',
  ] },
];

const FAQ: [string, string][] = [
  ['¿Por qué pagar la tarjeta no aparece como gasto?', 'Porque el gasto ya se registró cuando hiciste la compra. El pago solo mueve dinero de tu débito para reducir la deuda. Contarlo dos veces inflaría tus gastos.'],
  ['¿Por qué mi saldo no coincide con el banco?', 'Puede faltar algún movimiento, haber uno duplicado o un importe distinto. Ve a Conciliación, escribe el saldo del banco y revisa la diferencia.'],
  ['¿Qué diferencia hay entre pago mínimo y pago de contado?', 'El mínimo evita el atraso, pero el resto se financia y suele generar intereses. El de contado suele evitar intereses de las compras del ciclo, según tu contrato.'],
  ['¿Puedo borrar un movimiento?', 'Sí. Se elimina de forma lógica: deja de contar en saldos y reportes, pero queda registrado en el historial de auditoría.'],
  ['¿Mis datos están protegidos?', 'Cada fila de la base de datos está protegida por seguridad a nivel de fila (RLS): solo tu usuario puede leerla o modificarla. La clave de la IA vive solo en el servidor.'],
  ['¿La app me dice cómo subir mi puntaje de crédito?', 'No. Da principios generales; ningún porcentaje de utilización garantiza un resultado específico.'],
  ['¿Qué pasa si edito un gasto recurrente?', 'Solo cambian las proyecciones futuras. Los movimientos ya registrados conservan sus importes.'],
  ['¿Funciona sin internet?', 'Puedes registrar movimientos nuevos sin conexión; se sincronizan después. Editar, importar, conciliar y usar la IA requieren conexión.'],
];

export function GuidePage() {
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title="Guía y preguntas frecuentes" />
      {GUIDE.map((s) => (
        <Card key={s.title}>
          <h2 className="font-semibold text-brand-900">{s.title}</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm">{s.body.map((b) => <li key={b}>{b}</li>)}</ul>
        </Card>
      ))}
      <Card>
        <h2 className="mb-2 font-semibold text-brand-900">Preguntas frecuentes</h2>
        <div className="divide-y divide-line">
          {FAQ.map(([q, a]) => (
            <details key={q} className="py-2.5">
              <summary className="cursor-pointer text-sm font-medium">{q}</summary>
              <p className="mt-1.5 text-sm text-muted">{a}</p>
            </details>
          ))}
        </div>
      </Card>
    </div>
  );
}
