-- ============================================================================
-- 018 VERIFY — run the whole migration, prove it BEHAVES, throw it away.
-- Ends in `rollback;`. Safe against production by construction.
-- Prints "all 018 behaviour checks passed" or raises the assertion that failed.
--
-- It caught three real bugs before this shipped:
--   * "1 packet" x1.5 became 1.5 packets, because an unknown unit fell into
--     quarter-rounding instead of rounding up to something you can buy.
--   * "Pizza night" was told to start cooking.
--   * A ticked occurrence kept its reminders (the gap 017 left).
-- ============================================================================

-- ============================================================================
-- 018 — Recipes, meals, and the dinner countdown.
--
-- WHY ONE MIGRATION
--   Recipes and the countdown are not two features. The object both need is
--   the MEAL: "Monday, tacos, ready by 5:55" is what pushes ingredients onto
--   the shopping list AND what anchors the countdown. Building them apart
--   means telling the app "tacos Monday" twice.
--
-- ALSO FIXES A BUG 017 SHIPPED
--   017 added event_done so an occurrence can be ticked off, but no trigger
--   fires on it — so checking off Tuesday's trash at 4pm STILL pings the
--   driver at the lead. events.done_at got that trigger; event_done did not.
--   Meals need the identical fix, which is why it lands here.
--
-- WHAT IS DELIBERATELY ABSENT
--   No pantry table. Knowing what is in the cupboard requires someone to log
--   the can of beans they used, and nobody does, so the data rots within
--   weeks and then lies. What survives is a have/need tap at plan time, with
--   defaults from two things that ARE stable: staples, and what was bought
--   recently.
--
-- SAFE TO RE-RUN.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. The 017 gap: a ticked occurrence must stop reminding.
-- ---------------------------------------------------------------------------
create or replace function drop_reminders_for_occurrence()
returns trigger language plpgsql as $$
begin
  delete from reminders r
   where r.event_id = new.event_id
     and r.occurrence_date = new.occurrence_date
     and r.sent_at is null;
  return new;
end $$;

drop trigger if exists event_done_trg on event_done;
create trigger event_done_trg after insert on event_done
  for each row execute function drop_reminders_for_occurrence();

comment on column events.done_at is
  'Ticked off. Only meaningful for a NON-recurring event — a series is done '
  'one occurrence at a time, in the event_done table.';

-- ---------------------------------------------------------------------------
-- 1. Household defaults.
-- ---------------------------------------------------------------------------
alter table households add column if not exists default_servings int not null default 4;
alter table households add column if not exists default_dinner_at time not null default '18:00';

comment on column households.default_servings is
  'How many people dinner is for when nobody says otherwise. The scale factor '
  'is meal.servings / recipe.servings, and both have to be known or it is 1.';

-- Two staples facts that survive: what we always have, and what was bought.
alter table shopping_catalog add column if not exists staple boolean not null default false;

comment on column shopping_catalog.staple is
  'We always have this — salt, oil, taco seasoning. The one piece of pantry '
  'knowledge stable enough to be worth storing, and the default for the '
  'have/need screen.';

-- ---------------------------------------------------------------------------
-- 2. Recipes.
--
--    instructions live HERE, not behind a link. "Connect all of this" is
--    answered when the cooking happens in the app; if it still means opening
--    Pinterest, the feature failed. source_url is provenance and a
--    "view original" link, and image_url is a REFERENCE — the photograph is
--    the one part of a recipe that is actually copyrightable, so it is
--    linked, never copied.
-- ---------------------------------------------------------------------------
create table if not exists recipes (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  name          text not null check (length(btrim(name)) > 0),
  servings      int  check (servings between 1 and 100),
  cook_minutes  int  not null default 30 check (cook_minutes between 0 and 1440),
  prep_note     text,
  instructions  text[] not null default '{}',
  image_url     text,
  source_url    text,
  source        text not null default 'manual'
                check (source in ('manual','jsonld','microdata','heading','paste')),
  notes         text,
  favorite      boolean not null default false,
  created_by    uuid references members(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create unique index if not exists recipes_source_url_uniq
  on recipes (household_id, source_url) where source_url is not null and deleted_at is null;

comment on table recipes is
  'The household cookbook. Ingredients and directions are stored freely — a '
  'list of ingredients and functional steps carries no copyright. The PHOTO '
  'does, so image_url points at the original rather than copying it.';

-- ---------------------------------------------------------------------------
-- 3. Ingredients.
--
--    `original` is what the recipe said; `name` is what the shopping list
--    calls it. The recipe view shows the first, the list gets the second.
--    Losing the original is how "2 cups shredded sharp cheddar" becomes
--    "cheese" and the cook can no longer follow their own recipe.
--
--    NO foreign key to shopping_catalog: removing an item from the list hard-
--    deletes its catalog row on purpose, and an FK would either block that or
--    cascade and strip ingredients out of recipes.
-- ---------------------------------------------------------------------------
create table if not exists recipe_ingredients (
  id          uuid primary key default gen_random_uuid(),
  recipe_id   uuid not null references recipes(id) on delete cascade,
  name        text not null,
  original    text,
  qty         numeric,
  unit        text,
  note        text,
  optional    boolean not null default false,
  sort_order  int not null default 0
);

create index if not exists recipe_ing_idx on recipe_ingredients (recipe_id, sort_order);

/* Units that mean "a bit" and must never be multiplied. Doubling a pinch is
   not a quantity, it is a joke. */
create or replace function unit_scalable(p_unit text)
returns boolean language sql immutable as $$
  select coalesce(lower(btrim(p_unit)), '') not in
    ('pinch','pinches','dash','dashes','to taste','handful','handfuls',
     'splash','splashes','drizzle','sprinkle','some','a few');
$$;

/* Scale a purchase quantity, rounding by what the unit actually is.

   The default is CEIL, not quarter-rounding, and that is the important
   choice. A unit this function has never heard of — packet, sachet, tin,
   punnet, whatever a recipe writer invented — is far more likely to be a
   thing you buy whole than a thing you measure. "1.5 packets of taco
   seasoning" is not a shopping list entry. Only units that are genuinely
   measured get fractions, and that list is short and closed. */
create or replace function scale_qty(p_qty numeric, p_unit text, p_factor numeric)
returns numeric language sql immutable as $$
  select case
    when p_qty is null then null
    when p_factor is null or p_factor = 1 then p_qty
    when not unit_scalable(p_unit) then p_qty
    -- Measured: fractions are real, round to a quarter.
    when lower(btrim(coalesce(p_unit,''))) in (
         'cup','cups','tsp','teaspoon','teaspoons','tbsp','tablespoon','tablespoons',
         'oz','ounce','ounces','fl oz','fluid ounce','fluid ounces',
         'lb','lbs','pound','pounds','g','gram','grams','kg','kilogram','kilograms',
         'ml','milliliter','milliliters','l','liter','liters','litre','litres',
         'pint','pints','quart','quarts','gallon','gallons','stick','sticks')
      then round((p_qty * p_factor) * 4) / 4
    -- Everything else is bought whole. You buy two cans, not one and a half.
    else ceil(p_qty * p_factor)
  end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Prep steps — a star, not a graph.
--
--    Every real pre-dinner step has the SAME dependency: it must be finished
--    by the time cooking starts. Thaw, marinate, preheat, soak. So a step is
--    one number — minutes before cook-start — which is the number a cook
--    already thinks in ("take it out an hour and a half before I start").
--    A dependency graph is the version nobody fills in, and the first time a
--    step depends on itself nobody will know why 4:25 vanished.
-- ---------------------------------------------------------------------------
create table if not exists recipe_steps (
  id                  uuid primary key default gen_random_uuid(),
  recipe_id           uuid not null references recipes(id) on delete cascade,
  label               text not null check (length(btrim(label)) > 0),
  minutes_before_cook int not null check (minutes_before_cook between 0 and 4320),
  sort_order          int not null default 0
);

create index if not exists recipe_steps_idx on recipe_steps (recipe_id, minutes_before_cook desc);

-- ---------------------------------------------------------------------------
-- 5. The meal.
--
--    Three fixed nodes, working backwards:
--        anchor (be there)  ->  leave_minutes  ->  ready_by
--        ready_by           ->  eat_minutes    ->  cook starts
--        cook starts        ->  cook_minutes
--    and every prep step hangs off cook-start.
--
--    ready_by is stored, not derived, because most dinners have no anchor at
--    all — "we eat at 6:30" is the common case and church is the exception.
--    Design around the anchor and you build the exception first.
-- ---------------------------------------------------------------------------
create table if not exists meal_plan (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references households(id) on delete cascade,
  plan_date        date not null,
  slot             text not null default 'dinner' check (slot in ('breakfast','lunch','dinner','snack')),

  recipe_id        uuid references recipes(id) on delete set null,
  freeform         text,                    -- "leftovers", "pizza night"
  servings         int,

  ready_by         time,
  eat_minutes      int not null default 20 check (eat_minutes between 0 and 240),
  leave_minutes    int not null default 0  check (leave_minutes between 0 and 240),

  -- What this dinner is working around, when it is working around anything.
  anchor_event_id  uuid references events(id) on delete set null,
  anchor_date      date,

  /* One owner. Not the anchor's cast, not "whoever is home" — the app cannot
     know that, and fanning out produces "I thought YOU took the meat out". */
  cook_id          uuid references members(id) on delete set null,

  done_at          timestamptz,
  done_by          uuid references members(id) on delete set null,
  created_by       uuid references members(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,

  check (recipe_id is not null or freeform is not null)
);

create unique index if not exists meal_plan_slot_uniq
  on meal_plan (household_id, plan_date, slot) where deleted_at is null;

comment on table meal_plan is
  'One planned meal. The hub: it is what pushes ingredients onto the shopping '
  'list and what anchors the countdown, so "tacos Monday" is said once.';

-- Ingredients pushed from a meal know where they came from, so un-planning
-- can offer to take the un-bought ones back off again.
alter table shopping_items add column if not exists meal_id uuid
  references meal_plan(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 6. Reminders grow a third subject.
--
--    013 said the dispatcher "phrases the message by which" — this is that,
--    with a label because a meal has FIVE reminders and they are not the same
--    message. One delivery path, three subjects.
-- ---------------------------------------------------------------------------
alter table reminders add column if not exists meal_id uuid
  references meal_plan(id) on delete cascade;
alter table reminders add column if not exists label text;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'reminders_one_subject') then
    alter table reminders drop constraint reminders_one_subject;
  end if;
  alter table reminders add constraint reminders_one_subject
    check (num_nonnulls(event_id, todo_id, meal_id) = 1);
end $$;

/* A meal's steps are distinguished by label, not by date alone. */
create unique index if not exists reminders_unique_meal_step
  on reminders (meal_id, label, coalesce(member_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where meal_id is not null;

comment on column reminders.label is
  'Which step of a meal countdown this is — "Take the beef out", "Preheat". '
  'NULL for events and todos, where the subject names itself.';

-- ---------------------------------------------------------------------------
-- 7. Building the countdown.
--
--    Snapshots, not links: editing the recipe later does NOT move a dinner
--    already planned. Someone would otherwise "fix" the thaw time in March
--    and silently move a meal that already happened.
-- ---------------------------------------------------------------------------
create or replace function meal_cook_start(p_meal meal_plan)
returns timestamptz language plpgsql stable as $$
declare tz text; rb time; cm int;
begin
  select timezone into tz from households where id = p_meal.household_id;
  rb := p_meal.ready_by;

  -- No stated time: fall back to the anchor, then to the household default.
  if rb is null and p_meal.anchor_event_id is not null and p_meal.anchor_date is not null then
    select (o.starts_at at time zone tz)::time - make_interval(mins => p_meal.leave_minutes)
      into rb
      from occurrences_on(p_meal.anchor_date) o
     where o.event_id = p_meal.anchor_event_id and o.starts_at is not null
     limit 1;
  end if;
  if rb is null then select default_dinner_at into rb from households where id = p_meal.household_id; end if;

  select coalesce(r.cook_minutes, 30) into cm from recipes r where r.id = p_meal.recipe_id;
  if cm is null then cm := 30; end if;

  return ((p_meal.plan_date + rb) at time zone tz) - make_interval(mins => cm);
end $$;

create or replace function materialize_meal_reminders(p_meal uuid)
returns int language plpgsql security definer as $$
declare m meal_plan; cook timestamptz; n int := 0; who uuid;
begin
  select * into m from meal_plan where id = p_meal and deleted_at is null;
  if not found or m.done_at is not null then return 0; end if;

  /* A freeform meal is a note about what dinner is, not a process. "Pizza
     night" has no cook time, no steps, and telling somebody to start cooking
     it is noise — which is exactly the kind of alert that teaches a family to
     ignore the app. No recipe, no countdown. */
  if m.recipe_id is null then
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

  -- And the moment cooking starts.
  insert into reminders (household_id, meal_id, member_id, lead_minutes,
                         fire_at, occurrence_date, label)
  select m.household_id, m.id, who, 0, cook, m.plan_date, 'Start cooking'
   where cook > now()
  on conflict do nothing;

  return n;
end $$;

comment on function materialize_meal_reminders is
  'One reminder per prep step plus a start-cooking ping, all to the cook. '
  'Rebuilt from scratch whenever the meal moves; sent rows are never touched.';

-- The meal moved, or the recipe under it changed: rebuild.
create or replace function meal_resync()
returns trigger language plpgsql as $$
begin
  if new.done_at is not null then
    delete from reminders where meal_id = new.id and sent_at is null;
    return new;
  end if;
  perform materialize_meal_reminders(new.id);
  return new;
end $$;

drop trigger if exists meal_resync_trg on meal_plan;
create trigger meal_resync_trg after insert or update on meal_plan
  for each row execute function meal_resync();

-- ---------------------------------------------------------------------------
-- 8. What is on the list for a meal, at the servings actually planned.
-- ---------------------------------------------------------------------------
create or replace function meal_ingredients(p_meal uuid)
returns table (name text, original text, qty numeric, unit text,
               note text, optional boolean, factor numeric)
language sql stable as $$
  select i.name, i.original,
         scale_qty(i.qty, i.unit, f.factor), i.unit, i.note, i.optional, f.factor
    from meal_plan m
    join recipes r on r.id = m.recipe_id
    join recipe_ingredients i on i.recipe_id = r.id
    cross join lateral (select case
              when m.servings is null or r.servings is null or r.servings = 0 then 1::numeric
              else m.servings::numeric / r.servings::numeric end as factor) f
   where m.id = p_meal
   order by i.sort_order, i.name;
$$;

comment on function meal_ingredients is
  'Ingredients at the planned servings. Factor is 1 unless BOTH the recipe '
  'and the meal state a number — a family recipe that never said how many it '
  'feeds must not silently scale by a guess.';

insert into schema_migrations (id) values ('018-meals') on conflict do nothing;

do $$
declare hh uuid; me uuid; kid uuid; r uuid; mid uuid; ev uuid; n int;
        cook timestamptz; m meal_plan; q numeric;
begin
  select id into hh from households limit 1;
  select id into me  from members where name='Erich' and deleted_at is null limit 1;
  select id into kid from members where name='Bryce' and deleted_at is null limit 1;

  -- 0: ticking an OCCURRENCE now stops its reminders (the 017 gap)
  insert into events (household_id, title, event_date, all_day, repeat_freq,
                      repeat_interval, repeat_days, created_by)
  values (hh,'probe series',current_date,true,'weekly',1,array[2],me) returning id into ev;
  insert into reminders (household_id, event_id, member_id, lead_minutes, fire_at, occurrence_date)
  values (hh, ev, me, 0, now() + interval '2 hours', current_date);
  insert into event_done (household_id, event_id, occurrence_date, done_by)
  values (hh, ev, current_date, me);
  select count(*) into n from reminders where event_id=ev and occurrence_date=current_date and sent_at is null;
  if n <> 0 then raise exception 'FAIL 0: ticked occurrence kept % reminders', n; end if;

  -- ...and it must NOT clear another date
  insert into reminders (household_id, event_id, member_id, lead_minutes, fire_at, occurrence_date)
  values (hh, ev, me, 0, now() + interval '8 days', current_date + 7);
  insert into event_done (household_id, event_id, occurrence_date, done_by)
  values (hh, ev, current_date + 14, me);
  select count(*) into n from reminders where event_id=ev and occurrence_date=current_date+7 and sent_at is null;
  if n <> 1 then raise exception 'FAIL 0b: done leaked and cleared another date'; end if;

  -- 1: a recipe with steps and a meal builds the countdown, to the cook
  insert into recipes (household_id, name, servings, cook_minutes, created_by)
  values (hh,'Tacos',4,30,me) returning id into r;
  insert into recipe_ingredients (recipe_id, name, original, qty, unit, sort_order) values
    (r,'ground beef','2 lbs ground beef',2,'lbs',1),
    (r,'taco seasoning','1 packet taco seasoning',1,'packet',2),
    (r,'salt','a pinch of salt',1,'pinch',3),
    (r,'tortillas','8 tortillas',8,'',4);
  insert into recipe_steps (recipe_id, label, minutes_before_cook, sort_order) values
    (r,'Take the beef out to thaw',60,1),
    (r,'Preheat the oven',5,2);

  insert into meal_plan (household_id, plan_date, recipe_id, servings,
                         ready_by, cook_id, created_by)
  values (hh, current_date + 2, r, 4, '17:55', me, me) returning id into mid;

  select count(*) into n from reminders where meal_id = mid;
  if n <> 3 then raise exception 'FAIL 1: countdown made % rows, expected 3', n; end if;
  select count(*) into n from reminders where meal_id = mid and member_id <> me;
  if n <> 0 then raise exception 'FAIL 1b: countdown went to someone other than the cook'; end if;

  -- 2: the thaw fires 60 min before cook start, which is 30 min before ready_by
  select * into m from meal_plan where id = mid;
  cook := meal_cook_start(m);
  select count(*) into n from reminders
   where meal_id = mid and label = 'Take the beef out to thaw'
     and fire_at = cook - interval '60 minutes';
  if n <> 1 then raise exception 'FAIL 2: thaw not 60 min before cook start'; end if;

  -- 3: moving ready_by moves the whole chain
  update meal_plan set ready_by = '19:00' where id = mid;
  select * into m from meal_plan where id = mid;
  if meal_cook_start(m) <= cook then raise exception 'FAIL 3: chain did not move with ready_by'; end if;
  select count(*) into n from reminders where meal_id = mid;
  if n <> 3 then raise exception 'FAIL 3b: rebuild left % rows', n; end if;

  -- 4: marking the meal done clears the rest of the countdown
  update meal_plan set done_at = now() where id = mid;
  select count(*) into n from reminders where meal_id = mid and sent_at is null;
  if n <> 0 then raise exception 'FAIL 4: done meal kept % reminders', n; end if;
  update meal_plan set done_at = null where id = mid;

  -- 5: servings scaling — counts round UP, pinches never scale
  update meal_plan set servings = 6 where id = mid;         -- factor 1.5
  select qty into q from meal_ingredients(mid) where name = 'ground beef';
  if q <> 3 then raise exception 'FAIL 5a: 2 lbs x1.5 gave %, expected 3', q; end if;
  select qty into q from meal_ingredients(mid) where name = 'taco seasoning';
  if q <> 2 then raise exception 'FAIL 5b: 1 packet x1.5 should round UP to 2, got %', q; end if;
  select qty into q from meal_ingredients(mid) where name = 'salt';
  if q <> 1 then raise exception 'FAIL 5c: a pinch was scaled to %', q; end if;
  select qty into q from meal_ingredients(mid) where name = 'tortillas';
  if q <> 12 then raise exception 'FAIL 5d: 8 tortillas x1.5 gave %, expected 12', q; end if;

  /* An invented unit must be treated as a thing you buy whole, not measured.
     "1.5 sachets" is not a shopping list entry. */
  insert into recipe_ingredients (recipe_id, name, original, qty, unit, sort_order)
  values (r,'yeast','1 sachet yeast',1,'sachet',5);
  select qty into q from meal_ingredients(mid) where name = 'yeast';
  if q <> 2 then raise exception 'FAIL 5e: unknown unit did not round up (got %)', q; end if;

  /* A measured unit still gets real fractions. */
  insert into recipe_ingredients (recipe_id, name, original, qty, unit, sort_order)
  values (r,'milk','1 cup milk',1,'cup',6);
  select qty into q from meal_ingredients(mid) where name = 'milk';
  if q <> 1.5 then raise exception 'FAIL 5f: 1 cup x1.5 gave %, expected 1.5', q; end if;

  -- 6: a recipe with no stated servings never scales by a guess
  update recipes set servings = null where id = r;
  select qty into q from meal_ingredients(mid) where name = 'ground beef';
  if q <> 2 then raise exception 'FAIL 6: unstated servings scaled anyway (%)', q; end if;
  update recipes set servings = 4 where id = r;

  -- 7: the XOR now takes three subjects, and still exactly one
  begin
    insert into reminders (household_id, event_id, meal_id, member_id, lead_minutes, fire_at)
    values (hh, ev, mid, me, 0, now());
    raise exception 'FAIL 7: reminders accepted two subjects';
  exception when check_violation then null;
  end;

  -- 8: a freeform meal with no recipe is allowed and makes no countdown
  insert into meal_plan (household_id, plan_date, freeform, cook_id, created_by)
  values (hh, current_date + 3, 'pizza night', me, me) returning id into mid;
  select count(*) into n from reminders where meal_id = mid;
  if n <> 0 then raise exception 'FAIL 8: freeform meal built a countdown'; end if;

  -- 9: a meal must be one or the other, never neither
  begin
    insert into meal_plan (household_id, plan_date, slot, created_by)
    values (hh, current_date + 4, 'dinner', me);
    raise exception 'FAIL 9: a meal with neither recipe nor freeform was allowed';
  exception when check_violation then null;
  end;

  raise notice 'ALL 018 CHECKS PASSED';
end $$;
select 'all 018 behaviour checks passed' as result;
rollback;
