import { useMemo } from 'react';
import { useAccounts, useCategories } from './useFinance';
import type { CategoryKind, TransactionType } from '@/domain/types';

export function useLookups() {
  const accounts = useAccounts();
  const categories = useCategories();
  return useMemo(() => {
    const acc = new Map((accounts.data ?? []).map((a) => [a.id, a]));
    const cat = new Map((categories.data ?? []).map((c) => [c.id, c]));
    const bySlug = new Map((categories.data ?? []).filter((c) => c.slug).map((c) => [c.slug!, c]));
    return {
      accounts: accounts.data ?? [],
      categories: categories.data ?? [],
      accountName: (id: string | null) => (id ? acc.get(id)?.name ?? 'Cuenta eliminada' : '—'),
      categoryName: (id: string | null) => (id ? cat.get(id)?.name ?? 'Categoría eliminada' : 'Sin categoría'),
      categoryBySlug: (slug: string | null) => (slug ? bySlug.get(slug) ?? null : null),
      account: (id: string | null) => (id ? acc.get(id) ?? null : null),
    };
  }, [accounts.data, categories.data]);
}

export function categoryKindForType(type: TransactionType): CategoryKind | null {
  switch (type) {
    case 'INCOME': return 'income';
    case 'EXPENSE': case 'CARD_PURCHASE': case 'REFUND': return 'expense';
    case 'SAVINGS_CONTRIBUTION': case 'INVESTMENT': return 'savings';
    default: return null;
  }
}
