-- ============================================================================
-- 011 — Real store names, one store's aisles, per-person series reminders,
--       and the morning text
--
-- FOUR THINGS, all of which came out of using the calendar for real.
--
-- 1. STORES BY THEIR REAL NAMES, with aliases. Nobody will say "HEB Harpers
--    Trace" into a phone. They will say "Harpers". Same rule as people.
--
-- 2. AISLES FOR HEB ON 1488, from H-E-B's own published store guide for that
--    location (images.heb.com …/guide-the-woodlands-638.pdf). Harpers Trace
--    and Kroger publish nothing; those rows wait for someone to walk the
--    store with the app open. verified_at is set for the 1488 rows because a
--    published guide counts as verification; the date is when it was read.
--
-- 3. SERIES REMINDERS PER PERSON. The materializer wrote ONE reminder per
--    occurrence, on the event's owner, hardcoded to push, at the event's lead.
--    It never knew the cast existed. So "Soccer every Tuesday, Addie going,
--    Jess there, me back" reminded Erich, once, and reminded nobody to leave
--    for pickup. Rewritten to mirror what the app and the text number already
--    do for one-off events: one reminder per cast member, at their own lead,
--    pickup measured from the end, channel chosen by whether they have a
--    phone registered for push.
--
-- 4. THE MORNING TEXT. Each person gets their own day, in their own words,
--    before it starts. Needs a way to ask "what is on for THIS person on THIS
--    date" that agrees with the calendar and the reminders — so it is built
--    on the same recurrence predicate, in one function, used by both.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Stores
-- ---------------------------------------------------------------------------
alter table stores add column if not exists address text;
alter table stores add column if not exists aliases text[] not null default '{}';

comment on column stores.aliases is
  'What people actually call it. "Harpers", "1488". Resolved to the row on '
  'parse, exactly like member aliases.';

update stores set
  name = 'HEB Harpers Trace',
  address = '10200 Highway 242, Conroe, TX 77385',
  aliases = array['harpers','harper','harpers trace','harper''s','heb 242','242']
where name = 'HEB' and deleted_at is null;

update stores set
  name = 'HEB on 1488',
  address = '3601 FM 1488, The Woodlands, TX 77384',
  aliases = array['1488','heb 1488','fourteen eighty eight','north woodlands','woodlands market']
where name = 'HEB 2' and deleted_at is null;

update stores set
  address = '4747 Research Forest Dr, The Woodlands, TX 77381',
  aliases = array['krogers','cochrans','cochrans crossing','research forest']
where name = 'Kroger' and deleted_at is null;

update stores set aliases = array['costcos']
where name = 'Costco' and deleted_at is null;

update stores set
  name = 'Sams Club',
  aliases = array['sams','sam''s','sam''s club','sam s club','sams club']
where name in ('Sams Club','Sam''s Club') and deleted_at is null;

-- ---------------------------------------------------------------------------
-- 2. HEB on 1488 — aisles, from the published store guide
--
--    Perimeter departments (produce, bakery, deli, meat, seafood, dairy,
--    eggs, frozen) are not numbered in H-E-B guides. They keep the category
--    default order. Only what the guide actually says is entered here.
-- ---------------------------------------------------------------------------
insert into store_aisles (store_id, category, aisle, sort_order, verified_at)
select s.id, a.category, a.aisle, a.ord, now()
from stores s,
     (values
       ('bakery',     '5  bread, tortillas',                       5),
       ('pantry',     '7-8 rice, pasta, mac & cheese, soup',       7),
       ('condiments', '6',                                         6),
       ('canned',     '9',                                         9),
       ('baking',     '10',                                       10),
       ('beverages',  '31 sodas · 11 coffee, tea, sports drinks', 11),
       ('snacks',     '12 cookies, crackers · 3-4 chips · 14 candy', 12),
       ('breakfast',  '13 cereal, syrup, pop-tarts',              13),
       ('pet',        '20 cat · 21 dog',                          20),
       ('paper',      '32 bath tissue, paper towels · 33 napkins, plates', 32),
       ('household',  '33 foil, bags, trash bags · 24 bulbs, batteries', 33),
       ('cleaning',   '34 cleaners, dish soap · 35 laundry',      34),
       ('baby',       '36 · diapers & wipes on the pharmacy wall', 36),
       ('personal',   '37-41 hair, skin, deodorant, dental',      39),
       ('pharmacy',   '41-43 first aid, vitamins, cough & cold',  43)
     ) as a(category, aisle, ord)
where s.name = 'HEB on 1488' and s.deleted_at is null
on conflict (store_id, category) do update
  set aisle = excluded.aisle, sort_order = excluded.sort_order, verified_at = excluded.verified_at;

-- ---------------------------------------------------------------------------
-- 3. Which dates a series lands on. ONE predicate, used by the materializer
--    and by the morning text, so the two can never disagree about a Tuesday.
-- ---------------------------------------------------------------------------
create or replace function series_hits(e events, d date) returns boolean
language sql immutable as $$
  select
    (e.repeat_freq = 'daily'
      and mod((d - e.event_date)::int, e.repeat_interval) = 0)
    or (e.repeat_freq = 'weekly'
      and extract(dow from d)::int = any(
            coalesce(nullif(e.repeat_days, '{}'),
                     array[extract(dow from e.event_date)::int]))
      and mod(
            ( (d - extract(dow from d)::int)
            - (e.event_date - extract(dow from e.event_date)::int) )::int / 7,
            e.repeat_interval) = 0)
    or (e.repeat_freq = 'monthly'
      and extract(day from d) = extract(day from e.event_date)
      and mod( ((extract(year from d)*12 + extract(month from d))
              - (extract(year from e.event_date)*12 + extract(month from e.event_date)))::int,
              e.repeat_interval) = 0)
$$;

-- Everything that happens on a given date, one-off or series, with overrides
-- applied and skips removed. starts_at/ends_at are real instants.
create or replace function occurrences_on(p_date date)
returns table (event_id uuid, title text, all_day boolean,
               starts_at timestamptz, ends_at timestamptz, member_id uuid)
language sql stable as $$
  with h as (select timezone from households limit 1)
  -- one-offs
  select e.id, e.title, e.all_day, e.starts_at, e.ends_at, e.member_id
    from events e
   where e.deleted_at is null and e.repeat_freq is null and e.event_date = p_date
  union all
  -- series occurrences
  select e.id, e.title, e.all_day,
         coalesce(ov.starts_at,
           ((p_date::timestamp + case when e.all_day then time '09:00'
                                      else (e.starts_at at time zone h.timezone)::time end)
            at time zone h.timezone)),
         case when e.ends_at is null then null else
           coalesce(ov.ends_at,
             ((p_date::timestamp + (e.ends_at at time zone h.timezone)::time)
              at time zone h.timezone)) end,
         e.member_id
    from events e cross join h
    left join event_exceptions ov
           on ov.event_id = e.id and ov.occurrence_date = p_date and ov.action = 'override'
   where e.deleted_at is null
     and e.repeat_freq is not null
     and p_date >= e.event_date
     and (e.repeat_until is null or p_date <= e.repeat_until)
     and series_hits(e, p_date)
     and not exists (select 1 from event_exceptions x
                      where x.event_id = e.id and x.occurrence_date = p_date and x.action = 'skip');
$$;

-- ---------------------------------------------------------------------------
-- The cast of an event, or its owner as a one-row stand-in when nobody was
-- named. Lead is the person's own, then their role default.
-- ---------------------------------------------------------------------------
create or replace function event_cast(p_event_id uuid)
returns table (member_id uuid, role text, lead_minutes int)
language sql stable as $$
  select ep.member_id, ep.role,
         coalesce(ep.lead_minutes, role_default_lead(ep.role, m.default_lead_minutes))
    from event_people ep join members m on m.id = ep.member_id
   where ep.event_id = p_event_id
  union all
  select e.member_id, 'going', e.reminder_lead_minutes
    from events e
   where e.id = p_event_id and e.member_id is not null
     and not exists (select 1 from event_people ep where ep.event_id = p_event_id);
$$;

-- ---------------------------------------------------------------------------
-- What one person has on one day. This is the morning text.
-- ---------------------------------------------------------------------------
create or replace function member_day(p_member uuid, p_date date)
returns table (title text, all_day boolean, starts_at timestamptz, ends_at timestamptz, role text)
language sql stable as $$
  select o.title, o.all_day, o.starts_at, o.ends_at, c.role
    from occurrences_on(p_date) o
    cross join lateral event_cast(o.event_id) c
   where c.member_id = p_member
   order by o.all_day desc, o.starts_at;
$$;

-- ---------------------------------------------------------------------------
-- 4. The materializer, per person.
-- ---------------------------------------------------------------------------
create or replace function materialize_series_reminders(days_ahead int default 21)
returns int
language plpgsql
security definer
as $$
declare
  n int;
begin
  insert into reminders
    (household_id, event_id, member_id, lead_minutes, channel, fire_at, occurrence_date)
  select
    e.household_id, e.id, c.member_id, c.lead_minutes,
    case when exists (select 1 from push_subscriptions ps where ps.member_id = c.member_id)
         then 'push' else 'sms' end::reminder_channel,
    -- pickup is measured from the END; everyone else from the start
    (case when c.role = 'pickup' and o.ends_at is not null then o.ends_at else o.starts_at end)
      - make_interval(mins => c.lead_minutes),
    d
  from events e
  cross join lateral generate_series(
      greatest(current_date, e.event_date),
      least(current_date + days_ahead, coalesce(e.repeat_until, current_date + days_ahead)),
      interval '1 day') gs(ts)
  cross join lateral (select gs.ts::date) sel(d)
  cross join lateral (select * from occurrences_on(d) oo where oo.event_id = e.id) o
  cross join lateral event_cast(e.id) c
  where e.deleted_at is null
    and e.repeat_freq is not null
    and c.lead_minutes is not null
    and c.member_id is not null
  on conflict do nothing;      -- reminders_unique_occurrence covers (event, date, member)

  get diagnostics n = row_count;
  return n;
end $$;

comment on function materialize_series_reminders is
  'One reminder per cast member per occurrence, at their own lead, pickup '
  'measured from the end. Idempotent; safe to re-run.';

-- Re-run it now so the next 21 days pick up the cast immediately, rather than
-- waiting for tonight.
select materialize_series_reminders(21) as reminders_written;

-- ---------------------------------------------------------------------------
-- 5. The morning text — bookkeeping and schedule
--
--    The function decides WHEN in local time (6:30am, DST-proof); the cron
--    only has to wake it often enough across the window. One row per person
--    per day stops a second wake-up sending a second text.
-- ---------------------------------------------------------------------------
create table if not exists digest_log (
  member_id uuid not null references members(id) on delete cascade,
  for_date  date not null,
  sent_at   timestamptz not null default now(),
  primary key (member_id, for_date)
);
alter table digest_log enable row level security;
drop policy if exists digest_log_all on digest_log;
create policy digest_log_all on digest_log for all using (true) with check (true);

create extension if not exists pg_net;

-- Every 15 minutes between 11:00 and 13:59 UTC covers 6:30am Central in
-- both halves of the year. The function ignores wake-ups outside its window.
select cron.unschedule('morning-digest')
  where exists (select 1 from cron.job where jobname = 'morning-digest');

select cron.schedule('morning-digest', '*/15 11-13 * * *', $$
  select net.http_post(
    url     := 'https://rauvytdltnbqrvyiornh.supabase.co/functions/v1/morning-digest',
    headers := '{"Content-Type":"application/json","x-digest-secret":"REPLACE_WITH_DIGEST_SECRET"}'::jsonb,
    body    := '{}'::jsonb
  );
$$);

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
select 'stores' as check, string_agg(name || ' [' || array_to_string(aliases, '/') || ']', ' · ' order by sort_order) as detail
  from stores where deleted_at is null
union all
select 'HEB on 1488 aisles', count(*)::text || ' categories'
  from store_aisles a join stores s on s.id = a.store_id where s.name = 'HEB on 1488'
union all
select 'series reminders (next 21d)', count(*)::text
  from reminders where occurrence_date >= current_date and sent_at is null
union all
select 'cron jobs', string_agg(jobname || ' @ ' || schedule, ' · ')
  from cron.job where jobname in ('materialize-series','morning-digest');
