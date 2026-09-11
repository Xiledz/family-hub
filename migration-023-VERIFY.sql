-- ============================================================================
-- 023 VERIFY — run after migration-023-season-kind.sql. Ends in rollback.
-- ============================================================================
begin;

do $$
declare hh uuid := '00000000-0000-0000-0000-000000000001'; jess uuid; n int;
begin
  select id into jess from members where household_id = hh and name = 'Jess' and deleted_at is null;

  -- 1: the new kind is accepted, with a rows payload
  insert into sms_pending (household_id, member_id, kind, payload, options, expires_at)
  values (hh, jess, 'season_confirm',
          '{"rows":[{"date":"2026-09-15","start":"18:30","title":"Orchestra"}],"title":"Orchestra"}',
          '[{"keys":["1","yes","all"],"value":"all"},{"keys":["cancel","stop","no"],"value":"cancel"}]',
          now() + interval '15 minutes');
  select count(*) into n from sms_pending where member_id = jess and kind = 'season_confirm';
  if n <> 1 then raise exception 'FAIL 1: season_confirm not stored'; end if;
  if (select jsonb_array_length(payload->'rows') from sms_pending where member_id = jess) <> 1 then
    raise exception 'FAIL 1b: payload rows not readable';
  end if;

  -- 2: every kind that existed still does
  delete from sms_pending where member_id = jess;
  insert into sms_pending (household_id, member_id, kind, payload, options, expires_at)
  values (hh, jess, 'rides', '{}', '[]', now() + interval '1 minute');
  delete from sms_pending where member_id = jess;

  -- 3: nonsense is still refused
  begin
    insert into sms_pending (household_id, member_id, kind, payload, options, expires_at)
    values (hh, jess, 'bogus', '{}', '[]', now() + interval '1 minute');
    raise exception 'FAIL 3: sms_pending accepted kind=bogus';
  exception when check_violation then null;
  end;
end $$;

-- 4: the SMS function runs as service role; the app never writes sms_pending.
--    Still: anon can insert a season_confirm through the existing _all policy,
--    which is what the route_intent kind already relies on.
set local role anon;
do $$
declare hh uuid := '00000000-0000-0000-0000-000000000001'; jess uuid;
begin
  select id into jess from members where household_id = hh and name = 'Jess';
  insert into sms_pending (household_id, member_id, kind, payload, options, expires_at)
  values (hh, jess, 'season_confirm', '{"rows":[]}', '[]', now() + interval '1 minute');
  delete from sms_pending where member_id = jess;
end $$;
reset role;

select 'all 023 behaviour checks passed' as result;
rollback;
