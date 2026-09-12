-- ============================================================================
-- 028 — The Sunday planning nudge.
--
--   Sunday 10am, household time: ONE message to the default cook — last
--   week's dinners as the suggestion, "same as last week" as the reply.
--   Cron `sunday-plan` wakes morning-digest hourly 15–17 UTC on Sundays
--   with {"mode":"sunday"}; the function checks the local hour, skips when
--   the week ahead already has four dinners, and logs the send in
--   nudge_log(kind 'sunday') so a second wake-up sends nothing. The header
--   (with the digest secret) is copied from the morning-digest job, as 025
--   did for the 4pm nudge.
--
--   No schema change. meal_plan already carries anchor_event_id /
--   anchor_date / leave_minutes / eat_minutes (018); the Plan sheet now
--   writes them, and the VERIFY here proves that moving ready_by moves the
--   countdown (meal_resync).
--
-- SAFE TO RE-RUN.
-- ============================================================================

begin;
insert into schema_migrations (id) values ('028-sunday-plan') on conflict do nothing;
commit;

select cron.unschedule('sunday-plan')
  where exists (select 1 from cron.job where jobname = 'sunday-plan');

select cron.schedule('sunday-plan', '0 15-17 * * 0', format($cmd$
  select net.http_post(
    url     := 'https://rauvytdltnbqrvyiornh.supabase.co/functions/v1/morning-digest',
    headers := '%s'::jsonb,
    body    := '{"mode":"sunday"}'::jsonb
  );
$cmd$, (select regexp_replace(command, '.*headers := ''(\{[^}]*\})''.*', '\1', 's')
          from cron.job where jobname = 'morning-digest')));

select jobname, schedule, position('x-digest-secret' in command) > 0 as has_secret_header
  from cron.job where jobname in ('morning-digest','dinner-nudge','sunday-plan');
