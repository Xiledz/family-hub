-- ============================================================================
-- 030 VERIFY — run after migration-030-store-aisles.sql. Ends in rollback.
-- ============================================================================
begin;

do $$
declare sid uuid; n int; t text;
begin
  select id into sid from stores where name = 'HEB on 1488' and deleted_at is null;
  if sid is null then raise exception 'FAIL 0: no store named HEB on 1488'; end if;

  -- 1: the four refreshed rows carry what the 638 guide says
  select aisle into t from store_aisles where store_id = sid and category = 'beverages';
  if t not like '%water on the back wall%' or t not like '%wine 1%' then raise exception 'FAIL 1: beverages = %', t; end if;
  select aisle into t from store_aisles where store_id = sid and category = 'household';
  if t not like '%checkstands%' then raise exception 'FAIL 1b: household = %', t; end if;

  -- 2: 011's rows are all still there (15 categories), walking order intact
  select count(*) into n from store_aisles where store_id = sid;
  if n <> 15 then raise exception 'FAIL 2: % rows on HEB on 1488, expected 15', n; end if;
  if (select sort_order from store_aisles where store_id = sid and category = 'bakery') >=
     (select sort_order from store_aisles where store_id = sid and category = 'beverages') then
    raise exception 'FAIL 2b: bakery does not come before beverages'; end if;

  -- 3: nothing was invented for the stores with no published guide
  select count(*) into n from store_aisles a join stores s on s.id = a.store_id
   where s.name in ('HEB Harpers Trace', 'Kroger', 'Costco', 'Sams Club');
  if n <> 0 then raise exception 'FAIL 3: % aisle rows on unmapped stores', n; end if;

  -- 4: no perimeter row was invented either (the guide does not number them)
  select count(*) into n from store_aisles where store_id = sid
     and category in ('produce','meat','seafood','deli','dairy','eggs','frozen','other');
  if n <> 0 then raise exception 'FAIL 4: % perimeter rows invented', n; end if;
end $$;

-- 5: THE APP PATH — anon reads the map (SHOP.load selects store_aisles)
set local role anon;
do $$
declare n int;
begin
  select count(*) into n from store_aisles a join stores s on s.id = a.store_id where s.name = 'HEB on 1488';
  if n <> 15 then raise exception 'FAIL 5: anon sees % rows', n; end if;
end $$;
reset role;

select 'all 030 behaviour checks passed' as result;
rollback;
