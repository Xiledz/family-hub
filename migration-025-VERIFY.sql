-- ============================================================================
-- 025 VERIFY — run after migration-025-nudge-staples.sql. Ends in rollback.
-- ============================================================================
begin;

do $$
declare hh uuid := '00000000-0000-0000-0000-000000000001'; jess uuid; n int; cmd text;
begin
  select id into jess from members where household_id = hh and name = 'Jess' and deleted_at is null;

  -- 1: one nudge per kind per day per person
  insert into nudge_log (kind, for_date, member_id) values ('dinner', current_date, jess);
  begin
    insert into nudge_log (kind, for_date, member_id) values ('dinner', current_date, jess);
    raise exception 'FAIL 1: a second dinner nudge for the same day was allowed';
  exception when unique_violation then null;
  end;
  insert into nudge_log (kind, for_date, member_id) values ('dinner', current_date + 1, jess);

  -- 2: the cron job exists, on the hourly window, carrying the digest's own header
  select command into cmd from cron.job where jobname = 'dinner-nudge';
  if cmd is null then raise exception 'FAIL 2: dinner-nudge not scheduled'; end if;
  if position('x-digest-secret' in cmd) = 0 then raise exception 'FAIL 2b: nudge lacks the secret header'; end if;
  if position('"mode":"dinner"' in cmd) = 0 then raise exception 'FAIL 2c: nudge body is not {"mode":"dinner"}'; end if;
  if position('REPLACE_WITH' in cmd) > 0 and position('REPLACE_WITH' in (select command from cron.job where jobname='morning-digest')) = 0 then
    raise exception 'FAIL 2d: header not copied from morning-digest';
  end if;
  if (select schedule from cron.job where jobname = 'dinner-nudge') <> '0 20-23 * * *' then
    raise exception 'FAIL 2e: schedule is %', (select schedule from cron.job where jobname = 'dinner-nudge');
  end if;
end $$;

-- 3: THE APP PATH. Runs as anon: it must be able to stamp the staples guard
--    and star a catalog row, and the guard must read back.
set local role anon;
do $$
declare hh uuid := '00000000-0000-0000-0000-000000000001'; n int; t timestamptz;
begin
  update households set staples_seeded_at = now() where id = hh;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 3: anon cannot update households (staples guard)'; end if;
  select staples_seeded_at into t from households where id = hh;
  if t is null then raise exception 'FAIL 3b: guard did not read back'; end if;

  insert into shopping_catalog (household_id, name, category) values (hh, 'probe salt', 'baking')
  on conflict (household_id, name) do nothing;
  update shopping_catalog set staple = true where household_id = hh and name = 'probe salt';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 3c: anon cannot star a catalog row'; end if;

  -- and the nudge log, in case the app ever nudges itself
  insert into nudge_log (kind, for_date, member_id)
  select 'probe', current_date, id from members where household_id = hh and name = 'Jess';
end $$;
reset role;

select 'all 025 behaviour checks passed' as result;
rollback;
