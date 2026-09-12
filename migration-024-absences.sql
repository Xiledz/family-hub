-- ============================================================================
-- 024 — Not happening: absences, skips, and the reminders that must not fire.
--
-- WHY
--   A sick kid, a snow day, a parent out of town, one rehearsal cancelled:
--   the month's commonest interruption, and the app made it worse — a skip
--   exception left every reminder for that occurrence in place, so the
--   driver alert still fired at 3:15 for an orchestra nobody was going to.
--
-- WHAT THIS ADDS
--   1. A trigger on event_exceptions: a skip deletes the occurrence's unsent
--      reminders. The missing piece regardless of grammar. Mirrors 018's
--      drop_reminders_for_occurrence on event_done.
--   2. member_absences — who is not where the calendar says, for which
--      dates, and why. member_id NULL with kind school_closed means the
--      kids (roles child, teen).
--   3. apply_absence(): writes the skips and pauses the nags.
--        sick / school_closed → skip every occurrence that day where the
--          person is on the cast and nobody else is GOING (Jess driving
--          Addie to church is Addie's church; family dinner with all four
--          is not skipped because one is sick). School-ish events cannot be
--          told from the rest, so a sick kid's whole day is skipped.
--        away → skip only the person's own solo appointments; a ride role
--          (driving / dropoff / pickup) that nobody else covers is reported
--          as UNCOVERED, never skipped — an away parent does not cancel the
--          kid's practice, it uncovers the ride.
--        Either way: the person's own unsent reminders in the range go, and
--        the nags for their todos due in the range go (todos stay open).
--        Meals are untouched (headcount is M2 #4).
--      Returns a jsonb summary the text reply reads out.
--   4. revoke_absence(): soft-delete, remove the skips it created (tracked by
--      event_exceptions.absence_id), re-materialise those occurrences.
--   5. rematerialize_occurrence(): reminders back for one occurrence, series
--      or one-off, same clock rules as materialize_series_reminders.
--   6. uncovered_rides(): the away parent's digest line.
--
-- SAFE TO RE-RUN.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. A skip stops the reminders. (An override does not — the time moved,
--    resync_reminders follows it.)
-- ---------------------------------------------------------------------------
create or replace function drop_reminders_for_skip()
returns trigger language plpgsql as $$
begin
  if new.action = 'skip' then
    delete from reminders r
     where r.event_id = new.event_id
       and r.sent_at is null
       and (r.occurrence_date = new.occurrence_date
            or (r.occurrence_date is null
                and exists (select 1 from events e where e.id = new.event_id
                             and e.repeat_freq is null and e.event_date = new.occurrence_date)));
  end if;
  return new;
end $$;

drop trigger if exists event_exceptions_skip_trg on event_exceptions;
create trigger event_exceptions_skip_trg after insert or update on event_exceptions
  for each row execute function drop_reminders_for_skip();

-- ---------------------------------------------------------------------------
-- 2. Absences.
-- ---------------------------------------------------------------------------
create table if not exists member_absences (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  member_id     uuid references members(id) on delete cascade,
  kind          text not null check (kind in ('sick','away','school_closed')),
  from_date     date not null,
  to_date       date not null,
  note          text,
  created_by    uuid references members(id) on delete set null,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  check (to_date >= from_date and to_date - from_date <= 120)
);

create index if not exists member_absences_live_idx
  on member_absences (household_id, from_date, to_date) where deleted_at is null;

alter table member_absences enable row level security;
drop policy if exists member_absences_all on member_absences;
create policy member_absences_all on member_absences for all using (true) with check (true);

comment on table member_absences is
  'Who is not where the calendar says, for which dates, and why. member_id '
  'NULL + school_closed = the kids. Applying one writes event_exceptions '
  'skips tagged with absence_id, so revoking it can undo exactly those.';

alter table event_exceptions add column if not exists absence_id uuid
  references member_absences(id) on delete set null;

create index if not exists event_exceptions_absence_idx
  on event_exceptions (absence_id) where absence_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Which of this person's rides on a day nobody else covers.
-- ---------------------------------------------------------------------------
create or replace function uncovered_rides(p_member uuid, p_date date)
returns table (event_id uuid, title text, starts_at timestamptz, all_day boolean, role text)
language sql stable security definer set search_path = public as $$
  select o.event_id, o.title, o.starts_at, o.all_day, c.role
    from occurrences_on(p_date) o
    join events e on e.id = o.event_id and e.deleted_at is null
    cross join lateral event_cast(o.event_id) c
   where c.member_id = p_member
     and c.role in ('driving','dropoff','pickup')
     and not exists (select 1 from event_cast(o.event_id) c2
                      where c2.member_id <> p_member
                        and c2.role in ('driving','dropoff','pickup'))
     and not exists (select 1 from event_exceptions x
                      where x.event_id = o.event_id and x.occurrence_date = p_date and x.action = 'skip')
   order by o.all_day desc, o.starts_at;
$$;

-- ---------------------------------------------------------------------------
-- 4. Reminders back for one occurrence — series or one-off.
-- ---------------------------------------------------------------------------
create or replace function rematerialize_occurrence(p_event uuid, p_date date)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into reminders (household_id, event_id, member_id, lead_minutes, channel, fire_at, occurrence_date)
  select e.household_id, e.id, c.member_id, c.lead_minutes, null::reminder_channel,
         case
           when o.all_day or o.starts_at is null then ((p_date + hh.all_day_reminder_at) at time zone hh.timezone)
           when c.role = 'pickup' and o.ends_at is not null then o.ends_at - make_interval(mins => c.lead_minutes)
           else o.starts_at - make_interval(mins => c.lead_minutes)
         end,
         p_date
    from events e
    join households hh on hh.id = e.household_id
    cross join lateral (select * from occurrences_on(p_date) oo where oo.event_id = e.id) o
    cross join lateral event_cast(e.id) c
   where e.id = p_event and e.deleted_at is null
     and c.lead_minutes is not null and c.member_id is not null
     and (case
           when o.all_day or o.starts_at is null then ((p_date + hh.all_day_reminder_at) at time zone hh.timezone)
           when c.role = 'pickup' and o.ends_at is not null then o.ends_at - make_interval(mins => c.lead_minutes)
           else o.starts_at - make_interval(mins => c.lead_minutes)
         end) > now()
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Apply.
-- ---------------------------------------------------------------------------
create or replace function apply_absence(p_absence uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a member_absences; d date; o record; c record; mem uuid;
  members_affected uuid[]; others_going int; my_role text; other_ride int;
  skipped jsonb := '[]'; uncovered jsonb := '[]'; k int; nags int := 0; paused int := 0;
  who_drives text;
begin
  select * into a from member_absences where id = p_absence and deleted_at is null;
  if not found then return jsonb_build_object('error', 'no such absence'); end if;

  if a.member_id is not null then
    members_affected := array[a.member_id];
  elsif a.kind = 'school_closed' then
    select coalesce(array_agg(id), '{}') into members_affected
      from members where household_id = a.household_id and deleted_at is null and role in ('child','teen');
  else
    return jsonb_build_object('error', 'absence names nobody');
  end if;

  for d in select generate_series(a.from_date, a.to_date, interval '1 day')::date loop
    foreach mem in array members_affected loop
      for o in select oc.* from occurrences_on(d) oc
                 join events e on e.id = oc.event_id
                where e.household_id = a.household_id and e.deleted_at is null
                order by oc.all_day desc, oc.starts_at loop
        select role into my_role from event_cast(o.event_id) where member_id = mem limit 1;
        if my_role is null then continue; end if;
        select count(*) into others_going from event_cast(o.event_id)
         where member_id <> mem and role not in ('driving','dropoff','pickup');
        select count(*) into other_ride from event_cast(o.event_id)
         where member_id <> mem and role in ('driving','dropoff','pickup');

        if a.kind = 'away' and my_role in ('driving','dropoff','pickup') then
          if other_ride = 0 then
            uncovered := uncovered || jsonb_build_object('date', d, 'title', o.title,
              'starts_at', o.starts_at, 'all_day', o.all_day, 'role', my_role,
              'who', (select name from members where id = mem));
          end if;
          continue;
        end if;
        if a.kind = 'away' and others_going > 0 then continue; end if;
        if a.kind <> 'away' and my_role not in ('driving','dropoff','pickup') and others_going > 0 then continue; end if;
        if a.kind <> 'away' and my_role in ('driving','dropoff','pickup') then
          /* A sick driver does not cancel the kid's event; it uncovers the ride. */
          if other_ride = 0 then
            uncovered := uncovered || jsonb_build_object('date', d, 'title', o.title,
              'starts_at', o.starts_at, 'all_day', o.all_day, 'role', my_role,
              'who', (select name from members where id = mem));
          end if;
          continue;
        end if;

        select string_agg(m.name, ', ') into who_drives
          from event_cast(o.event_id) c2 join members m on m.id = c2.member_id
         where c2.member_id <> mem and c2.role in ('driving','dropoff','pickup');

        insert into event_exceptions (household_id, event_id, occurrence_date, action, created_by, absence_id)
        values (a.household_id, o.event_id, d, 'skip', a.created_by, a.id)
        on conflict (event_id, occurrence_date) do nothing;
        get diagnostics k = row_count;
        if k > 0 then
          skipped := skipped || jsonb_build_object('date', d, 'title', o.title,
            'starts_at', o.starts_at, 'all_day', o.all_day, 'driver', who_drives,
            'who', (select name from members where id = mem));
        end if;
      end loop;

      /* The person's own reminders in the range: gone, whatever they were for. */
      delete from reminders r
       where r.member_id = mem and r.sent_at is null and r.event_id is not null
         and ((r.occurrence_date = d)
              or (r.occurrence_date is null and (r.fire_at at time zone (select timezone from households where id = a.household_id))::date = d));
      get diagnostics k = row_count; paused := paused + k;

      /* Nags for todos due in the range: gone. The todos stay open. A snow
         day is not a sick day — the chores still stand. */
      if a.kind in ('sick','away') then
        delete from reminders r
         where r.sent_at is null and r.todo_id is not null
           and r.todo_id in (select t.id from todos t where t.assignee_id = mem and t.due_on = d);
        get diagnostics k = row_count; nags := nags + k;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('skipped', skipped, 'uncovered', uncovered,
                            'nags_paused', nags, 'reminders_paused', paused,
                            'members', members_affected);
end $$;

comment on function apply_absence is
  'Writes the skips an absence implies (tagged with absence_id), pauses the '
  'person''s reminders and nags in the range, and reports skipped occurrences '
  'and uncovered rides. Idempotent: re-applying adds nothing.';

-- ---------------------------------------------------------------------------
-- 6. Revoke.
-- ---------------------------------------------------------------------------
create or replace function revoke_absence(p_absence uuid)
returns int language plpgsql security definer set search_path = public as $$
declare x record; n int := 0;
begin
  update member_absences set deleted_at = now() where id = p_absence and deleted_at is null;
  for x in delete from event_exceptions where absence_id = p_absence and action = 'skip'
           returning event_id, occurrence_date loop
    perform rematerialize_occurrence(x.event_id, x.occurrence_date);
    n := n + 1;
  end loop;
  /* Todo nags come back: the queue only nags a todo once (nag_count), so
     the ones this absence silenced are reset and re-queued at the next tick. */
  update todos t set nag_count = 0, last_nagged_at = null
   where t.completed_at is null and t.deleted_at is null
     and t.due_on >= current_date
     and exists (select 1 from member_absences a
                  where a.id = p_absence and a.kind in ('sick','away')
                    and t.assignee_id = a.member_id
                    and t.due_on between a.from_date and a.to_date);
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- 7. The nag queue respects a live sick/away absence for days still to come
--    (apply_absence can only delete rows that exist; tomorrow's nag is
--    queued tomorrow). Body otherwise identical to 020.
-- ---------------------------------------------------------------------------
create or replace function queue_todo_nags()
returns int
language plpgsql
security definer
as $$
declare n int; hh record;
begin
  perform todos_roll_recurring();

  n := 0;
  for hh in select id, timezone from households loop
    insert into reminders (household_id, todo_id, member_id, lead_minutes,
                           fire_at, occurrence_date)
    select t.household_id, t.id, t.assignee_id, 0,
           ((t.due_on + coalesce(t.due_time, time '18:00')) at time zone hh.timezone),
           t.due_on
      from todos t
     where t.household_id = hh.id
       and t.deleted_at is null and t.cleared_at is null and t.completed_at is null
       and t.remind
       and t.due_on = (now() at time zone hh.timezone)::date
       and t.assignee_id is not null          -- the house nags nobody
       and t.nag_count = 0
       and not exists (select 1 from member_absences a
                        where a.deleted_at is null and a.kind in ('sick','away')
                          and a.member_id = t.assignee_id
                          and t.due_on between a.from_date and a.to_date)
    on conflict do nothing;
  end loop;

  update todos t set nag_count = 1, last_nagged_at = now()
   where t.completed_at is null and t.deleted_at is null and t.remind
     and t.nag_count = 0
     and exists (select 1 from reminders r
                  where r.todo_id = t.id and r.occurrence_date = t.due_on);

  get diagnostics n = row_count;
  return n;
end $$;

grant execute on function uncovered_rides(uuid, date)            to anon, service_role;
grant execute on function rematerialize_occurrence(uuid, date)   to anon, service_role;
grant execute on function apply_absence(uuid)                    to anon, service_role;
grant execute on function revoke_absence(uuid)                   to anon, service_role;

insert into schema_migrations (id) values ('024-absences') on conflict do nothing;

commit;

select tgname from pg_trigger where tgname = 'event_exceptions_skip_trg';
select count(*) as absences from member_absences;
