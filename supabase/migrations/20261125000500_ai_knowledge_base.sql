-- =============================================================================
-- CangreVault · 0500 · Base de conocimiento verificable para el asesor IA
-- Contenido curado (NO scraping de redes sociales). Solo lectura para usuarios.
-- =============================================================================

create table public.ai_knowledge_base (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique check (slug ~ '^[a-z0-9_]+$'),
  title              text not null check (char_length(title) between 3 and 160),
  topic              text not null check (topic in (
                       'credit_card', 'budgeting', 'emergency_fund', 'debt_management',
                       'investing_basics', 'accounting_basics')),
  target_audience    text not null default 'all' check (target_audience in ('simple', 'normal', 'all')),
  -- Distingue información oficial / principio general / recomendación orientativa.
  content_type       text not null check (content_type in ('official', 'general_principle', 'guidance')),
  principle_summary  text not null,
  actionable_tip     text not null,
  source_reference   text not null,
  source_url         text check (source_url is null or source_url ~ '^https://'),
  -- NULL = pendiente de verificación humana contra la fuente original.
  verification_date  date,
  keywords           text[] not null default '{}',
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index idx_kb_topic on public.ai_knowledge_base (topic) where is_active;

create trigger trg_kb_updated_at
  before update on public.ai_knowledge_base
  for each row execute function public.set_updated_at();

comment on column public.ai_knowledge_base.verification_date is
  'Fecha en que una persona verificó el contenido contra source_reference. NULL = no verificado aún.';
