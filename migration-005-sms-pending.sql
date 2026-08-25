-- ============================================================================
-- 005 — Short-lived memory for the text number
--
-- WHY
--   Every inbound text has been independent: parse it, act, forget. That makes
--   two things impossible.
--
--   1. ASKING. "Soccer Monday 6pm" sent on a Monday afternoon is genuinely
--      ambiguous — tonight, or next week? Guessing is wrong half the time, and
--      wrong quietly. To ask, the number has to remember what it asked.
--
--   2. EDITING. "Planning committee moved to Monday at 4" on a weekly series
--      needs to know whether you mean this one occurrence or all of them.
--      Same requirement: hold the question open until you answer.
--
-- SHAPE
--   One open question per person. A new question replaces any earlier one,
--   because a half-answered conversation is worse than none. Everything
--   expires — an unanswered question must not still be waiting tomorrow when
--   you text something unrelated.
-- ============================================================================

create table if not exists sms_pending (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  member_id    uuid not null references members(id)    on delete cascade,

  kind text not null check (kind in ('confirm_date','edit_scope')),

  -- What we need in order to act on the answer. Shape depends on kind:
  --   confirm_date : the whole parsed event, plus the two candidate dates
  --   edit_scope   : the event id, and the change to apply
  payload jsonb not null,

  -- The exact words we sent, so the reply can be matched to the options we
  -- actually offered rather than to what we assume we offered.
  options jsonb not null default '[]'::jsonb,

  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),

  -- One open question per person, always.
  unique (member_id)
);

create index if not exists sms_pending_expiry_idx on sms_pending (expires_at);

alter table sms_pending enable row level security;
drop policy if exists sms_pending_all on sms_pending;
create policy sms_pending_all on sms_pending for all using (true) with check (true);

comment on table sms_pending is
  'One open question per person for the SMS front door. Expires after 15 minutes.';

select 'sms_pending' as table_created, count(*)::text as rows from sms_pending;
