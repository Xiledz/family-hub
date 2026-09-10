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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
