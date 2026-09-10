-- ============================================================================
-- 017 — A chore can have a preferred hour.
--
-- WHY
--   "Take out trash every Tuesday morning at 7" was filing itself as a
--   CALENDAR EVENT, titled "Take out trash morning .", because the rule was
--   "a clock means an appointment". That rule is right for "Soccer Thursday
--   5:30" and wrong for the archetypal chore.
--
--   The reason the rule existed was that todos had no due TIME, so routing a
--   timed thing as a todo would silently drop the hour. Give them one and the
--   rule can be narrowed to what it was really protecting: a chore VERB beats
--   the clock; a chore FRAME does not. "Finish homework by 8pm" is a to-do.
--   "I need to leave for the airport Friday 6am" is still an appointment.
--
--   The nag then fires at the hour that was asked for, instead of the
--   household's 6pm default.
--
-- SAFE TO RE-RUN.
-- ============================================================================

begin;

alter table todos add column if not exists due_time time;

comment on column todos.due_time is
  'Optional preferred hour. A chore is still not an appointment — this only '
  'moves when the nag fires. NULL means the household default (6pm).';

-- The nag honours it.
create or replace function queue_todo_nags()
returns int
language plpgsql
security definer
as $$
declare n int; hh record;
begin
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

-- Carried forward when a repeating chore spawns its successor.
create or replace function todos_spawn_next()
returns trigger language plpgsql
as $$
declare nxt date; guard int := 0;
begin
  if new.completed_at is null or old.completed_at is not null then return new; end if;
  if new.repeat_freq is null then return new; end if;

  nxt := coalesce(new.due_on, current_date);
  loop
    nxt := todo_next_due(nxt, new.repeat_freq, new.repeat_interval, new.repeat_days);
    guard := guard + 1;
    exit when nxt is null or nxt >= current_date or guard > 500;
  end loop;

  if nxt is null then return new; end if;
  if new.repeat_until is not null and nxt > new.repeat_until then return new; end if;

  insert into todos (household_id, title, note, assignee_id, assigned_by, batch_id,
                     sort_order, due_on, due_time, remind,
                     repeat_freq, repeat_interval, repeat_days, repeat_until,
                     parent_id, source, created_by)
  values (new.household_id, new.title, new.note, new.assignee_id, new.assigned_by,
          new.batch_id, new.sort_order, nxt, new.due_time, new.remind,
          new.repeat_freq, new.repeat_interval, new.repeat_days, new.repeat_until,
          new.id, new.source, new.created_by);

  return new;
end $$;

-- member_todos hands the hour to the app so it can show it.
-- `create or replace` CANNOT change a function's return row type — adding
-- due_time to the OUT columns is exactly that — so it has to be dropped
-- first. Postgres says so explicitly; nothing else about this is subtle.
drop function if exists member_todos(uuid);
create or replace function member_todos(p_member uuid)
returns table (id uuid, title text, note text, due_on date, due_time time,
               sort_order double precision, shared boolean, overdue_days int)
language sql stable as $$
  select t.id, t.title, t.note, t.due_on, t.due_time, t.sort_order,
         t.assignee_id is null as shared,
         case when t.due_on is null or t.due_on >= current_date then 0
              else (current_date - t.due_on) end as overdue_days
    from todos t
   where t.deleted_at is null and t.cleared_at is null and t.completed_at is null
     and (t.assignee_id = p_member or t.assignee_id is null)
   order by t.sort_order, t.created_at;
$$;


-- ---------------------------------------------------------------------------
-- Checking things off.
--
--   Erich: "We also need a way to clear things from the event (like a check
--   box to check) and todos and shopping. App should be completely usable
--   and the text is an easy supplement if needed."
--
--   Shopping and todos already had it. Events did not, so a one-off thing
--   that has happened sat on the calendar looking identical to one that had
--   not — which is the difference between a calendar you trust and one you
--   scroll past.
--
--   A single event gets done_at. An OCCURRENCE of a recurring event cannot:
--   ticking this Tuesday's trash must not mark every Tuesday. That is what
--   event_exceptions is for, so 'done' joins its vocabulary.
-- ---------------------------------------------------------------------------
alter table events add column if not exists done_at timestamptz;
alter table events add column if not exists done_by uuid references members(id) on delete set null;

comment on column events.done_at is
  'Ticked off. Only meaningful for a NON-recurring event — a series is done '
  'one occurrence at a time, in event_exceptions.';

/* NOT event_exceptions. expand() keys exceptions by (event, date) in a Map,
   one row per date — so a 'done' row would overwrite an 'override' and
   silently lose a moved occurrence. A finished occurrence is a different
   fact from a changed one, and it gets its own table. */
create table if not exists event_done (
  household_id    uuid not null references households(id) on delete cascade,
  event_id        uuid not null references events(id) on delete cascade,
  occurrence_date date not null,
  done_at         timestamptz not null default now(),
  done_by         uuid references members(id) on delete set null,
  primary key (event_id, occurrence_date)
);

comment on table event_done is
  'One ticked-off occurrence. Separate from event_exceptions because a done '
  'occurrence and a moved one are different facts about the same date, and '
  'the expander only keeps one exception row per date.';

/* Is this particular occurrence finished? */
create or replace function occurrence_done(p_event uuid, p_date date)
returns boolean language sql stable as $$
  select exists (select 1 from event_done d
                  where d.event_id = p_event and d.occurrence_date = p_date)
      or exists (select 1 from events e
                  where e.id = p_event and e.repeat_freq is null and e.done_at is not null);
$$;

/* A finished thing does not need reminding about. */
create or replace function drop_reminders_when_done()
returns trigger language plpgsql as $$
begin
  if new.done_at is not null and old.done_at is null then
    delete from reminders r where r.event_id = new.id and r.sent_at is null;
  end if;
  return new;
end $$;

drop trigger if exists events_done_trg on events;
create trigger events_done_trg after update on events
  for each row execute function drop_reminders_when_done();

insert into schema_migrations (id) values ('017-due-time') on conflict do nothing;

commit;

select column_name, data_type from information_schema.columns
 where table_schema='public' and table_name='todos' and column_name='due_time';
