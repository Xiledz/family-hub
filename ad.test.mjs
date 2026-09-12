/* ===========================================================================
 * WEEKLY ADS
 *
 * A weekly ad, copied off a web page: brand-first names, prices on their own
 * line, "2/$5", "BOGO", "save $1.00", a validity line, sizes glued to names.
 * parseAd reads it into rows the list can match; name_key goes through the
 * same normalizer the catalog uses, so nothing here spells milk differently.
 * ========================================================================= */
import { parseAd, looksLikeAd, routeIntent } from './parse.js';

const NOW = new Date('2026-09-10T12:00:00Z');            // Thursday
const STORES = [
  { id: 'h1', name: 'HEB Harpers Trace', aliases: ['harpers'] },
  { id: 'h2', name: 'HEB on 1488',       aliases: ['1488', 'heb 1488'] },
  { id: 'k',  name: 'Kroger',            aliases: ['krogers'] },
  { id: 'c',  name: 'Costco',            aliases: [] },
];
const CAT = ['milk','eggs','ground beef','chicken breast','bananas','tortilla chips','strawberries','yogurt','bread']
  .map(name => ({ name }));
const OPTS = { stores: STORES, catalog: CAT, now: NOW };

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
  if (!ok) { console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); fail++; }
  else pass++;
};
const A = t => parseAd(t, OPTS);
const row = (t, i = 0) => { const r = A(t).rows[i]; return r ? [r.name, r.name_key, r.price, r.deal, r.coupon] : null; };

// --- (a) an HEB weekly-ad page ------------------------------------------------
const HEB = 'H-E-B Weekly Ad\nPrices good Wed 9/10 thru Tue 9/16\nProduce\nStrawberries 1 lb\n$2.99 ea\nBananas\n$0.49 lb\nMeat\nH-E-B Ground Beef 80% lean\n$3.99 lb\nBoneless Skinless Chicken Breast $1.97 lb\nDairy\nH-E-B Whole Milk 1 gal $2.79\nH-E-B Large Eggs 12 ct 2/$5\nSnacks\nTostitos Tortilla Chips 10-13 oz BOGO\nBlue Bell Ice Cream half gallon $5.99 with in-store coupon\nLimit 2\nView all';
const heb = A(HEB);
eq('validity from the header',    [heb.valid_from, heb.valid_to], ['2026-09-10', '2026-09-16']);
eq('the validity line is not a row', heb.rows.some(r => /prices good/i.test(r.name)), false);
eq('eight rows, nothing skipped', [heb.rows.length, heb.skipped], [8, 0]);
eq('price on the next line',      row(HEB, 0), ['Strawberries', 'strawberries', '$2.99 ea · 1 lb', null, false]);
eq('per-pound price',             row(HEB, 1), ['Bananas', 'bananas', '$0.49/lb', null, false]);
eq('brand-first name keys to the catalog word', row(HEB, 2)[1], 'ground beef');
eq('price on the same line',      row(HEB, 3), ['Boneless Skinless Chicken Breast', 'chicken breast', '$1.97/lb', null, false]);
eq('size moves out of the name',  row(HEB, 4), ['H-E-B Whole Milk', 'whole milk', '$2.79 · 1 gal', null, false]);
eq('2/$5 is a deal, not a price', row(HEB, 5), ['H-E-B Large Eggs', 'eggs', null, '2/$5 · 12 ct', false]);
eq('BOGO',                        row(HEB, 6)[3], 'BOGO · 10-13 oz');
eq('in-store coupon flags the row', row(HEB, 7), ['Blue Bell Ice Cream', 'blue bell ice cream', '$5.99 · half gallon', null, true]);
eq('category headers are not rows', heb.rows.some(r => /^(produce|meat|dairy|snacks)$/i.test(r.name)), false);
eq('"Limit 2" / "View all" are not rows', heb.rows.some(r => /limit|view all/i.test(r.name)), false);
eq('H-E-B alone is two stores: no guess', heb.store, null);

// --- (b) a Kroger digital-coupons page ----------------------------------------
const KRO = 'Kroger Digital Coupons\nThis week\'s deals\nKroger Large Grade A Eggs 12 ct\nSave $1.00\nExpires 09/16/2026\nClip Coupon\nChobani Greek Yogurt 5.3 oz\n10 for $10\nExp. 9/16\nTide Pods 42 ct\n$3 off\nKroger 2% Milk gallon\n$2.49 with card\nSimple Truth Organic Bananas\n25% off';
const kro = A(KRO);
eq('store from the header',       kro.store?.name, 'Kroger');
eq('a coupon page: every row is a coupon', kro.rows.every(r => r.coupon), true);
eq('save $1.00',                  row(KRO, 0), ['Kroger Large Grade A Eggs', 'eggs', null, 'save $1.00 · 12 ct', true]);
eq('10 for $10',                  row(KRO, 1)[3], '10/$10 · 5.3 oz');
eq('$3 off',                      row(KRO, 2)[3], '$3 off · 42 ct');
eq('with card rides in the price', row(KRO, 3), ['Kroger 2% Milk', 'milk', '$2.49 · gallon with card', null, true]);
eq('25% off',                     row(KRO, 4)[3], '25% off');
eq('expiry and clip lines are not rows', kro.rows.length, 5);
eq('no validity line: this week by default', [kro.valid_from, kro.valid_to], ['2026-09-10', '2026-09-16']);

// --- (c) a plain typed list ----------------------------------------------------
const PLAIN = 'milk 2.49, eggs 3/$5\nbread 1.99\nbananas .59 lb\nchicken 1.99/lb';
eq('two offers on one line are two rows', A(PLAIN).rows.length, 5);
eq('no dollar sign is still a price', row(PLAIN, 0), ['milk', 'milk', '$2.49', null, false]);
eq('3/$5 after the comma',         row(PLAIN, 1), ['eggs', 'eggs', null, '3/$5', false]);
eq('.59 lb',                       row(PLAIN, 3)[2], '$0.59/lb');
eq('1.99/lb',                      row(PLAIN, 4)[2], '$1.99/lb');
eq('"chicken" keys to itself when the catalog has no exact word', row(PLAIN, 4)[1], 'chicken');

// --- shapes and edges ----------------------------------------------------------
eq('buy one get one free',        row('Doritos buy one get one free')[3], 'buy one get one free');
eq('B1G1',                        row('Oreos B1G1')[3], 'BOGO');
eq('$1 off',                      row('Cheerios $1 off')[3], '$1 off');
eq('per lb',                      row('Ground Turkey $2.49 per lb')[2], '$2.49/lb');
eq('each',                        row('Avocados $0.99 each')[2], '$0.99 ea');
eq('a name with no price is dropped', A('Bananas\nApples $1.29').rows.map(r => r.name), ['Apples']);
eq('...and counted as skipped',   A('Bananas\nApples $1.29').skipped, 1);
eq('a trailing name with no price is skipped', A('Apples $1.29\nBananas').skipped, 1);
eq('a date range like 9/10 is not 9/$10', A('Valid 9/10 to 9/16\nMilk $2.49').rows.length, 1);
eq('valid range with month names',  (() => { const r = A('Valid Sep 10–16\nMilk $2.49'); return [r.valid_from, r.valid_to]; })(), ['2026-09-10', '2026-09-16']);
eq('cap at 300 rows',             A(Array.from({ length: 320 }, (_, i) => `Item ${i} $1.${String(i % 100).padStart(2, '0')}`).join('\n')).rows.length, 300);
eq('empty paste',                 A('').rows.length, 0);

// --- detection --------------------------------------------------------------------
eq('an ad is an ad',              looksLikeAd(HEB), true);
eq('a coupon page is an ad',      looksLikeAd(KRO), true);
eq('a grocery list is not an ad', looksLikeAd('milk\neggs\nbananas'), false);
eq('two priced lines are not an ad', looksLikeAd('milk 2.49\neggs 3.99'), false);
/* An ad's "9/10 thru 9/16" and "10-13 oz" read as dates, so the season
   test would claim it. The ad test runs first, everywhere a paste is read —
   pinned through the router. */
eq('an ad paste routes as an ad, not a season', routeIntent(HEB, { ...OPTS, members: [] }).intent, 'ad');
eq('a season still routes as a season', routeIntent('Orchestra — Addie\n9/15 6pm\n9/22 6pm\n9/29 6pm', { ...OPTS, members: [{ name: 'Addie', aliases: [] }] }).intent, 'season');
eq('a season is not an ad',       looksLikeAd('Orchestra — Addie\n9/15 6pm\n9/22 6pm\n9/29 6pm'), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
