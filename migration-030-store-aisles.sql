-- ============================================================================
-- 030 — Store aisle maps, from published store guides only.
--
-- WHAT WAS FOUND (2026-09-14)
--   The 15 rows 011 seeded on "HEB on 1488" were checked line by line against
--   H-E-B's published guide for store 638, North Woodlands Market H-E-B,
--   3601 FM 1488, The Woodlands (the DB alias "north woodlands"):
--     https://images.heb.com/is/content/HEBGrocery/Store%20Finder%20Layouts/guide-the-woodlands-638.pdf
--   They match that store exactly (bread 5, tortillas 5, pasta 7, rice 8,
--   soup 8, condiments 6, canned 9, baking 10, coffee 11, cereal 13, candy
--   14, sodas 31, bath tissue 32, foil 33, cleaners 34, laundry 35, baby 36,
--   hair 37, vitamins 42, cough & cold 43). They are on the RIGHT store row.
--
--   That guide, like every H-E-B guide, does not number the perimeter
--   (produce, meat, seafood, deli, bakery cases, dairy, eggs, frozen), so
--   those categories still have no row here. It DOES place water, beer and
--   wine, batteries and hardware, and those are folded into the existing
--   beverages and household rows below. Nothing in this file is inferred.
--
-- NOT MAPPED, DELIBERATELY (never invent an aisle number)
--   HEB Harpers Trace (store 757, 10200 Hwy 242, Conroe): heb.com publishes
--     no store guide for it — the store page carries no layout link and
--     guide-conroe-757 / guide-the-woodlands-757 / guide-spring-757 all 404.
--   Kroger Cochran's Crossing (#00316, 4747 Research Forest Dr): Kroger
--     publishes no aisle directory; its per-product aisle needs a signed-in
--     store session, which is the home-PC plan.
--   Costco, Sams Club: warehouses publish nothing; a guessed section map
--     would be a guess. Category order (shopping_categories) applies.
--
-- SAFE TO RE-RUN.
-- ============================================================================

begin;

-- HEB on 1488 = North Woodlands Market H-E-B #638. Source, read 2026-09-14:
-- https://images.heb.com/is/content/HEBGrocery/Store%20Finder%20Layouts/guide-the-woodlands-638.pdf
insert into store_aisles (store_id, category, aisle, sort_order, verified_at)
select s.id, a.category, a.aisle, a.ord, now()
from stores s,
     (values
       ('beverages',  '31 sodas · 11 coffee, tea, sports drinks, Kool-Aid · 14 juice · water on the back wall · beer 3, wine 1', 11),
       ('household',  '33 foil, bags, trash bags · 24 bulbs, hardware · 22-23 kitchen gadgets, bakeware · batteries at the checkstands', 33),
       ('pantry',     '7-8 rice, pasta, mac & cheese, soup · 5 peanut butter, honey, jam · 7 international, Goya, kosher', 7),
       ('baking',     '10 flour, sugar, spices, oil, cake mixes · 9 Jell-O, pudding, marshmallows', 10)
     ) as a(category, aisle, ord)
where s.name = 'HEB on 1488' and s.deleted_at is null
on conflict (store_id, category) do update
  set aisle = excluded.aisle, sort_order = excluded.sort_order, verified_at = excluded.verified_at;

insert into schema_migrations (id) values ('030-store-aisles') on conflict do nothing;

commit;

select s.name, count(a.*) as aisle_rows
  from stores s left join store_aisles a on a.store_id = s.id
 where s.deleted_at is null group by s.name order by s.name;
