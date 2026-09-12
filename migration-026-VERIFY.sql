-- ============================================================================
-- 026 VERIFY — run after migration-026-store-sales.sql. Ends in rollback.
-- ============================================================================
begin;

do $$
declare hh uuid := '00000000-0000-0000-0000-000000000001'; heb uuid; kro uuid; costco uuid; erich uuid;
        i_milk uuid; i_eggs uuid; i_beef uuid; i_whole uuid; n int; r record;
begin
  select id into heb    from stores where household_id = hh and name = 'HEB on 1488' and deleted_at is null;
  select id into kro    from stores where household_id = hh and name = 'Kroger' and deleted_at is null;
  select id into costco from stores where household_id = hh and name = 'Costco' and deleted_at is null;
  select id into erich  from members where household_id = hh and name = 'Erich' and deleted_at is null;
  if heb is null or kro is null or costco is null then raise exception 'FAIL 0: stores missing'; end if;

  insert into store_sales (household_id, store_id, name, name_key, price, deal, coupon, valid_from, valid_to, created_by) values
    (hh, heb, 'H-E-B Whole Milk', 'whole milk', '$2.79 · 1 gal', null, false, current_date - 1, current_date + 5, erich),
    (hh, kro, 'Kroger Large Grade A Eggs', 'eggs', null, 'save $1.00', true, current_date - 10, current_date - 3, erich),  -- expired
    (hh, kro, 'Kroger Ground Beef 80%', 'ground beef', '$3.99/lb', null, true, current_date, current_date + 6, erich),
    (hh, heb, 'Bananas', 'bananas', '$0.49/lb', null, false, current_date, current_date + 6, erich);

  insert into shopping_items (household_id, name, category, store_id, added_by) values
    (hh, 'probe milk', 'dairy', heb, erich) returning id into i_milk;
  insert into shopping_items (household_id, name, category, store_id, added_by) values
    (hh, 'eggs', 'eggs', null, erich) returning id into i_eggs;
  insert into shopping_items (household_id, name, category, store_id, added_by) values
    (hh, 'ground beef', 'meat', costco, erich) returning id into i_beef;
  insert into shopping_items (household_id, name, category, store_id, added_by) values
    (hh, 'milk', 'dairy', null, erich) returning id into i_whole;

  -- 1: containment — "probe milk" is not milk, but "milk" (any store) meets "whole milk"
  select count(*) into n from sales_for_list(hh) where item_id = i_milk;
  if n <> 0 then raise exception 'FAIL 1: "probe milk" matched a sale it should not'; end if;
  select * into r from sales_for_list(hh) where item_id = i_whole;
  if r.item_id is null then raise exception 'FAIL 1b: milk (any store) found no sale'; end if;
  if r.store_name <> 'HEB on 1488' or r.price <> '$2.79 · 1 gal' or r.rank <> 2 then
    raise exception 'FAIL 1c: wrong match for milk: % % %', r.store_name, r.price, r.rank; end if;

  -- 2: an expired sale is invisible
  select count(*) into n from sales_for_list(hh) where item_id = i_eggs;
  if n <> 0 then raise exception 'FAIL 2: expired eggs coupon surfaced'; end if;

  -- 3: a store mismatch is no match (beef is on the Costco list; the sale is Kroger's)
  select count(*) into n from sales_for_list(hh) where item_id = i_beef;
  if n <> 0 then raise exception 'FAIL 3: Kroger sale matched a Costco item'; end if;
  update shopping_items set store_id = null where id = i_beef;
  select * into r from sales_for_list(hh) where item_id = i_beef;
  if r.item_id is null or r.rank <> 0 or not r.coupon then raise exception 'FAIL 3b: any-store beef did not meet the Kroger coupon'; end if;

  -- 4: the "on sale this week" section: bananas are bought often and not on the list
  insert into shopping_catalog (household_id, name, category, times_added) values (hh, 'bananas', 'produce', 5)
  on conflict (household_id, name) do update set times_added = 5;
  select count(*) into n from sales_for_catalog(hh) where catalog_name = 'bananas';
  if n <> 1 then raise exception 'FAIL 4: bananas not offered (% rows)', n; end if;
  -- ...until they are on the list
  insert into shopping_items (household_id, name, category, added_by) values (hh, 'bananas', 'produce', erich);
  select count(*) into n from sales_for_catalog(hh) where catalog_name = 'bananas';
  if n <> 0 then raise exception 'FAIL 4b: bananas still offered while on the list'; end if;
  -- ...and a once-bought, unstarred thing is not offered
  insert into shopping_catalog (household_id, name, category, times_added) values (hh, 'whole milk', 'dairy', 1)
  on conflict (household_id, name) do update set times_added = 1, staple = false;
  select count(*) into n from sales_for_catalog(hh) where catalog_name = 'whole milk';
  if n <> 0 then raise exception 'FAIL 4c: a once-bought item was offered'; end if;

  -- 5: a bought item drops out
  update shopping_items set got = true where id = i_whole;
  select count(*) into n from sales_for_list(hh) where item_id = i_whole;
  if n <> 0 then raise exception 'FAIL 5: a bought item still carries a sale'; end if;

  -- 6: the check constraints hold
  begin
    insert into store_sales (household_id, store_id, name, name_key, valid_from, valid_to)
    values (hh, heb, 'x', 'x', current_date, current_date - 1);
    raise exception 'FAIL 6: valid_to before valid_from was allowed';
  exception when check_violation then null;
  end;
end $$;

-- 7: THE APP PATH — anon pastes, reads, and replaces
set local role anon;
do $$
declare hh uuid := '00000000-0000-0000-0000-000000000001'; heb uuid; n int;
begin
  select id into heb from stores where household_id = hh and name = 'HEB on 1488';
  insert into store_sales (household_id, store_id, name, name_key, price, valid_from, valid_to)
  values (hh, heb, 'Strawberries', 'strawberries', '$2.99 ea', current_date, current_date + 6);
  select count(*) into n from sales_for_list(hh);
  if n < 1 then raise exception 'FAIL 7: anon cannot read sales_for_list'; end if;
  select count(*) into n from sales_for_catalog(hh);
  delete from store_sales where household_id = hh and store_id = heb and valid_to >= current_date;
  get diagnostics n = row_count;
  if n < 1 then raise exception 'FAIL 7b: anon cannot replace a store''s week'; end if;
end $$;
reset role;

select 'all 026 behaviour checks passed' as result;
rollback;
