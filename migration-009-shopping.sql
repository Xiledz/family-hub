-- ============================================================================
-- 009 — Shopping
--
-- Phase 1 of four. The tables here are shaped for all four so the later ones
-- are additions rather than rewrites:
--
--   1 (this)  stores, items, categories, check-off, adding by text
--   2         aisle order per store, so the list sorts into a walking path
--   3         recipes that push their ingredients onto the list
--   4         weekly-ad sales matched against what is on the list
--
-- TWO DECISIONS WORTH THE COMMENT
--
--   CATEGORY IS A CLOSED VOCABULARY, exactly like event roles. It is the hinge
--   the whole thing turns on: aisle order is per-category, recipes emit
--   categorised ingredients, and sale matching groups by category. Free text
--   here would quietly break all three, and it would break them a month from
--   now rather than today.
--
--   A CHECKED ITEM IS NOT DELETED. It stays on the list struck through, so
--   nobody has to text "did you get the milk?". It leaves when a new trip
--   starts. Buying the same thing next week creates a NEW row on the NEW
--   list — history stays honest, and the catalog remembers you buy it often.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Stores
--
-- flyer_group exists because the two HEBs run the same weekly ad but have
-- different floor plans. Sales are looked up per GROUP; aisles per STORE.
-- One column now saves a migration in phase 4.
-- ---------------------------------------------------------------------------
create table if not exists stores (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name         text not null,
  flyer_group  text,
  sort_order   int  not null default 0,
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (household_id, name)
);

-- ---------------------------------------------------------------------------
-- The category vocabulary. Ordered roughly as a store is walked, so a list
-- sorts sensibly on day one, before anyone has entered a single aisle number.
-- ---------------------------------------------------------------------------
create table if not exists shopping_categories (
  name       text primary key,
  sort_order int not null
);

insert into shopping_categories (name, sort_order) values
  ('produce', 10), ('bakery', 20), ('deli', 30), ('meat', 40), ('seafood', 50),
  ('dairy', 60), ('eggs', 70), ('frozen', 80), ('breakfast', 90),
  ('canned', 100), ('pantry', 110), ('baking', 120), ('condiments', 130),
  ('snacks', 140), ('beverages', 150), ('household', 160), ('paper', 170),
  ('cleaning', 180), ('personal', 190), ('baby', 200), ('pet', 210),
  ('pharmacy', 220), ('other', 999)
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- Phase 2 lives here. Empty until someone walks a store with the HEB app open.
-- Absent a row, the list falls back to shopping_categories.sort_order.
-- ---------------------------------------------------------------------------
create table if not exists store_aisles (
  store_id uuid not null references stores(id) on delete cascade,
  category text not null references shopping_categories(name),
  aisle    text,
  sort_order int not null default 0,
  primary key (store_id, category)
);

-- ---------------------------------------------------------------------------
-- The list itself
-- ---------------------------------------------------------------------------
create table if not exists shopping_items (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  store_id     uuid references stores(id) on delete set null,   -- null = any store
  name         text not null,
  qty          text,                                            -- "2 lbs", "a dozen"
  category     text not null default 'other' references shopping_categories(name),
  note         text,

  got          boolean not null default false,
  got_at       timestamptz,
  got_by       uuid references members(id) on delete set null,

  added_by     uuid references members(id) on delete set null,
  source       text not null default 'web',                     -- 'web' | 'sms' | 'recipe'
  created_at   timestamptz not null default now(),

  -- Set when a new trip starts. Nulls are the live list; the rest is history.
  cleared_at   timestamptz
);

create index if not exists shopping_live_idx
  on shopping_items (household_id, got, category) where cleared_at is null;

-- ---------------------------------------------------------------------------
-- What this household buys. Powers one-tap re-adding, and remembers the
-- category so nobody has to classify milk twice.
-- ---------------------------------------------------------------------------
create table if not exists shopping_catalog (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name         text not null,
  category     text not null default 'other' references shopping_categories(name),
  store_id     uuid references stores(id) on delete set null,
  times_added  int  not null default 1,
  last_added_at timestamptz not null default now(),
  unique (household_id, name)
);

-- ---------------------------------------------------------------------------
-- Start a new trip: everything bought drops off the live list and becomes
-- history. Anything still unbought carries over, because it is still needed.
-- ---------------------------------------------------------------------------
create or replace function clear_bought(hh uuid) returns int as $$
declare n int;
begin
  update shopping_items
     set cleared_at = now()
   where household_id = hh and cleared_at is null and got = true;
  get diagnostics n = row_count;
  return n;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- Seed the three stores. Both HEBs share a flyer group; Kroger runs its own.
-- Rename them to whatever you actually call them.
-- ---------------------------------------------------------------------------
insert into stores (household_id, name, flyer_group, sort_order)
select h.id, s.name, s.grp, s.ord
from households h,
     (values ('HEB', 'heb', 1), ('HEB 2', 'heb', 2), ('Kroger', 'kroger', 3))
       as s(name, grp, ord)
where not exists (
  select 1 from stores x where x.household_id = h.id and x.name = s.name
);

-- ---------------------------------------------------------------------------
-- A fourth question the text number can ask: event, or shopping?
-- ---------------------------------------------------------------------------
alter table sms_pending drop constraint if exists sms_pending_kind_check;
alter table sms_pending add  constraint sms_pending_kind_check
  check (kind in ('confirm_date','edit_scope','confirm_time','route_intent'));

-- ---------------------------------------------------------------------------
-- RLS, matching the rest of the schema.
-- ---------------------------------------------------------------------------
alter table stores              enable row level security;
alter table shopping_items      enable row level security;
alter table shopping_catalog    enable row level security;
alter table store_aisles        enable row level security;
alter table shopping_categories enable row level security;

drop policy if exists stores_all on stores;
create policy stores_all on stores for all using (true) with check (true);
drop policy if exists shopping_items_all on shopping_items;
create policy shopping_items_all on shopping_items for all using (true) with check (true);
drop policy if exists shopping_catalog_all on shopping_catalog;
create policy shopping_catalog_all on shopping_catalog for all using (true) with check (true);
drop policy if exists store_aisles_all on store_aisles;
create policy store_aisles_all on store_aisles for all using (true) with check (true);
drop policy if exists shopping_categories_all on shopping_categories;
create policy shopping_categories_all on shopping_categories for all using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
select 'stores' as t, string_agg(name || ' (' || coalesce(flyer_group,'-') || ')', ', ' order by sort_order) as detail
  from stores where deleted_at is null
union all
select 'categories', count(*)::text from shopping_categories
union all
select 'items', count(*)::text from shopping_items
union all
select 'sms_pending kinds', 'confirm_date, edit_scope, confirm_time, route_intent';
