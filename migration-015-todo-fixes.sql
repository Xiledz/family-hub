-- ============================================================================
-- 015 — The defects 014 shipped with, plus the todo nag.
--
-- Found by running the schema rather than reading it, and by walking real
-- phrasings through the live parser.
--
--   1. reminders.channel still DEFAULTS to 'push'. 013 dropped NOT NULL and
--      left the default behind, so any insert that does not name a channel is
--      stamped 'push' again — the exact thing 013 existed to end. Harmless
--      today because deliver() overwrites at send, but it is a loaded gun.
--
--   2. member_todos orders by due_on FIRST, which makes drag-to-reorder a
--      no-op across anything dated. Erich picked hand-ranking over priority
--      levels; the list has to actually obey the hand. Due dates become
--      badges, not sort keys. The digest still sorts by due_on — that is a
--      different question ("what is urgent") from the list ("what order do I
--      want to see my work in").
--
--   3. sort_order defaults to 0, which drops every new todo into the MIDDLE
--      of a ranked list. New things belong at the top. A trigger, not app
--      code, because SMS inserts too.
--
--   4. todos_spawn_next counts the next occurrence from due_on even when
--      due_on is weeks past. Finish the trash three weeks late and its
--      successor is due two weeks ago — born overdue, nagging immediately.
--
--   5. todo_next_due applies the interval per HIT rather than per week, so
--      "Tue and Thu, every other week" returns Thursday of the SAME week
--      plus seven. series_hits gets this right; the todo copy did not.
--
--   6. sms_last_action cannot point at a todo, so "delete that" after adding
--      one deletes the last EVENT instead. Same class of bug already fixed
--      for shopping by comparing timestamps.
--
--   7. sms_pending has no 'pick_todo' kind, so an ambiguous "did the dishes"
--      has nowhere to ask.
--
--   8. The 6pm nag needs to BE a reminders row, not a second sender. One
--      delivery path was the whole point of 013.
--
-- SAFE TO RE-RUN.
-- ============================================================================

begin;

-- 1 -------------------------------------------------------------------------
alter table reminders alter column channel drop default;

-- 2 -------------------------------------------------------------------------
create or replace function member_todos(p_member uuid)
returns table (id uuid, title text, note text, due_on date, sort_order double precision,
               shared boolean, overdue_days int)
language sql stable as $$
  select t.id, t.title, t.note, t.due_on, t.sort_order,
         t.assignee_id is null as shared,
         case when t.due_on is null or t.due_on >= current_date then 0
              else (current_date - t.due_on) end as overdue_days
    from todos t
   where t.deleted_at is null and t.cleared_at is null and t.completed_at is null
     and (t.assignee_id = p_member or t.assignee_id is null)
   order by t.sort_order, t.created_at;
$$;

comment on function member_todos is
  'One person''s open list, in the order THEY dragged it into. Due dates are '
  'shown as badges, never as the sort key — a list that silently reorders '
  'itself is not hand-ranked.';

-- 3 -------------------------------------------------------------------------
create or replace function todos_place_new()
returns trigger language plpgsql as $$
begin
  if new.sort_order is null or new.sort_order = 0 then
    select coalesce(min(t.sort_order), 0) - 1000 into new.sort_order
      from todos t
     where t.household_id = new.household_id
       and t.assignee_id is not distinct from new.assignee_id
       and t.completed_at is null and t.deleted_at is null and t.cleared_at is null;
  end if;
  return new;
end $$;

drop trigger if exists todos_place_new_trg on todos;
create trigger todos_place_new_trg before insert on todos
  for each row execute function todos_place_new();

-- 5 (before 4, because 4 calls it) ------------------------------------------
create or replace function todo_next_due(p_from date, p_freq text, p_interval int, p_days int[])
returns date
language plpgsql immutable as $$
declare d date; wk date;
begin
  if p_freq is null then return null; end if;

  if p_freq = 'weekly' and array_length(p_days, 1) is not null then
    /* Walk forward to the next listed weekday. The interval is a property of
       the WEEK, not of each hit: "Tue and Thu, every other week" must give
       Thursday of the same week, then Tuesday two weeks on — not Thursday
       plus a fortnight. So only a week boundary consumes the interval. */
    d := p_from + 1;
    for _i in 1..7 loop
      if extract(dow from d)::int = any (p_days) then
        -- same week as p_from? then the interval has not elapsed yet.
        wk := date_trunc('week', d)::date;
        if wk = date_trunc('week', p_from)::date then return d; end if;
        return d + (7 * (p_interval - 1));
      end if;
      d := d + 1;
    end loop;
    return p_from + (7 * p_interval);
  end if;

  return case p_freq
    when 'daily'   then p_from + p_interval
    when 'weekly'  then p_from + (7 * p_interval)
    when 'monthly' then (p_from + make_interval(months => p_interval))::date
    when 'yearly'  then (p_from + make_interval(years  => p_interval))::date
  end;
end $$;

-- 4 -------------------------------------------------------------------------
create or replace function todos_spawn_next()
returns trigger language plpgsql as $$
declare nxt date; guard int := 0;
begin
  if new.completed_at is null or old.completed_at is not null then return new; end if;
  if new.repeat_freq is null then return new; end if;

  nxt := coalesce(new.due_on, current_date);

  /* Finish something three weeks late and the next one must still be in the
     future. Without this the successor is born overdue and starts nagging
     the moment it exists, which is how a chore list teaches people to
     ignore it. The guard is because a malformed repeat must not spin. */
  loop
    nxt := todo_next_due(nxt, new.repeat_freq, new.repeat_interval, new.repeat_days);
    guard := guard + 1;
    exit when nxt is null or nxt >= current_date or guard > 500;
  end loop;

  if nxt is null then return new; end if;
  if new.repeat_until is not null and nxt > new.repeat_until then return new; end if;

  insert into todos (household_id, title, note, assignee_id, assigned_by, batch_id,
                     sort_order, due_on, remind,
                     repeat_freq, repeat_interval, repeat_days, repeat_until,
                     parent_id, source, created_by)
  values (new.household_id, new.title, new.note, new.assignee_id, new.assigned_by,
          new.batch_id, new.sort_order, nxt, new.remind,
          new.repeat_freq, new.repeat_interval, new.repeat_days, new.repeat_until,
          new.id, new.source, new.created_by);

  return new;
end $$;

-- 6 -------------------------------------------------------------------------
alter table sms_last_action add column if not exists todo_id uuid
  references todos(id) on delete cascade;

comment on column sms_last_action.todo_id is
  'Set instead of event_id when the last thing this person did by text was a '
  'todo. Without it "delete that" after adding a todo deletes their last '
  'calendar event instead.';

-- 7 -------------------------------------------------------------------------
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'sms_pending'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%kind%';
  if c is not null then execute format('alter table sms_pending drop constraint %I', c); end if;
end $$;

alter table sms_pending add constraint sms_pending_kind_check
  check (kind in ('confirm_date','confirm_time','route_intent','pick_todo','series_scope'));

-- 8 -------------------------------------------------------------------------
create or replace function queue_todo_nags()
returns int
language plpgsql
security definer
as $$
declare n int; hh record;
begin
  n := 0;
  for hh in select id, timezone, all_day_reminder_at from households loop
    insert into reminders (household_id, todo_id, member_id, lead_minutes,
                           fire_at, occurrence_date)
    select t.household_id, t.id, t.assignee_id, 0,
           ((t.due_on + time '18:00') at time zone hh.timezone),
           t.due_on
      from todos t
     where t.household_id = hh.id
       and t.deleted_at is null and t.cleared_at is null and t.completed_at is null
       and t.remind
       and t.due_on = (now() at time zone hh.timezone)::date
       and t.assignee_id is not null          -- the house nags nobody
       and t.nag_count = 0
    on conflict do nothing;                   -- unique (todo, occurrence, member)
    n := n + coalesce((select count(*) from todos t
                        where t.household_id = hh.id and t.due_on = (now() at time zone hh.timezone)::date), 0);
  end loop;

  update todos t set nag_count = 1, last_nagged_at = now()
   where t.completed_at is null and t.deleted_at is null and t.remind
     and t.nag_count = 0
     and exists (select 1 from reminders r
                  where r.todo_id = t.id and r.occurrence_date = t.due_on);

  return n;
end $$;

comment on function queue_todo_nags is
  'The 6pm "still open" ping, as a reminders row so the existing dispatcher '
  'and deliver() carry it. One per todo per day, enforced by the unique '
  'index, not by hoping the cron fires once.';

insert into schema_migrations (id) values ('015-todo-fixes') on conflict do nothing;

commit;

select cron.schedule('todo-nags', '5 * * * *', $$ select queue_todo_nags() $$);
