-- Cold outreach platform schema.
-- Every row belongs to an owner (auth.users). Row Level Security restricts
-- each signed-in user to their own data. Audit and usage logs are append-only.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- companies
create table public.companies (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  domain        text not null check (char_length(domain) between 3 and 253),
  url           text not null check (char_length(url) <= 2048),
  name          text check (char_length(name) <= 300),
  description   text check (char_length(description) <= 5000),
  industry      text check (char_length(industry) <= 300),
  status        text not null default 'new'
                check (status in ('new','researching','researched','failed','contacted','replied','not_interested','do_not_contact')),
  last_researched_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (owner_id, domain)
);
create index companies_owner_updated_idx on public.companies (owner_id, updated_at desc);

-- ------------------------------------------------------------ research_runs
create table public.research_runs (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  company_id    uuid not null references public.companies(id) on delete cascade,
  status        text not null default 'running' check (status in ('running','completed','partial','failed')),
  input_url     text not null,
  pages_found   int not null default 0,
  pages_crawled int not null default 0,
  pages_failed  int not null default 0,
  robots_blocked int not null default 0,
  facts         jsonb not null default '[]'::jsonb,   -- [{fact, source_url}]
  summary       jsonb not null default '{}'::jsonb,   -- structured business profile
  errors        jsonb not null default '[]'::jsonb,
  duration_ms   int,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index research_runs_company_idx on public.research_runs (company_id, started_at desc);
create index research_runs_owner_started_idx on public.research_runs (owner_id, started_at desc);
-- Prevent two concurrent runs for the same company (duplicate submissions).
create unique index research_runs_one_running_idx on public.research_runs (company_id) where status = 'running';

-- ------------------------------------------------------------ crawled_pages
create table public.crawled_pages (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  run_id        uuid not null references public.research_runs(id) on delete cascade,
  company_id    uuid not null references public.companies(id) on delete cascade,
  url           text not null,
  status_code   int,
  title         text,
  word_count    int,
  excerpt       text check (char_length(excerpt) <= 4000),
  error         text,
  fetched_at    timestamptz not null default now()
);
create index crawled_pages_run_idx on public.crawled_pages (run_id);
create index crawled_pages_company_idx on public.crawled_pages (company_id);

-- ----------------------------------------------------------------- founders
create table public.founders (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  company_id    uuid not null references public.companies(id) on delete cascade,
  name          text not null check (char_length(name) <= 200),
  title         text check (char_length(title) <= 200),
  source_url    text,
  evidence      text check (char_length(evidence) <= 1000),
  created_at    timestamptz not null default now(),
  unique (company_id, name)
);
create index founders_company_idx on public.founders (company_id);

-- ----------------------------------------------------------------- contacts
create table public.contacts (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  company_id    uuid not null references public.companies(id) on delete cascade,
  founder_id    uuid references public.founders(id) on delete set null,
  kind          text not null check (kind in ('email','phone','contact_form','linkedin','twitter','facebook','instagram','github','youtube','calendly','discord','other')),
  value         text not null check (char_length(value) <= 1000),
  label         text check (char_length(label) <= 200),
  tier          text not null check (tier in ('founder_email','company_email','other_contact')),
  rank          int not null default 100,
  confidence    text not null default 'medium' check (confidence in ('high','medium','low')),
  source_url    text,
  mx_valid      boolean,
  is_valid      boolean not null default true,
  invalid_reason text,
  created_at    timestamptz not null default now(),
  unique (company_id, kind, value)
);
create index contacts_company_idx on public.contacts (company_id, rank);

-- ---------------------------------------------------------- outreach_emails
create table public.outreach_emails (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  company_id    uuid not null references public.companies(id) on delete cascade,
  run_id        uuid references public.research_runs(id) on delete set null,
  contact_id    uuid references public.contacts(id) on delete set null,
  to_email      text check (char_length(to_email) <= 320),
  subject       text not null check (char_length(subject) <= 300),
  body          text not null check (char_length(body) <= 10000),
  alt_subjects  jsonb not null default '[]'::jsonb,
  personalization jsonb not null default '[]'::jsonb, -- [{fact, source_url}]
  strategy_notes text,
  provider      text,
  model         text,
  is_fallback_template boolean not null default false,
  spam_score    int,
  spam_warnings jsonb not null default '[]'::jsonb,
  status        text not null default 'draft' check (status in ('draft','opened_in_mail','sent','replied','bounced','archived')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index outreach_company_idx on public.outreach_emails (company_id, created_at desc);

-- ----------------------------------------------------------- communications
create table public.communications (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  company_id    uuid not null references public.companies(id) on delete cascade,
  outreach_id   uuid references public.outreach_emails(id) on delete set null,
  event         text not null check (event in ('draft_created','edited','opened_in_mail','marked_sent','reply_received','bounced','note','status_changed')),
  channel       text check (channel in ('email','gmail','outlook','mailto','phone','linkedin','other')),
  note          text check (char_length(note) <= 4000),
  created_at    timestamptz not null default now()
);
create index communications_company_idx on public.communications (company_id, created_at desc);

-- ------------------------------------------------------------ ai_usage_logs
create table public.ai_usage_logs (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  run_id        uuid references public.research_runs(id) on delete set null,
  company_id    uuid references public.companies(id) on delete set null,
  provider      text not null,
  model         text not null,
  purpose       text not null default 'outreach',
  attempt       int not null default 1,
  success       boolean not null,
  error         text,
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  total_tokens  int not null default 0,
  latency_ms    int not null default 0,
  cost_usd      numeric(12,6) not null default 0,
  created_at    timestamptz not null default now()
);
create index ai_usage_owner_created_idx on public.ai_usage_logs (owner_id, created_at desc);

-- --------------------------------------------------------------- audit_logs
create table public.audit_logs (
  id            bigint generated always as identity primary key,
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  action        text not null check (char_length(action) <= 100),
  entity        text check (char_length(entity) <= 100),
  entity_id     text,
  ip            text,
  user_agent    text check (char_length(user_agent) <= 500),
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index audit_owner_created_idx on public.audit_logs (owner_id, created_at desc);

-- ------------------------------------------------------------ updated_at
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;

create trigger companies_touch before update on public.companies
  for each row execute function public.touch_updated_at();
create trigger outreach_touch before update on public.outreach_emails
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- RLS
alter table public.companies       enable row level security;
alter table public.research_runs   enable row level security;
alter table public.crawled_pages   enable row level security;
alter table public.founders        enable row level security;
alter table public.contacts        enable row level security;
alter table public.outreach_emails enable row level security;
alter table public.communications  enable row level security;
alter table public.ai_usage_logs   enable row level security;
alter table public.audit_logs      enable row level security;

-- Full CRUD on own rows for the working tables.
do $$
declare t text;
begin
  foreach t in array array['companies','research_runs','crawled_pages','founders','contacts','outreach_emails','communications']
  loop
    execute format('create policy %I on public.%I for select to authenticated using (owner_id = (select auth.uid()))', t||'_select_own', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (owner_id = (select auth.uid()))', t||'_insert_own', t);
    execute format('create policy %I on public.%I for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()))', t||'_update_own', t);
    execute format('create policy %I on public.%I for delete to authenticated using (owner_id = (select auth.uid()))', t||'_delete_own', t);
  end loop;
end $$;

-- Append-only logs: read + insert own, never update/delete from the client.
create policy ai_usage_select_own on public.ai_usage_logs for select to authenticated using (owner_id = (select auth.uid()));
create policy ai_usage_insert_own on public.ai_usage_logs for insert to authenticated with check (owner_id = (select auth.uid()));
create policy audit_select_own on public.audit_logs for select to authenticated using (owner_id = (select auth.uid()));
create policy audit_insert_own on public.audit_logs for insert to authenticated with check (owner_id = (select auth.uid()));

-- Anonymous role gets nothing.
revoke all on all tables in schema public from anon;

-- Indexes for foreign keys used in joins / cascades.
create index outreach_run_idx on public.outreach_emails (run_id);
create index outreach_contact_idx on public.outreach_emails (contact_id);
create index communications_outreach_idx on public.communications (outreach_id);
create index ai_usage_run_idx on public.ai_usage_logs (run_id);
create index ai_usage_company_idx on public.ai_usage_logs (company_id);
create index contacts_founder_idx on public.contacts (founder_id);
create index crawled_pages_owner_idx on public.crawled_pages (owner_id);
create index founders_owner_idx on public.founders (owner_id);
create index contacts_owner_idx on public.contacts (owner_id);
create index outreach_owner_idx on public.outreach_emails (owner_id);
create index communications_owner_idx on public.communications (owner_id);
