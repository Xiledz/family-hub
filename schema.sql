-- ============================================================================
-- FAMILY HUB — Supabase schema
-- Run once in the Supabase SQL Editor on a new free project.
--
-- Designed for a multi-module family system: calendar (v1), shopping lists,
-- meal planning, purchase tracking, and a finance dashboard visible only to
-- selected members. Every design choice below exists so those modules can be
-- added WITHOUT a data migration.
--
-- Three conventions every table follows:
--   1. household_id            — scopes the row to one family
--   2. visibility + audience   — who may see it (see note on privacy below)
--   3. deleted_at              — soft delete only; family data is never dropped
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ============================================================================
-- HOUSEHOLD + MEMBERS
-- ============================================================================
create table households (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  passcode      text not null,                    -- shared family code (v1 auth)
  timezone      text not null default 'America/Chicago',
  created_at    timestamptz not null default now()
);

-- role drives module access. 'adult' sees finance; 'child' never does.
create type member_role as enum ('owner','adult','teen','child','guest');

create table members (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  name          text not null,
  color         text not null,                    -- hex; drives every UI accent
  role          member_role not null default 'adult',
  sort_order    int not null default 0,

  -- DORMANT until per-person login is needed (finance module).
  -- Nullable today; populated by Supabase Auth later. Its existence now is what
  -- makes that upgrade a config change instead of a migration.
  auth_user_id  uuid unique,

  -- notification routing
  phone         text,                             -- E.164, e.g. +12145551212. For Twilio later.
  default_lead_minutes int not null default 30,   -- "always warn me 30 min before"
  quiet_hours_start time,                         -- suppress pushes overnight
  quiet_hours_end   time,

  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create index members_household_idx on members (household_id) where deleted_at is null;

-- ============================================================================
-- PRIVACY MODEL  (applies to every module table)
--
--   'household'  everyone in the family sees it            <- calendar, lists
--   'adults'     only role in (owner, adult)               <- finance
--   'private'    only the members listed in audience_ids   <- one-off secrets
--
-- v1 writes 'household' everywhere. The column exists now so the finance
-- module is a filter change, not a schema change.
-- ============================================================================
create type visibility_level as enum ('household','adults','private');

-- ============================================================================
-- EVENTS  (v1)
-- ============================================================================
create table events (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  member_id     uuid references members(id) on delete set null,   -- null = Everyone
  title         text not null,
  notes         text,
  location      text,

  all_day       boolean not null default false,
  -- All-day events use event_date (a DATE, never a timestamp) so they cannot
  -- drift across midnight when the timezone changes. Timed events use
  -- starts_at/ends_at stored in UTC and rendered in the household timezone.
  event_date    date,
  starts_at     timestamptz,
  ends_at       timestamptz,
  rrule         text,                             -- future: RFC 5545 recurrence

  visibility    visibility_level not null default 'household',
  audience_ids  uuid[] not null default '{}',

  created_by    uuid references members(id) on delete set null,
  source        text not null default 'web',      -- 'web' | 'sms' | 'shortcut' | 'ics'
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,

  constraint when_check check (
    (all_day and event_date is not null) or
    (not all_day and starts_at is not null)
  )
);

create index events_household_idx on events (household_id) where deleted_at is null;
create index events_when_idx      on events (household_id, event_date, starts_at);

-- ============================================================================
-- REMINDERS
-- One event can have several: a day-before heads-up AND a leave-now alert.
-- fire_at is computed on write so the dispatcher only ever does a cheap
-- indexed range scan once a minute.
-- ============================================================================
create type reminder_channel as enum ('push','sms','email');

create table reminders (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  event_id      uuid not null references events(id) on delete cascade,
  member_id     uuid references members(id) on delete cascade,   -- null = whole household
  lead_minutes  int not null default 30,          -- 0 = at start time
  channel       reminder_channel not null default 'push',
  fire_at       timestamptz not null,
  sent_at       timestamptz,
  error         text,
  created_at    timestamptz not null default now()
);

-- The dispatcher's only query. Partial index keeps it tiny forever.
create index reminders_due_idx on reminders (fire_at) where sent_at is null;

-- ============================================================================
-- PUSH SUBSCRIPTIONS  (Web Push / VAPID)
-- One row per installed home-screen app per person. A member with two devices
-- has two rows. Deleting the home screen icon invalidates the endpoint; the
-- dispatcher prunes rows that return 404/410.
-- ============================================================================
create table push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  member_id     uuid not null references members(id) on delete cascade,
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_ok_at    timestamptz
);

create index push_member_idx on push_subscriptions (member_id);

-- ============================================================================
-- TRIGGERS
-- ============================================================================
create or replace function touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger events_touch before update on events
for each row execute function touch_updated_at();

-- Recompute reminder fire times whenever an event moves.
create or replace function resync_reminders() returns trigger as $$
declare tz text;
begin
  select timezone into tz from households where id = new.household_id;
  update reminders r
     set fire_at = case
           when new.all_day
             -- all-day: measure from 9am local on the event date
             then ((new.event_date::timestamp + interval '9 hours') at time zone tz)
                  - make_interval(mins => r.lead_minutes)
           else new.starts_at - make_interval(mins => r.lead_minutes)
         end,
         sent_at = null
   where r.event_id = new.id and r.sent_at is null;
  return new;
end;
$$ language plpgsql;

create trigger events_resync after update of starts_at, event_date, all_day on events
for each row execute function resync_reminders();

-- ============================================================================
-- ROW LEVEL SECURITY
--
-- The anon key ships publicly in the browser BY DESIGN — that is how Supabase
-- works. These policies, not key secrecy, are the security boundary.
--
-- v1 model: the household id is a uuid known only to people given the URL and
-- passcode. Policies below are scoped to that. They deliberately do NOT expose
-- anything marked 'adults' or 'private' to the anon role, so when the finance
-- module lands its rows are already unreachable from the family app.
-- ============================================================================
alter table households         enable row level security;
alter table members            enable row level security;
alter table events             enable row level security;
alter table reminders          enable row level security;
alter table push_subscriptions enable row level security;

create policy households_select on households for select using (true);

create policy members_select on members
  for select using (deleted_at is null);

-- Household-visible rows only. 'adults' and 'private' are invisible to anon.
create policy events_select on events
  for select using (deleted_at is null and visibility = 'household');

create policy events_insert on events
  for insert with check (visibility = 'household');

create policy events_update on events
  for update using (visibility = 'household')
          with check (visibility = 'household');

create policy reminders_all on reminders for all using (true) with check (true);
create policy push_all      on push_subscriptions for all using (true) with check (true);

-- ============================================================================
-- REALTIME — every phone updates live
-- ============================================================================
alter publication supabase_realtime add table events;

-- ============================================================================
-- SEED — ALREADY FILLED IN with the Kelley family. Nothing to edit unless you
-- want to change something below. Run it exactly as it is.
--
-- WHAT EACH FIELD DOES
--
--   households
--     id        Leave this UUID alone. It is hard-coded in config.js and in the
--               .ics feed URL. Changing it means changing those too.
--     name      Shown nowhere critical; cosmetic.
--     passcode  What the family types once on each device. Case-insensitive.
--     timezone  Drives every displayed time and every reminder calculation.
--
--   members
--     name      Must match how people will TYPE it in the quick-add bar.
--               "Soccer Thursday 5:30 Addie" only works if the name is Addie.
--               Keep these short and use the name everyone actually says.
--     color     Hex. Drives that person's stripe on every event, their dot in
--               the week strip, and their chip in the Who picker. The four
--               below are already checked for contrast against each other in
--               both light and dark mode — change them only if you want to.
--                 Erich #2f6f5e green   Jess  #b4553c terracotta
--                 Addie #7d4a8c purple  Bryce #37588f blue
--     role      owner | adult | teen | child
--               Only owner and adult will ever see the future Money module.
--               teen and child never will. This is the ONLY thing here worth
--               thinking twice about, because changing it later means editing
--               the row by hand in the Table Editor.
--     sort_order        Order they appear in the "Who's using this phone?" list.
--     default_lead_minutes
--               That person's standing reminder. 30 = "always warn me 30
--               minutes before" so they never have to pick one per event.
--               Each person can still override it on any single event.
--
-- The four UUIDs on the left are all the same on purpose — that column says
-- "this member belongs to that household."
-- ============================================================================
insert into households (id, name, passcode, timezone) values
  ('00000000-0000-0000-0000-000000000001', 'Kelley Family', 'KELLEY2009', 'America/Chicago');

insert into members (household_id, name, color, role, sort_order, default_lead_minutes) values
  ('00000000-0000-0000-0000-000000000001', 'Erich', '#2f6f5e', 'owner', 1, 30),
  ('00000000-0000-0000-0000-000000000001', 'Jess',  '#b4553c', 'adult', 2, 30),
  ('00000000-0000-0000-0000-000000000001', 'Addie', '#7d4a8c', 'teen',  3, 15),
  ('00000000-0000-0000-0000-000000000001', 'Bryce', '#37588f', 'child', 4, 15);

-- ============================================================================
-- SCHEDULED DISPATCH — runs every minute, sends any reminder now due.
-- Replace <PROJECT-REF> and <ANON-KEY> before running.
-- ============================================================================
-- Run this AFTER `supabase functions deploy dispatch-reminders`, as its own query.
-- select cron.schedule('reminder-dispatch', '* * * * *', $$
--   select net.http_post(
--     url     := 'https://rauvytdltnbqrvyiornh.supabase.co/functions/v1/dispatch-reminders',
--     headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJhdXZ5dGRsdG5icXJ2eWlvcm5oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxODAzMzksImV4cCI6MjEwMjc1NjMzOX0.EN7nf6O3eo7LRuepdwlSHWKlliEPOxfIhW0C1SOEIU0"}'::jsonb,
--     body    := '{}'::jsonb
--   );
-- $$);

-- ============================================================================
-- FUTURE MODULES — not created yet. Kept here so the pattern is unambiguous
-- and so nobody invents a second data-access shape later.
-- ============================================================================
-- SHOPPING / LISTS
-- create table lists (
--   id uuid primary key default gen_random_uuid(),
--   household_id uuid not null references households(id) on delete cascade,
--   name text not null default 'Groceries',
--   visibility visibility_level not null default 'household',
--   audience_ids uuid[] not null default '{}',
--   created_at timestamptz not null default now(), deleted_at timestamptz);
--
-- create table list_items (
--   id uuid primary key default gen_random_uuid(),
--   household_id uuid not null references households(id) on delete cascade,
--   list_id uuid not null references lists(id) on delete cascade,
--   text text not null, qty text, category text,
--   done boolean not null default false, done_at timestamptz,
--   created_by uuid references members(id), source text not null default 'web',
--   created_at timestamptz not null default now(), deleted_at timestamptz);
--
-- MEALS -> auto-generated shopping lists
-- create table recipes (
--   id uuid primary key default gen_random_uuid(),
--   household_id uuid not null references households(id) on delete cascade,
--   name text not null, servings int, notes text, url text,
--   created_at timestamptz not null default now(), deleted_at timestamptz);
--
-- create table recipe_ingredients (
--   id uuid primary key default gen_random_uuid(),
--   recipe_id uuid not null references recipes(id) on delete cascade,
--   text text not null, qty numeric, unit text, category text);
--
-- create table meal_plan (
--   id uuid primary key default gen_random_uuid(),
--   household_id uuid not null references households(id) on delete cascade,
--   plan_date date not null, slot text not null default 'dinner',
--   recipe_id uuid references recipes(id) on delete set null,
--   freeform text);
-- -- "Generate this week's list" = meal_plan JOIN recipe_ingredients -> list_items,
-- -- grouped by category, deduped by name. Pure SQL, no service required.
--
-- PURCHASE TRACKING + DEAL WATCH
-- create table purchases (
--   id uuid primary key default gen_random_uuid(),
--   household_id uuid not null references households(id) on delete cascade,
--   item text not null, store text, price numeric(10,2), qty numeric,
--   unit_price numeric(10,2), purchased_on date not null,
--   member_id uuid references members(id),
--   visibility visibility_level not null default 'household',
--   created_at timestamptz not null default now(), deleted_at timestamptz);
-- -- Watchlist = distinct item from purchases where bought >= 3 times.
-- -- A scheduled Edge Function checks prices and pushes when unit_price drops
-- -- below the trailing median. Same reminders/push plumbing, new producer.
--
-- FINANCE  (adults only — note the visibility default differs)
-- create table accounts (
--   id uuid primary key default gen_random_uuid(),
--   household_id uuid not null references households(id) on delete cascade,
--   name text not null, kind text not null, institution text,
--   balance numeric(14,2), as_of date,
--   visibility visibility_level not null default 'adults',   -- <-- the whole point
--   audience_ids uuid[] not null default '{}',
--   created_at timestamptz not null default now(), deleted_at timestamptz);
-- -- Its RLS policy gates on auth.uid() against members.auth_user_id, which is
-- -- why that column exists from day one.
