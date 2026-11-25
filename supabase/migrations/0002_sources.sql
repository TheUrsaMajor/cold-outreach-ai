-- Numbered website sources given to the model, kept so drafts can be regenerated
-- without re-crawling. Only the latest run per company keeps them (see app code).
alter table public.research_runs add column if not exists sources jsonb not null default '[]'::jsonb;
alter table public.research_runs add column if not exists outcome text;
alter table public.research_runs add column if not exists ai_profile jsonb not null default '{}'::jsonb;
