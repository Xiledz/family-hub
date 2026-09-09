-- ============================================================================
-- 008 — Aliases, and Jess
--
-- WHY
--   A nine-year-old texts "mom is driving", not "Jess is driving". The parser
--   resolves every name against the real member list, which is what keeps junk
--   out of the database — but it means an unrecognised name is not an error,
--   it is a role silently dropped. The event still saves. Nobody is told the
--   ride never got recorded.
--
--   Aliases close that gap without loosening the rule: every alias resolves to
--   exactly one canonical member, and the database still only ever stores the
--   canonical name.
-- ============================================================================

alter table members add column if not exists aliases text[] not null default '{}';

comment on column members.aliases is
  'Other things this person gets called in a text — "mom", "dad", a nickname, '
  'a full first name when the short one is canonical. Resolved to name on '
  'parse; never stored on an event.';

-- ---------------------------------------------------------------------------
-- Jess
-- Canonical name is the short one, because that is what gets typed.
-- ---------------------------------------------------------------------------
insert into members (household_id, name, color, role, phone, default_lead_minutes,
                     sort_order, aliases)
select h.id, 'Jess', '#c2185b', 'adult', '+12817948842', 30, 1,
       array['mom','mommy','mama','momma','jessica','jess']
from households h
where not exists (
  select 1 from members m
   where m.household_id = h.id and m.name = 'Jess' and m.deleted_at is null
);

update members
   set phone   = '+12817948842',
       aliases = array['mom','mommy','mama','momma','jessica','jess']
 where name = 'Jess' and deleted_at is null;

-- ---------------------------------------------------------------------------
-- Erich — so the kids can say "dad"
-- ---------------------------------------------------------------------------
update members
   set aliases = array['dad','daddy','papa','pop','erich']
 where name = 'Erich' and deleted_at is null;

-- ---------------------------------------------------------------------------
-- Verify. Check the phones are on the right rows before texting anyone.
-- ---------------------------------------------------------------------------
select name, phone, role, sort_order, aliases
  from members
 where deleted_at is null
 order by sort_order, name;
