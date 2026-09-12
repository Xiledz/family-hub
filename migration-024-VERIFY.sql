-- ============================================================================
-- 024 VERIFY — run after migration-024-absences.sql. Ends in rollback.
-- Prints "all 024 behaviour checks passed" or raises the assertion that failed.
-- ============================================================================
begin;

do $$
declare
  hh uuid := '00000000-0000-0000-0000-000000000001';
  tz text; today date;
  erich uuid; jess uuid; addie uuid; bryce uuid;
  tue date; sat date;
  orch uuid; dinner uuid; soccer uuid; td uuid; td_today uuid;
  ab uuid; res jsonb; n int;
begin
  select timezone into tz from households where id = hh;
  today := (now() at time zone tz)::date;
  select id into erich from members where household_id = hh and name = 'Erich' and deleted_at is null;
  select id into jess  from members where household_id = hh and name = 'Jess'  and deleted_at is null;
  select id into addie from members where household_id = hh and name = 'Addie' and deleted_at is null;
  select id into bryce from members where household_id = hh and name = 'Bryce' and deleted_at is null;
  if erich is null or jess is null or addie is null or bryce is null then raise exception 'FAIL 0: members'; end if;

  tue := today + 10 + ((2 - extract(dow from today + 10)::int + 7) % 7);
  sat := tue + 4;

  -- Orchestra: weekly Tuesday, Addie going, Jess driving. Reminders via the materializer.
  insert into events (household_id, title, event_date, all_day, starts_at, ends_at,
                      repeat_freq, repeat_interval, repeat_days, created_by, member_id)
  values (hh, 'probe orchestra', tue, false,
          (tue::timestamp + time '15:30') at time zone tz, (tue::timestamp + time '16:30') at time zone tz,
          'weekly', 1, array[extract(dow from tue)::int], erich, addie) returning id into orch;
  insert into event_people (household_id, event_id, member_id, role) values
    (hh, orch, addie, 'going'), (hh, orch, jess, 'driving');
  perform materialize_series_reminders(30);
  select count(*) into n from reminders where event_id = orch and occurrence_date = tue and sent_at is null;
  if n <> 2 then raise exception 'FAIL 0b: expected 2 orchestra reminders on %, got %', tue, n; end if;

  -- Family dinner: one-off on Tuesday, all four going; Erich's reminder app-style (no occurrence_date).
  insert into events (household_id, title, event_date, all_day, starts_at, created_by)
  values (hh, 'probe family dinner', tue, false, (tue::timestamp + time '18:30') at time zone tz, erich)
  returning id into dinner;
  insert into event_people (household_id, event_id, member_id, role) values
    (hh, dinner, erich, 'going'), (hh, dinner, jess, 'going'), (hh, dinner, addie, 'going'), (hh, dinner, bryce, 'going');
  insert into reminders (household_id, event_id, member_id, lead_minutes, fire_at)
  values (hh, dinner, erich, 30, ((tue::timestamp + time '18:00') at time zone tz));

  -- Soccer: one-off Saturday, Bryce going, Erich the only driver.
  insert into events (household_id, title, event_date, all_day, starts_at, created_by, member_id)
  values (hh, 'probe soccer', sat, false, (sat::timestamp + time '09:00') at time zone tz, erich, bryce)
  returning id into soccer;
  insert into event_people (household_id, event_id, member_id, role) values
    (hh, soccer, bryce, 'going'), (hh, soccer, erich, 'driving');
  insert into reminders (household_id, event_id, member_id, lead_minutes, fire_at, occurrence_date) values
    (hh, soccer, bryce, 15, ((sat::timestamp + time '08:45') at time zone tz), sat),
    (hh, soccer, erich, 45, ((sat::timestamp + time '08:15') at time zone tz), sat);

  -- Bryce's trash, due Tuesday, already queued to nag.
  insert into todos (household_id, title, assignee_id, assigned_by, due_on, created_by, nag_count)
  values (hh, 'probe trash', bryce, jess, tue, jess, 1) returning id into td;
  insert into reminders (household_id, todo_id, member_id, lead_minutes, fire_at, occurrence_date)
  values (hh, td, bryce, 0, ((tue::timestamp + time '18:00') at time zone tz), tue);

  -- ===== 1. Addie is sick Tuesday ============================================
  insert into member_absences (household_id, member_id, kind, from_date, to_date, created_by)
  values (hh, addie, 'sick', tue, tue, jess) returning id into ab;
  res := apply_absence(ab);

  select count(*) into n from event_exceptions where event_id = orch and occurrence_date = tue and action = 'skip' and absence_id = ab;
  if n <> 1 then raise exception 'FAIL 1: orchestra not skipped (%)', res; end if;
  select count(*) into n from reminders where event_id = orch and occurrence_date = tue and sent_at is null;
  if n <> 0 then raise exception 'FAIL 1b: orchestra reminders survived the skip (% left)', n; end if;
  select count(*) into n from event_exceptions where event_id = dinner;
  if n <> 0 then raise exception 'FAIL 1c: family dinner skipped because one of four is sick'; end if;
  select count(*) into n from reminders where event_id = dinner and sent_at is null;
  if n <> 1 then raise exception 'FAIL 1d: Erich''s dinner reminder went'; end if;
  if (res->'skipped'->0->>'driver') <> 'Jess' then raise exception 'FAIL 1e: driver not named: %', res; end if;
  if jsonb_array_length(res->'skipped') <> 1 then raise exception 'FAIL 1f: skipped count %', res; end if;
  -- occurrences_on hides it, so the digest and the feed agree
  select count(*) into n from occurrences_on(tue) where event_id = orch;
  if n <> 0 then raise exception 'FAIL 1g: occurrences_on still shows the skipped orchestra'; end if;

  -- re-applying adds nothing
  res := apply_absence(ab);
  if jsonb_array_length(res->'skipped') <> 0 then raise exception 'FAIL 1h: re-apply skipped again'; end if;

  -- ===== 2. Addie is fine: revoke ============================================
  n := revoke_absence(ab);
  if n <> 1 then raise exception 'FAIL 2: revoke removed % skips, expected 1', n; end if;
  select count(*) into n from event_exceptions where event_id = orch and occurrence_date = tue;
  if n <> 0 then raise exception 'FAIL 2b: skip still there after revoke'; end if;
  select count(*) into n from reminders where event_id = orch and occurrence_date = tue and sent_at is null;
  if n <> 2 then raise exception 'FAIL 2c: reminders not back after revoke (% of 2)', n; end if;
  select count(*) into n from member_absences where id = ab and deleted_at is not null;
  if n <> 1 then raise exception 'FAIL 2d: absence not soft-deleted'; end if;

  -- ===== 3. Bryce is sick Tue–Sat ============================================
  insert into member_absences (household_id, member_id, kind, from_date, to_date, created_by)
  values (hh, bryce, 'sick', tue, sat, jess) returning id into ab;
  res := apply_absence(ab);
  select count(*) into n from event_exceptions where event_id = soccer and occurrence_date = sat and action = 'skip';
  if n <> 1 then raise exception 'FAIL 3: soccer not skipped for a sick Bryce (%)', res; end if;
  select count(*) into n from reminders where event_id = soccer and sent_at is null;
  if n <> 0 then raise exception 'FAIL 3b: soccer reminders survived (% left)', n; end if;
  select count(*) into n from reminders where todo_id = td and sent_at is null;
  if n <> 0 then raise exception 'FAIL 3c: trash nag not paused'; end if;
  if (res->>'nags_paused')::int <> 1 then raise exception 'FAIL 3d: nags_paused = %', res->>'nags_paused'; end if;
  select count(*) into n from event_exceptions where event_id = dinner;
  if n <> 0 then raise exception 'FAIL 3e: family dinner skipped'; end if;
  select count(*) into n from todos where id = td and completed_at is null;
  if n <> 1 then raise exception 'FAIL 3f: the todo itself was closed'; end if;
  perform revoke_absence(ab);
  select nag_count into n from todos where id = td;
  if n <> 0 then raise exception 'FAIL 3g: nag_count not reset on revoke (%)', n; end if;
  select count(*) into n from reminders where event_id = soccer and sent_at is null;
  if n <> 2 then raise exception 'FAIL 3h: soccer reminders not back (% of 2)', n; end if;

  -- ===== 4. Erich is away Saturday: the ride is uncovered, not cancelled ======
  insert into member_absences (household_id, member_id, kind, from_date, to_date, created_by)
  values (hh, erich, 'away', sat, sat, erich) returning id into ab;
  res := apply_absence(ab);
  select count(*) into n from event_exceptions where event_id = soccer;
  if n <> 0 then raise exception 'FAIL 4: away parent cancelled the kid''s soccer'; end if;
  if jsonb_array_length(res->'uncovered') <> 1 or (res->'uncovered'->0->>'role') <> 'driving' then
    raise exception 'FAIL 4b: uncovered ride not reported: %', res; end if;
  select count(*) into n from reminders where event_id = soccer and member_id = erich and sent_at is null;
  if n <> 0 then raise exception 'FAIL 4c: away Erich still gets the leave-now alert'; end if;
  select count(*) into n from reminders where event_id = soccer and member_id = bryce and sent_at is null;
  if n <> 1 then raise exception 'FAIL 4d: Bryce''s own reminder went with Erich''s'; end if;
  select count(*) into n from uncovered_rides(erich, sat);
  if n <> 1 then raise exception 'FAIL 4e: uncovered_rides() disagrees (%)', n; end if;
  perform revoke_absence(ab);

  -- ===== 5. Snow day Tuesday: the kids' things, not the adults' ==============
  insert into member_absences (household_id, member_id, kind, from_date, to_date, created_by)
  values (hh, null, 'school_closed', tue, tue, jess) returning id into ab;
  res := apply_absence(ab);
  select count(*) into n from event_exceptions where event_id = orch and occurrence_date = tue and absence_id = ab;
  if n <> 1 then raise exception 'FAIL 5: snow day did not skip Addie''s orchestra (%)', res; end if;
  select count(*) into n from event_exceptions where event_id = dinner;
  if n <> 0 then raise exception 'FAIL 5b: snow day skipped family dinner'; end if;
  select count(*) into n from reminders where todo_id = td and sent_at is null;
  -- the nag was re-queued? No: revoke reset nag_count, but nothing re-queued yet (not today). 0 is right;
  -- what matters is that a snow day does not touch it: nags_paused must be 0.
  if (res->>'nags_paused')::int <> 0 then raise exception 'FAIL 5c: snow day paused chores'; end if;
  perform revoke_absence(ab);

  -- ===== 6. The trigger alone: a hand-written skip drops the reminders ========
  select count(*) into n from reminders where event_id = orch and occurrence_date = tue and sent_at is null;
  if n <> 2 then raise exception 'FAIL 6: setup — expected 2, got %', n; end if;
  insert into event_exceptions (household_id, event_id, occurrence_date, action, created_by)
  values (hh, orch, tue, 'skip', erich);
  select count(*) into n from reminders where event_id = orch and occurrence_date = tue and sent_at is null;
  if n <> 0 then raise exception 'FAIL 6b: trigger left % reminders', n; end if;
  -- ...and a one-off's app-style reminder (no occurrence_date) too
  insert into event_exceptions (household_id, event_id, occurrence_date, action, created_by)
  values (hh, dinner, tue, 'skip', erich);
  select count(*) into n from reminders where event_id = dinner and sent_at is null;
  if n <> 0 then raise exception 'FAIL 6c: one-off reminder survived a skip'; end if;
  delete from event_exceptions where event_id in (orch, dinner);

  -- ===== 7. The nag queue respects a live absence for a day still to come ====
  insert into todos (household_id, title, assignee_id, assigned_by, due_on, created_by)
  values (hh, 'probe dishes', bryce, jess, today, jess) returning id into td_today;
  insert into member_absences (household_id, member_id, kind, from_date, to_date, created_by)
  values (hh, bryce, 'sick', today, today, jess) returning id into ab;
  perform queue_todo_nags();
  select count(*) into n from reminders where todo_id = td_today;
  if n <> 0 then raise exception 'FAIL 7: nag queued for a sick kid'; end if;
  perform revoke_absence(ab);
  perform queue_todo_nags();
  select count(*) into n from reminders where todo_id = td_today;
  if n <> 1 then raise exception 'FAIL 7b: nag not queued once he is fine (%)', n; end if;
end $$;

-- ===== 8. THE APP PATH: anon can record an absence and apply it ===============
set local role anon;
do $$
declare hh uuid := '00000000-0000-0000-0000-000000000001'; bryce uuid; ab uuid; res jsonb; n int;
begin
  select id into bryce from members where household_id = hh and name = 'Bryce';
  insert into member_absences (household_id, member_id, kind, from_date, to_date)
  values (hh, bryce, 'sick', current_date + 30, current_date + 30) returning id into ab;
  res := apply_absence(ab);
  if res ? 'error' then raise exception 'FAIL 8: apply as anon: %', res; end if;
  n := revoke_absence(ab);
  select count(*) into n from member_absences where id = ab and deleted_at is not null;
  if n <> 1 then raise exception 'FAIL 8b: anon revoke did not soft-delete'; end if;
end $$;
reset role;

select 'all 024 behaviour checks passed' as result;
rollback;
