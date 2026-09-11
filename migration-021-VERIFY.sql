-- ============================================================================
-- 021 VERIFY — run after migration-021-feed-token.sql. Ends in rollback.
-- Prints "all 021 behaviour checks passed" or raises the assertion that failed.
-- ============================================================================
begin;

do $$
declare hh uuid := '00000000-0000-0000-0000-000000000001'; tok text; n int;
begin
  -- 1: the household has a token of the expected shape
  select feed_token into tok from households where id = hh;
  if tok is null then raise exception 'FAIL 1: feed_token is null'; end if;
  if tok !~ '^[0-9a-f]{64}$' then raise exception 'FAIL 1b: feed_token is not 64 hex chars: %', tok; end if;

  -- 2: re-running the migration's update does NOT rotate an existing token
  update households set feed_token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') where feed_token is null;
  if (select feed_token from households where id = hh) <> tok then
    raise exception 'FAIL 2: re-run rotated the token';
  end if;

  -- 3: the unique index holds
  insert into households (id, name, passcode, timezone, feed_token)
  values ('00000000-0000-0000-0000-0000000000aa', 'probe', 'X', 'UTC', tok);
  raise exception 'FAIL 3: a second household was allowed the same token';
exception when unique_violation then
  null;
end $$;

-- 4: THE APP PATH. The Settings sheet runs as anon and must be able to read
--    the token (this is the documented, deliberate exposure) — and must NOT
--    be able to change it.
set local role anon;
do $$
declare tok text; n int;
begin
  select feed_token into tok from households where id = '00000000-0000-0000-0000-000000000001';
  if tok is null then raise exception 'FAIL 4a: anon cannot read feed_token (Settings row would stay hidden)'; end if;
  update households set feed_token = 'x' where id = '00000000-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 4b: anon was able to change feed_token'; end if;
end $$;
reset role;

-- 5: rotation is one update, and it is what the app would then show
do $$
declare before text; after text;
begin
  select feed_token into before from households where id = '00000000-0000-0000-0000-000000000001';
  update households set feed_token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
   where id = '00000000-0000-0000-0000-000000000001';
  select feed_token into after from households where id = '00000000-0000-0000-0000-000000000001';
  if before = after then raise exception 'FAIL 5: rotation did nothing'; end if;
end $$;

select 'all 021 behaviour checks passed' as result;
rollback;
