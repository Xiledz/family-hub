-- ============================================================================
-- 014 — Todos, and three things the 012/013 verify grids exposed.
--
-- THE FEATURE
--   A list per person. Some things are scheduled, some just need to get done,
--   some repeat. One row is one thing one person owes. Two people responsible
--   for different portions is two rows sharing a batch — not a subtask tree,
--   because "who do I nag" has to have exactly one answer.
--
--   Shared-with-one-check is assignee_id NULL: it belongs to the house, and
--   whoever gets to it first closes it.
--
-- WHAT THE VERIFY GRIDS SHOWED
--   1. Three orphan reminders for "Planning committee" with member_id NULL,
--      written at 3:10am on Aug 26, Sep 1 and Sep 8 by the OLD materializer
--      (003's, before 011 replaced it). They duplicate the correct per-person
--      rows 012 created, and they belong to nobody, so the dispatcher cannot
--      route them anywhere. The current materializer cannot produce them
--      again — it requires c.member_id is not null — so this is cleanup, not
--      a guard.
--
--   2. resync_reminders() still hardcodes 9am for all-day events while 012
--      introduced households.all_day_reminder_at at 8:30. Editing an all-day
--      event silently moved its reminder half an hour. One clock, not two.
--
--   3. Migration 007 has no detectable column, so 013's backfill missed it.
--      Recorded by hand.
--
-- SAFE TO RE-RUN.
-- ============================================================================

begin;

insert into schema_migrations (id) values ('007-pickup-end-time') on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 1. Cleanup: the orphans.
-- ---------------------------------------------------------------------------
delete from reminders r
 where r.sent_at is null
   and r.member_id is null
   and exists (select 1 from reminders o
                where o.event_id = r.event_id
                  and o.occurrence_date is not distinct from r.occurrence_date
                  and o.member_id is not null
                  and o.sent_at is null);

-- ---------------------------------------------------------------------------
-- 2. One all-day clock, shared with the materializer.
-- ---------------------------------------------------------------------------
create or replace function resync_reminders()
returns trigger
language plpgsql
as $$
declare
  tz  text;
  adr time;
begin
  select timezone, all_day_reminder_at into tz, adr
    from households where id = new.household_id;

  update reminders r
     set fire_at = case
           -- All-day: the household's all-day hour, not a number hidden here.
           when new.all_day
             then ((new.event_date + adr) at time zone tz)

           -- Whoever collects is timed off the end, when there is one.
           when new.ends_at is not null and exists (
                  select 1 from event_people ep
                   where ep.event_id  = new.id
                     and ep.member_id = r.member_id
                     and ep.role      = 'pickup')
             then new.ends_at - make_interval(mins => r.lead_minutes)

           -- Everyone else: from the start.
           else new.starts_at - make_interval(mins => r.lead_minutes)
         end
   where r.event_id = new.id and r.sent_at is null;

  return new;
end $$;

comment on function resync_reminders is
  'Keeps unsent reminders in step with an edited event. All-day events use '
  'households.all_day_reminder_at so the app and this trigger never disagree.';

-- ---------------------------------------------------------------------------
-- 3. Todos.
--
--    assignee_id NULL means the household: shared, one check finishes it.
--    batch_id groups the rows created together from one sentence, so
--    "Bryce and Addie clean the garage" is two owners, two checkboxes, one
--    thing you said once.
-- ---------------------------------------------------------------------------
create table if not exists todos (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,

  title         text not null check (length(btrim(title)) > 0),
  note          text,

  assignee_id   uuid references members(id) on delete cascade,
  assigned_by   uuid references members(id) on delete set null,
  batch_id      uuid,

  -- Hand-ranked. Erich chose drag-to-reorder over priority levels: a level
  -- is a field nobody fills in, and once half the list is unset the sort
  -- stops meaning anything. Sparse (double precision) so a drag between two
  -- rows is one write, not a renumber of the whole list.
  --
  -- NOT named "position": that is reserved in a RETURNS TABLE signature, and
  -- sort_order is what members and stores already call the same idea.
  sort_order    double precision not null default 0,

  due_on        date,
  remind        boolean not null default true,

  -- Same vocabulary as events, deliberately. describeRepeat() in recur.js
  -- and the parser's repeat output both work unchanged.
  repeat_freq     text check (repeat_freq in ('daily','weekly','monthly','yearly')),
  repeat_interval int  not null default 1 check (repeat_interval between 1 and 52),
  repeat_days     int[] not null default '{}',
  repeat_until    date,
  -- The live row IS the instance. Completing a repeating todo spawns the
  -- next one; nothing is materialized ahead. Trash missed for three weeks is
  -- one overdue trash, not three.
  parent_id     uuid references todos(id) on delete set null,

  completed_at  timestamptz,
  completed_by  uuid references members(id) on delete set null,

  -- Nag bookkeeping. Reset whenever the due date moves, by trigger below.
  nag_count     int not null default 0,
  last_nagged_at timestamptz,

  source        text not null default 'app',
  created_by    uuid references members(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  cleared_at    timestamptz,          -- bulk "clear done", recoverable
  deleted_at    timestamptz
);

create index if not exists todos_open_idx
  on todos (household_id, assignee_id, sort_order)
  where completed_at is null and deleted_at is null and cleared_at is null;

create index if not exists todos_due_idx
  on todos (due_on)
  where completed_at is null and deleted_at is null and remind;

comment on table todos is
  'One row is one thing one person owes. assignee_id NULL means the whole '
  'house and anyone can close it. Two people owing different portions of the '
  'same job is two rows sharing batch_id.';

-- The reminders FK 013 could not add, because this table did not exist yet.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'reminders_todo_id_fkey') then
    alter table reminders
      add constraint reminders_todo_id_fkey
      foreign key (todo_id) references todos(id) on delete cascade;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Moving the due date resets the nagging.
--
--    This is what makes "later" and "tomorrow" work as a snooze without a
--    snooze table: push the date, and the counter starts over.
-- ---------------------------------------------------------------------------
create or replace function todos_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  if new.due_on is distinct from old.due_on then
    new.nag_count = 0;
    new.last_nagged_at = null;
  end if;
  return new;
end $$;

drop trigger if exists todos_touch_trg on todos;
create trigger todos_touch_trg before update on todos
  for each row execute function todos_touch();

-- ---------------------------------------------------------------------------
-- 5. Completing a repeating todo spawns the next one.
--
--    Counted from the DUE DATE, not from when it was finished: Tuesday is
--    Tuesday whether or not last Tuesday's got done. (A per-todo "count from
--    when I finished" is a repeat_from column, the day something needs it.)
-- ---------------------------------------------------------------------------
create or replace function todo_next_due(p_from date, p_freq text, p_interval int, p_days int[])
returns date
language plpgsql immutable as $$
declare d date;
begin
  if p_freq is null then return null; end if;

  if p_freq = 'weekly' and array_length(p_days, 1) is not null then
    -- Next listed weekday after p_from. dow: 0=Sunday, matching repeat_days.
    d := p_from + 1;
    for _i in 1..7 loop
      if extract(dow from d)::int = any (p_days) then
        -- "Every other Tuesday" is the Tuesday after next, not the next one.
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

create or replace function todos_spawn_next()
returns trigger
language plpgsql
as $$
declare nxt date;
begin
  if new.completed_at is null or old.completed_at is not null then return new; end if;
  if new.repeat_freq is null then return new; end if;

  nxt := todo_next_due(coalesce(new.due_on, current_date),
                       new.repeat_freq, new.repeat_interval, new.repeat_days);

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

drop trigger if exists todos_spawn_next_trg on todos;
create trigger todos_spawn_next_trg after update on todos
  for each row execute function todos_spawn_next();

-- ---------------------------------------------------------------------------
-- 6. What one person owes, for the list and for the digest.
-- ---------------------------------------------------------------------------
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
   order by (t.due_on is null), t.due_on, t.sort_order, t.created_at;
$$;

comment on function member_todos is
  'One person''s open list: their own plus anything shared with the house. '
  'Dated things first, then hand-ranked order.';

insert into schema_migrations (id) values ('014-todos') on conflict do nothing;

commit;

-- ---------------------------------------------------------------------------
-- Verify.
-- ---------------------------------------------------------------------------
select id from schema_migrations order by id;

select count(*) filter (where member_id is null) as orphans_left,
       count(*)                                  as unsent_total
  from reminders where sent_at is null;

-- Should be exactly the columns the app expects, and zero rows.
select count(*) as todos from todos;
