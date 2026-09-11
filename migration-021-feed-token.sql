-- ============================================================================
-- 021 — The calendar feed gets a door.
--
-- WHY
--   ics-feed has been deployed since v1 and gated on a FEED_TOKEN secret that
--   was never set and that nothing in the app could show. Finished code with
--   no door: the grandparents could have had the family calendar in their
--   own phone since August.
--
--   The token moves onto the household row so the app's Settings sheet can
--   build the subscribe link. ics-feed.ts checks ?t= against this column
--   first and the env secret second, so deploying the function before this
--   migration breaks nothing.
--
-- WHAT THIS EXPOSES, PLAINLY
--   households already has a `select using (true)` policy, so the anon key —
--   which ships in every browser that loads the page — can read feed_token.
--   That makes the token exactly as public as the anon key and the passcode
--   gate in front of it: anyone who has the app can share the link. For a
--   read-only family calendar that is the intended audience. It is NOT a
--   secret in the credential sense; rotate it by updating the column.
--
-- SAFE TO RE-RUN. Re-running does not rotate an existing token.
-- ============================================================================

begin;

alter table households add column if not exists feed_token text;

comment on column households.feed_token is
  'The ?t= for ics-feed. Readable by the app (anon) on purpose: as public as '
  'the anon key. Rotate by updating it; subscribers re-paste the link.';

update households
   set feed_token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
 where feed_token is null;

-- One token per household is the whole point; two households sharing one
-- would let one read the other's calendar.
create unique index if not exists households_feed_token_uniq
  on households (feed_token) where feed_token is not null;

insert into schema_migrations (id) values ('021-feed-token') on conflict do nothing;

commit;

-- ---------------------------------------------------------------------------
-- Verify (read-only). Expect one row with a 64-character token.
-- ---------------------------------------------------------------------------
select id from schema_migrations order by id desc limit 3;
select name, length(feed_token) as token_len from households;
