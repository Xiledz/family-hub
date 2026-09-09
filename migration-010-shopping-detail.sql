-- ============================================================================
-- 010 — Two more stores, and what the list has to know about an item
--
-- WHY
--   Three things came out of using the list for real.
--
--   1. WHAT YOU HAVE TO CHOOSE YOURSELF. A box of cereal is a SKU — anyone
--      can grab it and it can be ordered online without a thought. Produce,
--      meat, seafood and the counters are judgement calls: ripeness, cut, how
--      brown the bananas are. Those are exactly the items a pickup order gets
--      wrong, so the list has to say which is which.
--
--   2. BRAND IS NOT THE ITEM. "Cheerios" and "cereal" are the same row to a
--      shopper and different rows to a coupon. Keeping brand separate is what
--      makes manufacturer offers matchable later without re-typing the list.
--
--   3. AISLES MOVE. A store re-sets its floor twice a year, and an aisle
--      number nobody has checked since spring is worse than no number — it
--      sends someone confidently to the wrong end of the store. Every aisle
--      row carries when it was last confirmed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Costco and Sam's. Warehouses run their own offers, so each is its own
-- flyer group — neither shares the HEB ad or Kroger's.
-- ---------------------------------------------------------------------------
insert into stores (household_id, name, flyer_group, sort_order)
select h.id, s.name, s.grp, s.ord
from households h,
     (values ('Costco', 'costco', 4), ('Sams Club', 'sams', 5)) as s(name, grp, ord)
where not exists (
  select 1 from stores x where x.household_id = h.id and x.name = s.name
);

-- ---------------------------------------------------------------------------
-- Item detail
-- ---------------------------------------------------------------------------
alter table shopping_items add column if not exists brand         text;
alter table shopping_items add column if not exists pick_yourself boolean not null default false;
alter table shopping_items add column if not exists online_ok     boolean not null default true;

comment on column shopping_items.pick_yourself is
  'Someone has to stand in front of this and choose it — ripeness, cut, size. '
  'Produce, meat, seafood, bakery, deli. These are the items a pickup order '
  'gets wrong.';
comment on column shopping_items.online_ok is
  'A packaged SKU that can be ordered for delivery or pickup without anyone '
  'judging it. The inverse of pick_yourself today; a separate column because '
  'the two stop being inverses the moment one store stocks something another '
  'does not.';
comment on column shopping_items.brand is
  'Kept apart from name so a manufacturer offer can be matched without '
  'reparsing. "Cheerios" is a brand; "cereal" is the item.';

alter table shopping_catalog add column if not exists brand         text;
alter table shopping_catalog add column if not exists pick_yourself boolean not null default false;

-- ---------------------------------------------------------------------------
-- Aisles, with an expiry on trust
-- ---------------------------------------------------------------------------
alter table store_aisles add column if not exists verified_at timestamptz;
alter table store_aisles add column if not exists verified_by uuid references members(id) on delete set null;

comment on column store_aisles.verified_at is
  'When someone last stood in this aisle and confirmed it. Stores re-set '
  'their floors; an unchecked number is worse than none, because it is '
  'followed confidently.';

-- ---------------------------------------------------------------------------
-- Backfill the two flags on anything already on a list, from its category.
-- ---------------------------------------------------------------------------
update shopping_items
   set pick_yourself = (category in ('produce','meat','seafood','bakery','deli')),
       online_ok     = (category not in ('produce','meat','seafood','bakery','deli'))
 where true;

update shopping_catalog
   set pick_yourself = (category in ('produce','meat','seafood','bakery','deli'))
 where true;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
select 'stores' as check,
       string_agg(name || ' [' || coalesce(flyer_group,'-') || ']', ', ' order by sort_order) as detail
  from stores where deleted_at is null
union all
select 'item columns',
       string_agg(column_name, ', ' order by column_name)
  from information_schema.columns
 where table_name = 'shopping_items'
   and column_name in ('brand','pick_yourself','online_ok')
union all
select 'aisle columns',
       string_agg(column_name, ', ' order by column_name)
  from information_schema.columns
 where table_name = 'store_aisles' and column_name in ('verified_at','verified_by');
