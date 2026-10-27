-- Doc.AI database schema (Supabase / PostgreSQL 14+). Idempotent: safe to run again after upgrades.
-- Access model: only the server (service_role key) talks to these tables; anon/authenticated get nothing.

-- ---------------------------------------------------------------- templates & documents
create table if not exists public.document_types (
  id bigint generated always as identity primary key,
  name text not null,
  slug text unique not null,
  prompt text not null,
  created_at timestamptz default now()
);
-- P1: per-template validation schema ("invoice" | "act" | {"fields":[...]}).
alter table public.document_types add column if not exists schema jsonb;

create table if not exists public.documents (
  id bigint generated always as identity primary key,
  filename text,
  original_name text,
  mime_type text,
  extracted_data jsonb,
  type_slug text,
  created_at timestamptz default now()
);
alter table public.documents
  add column if not exists status text default 'completed',
  add column if not exists error_message text,
  add column if not exists ai_model text,
  add column if not exists prompt_tokens bigint default 0,
  add column if not exists completion_tokens bigint default 0,
  add column if not exists validation_errors jsonb default '[]'::jsonb,
  add column if not exists storage_path text,
  -- P1: who did what, and the untouched AI output for quality metrics
  add column if not exists created_by text,
  add column if not exists edited_by text,
  add column if not exists edited_at timestamptz,
  add column if not exists original_extracted_data jsonb,
  add column if not exists reviewed_by text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text;
create index if not exists documents_created_at_idx on public.documents (created_at desc);
create index if not exists documents_status_idx on public.documents (status);
-- Statuses: pending_review | invalid | approved | rejected | completed | failed (legacy: success)

-- ---------------------------------------------------------------- P2: job queue (multi-worker)
create table if not exists public.docai_jobs (
  id text primary key,
  status text not null default 'queued' check (status in ('staging', 'queued', 'processing', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  payload jsonb not null,
  idempotency_key text unique,
  attempts int not null default 0,
  max_attempts int not null default 3,
  next_attempt_at timestamptz,
  lease_until timestamptz,
  result jsonb,
  error text,
  workspace_id text not null default 'default'
);
create index if not exists docai_jobs_ready_idx on public.docai_jobs (status, next_attempt_at, created_at);
create index if not exists docai_jobs_created_idx on public.docai_jobs (created_at desc);

-- Uploaded files waiting for a worker (deleted after processing). Base64 keeps PostgREST transport simple.
create table if not exists public.docai_job_files (
  job_id text primary key references public.docai_jobs (id) on delete cascade,
  content_base64 text not null
);

-- Atomically claim the oldest ready job; expired leases (crashed/hung workers) are recovered first.
create or replace function public.docai_claim_job(lease_seconds int default 600)
returns setof public.docai_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.docai_jobs
     set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
         error = case when attempts >= max_attempts
                      then coalesce(error, 'Обробку перервано (тайм-аут воркера) і спроби вичерпано')
                      else 'Попередню спробу перервано; завдання повернуто в чергу' end,
         lease_until = null,
         updated_at = now()
   where status = 'processing' and lease_until < now();

  return query
  update public.docai_jobs j
     set status = 'processing',
         attempts = j.attempts + 1,
         lease_until = now() + make_interval(secs => lease_seconds),
         next_attempt_at = null,
         updated_at = now()
   where j.id = (
     select id from public.docai_jobs
      where status = 'queued' and (next_attempt_at is null or next_attempt_at <= now())
      order by created_at
      for update skip locked
      limit 1)
  returning j.*;
end;
$$;

-- ---------------------------------------------------------------- P2: webhook outbox
create table if not exists public.docai_webhook_deliveries (
  id text primary key,
  type text not null,
  url text not null,
  body text not null,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  last_status int,
  last_error text
);
create index if not exists docai_webhooks_due_idx on public.docai_webhook_deliveries (status, next_attempt_at);

-- ---------------------------------------------------------------- P2: audit log (shared by all nodes)
create table if not exists public.docai_audit (
  id text primary key,
  at timestamptz not null default now(),
  action text not null,
  actor text,
  via text,
  document_id text,
  job_id text,
  type_slug text,
  provider text,
  model text,
  prompt_tokens int,
  completion_tokens int,
  duration_ms int,
  estimated_cost_usd numeric(14, 8),
  status text,
  detail text,
  workspace_id text default 'default'
);
create index if not exists docai_audit_at_idx on public.docai_audit (at desc);
create index if not exists docai_audit_action_idx on public.docai_audit (action, at desc);

-- ---------------------------------------------------------------- access
alter table public.document_types enable row level security;
alter table public.documents enable row level security;
alter table public.docai_jobs enable row level security;
alter table public.docai_job_files enable row level security;
alter table public.docai_webhook_deliveries enable row level security;
alter table public.docai_audit enable row level security;

revoke all on table public.document_types, public.documents, public.docai_jobs, public.docai_job_files,
  public.docai_webhook_deliveries, public.docai_audit from anon, authenticated;
grant select, insert, update, delete on table public.document_types, public.documents, public.docai_jobs,
  public.docai_job_files, public.docai_webhook_deliveries, public.docai_audit to service_role;
grant usage, select on sequence public.document_types_id_seq, public.documents_id_seq to service_role;
revoke all on function public.docai_claim_job(int) from public, anon, authenticated;
grant execute on function public.docai_claim_job(int) to service_role;

insert into public.document_types (name, slug, prompt, schema)
values ('Рахунок / Invoice', 'invoice',
        'Оброби рахунок (invoice) та поверни один JSON-об’єкт за структурою: {"invoice_number":null,"date":null,"due_date":null,"supplier":{"name":null,"edrpou":null,"iban":null},"customer":{"name":null,"edrpou":null},"currency":null,"items":[{"description":null,"quantity":null,"unit_price":null,"amount":null}],"subtotal":null,"vat":null,"total":null}. Дати — YYYY-MM-DD. Суми — числа. Валюта — ISO. Відсутнє — null. Поверни тільки JSON.',
        '"invoice"'::jsonb)
on conflict (slug) do nothing;
