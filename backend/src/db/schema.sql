-- RishtaAI Backend — Authoritative Postgres schema.
-- Apply via: Supabase SQL Editor or psql -f schema.sql
-- See MASTERPLAN.md section 6.1.

create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- =========================================================
-- users
-- =========================================================
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  phone         text unique not null,
  name          text,
  age           int,
  gender        text check (gender in ('male', 'female', 'other')),
  city          text,
  language_pref text check (language_pref in ('ur', 'ro_ur', 'en')) default 'en',
  wali_contact  text,
  created_at    timestamptz not null default now(),
  last_active   timestamptz not null default now()
);

create index if not exists users_phone_idx on users (phone);

-- =========================================================
-- twins  (user twins AND seeded candidate twins)
-- =========================================================
create table if not exists twins (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references users (id) on delete cascade,
  is_candidate  boolean not null default false,
  version       int not null default 1,
  spec          jsonb not null,
  embedding     vector(768),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists twins_user_id_idx on twins (user_id);
create index if not exists twins_is_candidate_idx on twins (is_candidate);

-- ivfflat needs a populated table to build; create empty for now and reindex after seed.
do $$
begin
  if not exists (
    select 1 from pg_indexes where indexname = 'twins_embedding_idx'
  ) then
    execute 'create index twins_embedding_idx on twins using ivfflat (embedding vector_cosine_ops) with (lists = 100)';
  end if;
end $$;

-- =========================================================
-- compatibility_reports
-- =========================================================
create table if not exists compatibility_reports (
  id                  uuid primary key default gen_random_uuid(),
  user_twin_id        uuid not null references twins (id) on delete cascade,
  candidate_twin_id   uuid not null references twins (id) on delete cascade,
  overall_score       numeric(3, 2),
  dimension_scores    jsonb,
  top_strengths       text[],
  top_friction_points text[],
  dealbreakers_hit    text[],
  recommendation      text check (recommendation in ('strong_match', 'conditional_match', 'not_recommended')),
  reasoning_trace     jsonb,
  generated_at        timestamptz not null default now()
);

create index if not exists compat_user_twin_idx on compatibility_reports (user_twin_id);
create index if not exists compat_candidate_idx on compatibility_reports (candidate_twin_id);

-- =========================================================
-- meetings
-- =========================================================
create table if not exists meetings (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users (id) on delete cascade,
  candidate_id      uuid not null references twins (id) on delete cascade,
  slot_iso          timestamptz,
  venue             jsonb,
  wali_contacts     jsonb,
  meeting_card_url  text,
  status            text check (status in ('proposed', 'confirmed', 'completed', 'cancelled', 'no_show')) default 'proposed',
  reminders         jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists meetings_user_idx on meetings (user_id);
create index if not exists meetings_status_idx on meetings (status);

-- =========================================================
-- disputes
-- =========================================================
create table if not exists disputes (
  id                 uuid primary key default gen_random_uuid(),
  meeting_id         uuid not null references meetings (id) on delete cascade,
  filed_by           text check (filed_by in ('user', 'wali')),
  type               text,
  severity           int check (severity between 1 and 5),
  status             text not null default 'open',
  resolution         jsonb,
  reputation_impact  jsonb,
  created_at         timestamptz not null default now()
);

create index if not exists disputes_meeting_idx on disputes (meeting_id);
create index if not exists disputes_status_idx on disputes (status);

-- =========================================================
-- traces  (Antigravity workplan execution logs)
-- =========================================================
create table if not exists traces (
  id            uuid primary key default gen_random_uuid(),
  workplan      text not null,
  user_id       uuid references users (id) on delete set null,
  flow_id       text not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  observations  jsonb,
  decisions     jsonb,
  tool_calls    jsonb,
  recoveries    jsonb,
  events        jsonb,           -- full ordered TraceEvent[] for export
  outcome       jsonb
);

create index if not exists traces_workplan_idx on traces (workplan);
create index if not exists traces_flow_id_idx on traces (flow_id);
create index if not exists traces_user_idx on traces (user_id);

-- =========================================================
-- updated_at triggers (twins only — others are append-mostly)
-- =========================================================
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists twins_set_updated_at on twins;
create trigger twins_set_updated_at
  before update on twins
  for each row
  execute function set_updated_at();
