-- ============================================================================
-- 029 VERIFY — run after migration-029-meal-week.sql. Ends in rollback.
-- ============================================================================
begin;

do $$
declare hh uuid := '00000000-0000-0000-0000-000000000001'; tz text;
        erich uuid; addie uuid; d date; ev uuid; r uuid; a uuid; b uuid; c uuid; bumped uuid; n int; w date; t timestamptz;
begin
  select timezone into tz from households where id = hh;
  select id into erich from members where household_id = hh and name = 'Erich' and deleted_at is null;
  select id into addie from members where household_id = hh and name = 'Addie' and deleted_at is null;

  -- 1: existing rows got a week_start
  select count(*) into n from meal_plan where deleted_at is null and week_start is null;
  if n <> 0 then raise exception 'FAIL 1: % meals without week_start', n; end if;

  -- 2: an undated meal is allowed and gets this week
  insert into meal_plan (household_id, plan_date, freeform, created_by) values (hh, null, 'probe tray meal', erich) returning id into a;
  select week_start into w from meal_plan where id = a;
  if w <> current_date - extract(dow from current_date)::int then raise exception 'FAIL 2: tray meal week_start = %', w; end if;
  if extract(dow from w) <> 0 then raise exception 'FAIL 2b: week_start is not a Sunday'; end if;

  -- 3: two undated meals in one week do not collide; two dated on one day still do
  insert into meal_plan (household_id, plan_date, freeform, created_by) values (hh, null, 'probe tray meal 2', erich) returning id into b;
  d := current_date + 30;                                  -- a Tuesday-ish far ahead, whatever it is
  insert into meal_plan (household_id, plan_date, freeform, created_by) values (hh, d, 'probe day meal', erich) returning id into c;
  begin
    insert into meal_plan (household_id, plan_date, freeform, created_by) values (hh, d, 'probe collision', erich);
    raise exception 'FAIL 3: two dinners on one day were allowed';
  exception when unique_violation then null;
  end;

  -- 4: meal_move onto an occupied day bumps the occupant into the tray, same week
  bumped := meal_move(a, d);
  if bumped <> c then raise exception 'FAIL 4: bumped % expected %', bumped, c; end if;
  if (select plan_date from meal_plan where id = a) <> d then raise exception 'FAIL 4b: meal did not move'; end if;
  if (select plan_date from meal_plan where id = c) is not null then raise exception 'FAIL 4c: occupant still on the day'; end if;
  if (select week_start from meal_plan where id = c) <> d - extract(dow from d)::int then raise exception 'FAIL 4d: bumped meal left its week'; end if;
  if (select deleted_at from meal_plan where id = c) is not null then raise exception 'FAIL 4e: bumped meal was deleted'; end if;
  if (select week_start from meal_plan where id = a) <> d - extract(dow from d)::int then raise exception 'FAIL 4f: moved meal week_start not updated'; end if;

  -- 5: moving to an empty day bumps nothing; moving to its own day is a no-op
  bumped := meal_move(b, d + 1);
  if bumped is not null then raise exception 'FAIL 5: bumped % on an empty day', bumped; end if;
  if meal_move(b, d + 1) is not null then raise exception 'FAIL 5b: self-move bumped something'; end if;

  -- 6: swap exchanges two days in one call
  perform meal_swap(a, b);
  if (select plan_date from meal_plan where id = a) <> d + 1 or (select plan_date from meal_plan where id = b) <> d then
    raise exception 'FAIL 6: swap did not exchange the days'; end if;
  perform meal_swap(a, c);                                 -- with an undated one: a goes to the tray, c takes a's day
  if (select plan_date from meal_plan where id = a) is not null or (select plan_date from meal_plan where id = c) <> d + 1 then
    raise exception 'FAIL 6b: swap with a tray meal'; end if;

  -- 7: the countdown follows the day, and disappears in the tray
  insert into events (household_id, title, event_date, all_day, starts_at, created_by, member_id)
  values (hh, 'probe church', d + 2, false, ((d + 2)::timestamp + time '18:30') at time zone tz, erich, addie) returning id into ev;
  insert into recipes (household_id, name, servings, cook_minutes, created_by) values (hh, 'probe enchiladas', 4, 30, erich) returning id into r;
  insert into recipe_steps (recipe_id, label, minutes_before_cook, sort_order) values (r, 'Take the beef out', 60, 1);
  update meal_plan set recipe_id = r, freeform = null, cook_id = erich, ready_by = '18:00',
                       plan_date = d + 2, anchor_event_id = ev, anchor_date = d + 2 where id = b;
  select fire_at into t from reminders where meal_id = b and label = 'Take the beef out' and sent_at is null;
  if t is null then raise exception 'FAIL 7: no countdown on the dated meal'; end if;
  perform meal_move(b, d + 3);
  if (select fire_at from reminders where meal_id = b and label = 'Take the beef out' and sent_at is null) <> t + interval '1 day' then
    raise exception 'FAIL 7b: countdown did not follow the move'; end if;
  if (select anchor_event_id from meal_plan where id = b) is not null then raise exception 'FAIL 7c: anchor survived a move off its day'; end if;
  perform meal_unschedule(b);
  select count(*) into n from reminders where meal_id = b and sent_at is null;
  if n <> 0 then raise exception 'FAIL 7d: % countdown rows on a tray meal', n; end if;
  if (select plan_date from meal_plan where id = b) is not null then raise exception 'FAIL 7e: unschedule left a date'; end if;
  perform meal_move(b, d + 4);
  select count(*) into n from reminders where meal_id = b and sent_at is null;
  if n < 1 then raise exception 'FAIL 7f: countdown not rebuilt when the meal got a day again'; end if;

  -- 8: dinner_headcount / home_for_dinner still key on the day (undated meals are invisible to them)
  n := dinner_headcount(hh, d + 4);
  if n is null then raise exception 'FAIL 8: dinner_headcount broke'; end if;
end $$;

-- 9: THE APP PATH — anon can move, swap and unschedule, and insert an undated meal
set local role anon;
do $$
declare hh uuid := '00000000-0000-0000-0000-000000000001'; a uuid; b uuid; d date := current_date + 40; x uuid;
begin
  insert into meal_plan (household_id, plan_date, freeform) values (hh, null, 'anon tray') returning id into a;
  insert into meal_plan (household_id, plan_date, freeform) values (hh, d, 'anon day') returning id into b;
  x := meal_move(a, d);
  if x <> b then raise exception 'FAIL 9: anon meal_move bumped % not %', x, b; end if;
  perform meal_swap(a, b);
  if (select plan_date from meal_plan where id = b) <> d then raise exception 'FAIL 9b: anon swap'; end if;
  perform meal_unschedule(b);
  if (select plan_date from meal_plan where id = b) is not null then raise exception 'FAIL 9c: anon unschedule'; end if;
  if (select count(*) from meal_plan where household_id = hh and plan_date is null and deleted_at is null) < 2 then
    raise exception 'FAIL 9d: anon cannot read the tray'; end if;
end $$;
reset role;

select 'all 029 behaviour checks passed' as result;
rollback;
