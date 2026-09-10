-- ============================================================================
-- 016 — "no ride needed" as a number.
--
-- WHY
--   The rides follow-up asked for a sentence: 'Reply "Jess there, me back"'.
--   Most of the time the true answer is "nobody needs a lift", and typing a
--   sentence to say nothing is exactly the friction that makes people stop
--   answering at all. So the question is numbered now, 1 is the common case,
--   and a bare "1" has to resolve — which means sms_pending must accept the
--   kind. Its check constraint did not.
--
--   The question stays NON-BLOCKING. The event is already saved before it is
--   asked, and an unmatched reply drops the question and routes normally, so
--   ignoring it entirely costs nothing.
--
-- SAFE TO RE-RUN.
-- ============================================================================

begin;

do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'sms_pending'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%kind%';
  if c is not null then execute format('alter table sms_pending drop constraint %I', c); end if;
end $$;

alter table sms_pending add constraint sms_pending_kind_check
  check (kind in ('confirm_date','confirm_time','route_intent',
                  'pick_todo','series_scope','rides'));

insert into schema_migrations (id) values ('016-rides-kind') on conflict do nothing;

commit;

select pg_get_constraintdef(oid) as kinds_allowed
  from pg_constraint where conname = 'sms_pending_kind_check';
