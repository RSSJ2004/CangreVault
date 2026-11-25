import { describe, expect, it } from 'vitest';
import { sanitizeDescription, rankKnowledge, type KbEntry } from './sanitize';
import { detectIntent, matchCategorySlug } from './keywordRules';

describe('saneamiento de salida IA', () => {
  it('elimina importes inventados y conserva los de la nota original', () => {
    expect(sanitizeDescription('Pago de luz RD$ 900', 'Pagué 850 de luz')).toBe('Pago de luz');
    expect(sanitizeDescription('Pago de luz 850', 'Pagué 850 de luz')).toBe('Pago de luz 850');
    expect(sanitizeDescription(42, 'x')).toBeNull();
    expect(sanitizeDescription('1500', 'algo')).toBeNull();
  });
});

describe('reglas compartidas web/Edge', () => {
  it('categorías e intención', () => {
    expect(matchCategorySlug('Pago EDESUR factura')).toBe('electricity');
    expect(matchCategorySlug('Altice internet')).toBe('telecom');
    expect(matchCategorySlug('xyz')).toBeNull();
    expect(detectIntent('Recibí 24,240 de mi trabajo')).toBe('income');
    expect(detectIntent('Pasé 1,200 al ahorro')).toBe('savings_transfer');
    expect(detectIntent('Pagué la tarjeta')).toBe('card_payment');
  });
});

describe('recuperación de conocimiento', () => {
  const e = (slug: string, topic: string, keywords: string[], audience = 'all'): KbEntry => ({
    slug, title: slug, topic, target_audience: audience, content_type: 'general_principle', principle_summary: '', actionable_tip: '',
    source_reference: '', source_url: null, verification_date: null, keywords,
  });
  const kb = [e('cc_min', 'credit_card', ['pago minimo']), e('ef', 'emergency_fund', ['fondo de emergencia']), e('acc', 'accounting_basics', ['patrimonio'], 'normal')];
  it('prioriza por palabras clave y respeta el público objetivo', () => {
    expect(rankKnowledge('¿Qué pasa si pago el pago mínimo de la tarjeta?', kb, 'simple')[0]!.slug).toBe('cc_min');
    expect(rankKnowledge('¿Cómo calculo mi patrimonio?', kb, 'simple').map((x) => x.slug)).not.toContain('acc');
    expect(rankKnowledge('¿Cómo calculo mi patrimonio?', kb, 'normal')[0]!.slug).toBe('acc');
  });
});
