-- ============================================================================
-- 026 — What is on sale this week, matched to what we buy.
--
-- WHY
--   Erich asked about sales and coupons. No store sign-in, no scraping: the
--   family pastes the weekly ad (or a digital-coupon page) into the app,
--   parseAd() reads it into rows, and this is where those rows live and how
--   they meet the list. A digital coupon is only ever a "clip at <store>"
--   link — the store's own page does the clipping.
--
-- MATCHING
--   name_key is the ad line as the catalog would spell it (parseShopping's
--   normalizer), so "H-E-B Whole Milk 1 gal" keys to "whole milk". A list
--   item matches a sale at its store (any store, when the item has none) by
--   key equality first, then word-bounded containment either way. Expired
--   rows are filtered here, not swept: the paste handler deletes rows older
--   than 60 days, and that is enough.
--
-- SAFE TO RE-RUN.
-- ============================================================================

begin;

create table if not exists store_sales (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  store_id      uuid not null references stores(id) on delete cascade,
  name          text not null check (length(btrim(name)) > 0),
  name_key      text not null,
  price         text,
  deal          text,
  coupon        boolean not null default false,
  valid_from    date not null,
  valid_to      date not null,
  source        text not null default 'paste',
  created_by    uuid references members(id) on delete set null,
  created_at    timestamptz not null default now(),
  check (valid_to >= valid_from)
);

create index if not exists store_sales_live_idx
  on store_sales (household_id, store_id, valid_to);

alter table store_sales enable row level security;
drop policy if exists store_sales_all on store_sales;
create policy store_sales_all on store_sales for all using (true) with check (true);

comment on table store_sales is
  'One pasted ad line: what, at which store, for what, until when. name_key '
  'is the catalog spelling so the list can match it.';

-- Does a sale line answer to a list/catalog name? 0 = same key, 1 = same
-- name, 2 = one contains the other as whole words, null = no.
create or replace function sale_match_rank(p_sale_name text, p_sale_key text, p_item text)
returns int language sql immutable as $$
  select case
    when lower(p_sale_key) = lower(p_item) then 0
    when lower(p_sale_name) = lower(p_item) then 1
    when (' ' || lower(p_sale_key)  || ' ') like ('% ' || lower(p_item) || ' %')
      or (' ' || lower(p_sale_name) || ' ') like ('% ' || lower(p_item) || ' %')
      or (' ' || lower(p_item) || ' ')      like ('% ' || lower(p_sale_key) || ' %') then 2
    else null end;
$$;

-- The best current sale for every live, unbought item on the list.
create or replace function sales_for_list(p_household uuid)
returns table (item_id uuid, sale_id uuid, store_id uuid, store_name text,
               sale_name text, price text, deal text, coupon boolean, rank int)
language sql stable security definer set search_path = public as $$
  select i.id, s.id, s.store_id, st.name, s.name, s.price, s.deal, s.coupon, s.rank
    from shopping_items i
    cross join lateral (
      select x.*, sale_match_rank(x.name, x.name_key, i.name) as rank
        from store_sales x
       where x.household_id = i.household_id
         and (i.store_id is null or x.store_id = i.store_id)
         and x.valid_from <= current_date and x.valid_to >= current_date
         and sale_match_rank(x.name, x.name_key, i.name) is not null
       order by sale_match_rank(x.name, x.name_key, i.name), x.coupon desc, x.valid_to
       limit 1) s
    join stores st on st.id = s.store_id
   where i.household_id = p_household
     and i.cleared_at is null and not i.got;
$$;

-- Things this house buys (twice or more, or starred) that are on sale now
-- and NOT on the list — the "on sale this week" section.
create or replace function sales_for_catalog(p_household uuid)
returns table (catalog_name text, category text, sale_id uuid, store_id uuid, store_name text,
               sale_name text, price text, deal text, coupon boolean, rank int)
language sql stable security definer set search_path = public as $$
  select c.name, c.category, s.id, s.store_id, st.name, s.name, s.price, s.deal, s.coupon, s.rank
    from shopping_catalog c
    cross join lateral (
      select x.*, sale_match_rank(x.name, x.name_key, c.name) as rank
        from store_sales x
       where x.household_id = c.household_id
         and x.valid_from <= current_date and x.valid_to >= current_date
         and sale_match_rank(x.name, x.name_key, c.name) is not null
       order by sale_match_rank(x.name, x.name_key, c.name), x.coupon desc, x.valid_to
       limit 1) s
    join stores st on st.id = s.store_id
   where c.household_id = p_household
     and (c.times_added >= 2 or c.staple)
     and not exists (select 1 from shopping_items i
                      where i.household_id = c.household_id and i.cleared_at is null and not i.got
                        and lower(i.name) = lower(c.name))
   order by s.rank, c.name;
$$;

grant execute on function sale_match_rank(text, text, text) to anon, service_role;
grant execute on function sales_for_list(uuid)    to anon, service_role;
grant execute on function sales_for_catalog(uuid) to anon, service_role;

insert into schema_migrations (id) values ('026-store-sales') on conflict do nothing;

commit;

select count(*) as sales from store_sales;
