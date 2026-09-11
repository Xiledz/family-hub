-- ============================================================================
-- 020 — M0: chores that survive a missed week, DID by text, and the cook.
--
-- WHAT THE FAMILY WALK-THROUGH SHOWED
--   1. A recurring chore only spawned its next occurrence when the current
--      one was COMPLETED. Miss one Tuesday and the chain is dead: the old row
--      sits overdue forever, next Tuesday never nags, and the trash is now
--      a thing nobody is asked about. The date has to advance the chore,
--      not the checkbox.
--
--   2. Jess gets Bryce's nag (he has no phone) and replies "did it". The
--      handler now resolves that against sms_last_action — but the nag was
--      never written there, and the action vocabulary did not allow it.
--
--   3. meal_plan.cook_id was whoever tapped Plan. Erich plans, the thaw alert
--      lands on Erich, the beef stays frozen. The house has a default cook.
--
-- THE MISSED-CHORE RULE
--   An open recurring chore stays open and overdue — listed, and in the
--   morning digest as "Overdue 2d" — until the day its NEXT occurrence is
--   due. On that day it is closed as MISSED (completed_at set, missed_at set,
--   completed_by null) and the next occurrence is spawned from the DATE. One
--   row is one thing: the missed one is a closed row with a badge, not a
--   second open "Take out the trash" sitting beside the live one — which is
--   exactly what would make "did trash" ambiguous every single week.
--
--   Daily chores get no grace (the next one is due tomorrow); weekly ones
--   get the week. Nothing is deleted; "Clear done" in the app sweeps it.
--
-- SAFE TO RE-RUN.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The house has a default cook.
-- ---------------------------------------------------------------------------
alter table households add column if not exists default_cook_id uuid
  references members(id) on delete set null;

comment on column households.default_cook_id is
  'Who cooks when the meal does not say. meal_plan.cook_id overrides per '
  'meal; the planner is the fallback after that, never the default.';

update households
   set default_cook_id = '6e1fa667-6bd3-4432-8f8c-102535c7cef2'
 where id = '00000000-0000-0000-0000-000000000001'
   and default_cook_id is null
   and exists (select 1 from members
                where id = '6e1fa667-6bd3-4432-8f8c-102535c7cef2' and deleted_at is null);

-- cook_id -> household default -> planner.
create or replace function materialize_meal_reminders(p_meal uuid)
returns int language plpgsql security definer as $$
declare m meal_plan; cook timestamptz; n int := 0; who uuid; dflt uuid;
begin
  select * into m from meal_plan where id = p_meal and deleted_at is null;
  if not found or m.done_at is not null then return 0; end if;

  if m.recipe_id is null then
    delete from reminders where meal_id = p_meal and sent_at is null;
    return 0;
  end if;

  select default_cook_id into dflt from households where id = m.household_id;
  who := coalesce(m.cook_id, dflt, m.created_by);
  if who is null then return 0; end if;

  cook := meal_cook_start(m);
  delete from reminders where meal_id = p_meal and sent_at is null;

  insert into reminders (household_id, meal_id, member_id, lead_minutes,
                         fire_at, occurrence_date, label)
  select m.household_id, m.id, who, s.minutes_before_cook,
         cook - make_interval(mins => s.minutes_before_cook),
         m.plan_date, s.label
    from recipe_steps s
   where s.recipe_id = m.recipe_id
     and cook - make_interval(mins => s.minutes_before_cook) > now()
  on conflict do nothing;

  get diagnostics n = row_count;

  insert into reminders (household_id, meal_id, member_id, lead_minutes,
                         fire_at, occurrence_date, label)
  select m.household_id, m.id, who, 0, cook, m.plan_date, 'Start cooking'
   where cook > now()
  on conflict do nothing;

  return n;
end $$;

-- ---------------------------------------------------------------------------
-- 2. A chore can be missed.
-- ---------------------------------------------------------------------------
alter table todos add column if not exists missed_at timestamptz;

comment on column todos.missed_at is
  'Closed by the date, not by a person: its next occurrence came due while '
  'it was still open. completed_at is set too, so it leaves every open list; '
  'completed_by stays null because nobody did it.';

/* One successor per parent, enforced by the database rather than by hoping
   only one code path spawns. A unique index over a nullable column does
   not dedup NULLs, so it is partial — every non-recurring todo has a NULL
   parent and they must not collide. */
create unique index if not exists todos_parent_uniq
  on todos (parent_id) where parent_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Spawning the successor: from the DATE, once, in household-local time.
--
--    Called by the trigger whether the row was completed by a person or
--    closed as missed. The ON CONFLICT is the guard: completing an overdue
--    row that the roll already advanced spawns nothing.
-- ---------------------------------------------------------------------------
create or replace function todos_spawn_next()
returns trigger language plpgsql
as $$
declare nxt date; guard int := 0; today date;
begin
  if new.completed_at is null or old.completed_at is not null then return new; end if;
  if new.repeat_freq is null then return new; end if;
  if exists (select 1 from todos c where c.parent_id = new.id) then return new; end if;

  /* current_date is the SERVER's date (UTC). Between 6pm and midnight in
     Texas that is already tomorrow, and a chore ticked at 7pm Tuesday would
     skip next Tuesday entirely. The household's clock decides. */
  select (now() at time zone h.timezone)::date into today
    from households h where h.id = new.household_id;
  today := coalesce(today, current_date);

  nxt := coalesce(new.due_on, today);
  loop
    nxt := todo_next_due(nxt, new.repeat_freq, new.repeat_interval, new.repeat_days);
    guard := guard + 1;
    exit when nxt is null or nxt >= today or guard > 500;
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
          new.id, new.source, new.created_by)
  on conflict (parent_id) where parent_id is not null do nothing;

  return new;
end $$;

-- The trigger itself is unchanged (AFTER UPDATE, from 014); re-stated so a
-- fresh database gets it.
drop trigger if exists todos_spawn_next_trg on todos;
create trigger todos_spawn_next_trg after update on todos
  for each row execute function todos_spawn_next();

-- ---------------------------------------------------------------------------
-- 4. The roll: close what was missed, which spawns what is next.
-- ---------------------------------------------------------------------------
create or replace function todos_roll_recurring()
returns int
language plpgsql
security definer
as $$
declare n int := 0; hh record; k int;
begin
  for hh in select id, timezone from households loop
    update todos t
       set completed_at = now(), missed_at = now(), completed_by = null
     where t.household_id = hh.id
       and t.deleted_at is null and t.cleared_at is null and t.completed_at is null
       and t.repeat_freq is not null
       and t.due_on is not null
       and t.due_on < (now() at time zone hh.timezone)::date
       /* Only once its successor's day has arrived. Until then it is simply
          overdue, and the digest says so every morning. */
       and todo_next_due(t.due_on, t.repeat_freq, t.repeat_interval, t.repeat_days)
           <= (now() at time zone hh.timezone)::date;
    get diagnostics k = row_count;
    n := n + k;
  end loop;
  return n;
end $$;

comment on function todos_roll_recurring is
  'Closes open recurring chores whose next occurrence is due, as MISSED, '
  'which makes todos_spawn_next create the occurrence from the date. Runs '
  'from queue_todo_nags on the hourly todo-nags cron.';

-- The nag queue rolls first, so a chore spawned at 00:05 nags at its hour.
-- Body otherwise identical to 017.
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

-- ---------------------------------------------------------------------------
-- 5. A nag is something "did it" can answer.
-- ---------------------------------------------------------------------------
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'sms_last_action'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%action%';
  if c is not null then execute format('alter table sms_last_action drop constraint %I', c); end if;
end $$;

alter table sms_last_action add constraint sms_last_action_action_check
  check (action in ('create','edit','nag','done'));

comment on table sms_last_action is
  'The last thing each person touched by text — an event they created or '
  'changed, a todo they added, or a nag they were sent — so "did it" and '
  '"delete that" can answer without naming it. One row per person.';

insert into schema_migrations (id) values ('020-m0-chores-cook') on conflict do nothing;

commit;

-- ---------------------------------------------------------------------------
-- Verify (read-only).
-- ---------------------------------------------------------------------------
select id from schema_migrations order by id;

select h.name, m.name as default_cook
  from households h left join members m on m.id = h.default_cook_id;

select indexname from pg_indexes where tablename = 'todos' and indexname = 'todos_parent_uniq';
