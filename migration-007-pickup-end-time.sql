-- ============================================================================
-- 007 — A pickup is measured from the END of the event
--
-- WHY
--   Telling someone to leave for pickup thirty minutes before the event
--   STARTS is worse than telling them nothing. They arrive an hour early, sit
--   in a car park, and stop trusting the alerts. Whoever collects needs to be
--   timed off ends_at.
--
--   The application code now does this on write. This migration fixes the
--   database side, which would otherwise quietly undo it: resync_reminders()
--   recomputes EVERY reminder for an event from starts_at whenever the event
--   moves. One edit and every pickup alert silently reverts.
--
--   It also never fired on a change to ends_at, so setting a finish time left
--   the pickup alert pointing at the old one.
-- ============================================================================

create or replace function resync_reminders() returns trigger as $$
declare tz text;
begin
  select timezone into tz from households where id = new.household_id;

  update reminders r
     set fire_at = case
           -- All-day: measured from 9am local on the event date, as before.
           when new.all_day
             then ((new.event_date::timestamp + interval '9 hours') at time zone tz)
                  - make_interval(mins => r.lead_minutes)

           -- Whoever collects is timed off the end, when there is one.
           when new.ends_at is not null and exists (
                  select 1 from event_people ep
                   where ep.event_id  = new.id
                     and ep.member_id = r.member_id
                     and ep.role      = 'pickup')
             then new.ends_at - make_interval(mins => r.lead_minutes)

           -- Everyone else: from the start.
           else new.starts_at - make_interval(mins => r.lead_minutes)
         end,
         sent_at = null
   where r.event_id = new.id and r.sent_at is null;

  return new;
end;
$$ language plpgsql;

-- ends_at was missing from the trigger's column list, so setting a finish
-- time never re-timed anything.
drop trigger if exists events_resync on events;
create trigger events_resync
after update of starts_at, ends_at, event_date, all_day on events
for each row execute function resync_reminders();

-- ---------------------------------------------------------------------------
-- Verify: the trigger now watches ends_at, and the function knows about pickup
-- ---------------------------------------------------------------------------
select 'trigger watches' as check,
       string_agg(a.attname, ', ' order by a.attname) as columns
  from pg_trigger t
  join unnest(t.tgattr) with ordinality as u(attnum, ord) on true
  join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = u.attnum
 where t.tgname = 'events_resync'
union all
select 'function handles pickup',
       case when prosrc like '%pickup%' then 'yes' else 'NO — did not apply' end
  from pg_proc where proname = 'resync_reminders';
