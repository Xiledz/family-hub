-- ============================================================================
-- 029 — A week's meals, not seven fixed days.
--
-- WHY
--   Erich: "sometimes we plan enchiladas on Tuesday and actually make them
--   Thursday. We eat something else Tuesday, and whatever was on Thursday,
--   we kick. Those meals are meals for the week, not set in stone."
--
--   Until now a meal WAS its date: plan_date was NOT NULL, so a displaced
--   dinner had nowhere to go but the bin, and moving one onto an occupied
--   day meant overwriting what was there.
--
-- THE MODEL
--   A meal belongs to a WEEK (week_start, the Sunday). Its plan_date is an
--   INTENTION and may be null: "this week, no day yet". Everything that is
--   about a particular evening — the countdown, the headcount, the anchor,
--   tonight's line in the digest and on the kitchen wall — keys on plan_date
--   exactly as before and simply does not apply to an undated meal.
--
--   meal_move(meal, date)   put a meal on a day; whatever was on that day is
--                           bumped into the week's tray (plan_date null),
--                           never deleted. One call, returns the bumped id.
--   meal_swap(a, b)         exchange two meals' days in one transaction.
--   meal_unschedule(meal)   back into the tray.
--   The one-dinner-per-day index is unchanged (nulls do not collide).
--   A moved meal drops its anchor when the anchor was for the old day;
--   meal_resync rebuilds the countdown for the new day, or removes it
--   while the meal has no day. Servings, cook, headcount ride along.
--
-- SAFE TO RE-RUN.
-- ============================================================================

begin;

alter table meal_plan add column if not exists week_start date;
alter table meal_plan alter column plan_date drop not null;

update meal_plan set week_start = plan_date - extract(dow from plan_date)::int
 where week_start is null and plan_date is not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'meal_plan_week_or_day') then
    alter table meal_plan add constraint meal_plan_week_or_day
      check (plan_date is not null or week_start is not null);
  end if;
end $$;

comment on column meal_plan.week_start is
  'The Sunday of the week this meal belongs to. Filled from plan_date by '
  'trigger; the only thing an undated ("sometime this week") meal has.';
comment on column meal_plan.plan_date is
  'The day this meal is meant for — an intention, not a commitment. NULL '
  'means it is in the week''s tray, waiting for a night.';

-- ---------------------------------------------------------------------------
-- 1. Keep week_start honest, and drop an anchor the meal has moved away from.
-- ---------------------------------------------------------------------------
create or replace function meal_week_fill()
returns trigger language plpgsql as $$
begin
  if new.plan_date is not null then
    new.week_start := new.plan_date - extract(dow from new.plan_date)::int;
  elsif new.week_start is null then
    /* Undated and no week named: keep the week it had (an unschedule), else
       this week (a new tray meal). */
    if tg_op = 'UPDATE' and old.week_start is not null then
      new.week_start := old.week_start;
    else
      new.week_start := current_date - extract(dow from current_date)::int;
    end if;
  end if;
  if tg_op = 'UPDATE' and new.plan_date is distinct from old.plan_date
     and new.anchor_date is not null and new.anchor_date is distinct from new.plan_date then
    new.anchor_event_id := null; new.anchor_date := null;
  end if;
  return new;
end $$;

drop trigger if exists meal_week_fill_trg on meal_plan;
create trigger meal_week_fill_trg before insert or update on meal_plan
  for each row execute function meal_week_fill();

-- ---------------------------------------------------------------------------
-- 2. No day, no countdown. (materialize_meal_reminders is what meal_resync
--    calls; an undated meal clears its unsent reminders and stops.)
-- ---------------------------------------------------------------------------
create or replace function materialize_meal_reminders(p_meal uuid)
returns int language plpgsql security definer as $$
declare m meal_plan; cook timestamptz; n int := 0; who uuid;
begin
  select * into m from meal_plan where id = p_meal and deleted_at is null;
  if not found or m.done_at is not null then return 0; end if;

  if m.recipe_id is null or m.plan_date is null then
    delete from reminders where meal_id = p_meal and sent_at is null;
    return 0;
  end if;

  who := coalesce(m.cook_id, m.created_by);
  if who is null then return 0; end if;

  cook := meal_cook_start(m);
  delete from reminders where meal_id = p_meal and sent_at is null;

  insert into reminders (household_id, meal_id, member_id, lead_minutes,
                         fire_at, occurrence_date, label)
  select m.household_id, m.id, who, s.minutes_before_cook,
         cook - make_interval(mins => s.minutes_before_cook),
         m.plan_date, s.label
    from recipe_steps s
   where s.recipe_id = m.recipe_id
     and cook - make_interval(mins => s.minutes_before_cook) > now()
  on conflict do nothing;

  get diagnostics n = row_count;

  insert into reminders (household_id, meal_id, member_id, lead_minutes,
                         fire_at, occurrence_date, label)
  select m.household_id, m.id, who, 0, cook, m.plan_date, 'Start cooking'
   where cook > now()
  on conflict do nothing;

  return n;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Moving, swapping, unscheduling — each one call, each all-or-nothing.
-- ---------------------------------------------------------------------------
create or replace function meal_move(p_meal uuid, p_date date)
returns uuid language plpgsql security definer set search_path = public as $$
declare m meal_plan; bumped uuid;
begin
  select * into m from meal_plan where id = p_meal and deleted_at is null;
  if not found then return null; end if;
  if m.plan_date = p_date then return null; end if;
  /* Whatever holds that night goes back into the week's tray — not deleted. */
  update meal_plan set plan_date = null,
                       week_start = p_date - extract(dow from p_date)::int,
                       updated_at = now()
   where household_id = m.household_id and slot = m.slot and plan_date = p_date
     and deleted_at is null and id <> p_meal
  returning id into bumped;
  update meal_plan set plan_date = p_date, updated_at = now() where id = p_meal;
  return bumped;
end $$;

create or replace function meal_swap(p_a uuid, p_b uuid)
returns void language plpgsql security definer set search_path = public as $$
declare da date; db date;
begin
  select plan_date into da from meal_plan where id = p_a and deleted_at is null;
  select plan_date into db from meal_plan where id = p_b and deleted_at is null;
  if da is null and db is null then return; end if;
  update meal_plan set plan_date = null, updated_at = now() where id = p_a;
  update meal_plan set plan_date = da,   updated_at = now() where id = p_b;
  update meal_plan set plan_date = db,   updated_at = now() where id = p_a;
end $$;

create or replace function meal_unschedule(p_meal uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update meal_plan set plan_date = null, updated_at = now() where id = p_meal and deleted_at is null;
end $$;

grant execute on function meal_move(uuid, date)  to anon, service_role;
grant execute on function meal_swap(uuid, uuid)  to anon, service_role;
grant execute on function meal_unschedule(uuid)  to anon, service_role;

comment on function meal_move is
  'Put a meal on a day. The meal already on that day is bumped into the '
  'week''s tray (plan_date null) and its id returned; nothing is deleted.';

insert into schema_migrations (id) values ('029-meal-week') on conflict do nothing;

commit;

select count(*) filter (where week_start is null) as missing_week,
       count(*) filter (where plan_date is null)  as in_tray,
       count(*) as meals
  from meal_plan where deleted_at is null;
