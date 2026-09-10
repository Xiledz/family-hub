-- ============================================================================
-- 012 — Aliases (008 never ran), a cast that always has somebody in it,
--       and all-day reminders that actually have a time to fire at.
--
-- WHY
--   Three separate silences, found by querying the live database rather than
--   trusting the migration list:
--
--   1. members.aliases does not exist. Migration 008 was written but never
--      run. Nothing crashes, because every reader does `m.aliases ?? []` —
--      which is exactly the problem. A kid texting "mom is driving" resolves
--      to nobody, the ride is dropped, and the event saves anyway.
--
--   2. event_cast() falls back to events.member_id when nobody was named, but
--      an event created by text has member_id NULL. So "Planning committee",
--      a weekly event that has run through the materializer seven nights in a
--      row, has produced exactly zero reminders. Nobody is on it, so nobody
--      is told. created_by is always set, so it is the honest last resort.
--
--   3. All-day events have starts_at NULL. The materializer computes
--      `starts_at - lead`, which is NULL, and fire_at is NOT NULL, so the row
--      is silently dropped by the insert. Every recurring all-day event is
--      invisible. An all-day thing has no clock time to count back from, so
--      it needs a wall time of its own: the morning of, at the household's
--      all-day hour.
--
-- SAFE TO RE-RUN. Every statement is idempotent.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Aliases — the body of 008, unchanged.
-- ---------------------------------------------------------------------------
alter table members add column if not exists aliases text[] not null default '{}';

comment on column members.aliases is
  'Other things this person gets called in a text — "mom", "dad", a nickname, '
  'a full first name when the short one is canonical. Resolved to name on '
  'parse; never stored on an event.';

update members
   set aliases = array['dad','daddy','papa','pop','erich']
 where name = 'Erich' and deleted_at is null and aliases = '{}';

update members
   set aliases = array['mom','mommy','mama','momma','jessica','jess']
 where name = 'Jess' and deleted_at is null and aliases = '{}';

-- ---------------------------------------------------------------------------
-- 2. The household's all-day reminder hour.
--
--    One knob, not one per event. 8:30am local is where the one-off all-day
--    reminders already land, so this keeps existing behaviour and gives the
--    series materializer the same anchor.
-- ---------------------------------------------------------------------------
alter table households
  add column if not exists all_day_reminder_at time not null default '08:30';

comment on column households.all_day_reminder_at is
  'Wall-clock time, household timezone, at which an all-day event reminds on '
  'the morning of. All-day events have no start time to count a lead back '
  'from, so they get an absolute time instead.';

-- ---------------------------------------------------------------------------
-- 3. event_cast — never returns zero rows for an event that exists.
--
--    Order of last resort: whoever was named, else the event's owner, else
--    whoever created it. The three arms are mutually exclusive by their NOT
--    EXISTS guards, so this still returns one row per person, never a
--    duplicate.
-- ---------------------------------------------------------------------------
create or replace function event_cast(p_event_id uuid)
returns table (member_id uuid, role text, lead_minutes int)
language sql stable as $$
  -- (a) the people actually named on the event
  select ep.member_id, ep.role,
         coalesce(ep.lead_minutes, role_default_lead(ep.role, m.default_lead_minutes))
    from event_people ep
    join members m on m.id = ep.member_id
   where ep.event_id = p_event_id
     and m.deleted_at is null

  union all

  -- (b) nobody named, but the event has an owner
  select e.member_id, 'going', e.reminder_lead_minutes
    from events e
    join members m on m.id = e.member_id
   where e.id = p_event_id
     and e.member_id is not null
     and m.deleted_at is null
     and not exists (select 1 from event_people ep where ep.event_id = p_event_id)

  union all

  -- (c) no cast and no owner — fall back to whoever put it on the calendar.
  --     An event nobody is attached to is not an event nobody cares about;
  --     it is an event we failed to attach anybody to.
  select e.created_by, 'going', e.reminder_lead_minutes
    from events e
    join members m on m.id = e.created_by
   where e.id = p_event_id
     and e.member_id is null
     and e.created_by is not null
     and m.deleted_at is null
     and not exists (select 1 from event_people ep where ep.event_id = p_event_id);
$$;

comment on function event_cast is
  'Who a reminder is for: the named cast, else the owner, else the creator. '
  'Never empty for an event that has any person attached to it at all.';

-- ---------------------------------------------------------------------------
-- 4. The materializer — all-day events get a wall time.
--
--    Timed events are unchanged: lead counted back from the start, or from
--    the end for a pickup. All-day events fire at the household hour on the
--    morning of, converted through the household timezone so it is 8:30
--    local in March and 8:30 local in November.
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
    case
      -- An all-day thing has no clock to count back from.
      when o.all_day or o.starts_at is null
        then ((sel.d + hh.all_day_reminder_at) at time zone hh.timezone)
      -- Pickup is measured from the end; everyone else from the start.
      when c.role = 'pickup' and o.ends_at is not null
        then o.ends_at - make_interval(mins => c.lead_minutes)
      else o.starts_at - make_interval(mins => c.lead_minutes)
    end,
    sel.d
  from events e
  join households hh on hh.id = e.household_id
  cross join lateral generate_series(
      greatest(current_date, e.event_date),
      least(current_date + days_ahead, coalesce(e.repeat_until, current_date + days_ahead)),
      interval '1 day') gs(ts)
  cross join lateral (select gs.ts::date) sel(d)
  cross join lateral (select * from occurrences_on(sel.d) oo where oo.event_id = e.id) o
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
  'One reminder per cast member per occurrence. Timed events count back from '
  'the start (or the end, for a pickup); all-day events fire at the '
  'household all-day hour on the morning of. Idempotent; safe to re-run.';

commit;

-- ---------------------------------------------------------------------------
-- Backfill and verify. Run this AFTER the commit above.
-- ---------------------------------------------------------------------------
select materialize_series_reminders(21) as reminders_written;

select name, phone, role, aliases from members where deleted_at is null order by sort_order, name;

select e.title,
       e.all_day,
       (select count(*) from event_cast(e.id))                            as cast_size,
       (select count(*) from reminders r
         where r.event_id = e.id and r.sent_at is null)                   as pending
  from events e
 where e.repeat_freq is not null and e.deleted_at is null;
