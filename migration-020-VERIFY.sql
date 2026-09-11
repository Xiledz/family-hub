-- ============================================================================
-- 020 VERIFY — prove the migration BEHAVES, then throw every row away.
-- Run AFTER migration-020-m0-chores-cook.sql (or in the same session as a
-- dry run, before its commit). Ends in `rollback;` — nothing persists.
-- Prints "all 020 behaviour checks passed" or raises the assertion that failed.
-- ============================================================================
begin;

do $$
declare
  hh uuid := '00000000-0000-0000-0000-000000000001';
  tz text; today date;
  erich uuid; jess uuid; bryce uuid;
  r uuid; mid uuid; n int; who uuid;
  t_missed uuid; t_grace uuid; t_daily uuid; kid uuid; kid2 uuid;
  dflt uuid;
begin
  select timezone into tz from households where id = hh;
  today := (now() at time zone tz)::date;
  select id into erich from members where household_id = hh and name = 'Erich' and deleted_at is null;
  select id into jess  from members where household_id = hh and name = 'Jess'  and deleted_at is null;
  select id into bryce from members where household_id = hh and name = 'Bryce' and deleted_at is null;
  if erich is null or jess is null or bryce is null then
    raise exception 'FAIL 0: expected members Erich, Jess, Bryce in household %', hh;
  end if;

  -- 1: the house has a default cook, and it is Jess
  select default_cook_id into dflt from households where id = hh;
  if dflt is null then raise exception 'FAIL 1: households.default_cook_id is null'; end if;
  if dflt <> jess then raise exception 'FAIL 1b: default cook is % not Jess', dflt; end if;

  -- 2: a meal planned by Erich with NO cook goes to the default cook
  insert into recipes (household_id, name, servings, cook_minutes, created_by)
  values (hh, 'probe tacos', 4, 30, erich) returning id into r;
  insert into recipe_steps (recipe_id, label, minutes_before_cook, sort_order)
  values (r, 'Take the beef out to thaw', 60, 1);
  insert into meal_plan (household_id, plan_date, recipe_id, servings, ready_by, cook_id, created_by)
  values (hh, today + 40, r, 4, '18:00', null, erich) returning id into mid;

  select count(*) into n from reminders where meal_id = mid and sent_at is null;
  if n <> 2 then raise exception 'FAIL 2: countdown made % rows, expected 2', n; end if;
  select count(*) into n from reminders where meal_id = mid and member_id <> jess;
  if n <> 0 then raise exception 'FAIL 2b: countdown did not go to the default cook'; end if;

  -- 2c: naming a cook on the meal overrides the default, via the trigger
  update meal_plan set cook_id = erich where id = mid;
  select count(*) into n from reminders where meal_id = mid and sent_at is null and member_id = erich;
  if n <> 2 then raise exception 'FAIL 2c: cook change did not move the countdown (% rows to Erich)', n; end if;

  -- 3: a weekly chore whose next occurrence is TODAY: missed last week
  insert into todos (household_id, title, assignee_id, assigned_by, due_on, remind,
                     repeat_freq, repeat_interval, repeat_days, created_by, source)
  values (hh, 'probe trash', bryce, jess, today - 7, true,
          'weekly', 1, array[extract(dow from today)::int], jess, 'app')
  returning id into t_missed;

  -- 4: a weekly chore missed YESTERDAY: next occurrence is six days out
  insert into todos (household_id, title, assignee_id, assigned_by, due_on, remind,
                     repeat_freq, repeat_interval, repeat_days, created_by, source)
  values (hh, 'probe room', bryce, jess, today - 1, true,
          'weekly', 1, array[extract(dow from today - 1)::int], jess, 'app')
  returning id into t_grace;

  -- 5: a daily chore three days stale
  insert into todos (household_id, title, assignee_id, assigned_by, due_on, remind,
                     repeat_freq, repeat_interval, repeat_days, created_by, source)
  values (hh, 'probe dog', bryce, jess, today - 3, true, 'daily', 1, '{}', jess, 'app')
  returning id into t_daily;

  perform todos_roll_recurring();

  -- 3a: the missed one is closed as missed, by nobody
  select count(*) into n from todos
   where id = t_missed and completed_at is not null and missed_at is not null and completed_by is null;
  if n <> 1 then raise exception 'FAIL 3a: missed chore was not closed as missed'; end if;
  -- 3b: exactly one successor, due today, open, un-nagged
  select count(*) into n from todos where parent_id = t_missed;
  if n <> 1 then raise exception 'FAIL 3b: expected 1 successor, got %', n; end if;
  select id into kid from todos where parent_id = t_missed;
  select count(*) into n from todos
   where id = kid and due_on = today and completed_at is null and missed_at is null
     and nag_count = 0 and assignee_id = bryce and repeat_freq = 'weekly';
  if n <> 1 then raise exception 'FAIL 3c: successor is wrong (due/open/owner/repeat)'; end if;
  -- 3d: it is on Bryce's list, once, and not late
  select count(*) into n from member_todos(bryce) where title = 'probe trash';
  if n <> 1 then raise exception 'FAIL 3d: Bryce''s list shows probe trash % times, expected 1', n; end if;
  select overdue_days into n from member_todos(bryce) where title = 'probe trash';
  if n <> 0 then raise exception 'FAIL 3e: fresh successor already % days late', n; end if;

  -- 4a: the one missed yesterday is still open and overdue — the grace week
  select count(*) into n from todos where id = t_grace and completed_at is null and missed_at is null;
  if n <> 1 then raise exception 'FAIL 4a: chore missed yesterday was rolled too early'; end if;
  select count(*) into n from todos where parent_id = t_grace;
  if n <> 0 then raise exception 'FAIL 4b: grace chore spawned a successor'; end if;
  select overdue_days into n from member_todos(bryce) where title = 'probe room';
  if n <> 1 then raise exception 'FAIL 4c: expected 1 day overdue, got %', n; end if;

  -- 5a: the daily one skips forward to today, not to three days ago
  select count(*) into n from todos where parent_id = t_daily and due_on = today and completed_at is null;
  if n <> 1 then raise exception 'FAIL 5a: daily successor not due today'; end if;
  select count(*) into n from todos where parent_id = t_daily;
  if n <> 1 then raise exception 'FAIL 5b: daily spawned % successors', n; end if;

  -- 6: re-completing the missed parent must not spawn a duplicate
  update todos set completed_at = null where id = t_missed;
  update todos set completed_at = now(), completed_by = jess where id = t_missed;
  select count(*) into n from todos where parent_id = t_missed;
  if n <> 1 then raise exception 'FAIL 6: re-completion spawned a duplicate (% children)', n; end if;

  -- 6b: nor can anything else — the index says one successor per parent
  begin
    insert into todos (household_id, title, assignee_id, due_on, parent_id, created_by)
    values (hh, 'probe trash', bryce, today + 7, t_missed, jess);
    raise exception 'FAIL 6b: a second successor was allowed';
  exception when unique_violation then null;
  end;

  -- 7: the nag queue rolls first, then nags the successor at its hour
  perform queue_todo_nags();
  select count(*) into n from reminders where todo_id = kid and occurrence_date = today;
  if n <> 1 then raise exception 'FAIL 7: successor was not queued to nag (% rows)', n; end if;
  select count(*) into n from reminders r join todos t on t.id = r.todo_id
   where t.id = t_missed;
  if n <> 0 then raise exception 'FAIL 7b: the missed one was queued to nag'; end if;
end $$;

-- 7c: the nag fires at 6pm household time (default due_time)
do $$
declare tz text; t time;
begin
  select timezone into tz from households where id = '00000000-0000-0000-0000-000000000001';
  select (r.fire_at at time zone tz)::time into t
    from reminders r join todos td on td.id = r.todo_id
   where td.title = 'probe trash' and td.parent_id is not null limit 1;
  if t is distinct from time '18:00' then raise exception 'FAIL 7c: nag fires at % not 18:00', t; end if;
end $$;

-- 8: sms_last_action takes a nag, and still refuses nonsense
do $$
declare jess uuid; kid uuid;
begin
  select id into jess from members where name = 'Jess' and deleted_at is null limit 1;
  select id into kid from todos where title = 'probe trash' and parent_id is not null limit 1;
  insert into sms_last_action (member_id, household_id, todo_id, action, occurrence_date)
  values (jess, '00000000-0000-0000-0000-000000000001', kid, 'nag', current_date)
  on conflict (member_id) do update set todo_id = excluded.todo_id, event_id = null,
    action = excluded.action, created_at = now();
  begin
    update sms_last_action set action = 'bogus' where member_id = jess;
    raise exception 'FAIL 8: sms_last_action accepted action=bogus';
  exception when check_violation then null;
  end;
end $$;

-- 9: THE APP PATH. Everything above ran as the service role, which bypasses
--    RLS — the exact way 019's gap hid for a week. This is the browser.
set local role anon;
do $$
declare hh uuid := '00000000-0000-0000-0000-000000000001';
        dflt uuid; jess uuid; erich uuid; bryce uuid; mid uuid; tid uuid; n int; today date; tz text;
begin
  select default_cook_id, timezone into dflt, tz from households where id = hh;
  if dflt is null then raise exception 'FAIL 9a: anon cannot read households.default_cook_id'; end if;
  today := (now() at time zone tz)::date;
  select id into jess  from members where household_id = hh and name = 'Jess';
  select id into erich from members where household_id = hh and name = 'Erich';
  select id into bryce from members where household_id = hh and name = 'Bryce';

  -- the cook picker: change the cook on an existing meal from the browser
  select id into mid from meal_plan where household_id = hh and recipe_id in
    (select id from recipes where name = 'probe tacos') limit 1;
  update meal_plan set cook_id = jess where id = mid;
  select count(*) into n from reminders where meal_id = mid and sent_at is null and member_id = jess;
  if n <> 2 then raise exception 'FAIL 9b: anon cook change did not re-materialize (% to Jess)', n; end if;

  -- ticking a recurring chore from the browser spawns its successor (trigger runs as anon)
  insert into todos (household_id, title, assignee_id, assigned_by, due_on, remind,
                     repeat_freq, repeat_interval, repeat_days, created_by, source)
  values (hh, 'probe dishes', bryce, erich, today, true, 'daily', 1, '{}', erich, 'web')
  returning id into tid;
  update todos set completed_at = now(), completed_by = erich where id = tid;
  select count(*) into n from todos where parent_id = tid and due_on = today + 1;
  if n <> 1 then raise exception 'FAIL 9c: anon completion did not spawn tomorrow''s (% rows)', n; end if;

  -- the Done section can see missed rows and Clear done can sweep them
  select count(*) into n from todos where household_id = hh and missed_at is not null and cleared_at is null;
  if n < 1 then raise exception 'FAIL 9d: anon cannot see missed rows'; end if;
  update todos set cleared_at = now() where household_id = hh and missed_at is not null and title like 'probe %';
  select count(*) into n from todos where household_id = hh and missed_at is not null and cleared_at is null and title like 'probe %';
  if n <> 0 then raise exception 'FAIL 9e: anon could not clear missed rows'; end if;
end $$;
reset role;

select 'all 020 behaviour checks passed' as result;
rollback;
