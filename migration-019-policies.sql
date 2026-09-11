-- ============================================================================
-- 019 — The browser could not touch anything built since 013.
--
-- WHY
--   Row-level security is on for every table in this project, and every
--   table the app uses carries a policy that lets the household in. Every
--   table created since 013 — todos, event_done, deliveries, recipes,
--   recipe_ingredients, recipe_steps, meal_plan — has RLS on and NO policy,
--   which in Postgres means "nobody". The To-Do tab, the event check-off and
--   the whole Meals tab have been failing with "Could not save" from the
--   browser. Texted todos worked, because the SMS function uses the service
--   role and does not go through RLS — which is exactly how this hid.
--
--   The verify scripts run as the service role too. They could never have
--   caught this. A browser-side smoke test would have.
--
-- WHAT THIS GRANTS
--   The same thing every existing table grants: the household, gated by the
--   shared passcode and the anon key. `using (true)` is the pattern the rest
--   of the app has always used; it is not a new decision.
--
--   deliveries is READ-ONLY from the browser. Only the senders write it.
--   schema_migrations gets no policy at all; the app never reads it.
--
-- ALSO
--   recipes.source did not allow 'none' — the value the import returns when
--   a page has no readable recipe. Saving such a recipe would have failed on
--   a check constraint AFTER this policy fix let the insert through.
--
-- SAFE TO RE-RUN.
-- ============================================================================

begin;

do $$
declare t text;
begin
  foreach t in array array['todos','event_done','recipes','recipe_ingredients','recipe_steps','meal_plan'] loop
    execute format('drop policy if exists %I on %I', t || '_all', t);
    execute format('create policy %I on %I for all using (true) with check (true)', t || '_all', t);
  end loop;
end $$;

drop policy if exists deliveries_read on deliveries;
create policy deliveries_read on deliveries for select using (true);

-- recipes.source: allow what the importer can actually return.
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'recipes'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%source%';
  if c is not null then execute format('alter table recipes drop constraint %I', c); end if;
end $$;
alter table recipes add constraint recipes_source_check
  check (source in ('manual','jsonld','microdata','heading','paste','none'));

insert into schema_migrations (id) values ('019-policies') on conflict do nothing;

commit;

-- Every table with RLS on must now have at least one policy, except the
-- migration ledger. This should return ONE row: schema_migrations.
select c.relname as still_unreachable
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname='public' and c.relkind='r' and c.relrowsecurity
   and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
 order by 1;
