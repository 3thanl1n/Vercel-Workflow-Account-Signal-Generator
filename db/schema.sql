-- Signal Gen schema. Every statement is safe to rerun (npm run db:setup).

-- One row per account, model and day. Stands in for a warehouse table.
create table if not exists usage_daily (
  account_key    text          not null,
  day            date          not null,
  model          text          not null,
  requests       integer       not null,
  gpu_hours      numeric(10,2) not null,
  errors         integer       not null,
  p95_latency_ms integer       not null,
  spend_usd      numeric(12,2) not null,
  primary key (account_key, day, model)
);

create index if not exists usage_daily_day_idx on usage_daily (day);

-- One row per daily run. Hobby keeps workflow run data for 1 day; this is the history.
create table if not exists runs (
  run_id           text        primary key,
  day              date        not null,
  trigger          text        not null check (trigger in ('cron', 'manual')),
  status           text        not null check (status in ('running', 'succeeded', 'failed')),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  accounts_checked integer,
  flagged          integer,
  alerts_posted    integer,
  approvals        integer     not null default 0,
  error            text,
  -- Every flagged account with its signals and dollars, so nothing is dropped silently.
  ranking          jsonb,
  slack_channel    text,
  slack_ts         text
);

create index if not exists runs_day_idx on runs (day desc);

-- One row per flagged account per day: the agent's proposal and what the rep decided.
create table if not exists decisions (
  id            bigserial    primary key,
  run_id        text         not null references runs (run_id),
  day           date         not null,
  account_key   text         not null,
  play          text         not null check (play in ('expand', 'save', 'new_use_case', 'ignore')),
  confidence    numeric(3,2),
  why           jsonb,
  next_step     text,
  email_subject text,
  email_body    text,
  slack_ts      text,
  status        text         not null default 'pending' check (status in ('pending', 'approved', 'skipped')),
  sf_task_id    text,
  created_at    timestamptz  not null default now(),
  updated_at    timestamptz  not null default now(),
  unique (account_key, day)
);

-- Vercel Cron can deliver the same schedule more than once; the cron route claims each day first.
create table if not exists cron_days (
  day        date        primary key,
  claimed_at timestamptz not null default now()
);

-- Which model wrote each email draft, and its token counts (added 2026-09-26).
alter table decisions add column if not exists email_model text;
alter table decisions add column if not exists email_input_tokens integer;
alter table decisions add column if not exists email_output_tokens integer;

-- The agent's token usage per decision, for cost (added 2026-09-27).
alter table decisions add column if not exists agent_model text;
alter table decisions add column if not exists agent_input_tokens integer;
alter table decisions add column if not exists agent_output_tokens integer;
alter table decisions add column if not exists agent_cache_read_tokens integer;
alter table decisions add column if not exists agent_cache_write_tokens integer;

-- How many top accounts the agent decided on, and how many failed or timed out (added 2026-09-27).
alter table runs add column if not exists accounts_decided integer;
alter table runs add column if not exists accounts_failed integer;

-- The exact digest text that was posted (added 2026-09-27).
alter table runs add column if not exists digest text;
