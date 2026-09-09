-- ============================================================================
-- 003 — Reminder materializer for repeating events
--
-- WHY THIS EXISTS
--   reminders.fire_at is a precomputed timestamp. That works for a one-off
--   event, where the app writes one row on save. It cannot work for "soccer
--   every Tuesday through May", which has no bounded set of rows to write.
--
--   So: a daily job walks each series, expands the next few weeks, drops any
--   date carrying a 'skip' exception, and inserts the reminder rows for what
--   survives. The per-minute dispatcher is untouched and never learns that
--   repeating events exist.
--
-- ⚠  THE RECURRENCE RULE NOW LIVES IN TWO PLACES
--   recur.js  occurrenceDates()  — drives everything the family SEES
--   this file materialize_series_reminders() — drives what they get BUZZED for
--   They must agree. If you change one, change the other, then re-run
--   verify_recurrence_parity() below. A silent divergence means the calendar
--   shows practice on Tuesday and the phone buzzes on Wednesday.
-- ============================================================================

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
    e.household_id,
    e.id,
    e.member_id,
    e.reminder_lead_minutes,
    'push'::reminder_channel,
    -- all-day series are anchored to 9am local, same rule the app uses, so a
    -- "1 day before" reminder never fires in the middle of the night
    ((d::timestamp
      + case when e.all_day then time '09:00'
             else ((e.starts_at at time zone h.timezone)::time) end)
     at time zone h.timezone)
    - make_interval(mins => e.reminder_lead_minutes),
    d
  from events e
  join households h on h.id = e.household_id
  cross join lateral generate_series(
      greatest(current_date, e.event_date),
      least(current_date + days_ahead, coalesce(e.repeat_until, current_date + days_ahead)),
      interval '1 day') gs(ts)
  cross join lateral (select gs.ts::date) sel(d)
  where e.deleted_at is null
    and e.repeat_freq is not null
    and e.reminder_lead_minutes is not null
    and (
      -- daily, every N days from the series start
      (e.repeat_freq = 'daily'
        and mod((d - e.event_date)::int, e.repeat_interval) = 0)

      -- weekly: right weekday, and the right week when interval > 1.
      -- Week distance is measured between the Sundays of each week, not in
      -- raw days, so a DST week does not shift the cadence.
      or (e.repeat_freq = 'weekly'
        and extract(dow from d)::int = any(
              coalesce(nullif(e.repeat_days, '{}'),
                       array[extract(dow from e.event_date)::int]))
        and mod(
              ( (d - extract(dow from d)::int)
              - (e.event_date - extract(dow from e.event_date)::int) )::int / 7,
              e.repeat_interval) = 0)

      -- monthly on the same day-of-month
      or (e.repeat_freq = 'monthly'
        and extract(day from d) = extract(day from e.event_date)
        and mod( ((extract(year from d)*12 + extract(month from d))
                - (extract(year from e.event_date)*12 + extract(month from e.event_date)))::int,
                e.repeat_interval) = 0)
    )
    -- school break, holiday, or any single week the family called off
    and not exists (
      select 1 from event_exceptions x
      where x.event_id = e.id and x.occurrence_date = d and x.action = 'skip')
  on conflict do nothing;   -- reminders_unique_occurrence makes re-runs harmless

  get diagnostics n = row_count;
  return n;
end $$;

comment on function materialize_series_reminders is
  'Inserts reminder rows for repeating events N days ahead. Idempotent.';

-- ---------------------------------------------------------------------------
-- Parity check. Returns the dates THIS function would fire for a given series,
-- so they can be diffed against recur.js output. Run it after touching either.
-- ---------------------------------------------------------------------------
create or replace function preview_series_dates(p_event_id uuid, days_ahead int default 60)
returns table (occurrence_date date)
language sql stable as $$
  select d
  from events e
  cross join lateral generate_series(
      greatest(current_date, e.event_date),
      least(current_date + days_ahead, coalesce(e.repeat_until, current_date + days_ahead)),
      interval '1 day') gs(ts)
  cross join lateral (select gs.ts::date) sel(d)
  where e.id = p_event_id and e.repeat_freq is not null
    and (
      (e.repeat_freq='daily'   and mod((d - e.event_date)::int, e.repeat_interval)=0)
      or (e.repeat_freq='weekly'
          and extract(dow from d)::int = any(coalesce(nullif(e.repeat_days,'{}'),
                array[extract(dow from e.event_date)::int]))
          and mod(((d - extract(dow from d)::int) - (e.event_date - extract(dow from e.event_date)::int))::int / 7,
                  e.repeat_interval)=0)
      or (e.repeat_freq='monthly'
          and extract(day from d)=extract(day from e.event_date)
          and mod(((extract(year from d)*12+extract(month from d))
                 - (extract(year from e.event_date)*12+extract(month from e.event_date)))::int,
                 e.repeat_interval)=0)
    )
    and not exists (select 1 from event_exceptions x
                    where x.event_id=e.id and x.occurrence_date=d and x.action='skip')
  order by d;
$$;

-- ---------------------------------------------------------------------------
-- Schedule it. 3:10am local-ish, once a day. Nothing here is time-critical —
-- it only needs to stay ahead of the 21-day horizon.
-- ---------------------------------------------------------------------------
select cron.unschedule('materialize-series')
  where exists (select 1 from cron.job where jobname = 'materialize-series');

select cron.schedule('materialize-series', '10 8 * * *',
  $$ select materialize_series_reminders(21); $$);
