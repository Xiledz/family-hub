-- ============================================================================
-- 004 — Who is involved in an event, and in what capacity
--
-- WHY
--   events.member_id answers "whose event is this" with exactly one name. A
--   family calendar is mostly the other case: Bryce has soccer, Jess drives,
--   Erich collects him afterwards. Squeezing that into one column loses the
--   information that actually matters — and puts the reminder on the kid
--   instead of the parent who has to leave the house.
--
--   events.member_id STAYS. It is the primary person, and it drives the colour
--   on the calendar. This table is the full cast.
--
-- THE CLOSED VOCABULARY
--   role is checked against a fixed list on purpose. Free text here would let
--   "driving", "Driving", "is driving" and "drives" become four different
--   things, and no query could ever ask "what am I driving to this week".
--   The parser's job is to map what a person typed onto one of these.
-- ============================================================================

create table if not exists event_people (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  event_id     uuid not null references events(id)     on delete cascade,
  member_id    uuid not null references members(id)    on delete cascade,

  role text not null default 'going'
    check (role in ('going','driving','dropoff','pickup','helping','optional')),

  -- Overrides members.default_lead_minutes for THIS person on THIS event.
  -- A driver usually wants more warning than a passenger.
  lead_minutes int,

  created_at timestamptz not null default now(),

  -- One row per person per role. Jess can drive AND attend; she cannot be
  -- listed as driving twice.
  unique (event_id, member_id, role)
);

create index if not exists event_people_event_idx  on event_people (event_id);
create index if not exists event_people_member_idx on event_people (member_id);

alter table event_people enable row level security;
drop policy if exists event_people_all on event_people;
create policy event_people_all on event_people for all using (true) with check (true);

do $$ begin
  alter publication supabase_realtime add table event_people;
exception when duplicate_object then null;
end $$;

comment on table  event_people is 'Everyone attached to an event, with their role. events.member_id remains the primary person.';
comment on column event_people.role is 'Closed vocabulary. The parser maps free text onto exactly these values.';
comment on column event_people.lead_minutes is 'Per-person reminder lead for this event. Null = use the member default.';

-- ---------------------------------------------------------------------------
-- Default lead time by role.
--
-- A driver has to leave the house; the passenger only has to be ready. Giving
-- them the same warning means one of them is always wrong.
-- ---------------------------------------------------------------------------
create or replace function role_default_lead(p_role text, p_member_default int)
returns int language sql immutable as $$
  select case p_role
    when 'driving' then greatest(coalesce(p_member_default, 30), 45)
    when 'dropoff' then greatest(coalesce(p_member_default, 30), 45)
    when 'pickup'  then greatest(coalesce(p_member_default, 30), 30)
    else coalesce(p_member_default, 30)
  end;
$$;

-- ---------------------------------------------------------------------------
-- Backfill: every existing event's primary person becomes a 'going' row, so
-- the new table is the single place to ask "who is involved" from day one.
-- ---------------------------------------------------------------------------
insert into event_people (household_id, event_id, member_id, role)
select e.household_id, e.id, e.member_id, 'going'
from events e
where e.member_id is not null
  and e.deleted_at is null
on conflict (event_id, member_id, role) do nothing;
