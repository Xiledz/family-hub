-- ============================================================================
-- 002 — Recurring events with per-occurrence exceptions
--
-- Additive only. Safe to run against the live household; nothing is dropped
-- and no existing row is rewritten. Safe to run twice.
--
-- MODEL
--   An events row is the SERIES DEFINITION, not one occurrence. Occurrences are
--   computed on read from the repeat_* columns — "soccer every Tuesday through
--   May" stays one row, because a school-year series has no natural end and a
--   row-per-Tuesday table would grow without bound.
--
--   Deviations live in event_exceptions, one row per deviating date:
--     'skip'     — that date does not happen (spring break, snow day, holiday)
--     'override' — that date happens differently (moved to 6:15, different kid)
--
--   This is the RFC 5545 EXDATE / RECURRENCE-ID shape. Do not invent another.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Recurrence on the series
-- ---------------------------------------------------------------------------
alter table events add column if not exists repeat_freq     text;
alter table events add column if not exists repeat_interval int not null default 1;
alter table events add column if not exists repeat_days     int[] not null default '{}';
alter table events add column if not exists repeat_until    date;

-- The lead time chosen for the SERIES. One-off events get a reminders row
-- written directly by the app; a series cannot, so the materializer reads this.
alter table events add column if not exists reminder_lead_minutes int;

alter table events drop constraint if exists events_repeat_freq_check;
alter table events add  constraint events_repeat_freq_check
  check (repeat_freq is null or repeat_freq in ('daily','weekly','monthly'));

comment on column events.repeat_freq     is 'null = one-off. daily | weekly | monthly.';
comment on column events.repeat_interval is 'Every N periods. 2 + weekly = every other week.';
comment on column events.repeat_days     is 'Weekly only. 0=Sun .. 6=Sat. {2,4} = Tuesdays and Thursdays.';
comment on column events.repeat_until    is 'Inclusive last date. Null = open-ended.';

-- ---------------------------------------------------------------------------
-- Exceptions
--
-- Override fields are FLAT columns, not a jsonb blob, so they are typed,
-- indexable, and readable in the Table Editor. They mirror the events columns
-- they replace. A null override column means "inherit from the series".
-- ---------------------------------------------------------------------------
create table if not exists event_exceptions (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references households(id) on delete cascade,
  event_id        uuid not null references events(id) on delete cascade,
  occurrence_date date not null,
  action          text not null check (action in ('skip','override')),

  -- used only when action = 'override'
  title           text,
  notes           text,
  member_id       uuid references members(id) on delete set null,
  starts_at       timestamptz,
  ends_at         timestamptz,

  created_by      uuid references members(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (event_id, occurrence_date)
);

create index if not exists event_exceptions_event_idx
  on event_exceptions (event_id, occurrence_date);
create index if not exists event_exceptions_household_idx
  on event_exceptions (household_id);

alter table event_exceptions enable row level security;
drop policy if exists exceptions_all on event_exceptions;
create policy exceptions_all on event_exceptions for all using (true) with check (true);

-- a skip on one phone must vanish on every other phone
do $$ begin
  alter publication supabase_realtime add table event_exceptions;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Reminders for series
--
-- reminders.fire_at is precomputed, which cannot work for an unbounded series.
-- A daily materializer inserts reminder rows a short way ahead.
-- occurrence_date records which date each row covers, so re-running the
-- materializer is harmless and it can never double-book a date.
-- ---------------------------------------------------------------------------
alter table reminders add column if not exists occurrence_date date;

drop index if exists reminders_unique_occurrence;
create unique index reminders_unique_occurrence
  on reminders (event_id, occurrence_date,
                coalesce(member_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where occurrence_date is not null;

comment on column reminders.occurrence_date is
  'Which date of a repeating series this reminder covers. Null for one-off events.';
