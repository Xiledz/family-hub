-- ============================================================================
-- 027 VERIFY — run after migration-027-headcount.sql. Ends in rollback.
-- ============================================================================
begin;

do $$
declare hh uuid := '00000000-0000-0000-0000-000000000001'; tz text;
        erich uuid; jess uuid; addie uuid; bryce uuid; d date; ev uuid; mid uuid; n int; r record;
begin
  select timezone into tz from households where id = hh;
  select id into erich from members where household_id = hh and name = 'Erich' and deleted_at is null;
  select id into jess  from members where household_id = hh and name = 'Jess'  and deleted_at is null;
  select id into addie from members where household_id = hh and name = 'Addie' and deleted_at is null;
  select id into bryce from members where household_id = hh and name = 'Bryce' and deleted_at is null;
  d := current_date + 20;
  update households set default_dinner_at = '18:00' where id = hh;

  -- 0: nothing on the calendar: everyone home, count 4
  select count(*) into n from home_for_dinner(hh, d) where home;
  if n <> 4 then raise exception 'FAIL 0: expected 4 home on an empty day, got %', n; end if;
  if dinner_headcount(hh, d) <> 4 then raise exception 'FAIL 0b: headcount %', dinner_headcount(hh, d); end if;

  -- 1: Addie at church 6:30–7:30 (Jess driving): both out
  insert into events (household_id, title, event_date, all_day, starts_at, ends_at, created_by, member_id)
  values (hh, 'Church', d, false, (d::timestamp + time '18:30') at time zone tz, (d::timestamp + time '19:30') at time zone tz, erich, addie)
  returning id into ev;
  insert into event_people (household_id, event_id, member_id, role) values (hh, ev, addie, 'going'), (hh, ev, jess, 'driving');
  select home, why into r from home_for_dinner(hh, d) where member_id = addie;
  if r.home then raise exception 'FAIL 1: Addie counted home during church'; end if;
  if r.why <> 'at Church 6:30' then raise exception 'FAIL 1b: why = "%"', r.why; end if;
  select home into r from home_for_dinner(hh, d) where member_id = jess;
  if r.home then raise exception 'FAIL 1c: the driver counted home'; end if;
  if dinner_headcount(hh, d) <> 2 then raise exception 'FAIL 1d: headcount %', dinner_headcount(hh, d); end if;

  -- 2: a morning event does not empty the table
  insert into events (household_id, title, event_date, all_day, starts_at, ends_at, created_by, member_id)
  values (hh, 'Dentist', d, false, (d::timestamp + time '09:00') at time zone tz, (d::timestamp + time '10:00') at time zone tz, erich, bryce);
  select home into r from home_for_dinner(hh, d) where member_id = bryce;
  if not r.home then raise exception 'FAIL 2: a 9am dentist counted Bryce out of dinner'; end if;

  -- 3: an all-day event never counts
  insert into events (household_id, title, event_date, all_day, created_by, member_id)
  values (hh, 'Teacher workday', d, true, erich, bryce);
  select home into r from home_for_dinner(hh, d) where member_id = bryce;
  if not r.home then raise exception 'FAIL 3: an all-day event counted Bryce out'; end if;

  -- 4: away is out; sick is home
  insert into member_absences (household_id, member_id, kind, from_date, to_date, created_by)
  values (hh, erich, 'away', d, d, erich);
  select home, why into r from home_for_dinner(hh, d) where member_id = erich;
  if r.home or r.why <> 'away' then raise exception 'FAIL 4: away Erich counted home (%)', r.why; end if;
  insert into member_absences (household_id, member_id, kind, from_date, to_date, created_by)
  values (hh, bryce, 'sick', d, d, jess);
  select home into r from home_for_dinner(hh, d) where member_id = bryce;
  if not r.home then raise exception 'FAIL 4b: sick Bryce counted out'; end if;
  if dinner_headcount(hh, d) <> 1 then raise exception 'FAIL 4c: headcount % (expected 1: Bryce)', dinner_headcount(hh, d); end if;

  -- 5: the meal's own ready_by moves the window — dinner at 5:00 is over before church
  insert into meal_plan (household_id, plan_date, freeform, ready_by, created_by)
  values (hh, d, 'Tacos', '17:00', erich) returning id into mid;
  select home into r from home_for_dinner(hh, d) where member_id = addie;
  if not r.home then raise exception 'FAIL 5: with dinner at 5:00, 6:30 church still counted Addie out'; end if;
  if dinner_headcount(hh, d) <> 3 then raise exception 'FAIL 5b: headcount % (expected 3)', dinner_headcount(hh, d); end if;

  -- 6: a stated headcount wins
  update meal_plan set headcount_override = 6 where id = mid;
  if dinner_headcount(hh, d) <> 6 then raise exception 'FAIL 6: override ignored'; end if;
  begin
    update meal_plan set headcount_override = 0 where id = mid;
    raise exception 'FAIL 6b: headcount 0 was allowed';
  exception when check_violation then null;
  end;
  -- 6c: servings are what scale ingredients; the headcount is only a default, never a second factor
  update meal_plan set headcount_override = 6, servings = 6 where id = mid;
  -- (no recipe on this meal: meal_ingredients returns nothing — scaling is by servings alone, unchanged from 018)
  select count(*) into n from meal_ingredients(mid);
  if n <> 0 then raise exception 'FAIL 6c: freeform meal produced ingredients'; end if;
end $$;

-- 7: THE APP PATH — anon reads the count and writes the override
set local role anon;
do $$
declare hh uuid := '00000000-0000-0000-0000-000000000001'; n int;
begin
  n := dinner_headcount(hh, current_date + 20);
  if n is null then raise exception 'FAIL 7: anon cannot read dinner_headcount'; end if;
  update meal_plan set headcount_override = 5 where household_id = hh and plan_date = current_date + 20;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 7b: anon cannot write headcount_override'; end if;
  select count(*) into n from home_for_dinner(hh, current_date + 20);
  if n <> 4 then raise exception 'FAIL 7c: anon home_for_dinner returned % rows', n; end if;
end $$;
reset role;

select 'all 027 behaviour checks passed' as result;
rollback;
