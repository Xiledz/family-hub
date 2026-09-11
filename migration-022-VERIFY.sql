-- ============================================================================
-- 022 VERIFY — run after migration-022-feed-occurrences.sql. Ends in rollback.
-- Prints "all 022 behaviour checks passed" or raises the assertion that failed.
-- ============================================================================
begin;

do $$
declare
  hh uuid := '00000000-0000-0000-0000-000000000001';
  jess uuid; addie uuid; erich uuid;
  tue date; ev uuid; one uuid; adults uuid;
  n int; ppl text; d boolean;
begin
  select id into jess  from members where household_id = hh and name = 'Jess'  and deleted_at is null;
  select id into addie from members where household_id = hh and name = 'Addie' and deleted_at is null;
  select id into erich from members where household_id = hh and name = 'Erich' and deleted_at is null;
  if jess is null or addie is null or erich is null then raise exception 'FAIL 0: members missing'; end if;

  -- a Tuesday at least 10 days out, so the window below is clean of today
  tue := current_date + 10 + ((2 - extract(dow from current_date + 10)::int + 7) % 7);

  -- weekly series, Addie going, Jess driving
  insert into events (household_id, title, event_date, all_day, starts_at, ends_at,
                      repeat_freq, repeat_interval, repeat_days, created_by, member_id)
  values (hh, 'probe orchestra', tue, false,
          (tue::timestamp + time '15:30') at time zone 'America/Chicago',
          (tue::timestamp + time '16:30') at time zone 'America/Chicago',
          'weekly', 1, array[2], erich, addie)
  returning id into ev;
  insert into event_people (household_id, event_id, member_id, role) values
    (hh, ev, addie, 'going'), (hh, ev, jess, 'driving');

  -- second Tuesday skipped, third Tuesday done
  insert into event_exceptions (household_id, event_id, occurrence_date, action, created_by)
  values (hh, ev, tue + 7, 'skip', erich);
  insert into event_done (household_id, event_id, occurrence_date, done_by)
  values (hh, ev, tue + 14, jess);

  -- a one-off, ticked
  insert into events (household_id, title, event_date, all_day, created_by, done_at)
  values (hh, 'probe picnic', tue + 3, true, erich, now()) returning id into one;

  -- an adults-only one-off in the window: must never reach the feed
  insert into events (household_id, title, event_date, all_day, created_by, visibility)
  values (hh, 'probe gift run', tue + 4, true, erich, 'adults') returning id into adults;

  -- 1: four Tuesdays in a 28-day window from tue, minus the skip = 3
  select count(*) into n from feed_occurrences(hh, tue, tue + 27) where event_id = ev;
  if n <> 3 then raise exception 'FAIL 1: expected 3 orchestra occurrences (4 minus a skip), got %', n; end if;
  select count(*) into n from feed_occurrences(hh, tue, tue + 27) where event_id = ev and occurrence_date = tue + 7;
  if n <> 0 then raise exception 'FAIL 1b: the skipped Tuesday is in the feed'; end if;

  -- 2: the done occurrence is flagged, the others are not
  select done into d from feed_occurrences(hh, tue, tue + 27) where event_id = ev and occurrence_date = tue + 14;
  if not d then raise exception 'FAIL 2: done occurrence not flagged'; end if;
  select count(*) into n from feed_occurrences(hh, tue, tue + 27) where event_id = ev and done;
  if n <> 1 then raise exception 'FAIL 2b: % occurrences flagged done, expected 1', n; end if;

  -- 3: the cast reads as a person would say it, going first
  select people into ppl from feed_occurrences(hh, tue, tue + 27) where event_id = ev and occurrence_date = tue;
  if ppl <> 'Addie · Jess drives' then raise exception 'FAIL 3: people = "%"', ppl; end if;

  -- 4: the ticked one-off is present and done
  select done into d from feed_occurrences(hh, tue, tue + 27) where event_id = one;
  if d is distinct from true then raise exception 'FAIL 4: one-off done_at not reflected'; end if;

  -- 5: adults-only never appears, even to the definer
  select count(*) into n from feed_occurrences(hh, tue, tue + 27) where event_id = adults;
  if n <> 0 then raise exception 'FAIL 5: adults-only event leaked into the feed'; end if;

  -- 6: the window is honoured (nothing before p_from, nothing after p_to)
  select count(*) into n from feed_occurrences(hh, tue + 1, tue + 6) where event_id = ev;
  if n <> 0 then raise exception 'FAIL 6: occurrence outside the window'; end if;

  -- 7: a moved occurrence keeps its new time
  insert into event_exceptions (household_id, event_id, occurrence_date, action, starts_at, created_by)
  values (hh, ev, tue + 21, 'override', ((tue + 21)::timestamp + time '18:00') at time zone 'America/Chicago', erich);
  if (select (starts_at at time zone 'America/Chicago')::time
        from feed_occurrences(hh, tue + 21, tue + 21) where event_id = ev) <> time '18:00' then
    raise exception 'FAIL 7: override not applied';
  end if;
end $$;

-- 8: callable as anon (the execute grant) and still household-only
set local role anon;
do $$
declare n int;
begin
  select count(*) into n from feed_occurrences('00000000-0000-0000-0000-000000000001', current_date, current_date + 60)
   where title = 'probe orchestra';
  if n < 1 then raise exception 'FAIL 8: anon cannot see the series through feed_occurrences (% rows)', n; end if;
  select count(*) into n from feed_occurrences('00000000-0000-0000-0000-000000000001', current_date, current_date + 60)
   where title = 'probe gift run';
  if n <> 0 then raise exception 'FAIL 8b: adults-only row visible to anon'; end if;
end $$;
reset role;

select 'all 022 behaviour checks passed' as result;
rollback;
