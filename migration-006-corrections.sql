-- ============================================================================
-- 006 — Correcting what you just sent, and asking which half of the day
--
-- WHY
--   Two gaps showed up the moment real sentences went through the number.
--
--   1. THE CLOCK. "Practice at 12" is not a time. Plenty of people read 12:00
--      as noon and plenty read it as midnight, and a twelve-hour error looks
--      completely reasonable in a confirmation — it only announces itself
--      when somebody misses the thing. Same for a bare 7 through 11. The
--      parser now refuses to guess and hands the question up, which needs a
--      third kind of pending question.
--
--   2. THE CORRECTION. Nobody proofreads a text before sending it. They send
--      it, read the confirmation, and go "no, four". That reply names no
--      event, so there has to be a record of what each person last touched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. A third question the number is allowed to ask.
-- ---------------------------------------------------------------------------
alter table sms_pending drop constraint if exists sms_pending_kind_check;
alter table sms_pending add  constraint sms_pending_kind_check
  check (kind in ('confirm_date','edit_scope','confirm_time'));

-- ---------------------------------------------------------------------------
-- 2. What each person last touched.
--
--    One row per person, newest wins — "that" always means the most recent
--    thing, the same way it does out loud. On delete cascade, so a removed
--    event cannot leave a correction pointing at nothing.
--
--    This is memory, not history. The audit trail lives in events.created_by
--    and the reminders table; nothing here is worth keeping once it has been
--    superseded.
-- ---------------------------------------------------------------------------
create table if not exists sms_last_action (
  member_id       uuid primary key references members(id)    on delete cascade,
  household_id    uuid not null      references households(id) on delete cascade,
  event_id        uuid               references events(id)   on delete cascade,
  action          text not null check (action in ('create','edit')),
  occurrence_date date,
  created_at      timestamptz not null default now()
);

create index if not exists sms_last_action_event_idx on sms_last_action (event_id);

alter table sms_last_action enable row level security;
drop policy if exists sms_last_action_all on sms_last_action;
create policy sms_last_action_all on sms_last_action for all using (true) with check (true);

comment on table sms_last_action is
  'The last event each person created or changed by text, so their next '
  'message can correct it without naming it again. One row per person.';

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
select 'sms_last_action' as table_name, count(*)::text as rows from sms_last_action
union all
select 'sms_pending kinds', string_agg(v, ', ')
from (select unnest(array['confirm_date','edit_scope','confirm_time']) as v) k;
