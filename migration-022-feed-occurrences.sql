-- ============================================================================
-- 022 — The calendar feed reads the calendar the way the calendar does.
--
-- WHY
--   ics-feed emitted one VEVENT per events ROW: a weekly series was one
--   Tuesday, skips and moved occurrences were ignored, nobody's name was on
--   anything, and a ticked-off event looked identical to one still coming.
--   Worse, since events grew three foreign keys to members (member_id,
--   created_by, done_by) its `select *, members(name)` embed became
--   ambiguous, PostgREST refused it, the error was swallowed, and the feed
--   has been an empty calendar for weeks.
--
--   Expansion belongs in SQL, in the ONE predicate everything else already
--   uses: occurrences_on() → series_hits(), with overrides applied and skips
--   removed. This function walks a date window over it, attaches the cast
--   as text and the done state, and hands the feed finished occurrences.
--
-- SECURITY DEFINER because ics-feed runs as the service role but the same
--   function is handy from the app; it filters to visibility = 'household'
--   itself, so it can never leak an adults-only row to a subscriber.
--
-- SAFE TO RE-RUN.
-- ============================================================================

begin;

drop function if exists feed_occurrences(uuid, date, date);
create function feed_occurrences(p_household uuid, p_from date, p_to date)
returns table (event_id uuid, occurrence_date date, title text, all_day boolean,
               starts_at timestamptz, ends_at timestamptz,
               location text, notes text, people text, done boolean)
language sql stable security definer
set search_path = public
as $$
  select o.event_id, g.d, o.title, o.all_day, o.starts_at, o.ends_at,
         e.location, e.notes,
         /* "Addie · Jess drives" — the cast as a person would read it. */
         (select string_agg(
                   case c.role
                     when 'driving'  then m.name || ' drives'
                     when 'dropoff'  then m.name || ' takes'
                     when 'pickup'   then m.name || ' picks up'
                     when 'helping'  then m.name || ' helps'
                     when 'optional' then m.name || ' (maybe)'
                     else m.name end,
                   ' · ' order by (c.role <> 'going'), m.sort_order, m.name)
            from event_cast(o.event_id) c
            join members m on m.id = c.member_id
           where m.deleted_at is null),
         occurrence_done(o.event_id, g.d)
    from generate_series(p_from, least(p_to, p_from + 500), interval '1 day') gs(ts)
    cross join lateral (select gs.ts::date as d) g
    cross join lateral occurrences_on(g.d) o
    join events e on e.id = o.event_id
   where e.household_id = p_household
     and e.deleted_at is null
     and e.visibility = 'household'
   order by g.d, o.all_day desc, o.starts_at, o.title;
$$;

comment on function feed_occurrences is
  'Every occurrence in a date window, expanded by occurrences_on (skips out, '
  'overrides in), with the cast as text and the done flag. What the .ics '
  'feed publishes. Household rows only; window capped at 500 days.';

grant execute on function feed_occurrences(uuid, date, date) to anon, service_role;

insert into schema_migrations (id) values ('022-feed-occurrences') on conflict do nothing;

commit;

-- ---------------------------------------------------------------------------
-- Verify (read-only): the next 30 days, as the feed will see them.
-- ---------------------------------------------------------------------------
select occurrence_date, title, all_day, people, done
  from feed_occurrences('00000000-0000-0000-0000-000000000001', current_date, current_date + 30)
 limit 20;
