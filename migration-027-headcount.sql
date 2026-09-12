-- ============================================================================
-- 027 — Who's home tonight → headcount → servings.
--
-- WHY
--   "Addie's at church, 3 for dinner" is a fact the calendar already holds.
--   Nobody should type a number the app can see: anyone on the cast of an
--   occurrence that overlaps dinner is out; anyone away is out; a sick kid is
--   home. The count is the default servings when a dinner is planned, and a
--   stated headcount (by text or on the sheet) overrides it.
--
-- THE DINNER WINDOW
--   The meal's ready_by for that date, else the household default dinner
--   time, ± 45 minutes, in the household's zone. A timed occurrence counts
--   when it overlaps the window; an all-day event never does (a teacher
--   workday does not empty the table). "optional" is not a commitment.
--
-- SAFE TO RE-RUN.
-- ============================================================================

begin;

alter table meal_plan add column if not exists headcount_override int
  check (headcount_override is null or headcount_override between 1 and 50);

comment on column meal_plan.headcount_override is
  'A stated headcount ("3 for dinner") that beats the calendar''s count. '
  'NULL means derive it.';

create or replace function home_for_dinner(p_household uuid, p_date date)
returns table (member_id uuid, name text, home boolean, why text)
language sql stable security definer set search_path = public as $$
  with hh as (
    select h.timezone, h.default_dinner_at from households h where h.id = p_household
  ),
  win as (
    select ((p_date + coalesce(
              (select m.ready_by from meal_plan m
                where m.household_id = p_household and m.plan_date = p_date and m.slot = 'dinner'
                  and m.deleted_at is null limit 1),
              hh.default_dinner_at)) at time zone hh.timezone) as at,
           hh.timezone as tz
      from hh
  ),
  members_live as (
    select m.id, m.name, m.sort_order from members m
     where m.household_id = p_household and m.deleted_at is null
  ),
  away as (
    select a.member_id from member_absences a
     where a.household_id = p_household and a.deleted_at is null and a.kind = 'away'
       and a.from_date <= p_date and a.to_date >= p_date
  ),
  busy as (
    select distinct on (c.member_id) c.member_id,
           o.title || ' ' || to_char(o.starts_at at time zone w.tz, 'FMHH12:MI') as why
      from occurrences_on(p_date) o
      join events e on e.id = o.event_id and e.household_id = p_household and e.deleted_at is null
      cross join win w
      cross join lateral event_cast(o.event_id) c
     where not o.all_day and o.starts_at is not null
       and c.role in ('going','driving','dropoff','pickup','helping')
       and o.starts_at < w.at + interval '45 minutes'
       and coalesce(o.ends_at, o.starts_at + interval '1 hour') > w.at - interval '45 minutes'
     order by c.member_id, o.starts_at
  )
  select ml.id, ml.name,
         (aw.member_id is null and b.member_id is null) as home,
         case when aw.member_id is not null then 'away'
              when b.member_id is not null then 'at ' || b.why
              else null end as why
    from members_live ml
    left join away aw on aw.member_id = ml.id
    left join busy b  on b.member_id  = ml.id
   order by ml.sort_order, ml.name;
$$;

comment on function home_for_dinner is
  'Who is at the table on a date: not away, not on the cast of a timed '
  'occurrence overlapping the dinner window. Sick counts as home.';

create or replace function dinner_headcount(p_household uuid, p_date date)
returns int language sql stable security definer set search_path = public as $$
  select coalesce(
    (select m.headcount_override from meal_plan m
      where m.household_id = p_household and m.plan_date = p_date and m.slot = 'dinner'
        and m.deleted_at is null limit 1),
    (select count(*)::int from home_for_dinner(p_household, p_date) where home));
$$;

grant execute on function home_for_dinner(uuid, date)  to anon, service_role;
grant execute on function dinner_headcount(uuid, date) to anon, service_role;

insert into schema_migrations (id) values ('027-headcount') on conflict do nothing;

commit;

select name, home, why from home_for_dinner('00000000-0000-0000-0000-000000000001', current_date);
select dinner_headcount('00000000-0000-0000-0000-000000000001', current_date) as tonight;
