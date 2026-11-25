// Datos de PRUEBA para la revisión visual (scripts/visual-qa/run.mjs).
// No forman parte de la aplicación ni se empaquetan: solo alimentan un backend
// simulado (intercepción de red en Playwright) para poder ver las 15 páginas con
// contenido realista y con estados vacíos. Las filas imitan la forma de PostgREST.

const iso = (d) => d.toISOString().slice(0, 10);
const shift = (base, days) => { const d = new Date(base); d.setUTCDate(d.getUTCDate() + days); return iso(d); };
const ts = (date) => `${date}T12:00:00.000Z`;
let n = 0;
const id = (p) => `${p}-0000-4000-8000-${String(++n).padStart(12, '0')}`;

export const USER_ID = '11111111-1111-4111-8111-111111111111';

export function buildFixture(scenario, todayIso) {
  n = 0;
  const today = new Date(`${todayIso}T00:00:00Z`);
  const d = (days) => shift(today, days);
  const base = { user_id: USER_ID, deleted_at: null, updated_at: ts(d(0)), created_at: ts(d(-90)) };

  const catDefs = [
    ['Salario', 'income', 'salary'], ['Ingreso extra', 'income', 'extra_income'], ['Supermercado', 'expense', 'groceries'],
    ['Restaurantes', 'expense', 'restaurants'], ['Transporte', 'expense', 'transport'], ['Combustible', 'expense', 'fuel'],
    ['Electricidad', 'expense', 'electricity'], ['Internet y telefonía', 'expense', 'telecom'], ['Salud', 'expense', 'health'],
    ['Entretenimiento', 'expense', 'entertainment'], ['Suscripciones', 'expense', 'subscriptions'], ['Ropa y cuidado personal', 'expense', 'personal'],
    ['Otros gastos', 'expense', 'other_expense'], ['Ahorro', 'savings', 'savings'], ['Fondo de emergencia', 'savings', 'emergency_fund'],
  ];
  const categories = catDefs.map(([name, kind, slug]) => ({ ...base, id: id('c0000000'), client_id: id('cc000000'), name, kind, slug, color: null, is_system: true }));
  const cat = (slug) => categories.find((c) => c.slug === slug).id;

  const acc = (o) => ({
    ...base, id: id('a0000000'), client_id: id('ac000000'), institution: 'Banreservas', currency: 'DOP', credit_limit: null,
    annual_interest_rate_pct: null, statement_day: null, payment_due_day: null, utilization_alert_pct: 30, last4: null, color: null,
    is_archived: false, opening_balance_date: d(-75), ...o, is_liability: o.kind === 'credit_card',
  });
  const debit = acc({ name: 'Débito Banreservas', kind: 'checking', opening_balance: '18450.00', sort_order: 0, last4: '4821' });
  const savings = acc({ name: 'Ahorro Visa Banreservas', kind: 'savings', opening_balance: '35000.00', sort_order: 1 });
  const card = acc({ name: 'Crédito Visa Multimonedas', kind: 'credit_card', opening_balance: '3200.00', sort_order: 2, credit_limit: '8000.00',
    annual_interest_rate_pct: 60, statement_day: 30, payment_due_day: 21, last4: '9034' });
  const cardUsd = acc({ name: 'Crédito Visa Multimonedas (US$)', kind: 'credit_card', currency: 'USD', opening_balance: '0.00', sort_order: 3,
    credit_limit: '500.00', annual_interest_rate_pct: 60, statement_day: 30, payment_due_day: 21, last4: '9034' });
  const cash = acc({ name: 'Efectivo', kind: 'cash', institution: null, opening_balance: '1500.00', sort_order: 4 });
  const accounts = [debit, savings, card, cardUsd, cash];

  const profile = {
    user_id: USER_ID, display_name: 'Ana Pérez', base_currency: 'DOP', preferred_mode: 'normal', salary_amount: '24240.00',
    salary_frequency: 'monthly', salary_pay_days: [30], salary_account_id: debit.id, salary_effective_from: d(-75),
    emergency_fund_months: 3, onboarding_completed_at: ts(d(-75)),
  };

  const tx = (o) => ({
    ...base, id: id('t0000000'), client_id: id('tc000000'), to_account_id: null, currency: 'DOP', posted_on: null,
    normalized_description: null, original_note: null, category_id: null, classification_source: 'user', adjustment_direction: null,
    related_transaction_id: null, transfer_group_id: null, recurring_expense_id: null, savings_goal_id: null, import_batch_id: null,
    import_row_ref: null, bank_reference: null, dedupe_key: null, entry_mode: 'normal', source: 'manual', reconciliation_status: 'unreconciled',
    ai_status: 'none', ai_suggestion: null, version: 1, created_at: ts(o.occurred_on), ...o,
  });

  const empty = scenario === 'empty';
  const transactions = empty ? [] : [
    // Mes -2
    tx({ type: 'INCOME', account_id: debit.id, amount: '24240.00', occurred_on: d(-56), description: 'Sueldo', category_id: cat('salary'), reconciliation_status: 'reconciled' }),
    tx({ type: 'EXPENSE', account_id: debit.id, amount: '1530.00', occurred_on: d(-64), description: 'Altice internet', category_id: cat('telecom'), reconciliation_status: 'reconciled' }),
    tx({ type: 'EXPENSE', account_id: debit.id, amount: '4380.25', occurred_on: d(-60), description: 'Supermercado Nacional', category_id: cat('groceries'), reconciliation_status: 'reconciled' }),
    tx({ type: 'CARD_PURCHASE', account_id: card.id, amount: '1250.00', occurred_on: d(-58), description: 'Suscripción streaming', category_id: cat('subscriptions') }),
    tx({ type: 'SAVINGS_CONTRIBUTION', account_id: debit.id, to_account_id: savings.id, amount: '3000.00', occurred_on: d(-55), description: 'Aporte a meta: Fondo de emergencia', category_id: cat('emergency_fund') }),
    // Mes -1
    tx({ type: 'INCOME', account_id: debit.id, amount: '24240.00', occurred_on: d(-26), description: 'Sueldo', category_id: cat('salary'), reconciliation_status: 'reconciled' }),
    tx({ type: 'EXPENSE', account_id: debit.id, amount: '1530.00', occurred_on: d(-34), description: 'Altice internet', category_id: cat('telecom'), reconciliation_status: 'reconciled' }),
    tx({ type: 'EXPENSE', account_id: debit.id, amount: '2865.40', occurred_on: d(-31), description: 'Edesur factura de luz', category_id: cat('electricity'), reconciliation_status: 'reconciled' }),
    tx({ type: 'CARD_PURCHASE', account_id: card.id, amount: '2150.00', occurred_on: d(-30), description: 'Farmacia Carol', category_id: cat('health') }),
    tx({ type: 'CARD_PURCHASE', account_id: card.id, amount: '1250.00', occurred_on: d(-28), description: 'Suscripción streaming', category_id: cat('subscriptions') }),
    tx({ type: 'CARD_PAYMENT', account_id: debit.id, to_account_id: card.id, amount: '3200.00', occurred_on: d(-24), description: 'Pago tarjeta Visa', reconciliation_status: 'reconciled' }),
    tx({ type: 'SAVINGS_CONTRIBUTION', account_id: debit.id, to_account_id: savings.id, amount: '3000.00', occurred_on: d(-25), description: 'Aporte a meta: Fondo de emergencia', category_id: cat('emergency_fund') }),
    // Mes actual
    tx({ type: 'EXPENSE', account_id: debit.id, amount: '1530.00', occurred_on: d(-3), description: 'Altice internet', category_id: cat('telecom'), source: 'recurring', entry_mode: 'recurring' }),
    tx({ type: 'EXPENSE', account_id: debit.id, amount: '5120.60', occurred_on: d(-12), description: 'Supermercado Bravo', category_id: cat('groceries') }),
    tx({ type: 'EXPENSE', account_id: cash.id, amount: '650.00', occurred_on: d(-9), description: 'Pagué 650 de transporte', original_note: 'Pagué 650 de transporte', entry_mode: 'simple', category_id: cat('transport'), classification_source: 'rules' }),
    tx({ type: 'CARD_PURCHASE', account_id: card.id, amount: '1875.00', occurred_on: d(-7), description: 'Restaurante Adrian Tropical', category_id: cat('restaurants') }),
    tx({ type: 'CARD_PURCHASE', account_id: card.id, amount: '1250.00', occurred_on: d(-5), description: 'Suscripción streaming', category_id: cat('subscriptions') }),
    tx({ type: 'EXPENSE', account_id: debit.id, amount: '2400.00', occurred_on: d(-4), description: 'Gasolina Shell', category_id: cat('fuel') }),
    tx({ type: 'INCOME', account_id: debit.id, amount: '3500.00', occurred_on: d(-2), description: 'Venta de muebles', category_id: cat('extra_income'), entry_mode: 'simple', original_note: 'Me pagaron 3,500 de una venta' }),
    tx({ type: 'EXPENSE', account_id: debit.id, amount: '890.00', occurred_on: d(-1), description: 'Compré comida 890', original_note: 'Compré comida por 890', entry_mode: 'simple', category_id: null, classification_source: null, ai_status: 'suggested',
      ai_suggestion: { category_id: cat('restaurants'), category_slug: 'restaurants', normalized_description: 'Comida rápida', engine: 'rules', confidence: 0.7, rationale: 'Palabra clave «comida».' } }),
    tx({ type: 'TRANSFER', account_id: debit.id, to_account_id: cash.id, amount: '2000.00', occurred_on: d(0), description: 'Retiro cajero', classification_source: null }),
    tx({ type: 'CARD_PURCHASE', account_id: cardUsd.id, amount: '42.99', currency: 'USD', occurred_on: d(-6), description: 'Amazon.com pedido de libros con envío internacional', category_id: cat('other_expense') }),
  ];

  const recurring = empty ? [] : [
    { ...base, id: id('r0000000'), client_id: id('rc000000'), name: 'Altice', amount: '1530.00', currency: 'DOP', account_id: debit.id, category_id: cat('telecom'),
      transaction_type: 'EXPENSE', frequency: 'monthly', day_from: 21, day_to: 23, weekday: null, month_of_year: null, start_date: d(-75), end_date: null, status: 'active', remind_days_before: 3, notes: null },
    { ...base, id: id('r0000000'), client_id: id('rc000000'), name: 'Suscripción streaming', amount: '1250.00', currency: 'DOP', account_id: card.id, category_id: cat('subscriptions'),
      transaction_type: 'CARD_PURCHASE', frequency: 'monthly', day_from: 20, day_to: null, weekday: null, month_of_year: null, start_date: d(-75), end_date: null, status: 'active', remind_days_before: 3, notes: null },
    { ...base, id: id('r0000000'), client_id: id('rc000000'), name: 'Edesur (luz)', amount: '2900.00', currency: 'DOP', account_id: debit.id, category_id: cat('electricity'),
      transaction_type: 'EXPENSE', frequency: 'monthly', day_from: 28, day_to: 30, weekday: null, month_of_year: null, start_date: d(-75), end_date: null, status: 'active', remind_days_before: 3, notes: null },
    { ...base, id: id('r0000000'), client_id: id('rc000000'), name: 'Gimnasio', amount: '1800.00', currency: 'DOP', account_id: debit.id, category_id: cat('health'),
      transaction_type: 'EXPENSE', frequency: 'monthly', day_from: 5, day_to: null, weekday: null, month_of_year: null, start_date: d(-75), end_date: null, status: 'paused', remind_days_before: 3, notes: null },
  ];

  const goals = empty ? [] : [
    { ...base, id: id('g0000000'), client_id: id('gc000000'), name: 'Fondo de emergencia', target_amount: '60000.00', currency: 'DOP', target_date: d(400), account_id: savings.id, is_emergency_fund: true, status: 'active', notes: null },
    { ...base, id: id('g0000000'), client_id: id('gc000000'), name: 'Viaje a Samaná', target_amount: '25000.00', currency: 'DOP', target_date: d(150), account_id: savings.id, is_emergency_fund: false, status: 'active', notes: null },
  ];
  const contributions = empty ? [] : [
    { ...base, id: id('k0000000'), client_id: id('kc000000'), goal_id: goals[0].id, kind: 'contribution', amount: '3000.00', contributed_on: d(-55), transaction_id: transactions[4].id, notes: null },
    { ...base, id: id('k0000000'), client_id: id('kc000000'), goal_id: goals[0].id, kind: 'contribution', amount: '3000.00', contributed_on: d(-25), transaction_id: transactions[11].id, notes: null },
    { ...base, id: id('k0000000'), client_id: id('kc000000'), goal_id: goals[1].id, kind: 'contribution', amount: '4500.00', contributed_on: d(-20), transaction_id: null, notes: null },
  ];

  const lastStatement = d(-26);
  const cycles = empty ? [] : [
    { ...base, id: id('y0000000'), client_id: id('yc000000'), account_id: card.id, period_start: d(-56), statement_date: lastStatement, due_date: d(-5 + 1),
      previous_balance: '3200.00', statement_balance: '6600.00', minimum_payment: '350.00', full_payment: '6600.00', interest_charged: null, fees_charged: null,
      annual_rate_pct: 60, source: 'manual', notes: null },
  ];
  // Fecha límite futura para ver el recordatorio y el conteo de días.
  if (cycles[0]) cycles[0].due_date = d(6);

  const reconciliations = empty ? [] : [
    { ...base, id: id('z0000000'), client_id: id('zc000000'), account_id: debit.id, reconciled_on: d(-24), statement_balance: '30234.75', calculated_balance: '30234.75',
      difference: '0.00', status: 'matched', adjustment_transaction_id: null, notes: null },
  ];

  const incomeSources = empty ? [] : [
    { ...base, id: id('i0000000'), client_id: id('ic000000'), name: 'Clases particulares', amount: '3000.00', currency: 'DOP', frequency: 'monthly', pay_day: 15, account_id: debit.id,
      start_date: d(-60), end_date: null, is_active: true, notes: null },
  ];

  const knowledge = [
    { id: id('b0000000'), slug: 'utilizacion', title: 'Utilización del crédito', topic: 'credit_card', target_audience: 'all', content_type: 'general_principle',
      principle_summary: 'La utilización es la deuda dividida por el límite de crédito.', actionable_tip: 'Paga antes del corte si quieres reportar una utilización menor.', source_reference: 'Principio general de crédito', source_url: null, verification_date: null },
    { id: id('b0000000'), slug: 'pago-minimo', title: 'Pago mínimo vs. pago de contado', topic: 'credit_card', target_audience: 'all', content_type: 'official',
      principle_summary: 'El pago mínimo evita el atraso, pero el saldo restante genera intereses.', actionable_tip: 'Cuando puedas, paga el contado antes de la fecha límite.', source_reference: 'ProUsuario — Superintendencia de Bancos', source_url: 'https://www.prousuario.gob.do', verification_date: null },
    { id: id('b0000000'), slug: 'fondo-emergencia', title: 'Fondo de emergencia', topic: 'emergency_fund', target_audience: 'all', content_type: 'guidance',
      principle_summary: 'Una reserva líquida para imprevistos evita endeudarse.', actionable_tip: 'Empieza con una meta de un mes de gastos esenciales.', source_reference: 'Principio general de finanzas personales', source_url: null, verification_date: null },
  ];

  const audit = [];
  return {
    profiles: [profile], accounts, categories, transactions, recurring_expenses: recurring, savings_goals: goals, savings_contributions: contributions,
    credit_card_cycles: cycles, reconciliation_records: reconciliations, income_sources: incomeSources, ai_knowledge_base: knowledge,
    profile_income_history: empty ? [] : [{ id: id('h0000000'), user_id: USER_ID, changed_at: ts(d(-75)), old_amount: null, new_amount: '24240.00', old_frequency: null, new_frequency: 'monthly', effective_from: d(-75) }],
    transaction_audit: audit, account_balances: [], import_batches: [],
  };
}
