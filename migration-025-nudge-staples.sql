-- ============================================================================
-- 025 — The 4pm "nothing planned" nudge, and two small things the app needs.
--
--   1. households.staples_seeded_at — the once-only guard for starring the
--      obvious staples (salt, oil, flour…) in the catalog. The app runs as
--      anon and households only had a SELECT policy, so an UPDATE policy is
--      added for the household row. That also opens default_servings /
--      default_dinner_at / default_cook_id to the app, which is what a
--      settings screen will want anyway. feed_token and passcode are on the
--      same row; the passcode gate already stands in front of the anon key,
--      and the policy is the pattern every other table uses.
--   2. nudge_log(kind, for_date, member_id) — one nudge per kind per day per
--      person. digest_log is keyed (member_id, for_date) and already means
--      "the morning message went", so the 4pm nudge cannot share it.
--   3. cron `dinner-nudge`: hourly 20–23 UTC, POST morning-digest with
--      {"mode":"dinner"}. The function decides for itself whether it is
--      4pm on a weekday in the household's zone, same as the morning run,
--      and sends to the default cook only when no dinner is planned. The
--      headers (with x-digest-secret) are copied from the existing
--      morning-digest job rather than typed here.
--
-- SAFE TO RE-RUN.
-- ============================================================================

begin;

alter table households add column if not exists staples_seeded_at timestamptz;

comment on column households.staples_seeded_at is
  'When the app starred the obvious staples in shopping_catalog. Once ever; '
  'a household re-stars by hand after that.';

drop policy if exists households_update on households;
create policy households_update on households for update using (true) with check (true);

create table if not exists nudge_log (
  kind       text not null,
  for_date   date not null,
  member_id  uuid references members(id) on delete cascade,
  sent_at    timestamptz not null default now(),
  primary key (kind, for_date, member_id)
);
alter table nudge_log enable row level security;
drop policy if exists nudge_log_all on nudge_log;
create policy nudge_log_all on nudge_log for all using (true) with check (true);

comment on table nudge_log is
  'One row per nudge per day per person, so a cron that wakes hourly across '
  'a window sends once. The 4pm dinner nudge is the first kind.';

insert into schema_migrations (id) values ('025-nudge-staples') on conflict do nothing;

commit;

-- The cron job, outside the transaction like every other schedule here.
-- 20–23 UTC covers 4pm Central in both halves of the year.
select cron.unschedule('dinner-nudge')
  where exists (select 1 from cron.job where jobname = 'dinner-nudge');

select cron.schedule('dinner-nudge', '0 20-23 * * *', format($cmd$
  select net.http_post(
    url     := 'https://rauvytdltnbqrvyiornh.supabase.co/functions/v1/morning-digest',
    headers := '%s'::jsonb,
    body    := '{"mode":"dinner"}'::jsonb
  );
$cmd$, (select regexp_replace(command, '.*headers := ''(\{[^}]*\})''.*', '\1', 's')
          from cron.job where jobname = 'morning-digest')));

select jobname, schedule, position('x-digest-secret' in command) > 0 as has_secret_header
  from cron.job where jobname in ('morning-digest','dinner-nudge');
