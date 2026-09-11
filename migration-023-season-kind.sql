-- ============================================================================
-- 023 — A pasted schedule needs one question: "add these?"
--
-- WHY
--   The orchestra season arrives as twenty dated lines. The parser now reads
--   the block (parseSeason); over SMS the rows have to wait for a "1" before
--   they are written, and sms_pending's kind vocabulary is a check
--   constraint. 'season_confirm' joins it. The payload carries the parsed
--   rows (jsonb), the reply picks all / all-but / cancel.
--
--   events.source is unconstrained text ('web' | 'sms' | 'shortcut' | 'ics');
--   season rows write source = 'season' so a bad paste can be found and
--   removed as a batch. No schema change needed for that.
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
                  'pick_todo','series_scope','rides','season_confirm'));

insert into schema_migrations (id) values ('023-season-kind') on conflict do nothing;

commit;

select pg_get_constraintdef(oid) as kinds_allowed
  from pg_constraint where conname = 'sms_pending_kind_check';
