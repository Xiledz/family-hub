-- ============================================================================
-- 013 — Delivery: who a message goes to, how, and whether it arrived.
--
-- WHY
--   Four problems, all in the same place, all found by querying the live
--   database rather than reading the code and believing it.
--
--   1. reminders.event_id is NOT NULL. The brief promises that anything
--      needing an alert can insert a reminders row and the dispatcher needs
--      no changes. That has never been true for anything that is not an
--      event, and todos are about to need it.
--
--   2. channel is decided when the reminder is WRITTEN, in two different
--      places, by counting push_subscriptions weeks ahead of time. Bryce has
--      five reminders stamped 'push'. There has never been a push
--      subscription for anybody. Those five will fail on the day, for a fact
--      that was already knowable when they were written. A channel is not a
--      property of a reminder; it is a property of the moment you try to send
--      it.
--
--   3. A kid with no phone has no route at all. That is not an error case in
--      a family app, it is Tuesday. Bryce needs to point at Jess.
--
--   4. Nothing records what actually happened. "Did Bryce get told?" is
--      currently unanswerable.
--
--   Also: migration 008 was written and never run, and nothing noticed for
--   three weeks. "Never infer deploy state" was a rule for edge functions.
--   It should have been a rule for SQL too. This adds the stamp.
--
-- ORDERING NOTE
--   This migration leaves every EXISTING reminder's channel intact, so the
--   current dispatcher keeps working if it runs before the new one ships.
--   Only newly materialized rows get a NULL channel, and the new dispatcher
--   treats NULL as "decide now".
--
-- SAFE TO RE-RUN.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. The stamp. So "did 013 run?" is a query, not a guess.
-- ---------------------------------------------------------------------------
create table if not exists schema_migrations (
  id          text primary key,
  applied_at  timestamptz not null default now()
);

comment on table schema_migrations is
  'One row per migration file that has actually been applied. Migration 008 '
  'was written, committed, and never run; nothing noticed until someone '
  'queried information_schema by hand three weeks later.';

-- Backfill what we can prove ran, by looking for what each one created.
insert into schema_migrations (id) values ('001-base') on conflict do nothing;
insert into schema_migrations (id)
select v.id from (values
    ('002-recurrence',      'events',            'repeat_freq'),
    ('003-materializer',    'reminders',         'occurrence_date'),
    ('004-event-people',    'event_people',      'role'),
    ('005-sms-pending',     'sms_pending',       'kind'),
    ('006-corrections',     'sms_last_action',   'action'),
    ('008-aliases',         'members',           'aliases'),
    ('009-shopping',        'shopping_items',    'name'),
    ('010-shopping-detail', 'shopping_items',    'pick_yourself'),
    ('011-stores-digest',   'stores',            'flyer_group'),
    ('012-cast-fallback',   'households',        'all_day_reminder_at')
  ) as v(id, tbl, col)
 where exists (select 1 from information_schema.columns c
                where c.table_schema = 'public'
                  and c.table_name  = v.tbl
                  and c.column_name = v.col)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 1. A reminder can point at an event OR a todo — exactly one.
--
--    todo_id has no foreign key yet; the todos table does not exist. 014
--    adds the constraint. The XOR check is what actually protects the row.
-- ---------------------------------------------------------------------------
alter table reminders alter column event_id drop not null;
alter table reminders add column if not exists todo_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'reminders_one_subject') then
    alter table reminders add constraint reminders_one_subject
      check (num_nonnulls(event_id, todo_id) = 1);
  end if;
end $$;

comment on column reminders.todo_id is
  'Set instead of event_id when this reminder is about a todo. Exactly one of '
  'the two is always set; the dispatcher phrases the message by which.';

-- The existing unique index covers (event_id, occurrence_date, member). A
-- todo reminder has event_id NULL, and NULL is distinct from NULL in a unique
-- index, so it would not dedup at all. It needs its own.
create unique index if not exists reminders_unique_todo_occurrence
  on reminders (todo_id, occurrence_date, coalesce(member_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where todo_id is not null and occurrence_date is not null;

-- ---------------------------------------------------------------------------
-- 2. channel stops being an instruction and becomes a record.
--
--    NULL now means "nobody has tried yet". The sender writes the channel it
--    actually used, at the moment it used it.
-- ---------------------------------------------------------------------------
alter table reminders alter column channel drop not null;

comment on column reminders.channel is
  'What was ACTUALLY used to send this, written at send time. NULL means not '
  'yet attempted. Do not write this when creating a reminder — a channel '
  'chosen weeks ahead is a guess about a phone that may not exist yet.';

-- ---------------------------------------------------------------------------
-- 3. The guardian chain. A person with no device and no phone still has to
--    be reachable, through somebody.
-- ---------------------------------------------------------------------------
alter table members add column if not exists notify_via_member_id uuid
  references members(id) on delete set null;

comment on column members.notify_via_member_id is
  'Who receives this person''s alerts when they have no device and no phone '
  'of their own. The message is prefixed with their name so the recipient '
  'knows it is not about them.';

do $$
declare
  guardian uuid;
begin
  select id into guardian from members
   where name = 'Jess' and deleted_at is null limit 1;

  if guardian is not null then
    update members
       set notify_via_member_id = guardian
     where deleted_at is null
       and notify_via_member_id is null
       and id <> guardian
       and (phone is null or phone = '')
       and not exists (select 1 from push_subscriptions ps where ps.member_id = members.id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. What actually happened.
--
--    Not a debug log — the source of truth for "was Bryce told?", and the
--    thing the todo nag counter reads so it never pings twice for one day.
-- ---------------------------------------------------------------------------
create table if not exists deliveries (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  member_id     uuid references members(id) on delete set null,
  -- who it was really about, when it went to a guardian instead
  on_behalf_of  uuid references members(id) on delete set null,
  kind          text not null check (kind in ('reminder','digest','nag','reply','welcome')),
  ref_id        uuid,
  channel       reminder_channel,
  ok            boolean not null,
  detail        text,
  sent_at       timestamptz not null default now()
);

create index if not exists deliveries_member_idx on deliveries (member_id, sent_at desc);
create index if not exists deliveries_ref_idx    on deliveries (ref_id, sent_at desc);

comment on table deliveries is
  'Every attempt to reach somebody, successful or not. One row per attempt, '
  'not per message: a push that failed and an SMS that worked are two rows.';

-- ---------------------------------------------------------------------------
-- 5. The materializer stops guessing a channel.
--
--    Identical to 012 in every other respect. Only the channel expression
--    changes, from a subquery against push_subscriptions to NULL.
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
    null::reminder_channel,          -- decided at send time, not now
    case
      when o.all_day or o.starts_at is null
        then ((sel.d + hh.all_day_reminder_at) at time zone hh.timezone)
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
  on conflict do nothing;

  get diagnostics n = row_count;
  return n;
end $$;

comment on function materialize_series_reminders is
  'One reminder per cast member per occurrence. Timed events count back from '
  'the start (or the end, for a pickup); all-day events fire at the household '
  'all-day hour. Channel is left NULL deliberately. Idempotent.';

-- ---------------------------------------------------------------------------
-- 6. The five dead ones.
--
--    Bryce's reminders were stamped 'push' at write time against a
--    subscription table that has never had a row in it. They are still
--    unsent and still in the future, so clearing the stamp is enough — the
--    new dispatcher will route them through the guardian chain.
-- ---------------------------------------------------------------------------
update reminders r
   set channel = null
 where r.sent_at is null
   and r.channel = 'push'
   and not exists (select 1 from push_subscriptions ps where ps.member_id = r.member_id);

insert into schema_migrations (id) values ('013-delivery') on conflict do nothing;

commit;

-- ---------------------------------------------------------------------------
-- Verify.
-- ---------------------------------------------------------------------------
select id, applied_at from schema_migrations order by id;

select m.name,
       m.phone is not null                              as has_phone,
       (select count(*) from push_subscriptions ps
         where ps.member_id = m.id)                     as devices,
       (select g.name from members g
         where g.id = m.notify_via_member_id)           as alerts_go_to
  from members m
 where m.deleted_at is null
 order by m.sort_order, m.name;

select coalesce(channel::text, '(decide at send)') as channel,
       count(*)                                    as unsent
  from reminders where sent_at is null
 group by 1 order by 1;
