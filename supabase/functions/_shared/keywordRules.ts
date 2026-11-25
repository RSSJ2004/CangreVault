/**
 * Reglas determinísticas compartidas entre la web (Vite) y las Edge Functions (Deno).
 * Sin dependencias externas para que ambos entornos puedan importarlo.
 * Se usan como respaldo cuando no hay conexión o la IA no está disponible.
 */

export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface CategoryRule {
  slug: string;
  keywords: string[];
}

/** slug -> palabras clave (texto normalizado, sin acentos). El orden importa: gana la primera coincidencia. */
export const CATEGORY_RULES: CategoryRule[] = [
  { slug: 'salary', keywords: ['sueldo', 'salario', 'nomina', 'quincena', 'mi trabajo', 'pago de trabajo'] },
  { slug: 'interest_income', keywords: ['intereses ganados', 'interes ganado', 'rendimiento'] },
  { slug: 'card_interest', keywords: ['interes tarjeta', 'intereses tarjeta', 'cargo por financiamiento', 'interes financiamiento'] },
  { slug: 'bank_fees', keywords: ['comision', 'cargo por servicio', 'mantenimiento de cuenta', 'cargo bancario', 'impuesto 0 15', 'dgii 0 15', 'itbis cargo'] },
  { slug: 'electricity', keywords: ['luz', 'edenorte', 'edesur', 'edeeste', 'electricidad', 'energia'] },
  { slug: 'water', keywords: ['agua', 'caasd', 'coraasan', 'inapa'] },
  { slug: 'telecom', keywords: ['altice', 'claro', 'viva', 'internet', 'telefono', 'celular', 'recarga', 'wind telecom'] },
  { slug: 'subscriptions', keywords: ['netflix', 'spotify', 'disney', 'hbo', 'max ', 'youtube premium', 'amazon prime', 'icloud', 'google one', 'suscripcion', 'chatgpt'] },
  { slug: 'groceries', keywords: ['supermercado', 'colmado', 'jumbo', 'nacional', 'bravo', 'ole', 'sirena', 'pricesmart', 'carrefour', 'compra de comida'] },
  { slug: 'restaurants', keywords: ['restaurante', 'pizza', 'burger', 'mcdonald', 'kfc', 'wendy', 'pollo', 'cafeteria', 'starbucks', 'pedidosya', 'uber eats', 'cena', 'almuerzo'] },
  { slug: 'food', keywords: ['comida', 'alimento', 'desayuno', 'picapollo', 'frutas'] },
  { slug: 'fuel', keywords: ['gasolina', 'combustible', 'gasoil', 'shell', 'texaco', 'sunix', 'esso', 'total energies', 'bomba'] },
  { slug: 'transport', keywords: ['uber', 'didi', 'taxi', 'guagua', 'metro', 'teleferico', 'pasaje', 'peaje', 'transporte', 'motoconcho', 'indrive'] },
  { slug: 'housing', keywords: ['alquiler', 'renta', 'casa', 'condominio', 'mantenimiento edificio', 'hipoteca'] },
  { slug: 'health', keywords: ['farmacia', 'medicina', 'medico', 'doctor', 'clinica', 'hospital', 'laboratorio', 'carol', 'ars '] },
  { slug: 'education', keywords: ['universidad', 'colegio', 'curso', 'libro', 'matricula', 'inscripcion', 'udemy'] },
  { slug: 'insurance', keywords: ['seguro', 'poliza', 'aseguradora'] },
  { slug: 'entertainment', keywords: ['cine', 'juego', 'steam', 'playstation', 'concierto', 'fiesta', 'bar ', 'discoteca'] },
  { slug: 'personal', keywords: ['ropa', 'zapatos', 'barberia', 'salon', 'peluqueria', 'perfume', 'tienda'] },
  { slug: 'emergency_fund', keywords: ['fondo de emergencia', 'emergencia'] },
  { slug: 'investment', keywords: ['inversion', 'invertir', 'certificado', 'bono', 'fondo de inversion', 'acciones'] },
  { slug: 'savings', keywords: ['ahorro', 'ahorre', 'ahorrar'] },
  { slug: 'extra_income', keywords: ['venta', 'vendi', 'freelance', 'chiripa', 'propina', 'bono extra', 'regalo', 'me dieron'] },
];

export function matchCategorySlug(text: string): string | null {
  const n = ` ${normalizeText(text)} `;
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((k) => n.includes(` ${k}`) || n.includes(`${k} `))) return rule.slug;
  }
  return null;
}

export type Intent = 'income' | 'expense' | 'savings_transfer' | 'card_payment' | 'card_purchase' | 'transfer';

/** Detecta la intención económica de una nota en lenguaje natural. */
export function detectIntent(text: string): Intent | null {
  const n = ` ${normalizeText(text)} `;
  const has = (...words: string[]) => words.some((w) => n.includes(w));
  if (has(' pague la tarjeta', ' pago de la tarjeta', ' pago tarjeta', ' abono a la tarjeta', ' abone a la tarjeta', ' pague tarjeta', ' saldo de la tarjeta')) {
    return 'card_payment';
  }
  if (has(' al ahorro', ' a ahorro', ' a la cuenta de ahorro', ' ahorre ', ' para ahorrar', ' al fondo de emergencia')) {
    return 'savings_transfer';
  }
  if (has(' con la tarjeta', ' con tarjeta', ' con la de credito', ' con la visa', ' con credito')) return 'card_purchase';
  if (has(' pase ', ' transferi ', ' movi ', ' transferencia ')) return 'transfer';
  if (has(' recibi ', ' cobre ', ' me pagaron ', ' me depositaron ', ' entro ', ' entraron ', ' gane ', ' me dieron ', ' vendi ', ' sueldo ', ' salario ')) {
    return 'income';
  }
  if (has(' pague ', ' compre ', ' gaste ', ' salio ', ' salieron ', ' pago ', ' compra ', ' gasto ', ' di ', ' preste ')) {
    return 'expense';
  }
  return null;
}
