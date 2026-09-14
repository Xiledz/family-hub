/* ===========================================================================
 * SHOPPING PARSER
 *
 * Category is a closed vocabulary for the same reason event roles are: aisle
 * order, recipe ingredients and sale matching all key off it. A free-text
 * category would break all three, and it would break them a month from now
 * rather than today. So anything unrecognised lands on 'other' — never on a
 * value the parser invented.
 * ========================================================================= */
import { parseShopping, SHOP_CATEGORIES, looksMerged, skeleton, repairName } from './parse.js';

const STORES = [
  { id: 'h1', name: 'HEB Harpers Trace', aliases: ['harpers','harper','harpers trace','242'] },
  { id: 'h2', name: 'HEB on 1488',       aliases: ['1488','heb 1488','north woodlands'] },
  { id: 'k',  name: 'Kroger',            aliases: ['krogers','cochrans'] },
  { id: 'c',  name: 'Costco',            aliases: [] },
  { id: 's',  name: 'Sams Club',         aliases: ['sams',"sam's"] },
];
const P = (s, catalog) => parseShopping(s, { stores: STORES, catalog });
const names = s => P(s).items.map(i => i.name);
const cats  = s => P(s).items.map(i => i.category);

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
  if (!ok) { console.log('  got  ' + JSON.stringify(got)); console.log('  want ' + JSON.stringify(want)); fail++; } else pass++;
};

// --- the verb is not the item ---------------------------------------------
eq('buy milk',           names('buy milk'), ['milk']);
eq('we need X',          names('we need bread'), ['bread']);
eq('add X to the list',  names('add ziploc bags to the shopping list'), ['ziploc bags']);
eq('pick up X',          names('pick up dog food'), ['dog food']);

// --- several items, however they are strung together ----------------------
eq('commas',             names('buy milk, eggs, bread'), ['milk','eggs','bread']);
eq('oxford and',         names('milk, eggs, and bread'), ['milk','eggs','bread']);
eq('plain and',          names('milk and eggs'), ['milk','eggs']);
eq('newlines',           names('milk\neggs\nbread'), ['milk','eggs','bread']);

/* "and" is not always a separator. Splitting on every one of them turns one
   box of macaroni into two items nobody can find in the store. */
eq('mac and cheese is one', names('buy mac and cheese'), ['mac and cheese']);
eq('half and half is one',  names('buy half and half'), ['half and half']);

/* --- dictation: no commas at all ------------------------------------------
   Spoken lists arrive as one breath. Nothing in the punctuation can tell
   "ground beef" (one thing) from "milk eggs" (two things) — only knowing what
   things are called can. This is the case that started it. */
eq('the run-on that started this',
   names('milk eggs 2 pounds of ground beef'), ['milk','eggs','ground beef']);
eq('run-on keeps the quantity',
   P('milk eggs 2 pounds of ground beef').items[2].qty, '2 pounds');
eq('four bare items',    names('buy milk eggs bread bananas'), ['milk','eggs','bread','bananas']);
eq('two-word items hold together',
   names('we need paper towels toilet paper and trash bags'),
   ['paper towels','toilet paper','trash bags']);
eq('brands hold together',
   names('grab honey nut cheerios doritos and a gallon of whole milk'),
   ['honey nut cheerios','doritos','whole milk']);
eq('store still comes off a run-on', P('kroger diapers milk').store.name, 'Kroger');
eq('...and the rest still splits',  names('kroger diapers milk'), ['diapers','milk']);
eq('quantities restart an item',
   names('2 lbs ground beef 3 cans black beans mac and cheese'),
   ['ground beef','black beans','mac and cheese']);
eq('notes survive a run-on',
   [P('milk eggs bread, chips for the party').items.length,
    P('milk eggs bread, chips for the party').items[3].note], [4, 'the party']);

/* Where it genuinely cannot know — two unfamiliar words together — it keeps
   them as one item rather than guessing a split. A merged item is visible and
   takes one tap to fix; a wrongly split one leaves two half-items that both
   look real and neither is. */
eq('unknown words stay together', names('buy flux capacitor'), ['flux capacitor']);
eq('unknown next to known still splits', names('buy flux capacitor milk'), ['flux capacitor','milk']);

/* --- the catalog must not teach the parser its own mistakes ---------------
   The household catalog is consulted BEFORE the built-in lexicon, because it
   knows what this family actually buys. It is also where bad parses end up.
   A single early mistake wrote "milk eggs" into the catalog; longest-match
   then found it and merged those two items on every list afterwards. The
   system had learned its own error and would never unlearn it.

   So a LEARNED phrase is only trusted when it does not come apart into things
   already known separately. Real products survive; accidents do not. */
const POISON = [{ name: 'milk eggs', category: 'other' },
                { name: 'bread bananas', category: 'other' },
                { name: "dave's killer bread", category: 'bakery' }];

eq('a poisoned catalog cannot merge',
   parseShopping('milk eggs 2 pounds of ground beef', { catalog: POISON })
     .items.map(i => i.name), ['milk','eggs','ground beef']);
eq('...on any run-on',
   parseShopping('buy milk eggs bread bananas', { catalog: POISON })
     .items.map(i => i.name), ['milk','eggs','bread','bananas']);
eq('a real learned product still wins',
   parseShopping("dave's killer bread and milk", { catalog: POISON })
     .items.map(i => i.name), ["dave's killer bread",'milk']);
eq('learned brands the lexicon has never heard of',
   parseShopping("kodiak cakes and rao's marinara",
     { catalog: [{ name: 'kodiak cakes' }, { name: "rao's marinara" }] })
     .items.map(i => i.name), ['kodiak cakes',"rao's marinara"]);

eq('milk eggs comes apart',      looksMerged('milk eggs'), true);
eq('bread bananas comes apart',  looksMerged('bread bananas'), true);
eq('ground beef does not',       looksMerged('ground beef'), false);
eq('paper towels does not',      looksMerged('paper towels'), false);
eq('a lexicon phrase never does',looksMerged('honey nut cheerios'), false);
eq('unknown words do not',       looksMerged('flux capacitor'), false);
eq('a single word never does',   looksMerged('milk'), false);

// --- brands carry their own category --------------------------------------
eq('cereal brand',   cats('honey nut cheerios'), ['breakfast']);
eq('snack brand',    cats('doritos'),            ['snacks']);
eq('cleaning brand', cats('tide'),               ['cleaning']);
eq('paper brand',    cats('charmin'),            ['paper']);
eq('baby brand',     cats('pampers'),            ['baby']);
eq('frozen brand',   cats('blue bell'),          ['frozen']);
/* A box of macaroni is not in the dairy case, however much the word "cheese"
   suggests otherwise. Specific rules run before general ones. */
eq('mac and cheese is pantry', cats('mac and cheese'), ['pantry']);

/* --- what you have to choose yourself ------------------------------------
   A packaged item is a SKU; anyone can grab it and it can be ordered online.
   Produce, meat, seafood and the counters are judgement calls, and the list
   has to say so — those are the ones a pickup order gets wrong. */
const fresh = s => P(s).items.map(i => i.pickYourself);
eq('produce is picked',   fresh('bananas'),      [true]);
eq('meat is picked',      fresh('ground beef'),  [true]);
eq('seafood is picked',   fresh('salmon'),       [true]);
eq('cereal is not',       fresh('cheerios'),     [false]);
eq('detergent is not',    fresh('tide'),         [false]);
eq('online is the inverse',
   P('bananas, cheerios').items.map(i => i.onlineOk), [false, true]);

// --- quantities -----------------------------------------------------------
eq('weight',    [P('2 lbs ground beef').items[0].qty, P('2 lbs ground beef').items[0].name], ['2 lbs','ground beef']);
eq('a dozen',   [P('a dozen eggs').items[0].qty, P('a dozen eggs').items[0].name], ['a dozen','eggs']);
eq('cans',      [P('3 cans black beans').items[0].qty, P('3 cans black beans').items[0].name], ['3 cans','black beans']);
eq('of is not the name', [P('3 bottles of coke').items[0].qty, P('3 bottles of coke').items[0].name], ['3 bottles','coke']);
eq('bare item has no qty', P('milk').items[0].qty, null);
eq('"a" alone is not a qty', P('a pineapple').items[0].name, 'pineapple');

// --- stores ---------------------------------------------------------------
eq('colon prefix',  P('kroger: tylenol').store.name, 'Kroger');
eq('at STORE',      P('at harpers get bananas').store.name, 'HEB Harpers Trace');
eq('store leaves the item', names('kroger: tylenol'), ['tylenol']);
eq('no store named', P('buy milk').store, null);

/* --- a store is a switch, not a prefix ------------------------------------
   One trip covers two stores and it gets said in one breath. Looking only at
   the front of the message turned "Kroger" into a grocery item. */
const withStore = s => P(s).items.map(i => (i.store ? i.store.name : '-') + ':' + i.name);
eq('store switches mid-sentence',
   withStore('milk eggs kroger diapers costco paper towels'),
   ['-:milk','-:eggs','Kroger:diapers','Costco:paper towels']);
eq('noise words are not items',
   withStore('ground beef list kroger diapers'), ['-:ground beef','Kroger:diapers']);
eq('the verb can follow the store', names('at 1488 grab milk'), ['milk']);
eq('longest store name wins',      P('at 1488 grab milk').items[0].store.name, 'HEB on 1488');
eq('a leading store still covers everything',
   withStore('kroger: tylenol and diapers'), ['Kroger:tylenol','Kroger:diapers']);

/* --- dictation gets brand names wrong ------------------------------------
   Brands are not words, so no spelling rule recovers them. "Harbough" and
   "Haribo" share a consonant skeleton, and that is recoverable. Only applied
   where nothing else recognised the word, and always reported back — a
   confident wrong guess is worse than none. */
eq('skeletons match across spellings', skeleton('harbough'), skeleton('haribo'));
eq('haribo',   repairName('harbough').name, 'haribo');
eq('doritos',  repairName('dorritoes').name, 'doritos');
eq('charmin',  repairName('charmen').name,  'charmin');
eq('clorox',   repairName('klorox').name,   'clorox');
eq('zyrtec',   repairName('zyrtech').name,  'zyrtec');
/* A word that already means something is never "repaired". */
eq('a real item is left alone',   repairName('banana'), null);
eq('milk is left alone',          repairName('milk'), null);
eq('unknown stays unknown',       repairName('flux'), null);

eq('a repair reaches the item',   names('buy harbough gummies')[0], 'haribo gummies');
eq('...and says what it heard',   P('buy harbough gummies').items[0].heardAs, 'harbough');
/* Two mis-heard brands used to merge into one row reading "tide charmin",
   because the repair ran after the split instead of before it. */
eq('two misheard brands stay two items',
   names('costco tighed charmen'), ['tide','charmin']);

/* --- verbs said again halfway through -------------------------------------
   A verb is stripped from the front of a message, but people say them again
   mid-sentence: "...Kroger diapers, buy Haribo gummies, add bike". Those were
   landing on the list as groceries called "by" and "add bike". "by" is here
   because that is what speech-to-text hears when someone says "buy". */
eq('mid-sentence buy is not an item', names('milk buy eggs'), ['milk','eggs']);
eq('mis-heard buy is not either',     names('diapers by haribo'), ['diapers','haribo']);
eq('mid-sentence add is not an item', names('gummies add bike'), ['gummies','bike']);
eq('get and grab likewise',           names('buy milk and get eggs'), ['milk','eggs']);
eq('pick up is not two items',        names('pick up bananas'), ['bananas']);

/* The whole dictated message that exposed all of this, in one breath. */
eq('the full run-on',
   withStore('milk eggs 2 pounds of ground beef ground beef list kroger diapers ' +
             'by harbo gummies add bike'),
   ['-:milk','-:eggs','-:ground beef','Kroger:diapers','Kroger:haribo gummies',
    'Kroger:bike']);

/* --- said twice is still one thing ---------------------------------------
   "ground beef ... 2 pounds ground beef" means two pounds, not two rows. The
   mention carrying the quantity is the one that survives. */
eq('repeats collapse', names('ground beef and 2 lbs ground beef'), ['ground beef']);
eq('the quantity survives', P('ground beef and 2 lbs ground beef').items[0].qty, '2 lbs');
eq('same item at two stores is two rows',
   withStore('kroger milk costco milk'), ['Kroger:milk','Costco:milk']);

/* One case, always. A phone capitalises the first word of a text, so "Milk"
   and "milk" would otherwise become two catalog rows that never learn from
   each other. */
eq('names are lower case', names('Milk, Eggs, Ground Beef'), ['milk','eggs','ground beef']);

/* --- a brand is an adjective ----------------------------------------------
   "Nutella sticks" is one thing to buy. Splitting on the longest known word
   alone got this backwards and produced a brand with no product and a product
   with no meaning — "nutella" and "sticks", neither findable in a store.
   A brand introduces an item; it does not end one. */
eq('nutella sticks',   names('nutella sticks'),      ['nutella sticks']);
eq('tide pods',        names('tide pods'),           ['tide pods']);
eq('dove soap',        names('dove soap'),           ['dove soap']);
eq('haribo gummies',   names('haribo gummies'),      ['haribo gummies']);
eq('multi-word brand', names('blue bell vanilla'),   ['blue bell vanilla']);

/* But a brand does not swallow the whole list. Another brand, a quantity, a
   filler word or a core grocery all start a new item. */
eq('brand then brand',   names('tide charmin'),               ['tide','charmin']);
eq('brand then core',    names('doritos milk eggs'),          ['doritos','milk','eggs']);
eq('and still separates',names('nutella sticks and milk'),    ['nutella sticks','milk']);
eq('a quantity restarts',names('2 lbs ground beef doritos'),  ['ground beef','doritos']);
eq('brand then produce', names('cheerios bananas'),           ['cheerios','bananas']);

/* Quotes are the escape hatch for anything the lexicon has never heard of. */
eq('quotes force one item',
   names('buy "kodiak power cakes" and milk'), ['kodiak power cakes','milk']);

/* --- and the correction has to STICK --------------------------------------
   looksMerged guards the catalog against learning its own mistakes, but it
   was rejecting "haribo gummies" too — so correcting that once never stuck,
   because the catalog refused to learn the very thing the fix was for. A
   phrase opening with a brand is a product name, not an accident. */
eq('brand-led phrases are learnable', looksMerged('haribo gummies'), false);
eq('...and nutella sticks',           looksMerged('nutella sticks'), false);
eq('...and blue bell vanilla',        looksMerged('blue bell vanilla'), false);
eq('a real accident still is',        looksMerged('milk eggs'), true);

eq('a learned phrase wins next time',
   parseShopping('kodiak power cakes and milk',
     { catalog: [{ name: 'kodiak power cakes', category: 'breakfast' }] })
     .items.map(i => i.name), ['kodiak power cakes','milk']);

/* --- brand + flavour + item -----------------------------------------------
   A brand is an adjective: it introduces an item, it never ends one. What
   follows may be a flavour, a variety, a size descriptor, or several of
   them, before the noun finally arrives. "Blue Bell homemade vanilla ice
   cream" is five words past the brand, so a three-word tail chopped it and
   left an orphan "cream" behind. */
eq('brand flavour item',
   names('haribo gold bears gummy candy'), ['haribo gold bears gummy candy']);
eq('five past the brand',
   names('blue bell homemade vanilla ice cream'), ['blue bell homemade vanilla ice cream']);
eq('two-word flavour',
   names('chobani strawberry banana greek yogurt'), ['chobani strawberry banana greek yogurt']);
eq('variety then noun',
   names('campbells chicken noodle soup'), ['campbells chicken noodle soup']);
eq('dove sensitive skin body wash',
   names('dove sensitive skin body wash'), ['dove sensitive skin body wash']);
eq('eggo blueberry waffles',
   names('eggo blueberry waffles'), ['eggo blueberry waffles']);
eq('tide original scent pods',
   names('tide original scent pods'), ['tide original scent pods']);

/* The tail is not infinite. A bare staple after a product name is a new
   item, not another flavour word — otherwise one brand swallows the list. */
eq('a staple ends the tail',
   names('blue bell vanilla and milk'), ['blue bell vanilla','milk']);
eq('brand then staples',
   names('doritos milk eggs'), ['doritos','milk','eggs']);
eq('brand then brand',
   names('tide charmin'), ['tide','charmin']);

/* --- repair must not fire INSIDE a product name ---------------------------
   The consonant-skeleton repair is for words the speaker's phone mangled at
   the START of an item. Run it over the whole phrase and it eats the middle:
   "haribo gold bears" became "haribo glad" + "breyers ..." because gold/glad
   and bears/breyers collide on skeleton. Everything downstream of a brand is
   off limits, and short words are never repaired at all. */
eq('gold stays gold',  names('haribo gold bears gummy candy'), ['haribo gold bears gummy candy']);
eq('repair still fires at the start',
   names('buy harbough gummies'), ['haribo gummies']);
/* "costco" here is the store, not an item — repair still has to fix both
   of the items that follow it. */
eq('...and on a later item',
   names('costco tighed charmen'), ['tide','charmin']);

// --- notes ----------------------------------------------------------------
eq('parenthetical',  [P('milk (whole)').items[0].name, P('milk (whole)').items[0].note], ['milk','whole']);
eq('for X',          [P('chips for the party').items[0].name, P('chips for the party').items[0].note], ['chips','the party']);

// --- categories -----------------------------------------------------------
eq('produce',   cats('bananas'),        ['produce']);
eq('dairy',     cats('milk'),           ['dairy']);
eq('eggs',      cats('eggs'),           ['eggs']);
eq('meat',      cats('ground beef'),    ['meat']);
eq('paper',     cats('paper towels'),   ['paper']);
eq('pharmacy',  cats('tylenol'),        ['pharmacy']);
eq('snacks',    cats('chips'),          ['snacks']);
eq('beverages', cats('coke'),           ['beverages']);
eq('cleaning',  cats('laundry detergent'), ['cleaning']);
eq('baby',      cats('diapers'),        ['baby']);

/* Unknown is 'other', never a guess. A wrong aisle is worse than no aisle:
   it sends someone to the far side of the store with confidence. */
eq('unknown is other', cats('flux capacitor'), ['other']);
eq('every category is in the closed list',
   P('milk, chips, tylenol, bananas, flux capacitor').items
     .every(i => SHOP_CATEGORIES.includes(i.category)), true);

/* The household's own memory outranks the dictionary — a correction made
   once should never have to be made twice. */
eq('catalog wins over the dictionary',
   parseShopping('buy chips', { stores: STORES, catalog: [{ name: 'chips', category: 'pantry' }] })
     .items[0].category, 'pantry');
eq('catalog match is case-insensitive',
   parseShopping('buy La Croix', { stores: STORES, catalog: [{ name: 'la croix', category: 'beverages' }] })
     .items[0].category, 'beverages');

// --- nothing to add -------------------------------------------------------
eq('empty warns',   P('').warnings.length > 0, true);
eq('verb only warns', P('buy').warnings.length > 0, true);

/* --- the catalog remembers the store ------------------------------------
   Ticking milk at HEB teaches the catalog that milk is an HEB thing. The
   parser hands that memory back as catalogStore — apart from `store`, which
   is only ever what the TEXT said — so the app can rank an explicit store,
   then the chip it is looking at, then this. */
{
  const STORES2 = [{ id: 'h', name: 'HEB on 1488', aliases: ['1488'] }, { id: 'k', name: 'Kroger', aliases: [] }];
  const CAT = [{ name: 'milk', category: 'dairy', store_id: 'h' }, { name: 'eggs', category: 'eggs', store_id: null }];
  const r = parseShopping('milk and eggs', { stores: STORES2, catalog: CAT });
  eq('catalog store rides along',  r.items.map(i => i.catalogStore), ['h', null]);
  eq('...but is not the text\'s store', r.items.map(i => i.store), [null, null]);
  const r2 = parseShopping('kroger: milk', { stores: STORES2, catalog: CAT });
  eq('the text\'s store still wins', [r2.items[0].store.id, r2.items[0].catalogStore], ['k', 'h']);
}

/* =====================================================================
   REGRESSION NET — "butter sticks" came out as butter + sticks.
   Three roots, all in the splitter/classifier: (1) a known item followed
   by its SHAPE word closed the chunk and the shape became an orphan item;
   (2) a bare shape word in front of "of" was not a quantity; (3) the
   category table was first-match-wins, so a generic word in an early row
   ("butter" → dairy) beat a specific phrase in a later one ("peanut
   butter" → pantry). Plus the mirror class: one unknown word in front of a
   known one ("coconut oil") split. These two tables are what stop the
   class coming back: everything in ONE must stay one item with the aisle
   named; everything in SPLIT must come apart into exactly those items.
   ===================================================================== */
const ONE = [
  ['butter sticks',        'butter sticks',        'dairy'],
  ['cheese slices',        'cheese slices',        'dairy'],
  ['sour cream',           'sour cream',           'dairy'],
  ['cream cheese',         'cream cheese',         'dairy'],
  ['ice cream',            'ice cream',            'frozen'],
  ['peanut butter',        'peanut butter',        'pantry'],
  ['almond milk',          'almond milk',          'dairy'],
  ['butter lettuce',       'butter lettuce',       'produce'],
  ['chicken broth',        'chicken broth',        'canned'],
  ['beef broth',           'beef broth',           'canned'],
  ['egg noodles',          'egg noodles',          'pantry'],
  ['milk chocolate',       'milk chocolate',       'snacks'],
  ['string cheese',        'string cheese',        'dairy'],
  ['cottage cheese',       'cottage cheese',       'dairy'],
  ['heavy cream',          'heavy cream',          'dairy'],
  ['whipping cream',       'whipping cream',       'dairy'],
  ['half and half',        'half and half',        'dairy'],
  ['hot dog buns',         'hot dog buns',         'bakery'],
  ['tortilla chips',       'tortilla chips',       'snacks'],
  ['potato chips',         'potato chips',         'snacks'],
  ['sweet potatoes',       'sweet potatoes',       'produce'],
  ['green onions',         'green onions',         'produce'],
  ['bell peppers',         'bell peppers',         'produce'],
  ['baking powder',        'baking powder',        'baking'],
  ['brown sugar',          'brown sugar',          'baking'],
  ['powdered sugar',       'powdered sugar',       'baking'],
  ['olive oil',            'olive oil',            'pantry'],
  ['coconut oil',          'coconut oil',          'pantry'],
  ['paper towels',         'paper towels',         'paper'],
  ['toilet paper',         'toilet paper',         'paper'],
  ['toilet paper rolls',   'toilet paper rolls',   'paper'],
  ['dish soap',            'dish soap',            'cleaning'],
  ['laundry detergent',    'laundry detergent',    'cleaning'],
  ['dryer sheets',         'dryer sheets',         'cleaning'],
  ['chicken thighs',       'chicken thighs',       'meat'],
  ['chicken wings',        'chicken wings',        'meat'],
  ['ground turkey',        'ground turkey',        'meat'],
  ['pork chops',           'pork chops',           'meat'],
  ['ham steaks',           'ham steaks',           'meat'],
  ['bread crumbs',         'bread crumbs',         'pantry'],
  ['ice cream cones',      'ice cream cones',      'frozen'],
  ['coffee filters',       'coffee filters',       'household'],
  ['trash bags',           'trash bags',           'household'],
  ['cream of mushroom soup','cream of mushroom soup','canned'],
  ['chicken noodle soup',  'chicken noodle soup',  'canned'],
  ['cream of tartar',      'cream of tartar',      'baking'],
  ['ranch seasoning mix',  'ranch seasoning mix',  'condiments'],
  ['buttermilk pancake mix','buttermilk pancake mix','breakfast'],
  ['milk jug',             'milk jug',             'dairy'],
  ['egg carton',           'egg carton',           'eggs'],
  ['bread loaf',           'bread loaf',           'bakery'],
  ['fresh basil',          'fresh basil',          'produce'],
  ['organic milk',         'organic milk',         'dairy'],
  ['sweet corn',           'sweet corn',           'canned'],
  ['large eggs',           'large eggs',           'eggs'],
];
for (const [text, name, cat] of ONE) {
  const items = P(text).items;
  eq(`one item: ${text}`, items.map(i => `${i.name}[${i.category}]`), [`${name}[${cat}]`]);
}
/* Quantities said as a shape. */
const QTY = [
  ['sticks of butter',      'butter', 'sticks',      'dairy'],
  ['2 sticks of butter',    'butter', '2 sticks',    'dairy'],
  ['a box of pasta',        'pasta',  'a box',       'pantry'],
  ['loaf of bread',         'bread',  'loaf',        'bakery'],
  ['bag of chips',          'chips',  'bag',         'snacks'],
  ['head of lettuce',       'lettuce','head',        'produce'],
  ['a bunch of bananas',    'bananas','a bunch',     'produce'],
  ['dozen eggs',            'eggs',   'dozen',       'eggs'],
  ['half a dozen eggs',     'eggs',   'half a dozen','eggs'],
];
for (const [text, name, qty, cat] of QTY) {
  const it = P(text).items;
  eq(`quantity: ${text}`, it.map(i => [i.name, i.qty, i.category]), [[name, qty, cat]]);
}
/* And these must still come apart into exactly these. */
const SPLIT = [
  ['milk eggs bread',                  ['milk', 'eggs', 'bread']],
  ['butter sticks and milk',           ['butter sticks', 'milk']],
  ['milk and toilet paper',            ['milk', 'toilet paper']],
  ['tide charmin',                     ['tide', 'charmin']],
  ['milk eggs 2 pounds of ground beef',['milk', 'eggs', 'ground beef']],
  ['doritos milk eggs',                ['doritos', 'milk', 'eggs']],
  ['eggs bacon',                       ['eggs', 'bacon']],
  ['bananas milk',                     ['bananas', 'milk']],
  ['chicken thighs and rice',          ['chicken thighs', 'rice']],
  ['pork chops and milk',              ['pork chops', 'milk']],
  ['sticks of butter, milk',           ['butter', 'milk']],
  ['cheese slices bread',              ['cheese slices', 'bread']],
  ['apples oranges bananas',           ['apples', 'oranges', 'bananas']],
  ['peanut butter and jelly',          ['peanut butter', 'jelly']],
  ['coconut oil and olive oil',        ['coconut oil', 'olive oil']],
  ['butter lettuce tomatoes',          ['butter lettuce', 'tomatoes']],
];
for (const [text, want] of SPLIT) eq(`split: ${text}`, names(text), want);
/* A measure or shape word alone is nothing to buy: dropped, with a warning.
   (The app also sweeps any such rows the old bug wrote.) */
eq('bare shape word is not an item',   names('sticks'), []);
eq('bare measure word is not an item', names('cup'), []);
eq('...and says why', P('cup').warnings[0], 'nothing to buy in "cup"');
/* Cups that are things still land on the paper aisle. */
eq('paper cups',  cats('paper cups'),  ['paper']);
eq('solo cups',   cats('solo cups'),   ['paper']);
eq('coffee cups', cats('coffee cups'), ['paper']);
eq('coffee cups is one item', names('coffee cups'), ['coffee cups']);

/* ROOT 2, the whole class: every measure × {bare, article, number} ×
   {of X, X}. One unified list (UNIT_WORDS ∪ FORM_WORDS) feeds the
   splitter, the ingredient parser and isFormOnly, so "gallon of milk"
   can never again be an item called "gallon of". */
const MEASURES = ['gallon','quart','pint','pound','lb','ounce','oz','case','cup','carton','jug','six pack','bag','box','can','jar','bottle','bunch','head','loaf','stick','slice'];
const plural = w => w === 'box' ? 'boxes' : w === 'bunch' ? 'bunches' : w === 'loaf' ? 'loaves' : w === 'lb' ? 'lbs' : w === 'oz' ? 'oz' : w + 's';
for (const w of MEASURES) {
  const one = P(`${w} of milk`).items, art = P(`a ${w} of milk`).items;
  eq(`${w} of milk`,        one.map(i => [i.name, i.qty]), [['milk', w]]);
  eq(`a ${w} of milk`,      art.map(i => [i.name, i.qty]), [['milk', `a ${w}`]]);
  eq(`${w} milk (no of)`,   P(`${w} milk`).items.map(i => [i.name, i.qty]), [['milk', w]]);
  if (w === 'six pack') continue;                      // nobody says "2 six packs"
  eq(`2 ${plural(w)} of milk`, P(`2 ${plural(w)} of milk`).items.map(i => [i.name, i.qty]), [['milk', `2 ${plural(w)}`]]);
  eq(`2 ${plural(w)} milk`, P(`2 ${plural(w)} milk`).items.map(i => [i.name, i.qty]), [['milk', `2 ${plural(w)}`]]);
}
/* A measure word is never "repaired" into a brand: "loaves" is not Luvs. */
eq('loaves is not Luvs', P('2 loaves of bread').items.map(i => [i.name, i.qty, i.heardAs]), [['bread', '2 loaves', null]]);
/* A measure in front of something unknown is left alone — "can opener"
   is a can opener. */
eq('can opener keeps its can', P('can opener').items.map(i => i.name), ['can opener']);
/* Most-specific category wins, table order only breaks ties. */
eq('scoring: phrase beats word',   cats('peanut butter'), ['pantry']);
eq('scoring: longer phrase wins',  cats('ranch seasoning mix'), ['condiments']);
eq('scoring: tie keeps table order', cats('ground beef'), ['meat']);

/* ---------------------------------------------------------------------------
 * LEMONADE IS NOT A LEMON  (Erich: "Lemonade is not something we need to pick
 * out. It's not produce.") Three roots, each a rule:
 *   (a) every fruit and vegetable word ends at a word end, plurals spelled
 *       out — "lemonade" is not a lemon, "pineapple" is not an apple;
 *   (b) a compound is head-final: the LAST word decides the aisle, so
 *       "grape juice" is a juice and "banana bread" is a bread (catOf scores
 *       by how far a match reaches, not how long it is);
 *   (c) a flavour word before a thing that takes one is one item (MODIFIERS
 *       + HEADS in the splitter and in looksMerged), where "eggs bacon" and
 *       "onion garlic" stay two.
 * pick_yourself stays a property of the aisle (produce, meat, seafood,
 * bakery, deli): a bag of potatoes is still chosen by hand.
 * ------------------------------------------------------------------------- */
const pick = s => P(s).items.map(i => `${i.name}[${i.category}${i.pickYourself ? ' PICK' : ''}]`);
const FLAVOURED = [
  ['lemonade',            ['lemonade[beverages]']],
  ['limeade',             ['limeade[beverages]']],
  ['orange juice',        ['orange juice[beverages]']],
  ['apple juice',         ['apple juice[beverages]']],
  ['grape juice',         ['grape juice[beverages]']],
  ['butterscotch chips',  ['butterscotch chips[baking]']],
  ['pineapple',           ['pineapple[produce PICK]']],
  ['onion rings',         ['onion rings[frozen]']],
  ['garlic bread',        ['garlic bread[bakery PICK]']],
  ['banana bread',        ['banana bread[bakery PICK]']],
  ['orange soda',         ['orange soda[beverages]']],
  ['lemon pepper',        ['lemon pepper[baking]']],
  ['strawberry jam',      ['strawberry jam[pantry]']],
  ['celery salt',         ['celery salt[baking]']],
  ['apple cider vinegar', ['apple cider vinegar[pantry]']],
  ['strawberry ice cream',['strawberry ice cream[frozen]']],
  ['sweet potato fries',  ['sweet potato fries[frozen]']],
  ['honey mustard',       ['honey mustard[condiments]']],
  ['oatmeal cookies',     ['oatmeal cookies[snacks]']],
  ['chocolate milk',      ['chocolate milk[dairy]']],
  ['peanut butter',       ['peanut butter[pantry]']],
  ['cinnamon rolls',      ['cinnamon rolls[bakery PICK]']],
  ['egg rolls',           ['egg rolls[frozen]']],
  ['toilet paper rolls',  ['toilet paper rolls[paper]']],
  ['trash bags',          ['trash bags[household]']],
  /* must NOT change */
  ['lemons',              ['lemons[produce PICK]']],
  ['oranges',             ['oranges[produce PICK]']],
  ['a lemon',             ['lemon[produce PICK]']],
  ['tomatoes',            ['tomatoes[produce PICK]']],
  ['potatoes',            ['potatoes[produce PICK]']],
  ['strawberries',        ['strawberries[produce PICK]']],
  ['green beans',         ['green beans[produce PICK]']],
  ['bell pepper',         ['bell pepper[produce PICK]']],
  ['apples',              ['apples[produce PICK]']],
  ['eggs bacon',          ['eggs[eggs]', 'bacon[meat PICK]']],
  ['onion garlic lettuce',['onion[produce PICK]', 'garlic[produce PICK]', 'lettuce[produce PICK]']],
  ['milk eggs grape juice bananas', ['milk[dairy]', 'eggs[eggs]', 'grape juice[beverages]', 'bananas[produce PICK]']],
  ['onion rings and grape juice',   ['onion rings[frozen]', 'grape juice[beverages]']],
  ['2 lemons and a lime', ['lemons[produce PICK]', 'lime[produce PICK]']],
  ['butter sticks',       ['butter sticks[dairy]']],
  ['hot dog buns',        ['hot dog buns[bakery PICK]']],
  ['tomato sauce',        ['tomato sauce[canned]']],
  ['garlic powder',       ['garlic powder[baking]']],
];
for (const [t, want] of FLAVOURED) eq(`flavour: ${t}`, pick(t), want);
eq('flavour: qty rides along', P('2 gallons of orange juice').items.map(i => i.qty), ['2 gallons']);
/* looksMerged must not reject the compounds the splitter now makes, or the
   catalog could never learn them. */
import { isCompound } from './parse.js';
eq('compound: grape juice is one thing',       looksMerged('grape juice'), false);
eq('compound: apple cider vinegar is one',     isCompound('apple cider vinegar'), true);
eq('compound: milk eggs still comes apart',    looksMerged('milk eggs'), true);
eq('compound: onion garlic is not a compound', isCompound('onion garlic'), false);
eq('compound: eggs bacon is not a compound',   isCompound('eggs bacon'), false);
/* Word ends, both directions. */
eq('word end: lemonade is not a lemon',  cats('lemonade'),  ['beverages']);
eq('word end: lemons still are',          cats('lemons'),    ['produce']);
eq('word end: butterscotch is not butter', cats('butterscotch'), ['baking']);
eq('word end: buttermilk stays dairy',    cats('buttermilk'), ['dairy']);
eq('word end: mangoes / cherries / peaches', [cats('mangoes'), cats('cherries'), cats('peaches')].flat(), ['produce', 'produce', 'produce']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
