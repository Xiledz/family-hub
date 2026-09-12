-- ============================================================================
-- 028 VERIFY — run after migration-028-sunday-plan.sql. Ends in rollback.
-- ============================================================================
begin;

do $$
declare cmd text; hh uuid := '00000000-0000-0000-0000-000000000001'; tz text;
        erich uuid; addie uuid; d date; ev uuid; r uuid; mid uuid; before timestamptz; after timestamptz; n int;
begin
  -- 1: the cron job, on Sundays, carrying the digest's own header and the sunday body
  select command into cmd from cron.job where jobname = 'sunday-plan';
  if cmd is null then raise exception 'FAIL 1: sunday-plan not scheduled'; end if;
  if position('x-digest-secret' in cmd) = 0 then raise exception 'FAIL 1b: no secret header'; end if;
  if position('"mode":"sunday"' in cmd) = 0 then raise exception 'FAIL 1c: body is not {"mode":"sunday"}'; end if;
  if (select schedule from cron.job where jobname = 'sunday-plan') <> '0 15-17 * * 0' then
    raise exception 'FAIL 1d: schedule is %', (select schedule from cron.job where jobname = 'sunday-plan'); end if;

  -- 2: nudge_log takes the new kind, once per day
  insert into nudge_log (kind, for_date, member_id)
  select 'sunday', current_date, id from members where household_id = hh and name = 'Jess';
  begin
    insert into nudge_log (kind, for_date, member_id)
    select 'sunday', current_date, id from members where household_id = hh and name = 'Jess';
    raise exception 'FAIL 2: a second sunday nudge for the day was allowed';
  exception when unique_violation then null;
  end;

  -- 3: anchoring a meal moves its countdown (meal_resync on ready_by)
  select timezone into tz from households where id = hh;
  select id into erich from members where household_id = hh and name = 'Erich' and deleted_at is null;
  select id into addie from members where household_id = hh and name = 'Addie' and deleted_at is null;
  d := current_date + 15;
  insert into events (household_id, title, event_date, all_day, starts_at, created_by, member_id)
  values (hh, 'probe church', d, false, (d::timestamp + time '18:30') at time zone tz, erich, addie) returning id into ev;
  insert into recipes (household_id, name, servings, cook_minutes, created_by) values (hh, 'probe tacos', 4, 30, erich) returning id into r;
  insert into recipe_steps (recipe_id, label, minutes_before_cook, sort_order) values (r, 'Take the beef out', 60, 1);
  insert into meal_plan (household_id, plan_date, recipe_id, servings, ready_by, cook_id, created_by)
  values (hh, d, r, 4, '18:00', erich, erich) returning id into mid;
  select fire_at into before from reminders where meal_id = mid and label = 'Take the beef out';
  if before is null then raise exception 'FAIL 3: no countdown to start with'; end if;

  -- the Plan sheet's anchor write: 6:30 church → out the door 6:15 → on the table 5:55
  update meal_plan set anchor_event_id = ev, anchor_date = d, leave_minutes = 15, eat_minutes = 20, ready_by = '17:55'
   where id = mid;
  select fire_at into after from reminders where meal_id = mid and label = 'Take the beef out';
  if after is null then raise exception 'FAIL 3b: countdown vanished on anchor'; end if;
  if after <> before - interval '5 minutes' then
    raise exception 'FAIL 3c: thaw moved from % to %, expected 5 minutes earlier', before, after; end if;
  select count(*) into n from reminders where meal_id = mid and sent_at is null;
  if n <> 2 then raise exception 'FAIL 3d: countdown has % rows after anchor, expected 2', n; end if;

  -- 3e: with ready_by cleared, meal_cook_start falls back to the anchor − leave_minutes (018)
  update meal_plan set ready_by = null where id = mid;
  select fire_at into after from reminders where meal_id = mid and label = 'Take the beef out';
  if after <> ((d::timestamp + time '18:15') at time zone tz) - interval '30 minutes' - interval '60 minutes' then
    raise exception 'FAIL 3e: anchor fallback gave %', after; end if;
end $$;

select 'all 028 behaviour checks passed' as result;
rollback;
