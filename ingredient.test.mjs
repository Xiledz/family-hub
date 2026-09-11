/* ===========================================================================
 * INGREDIENTS
 *
 * A recipe line was written by a cook, not a database. It has to become a
 * quantity the list can scale and a name the catalog recognises, WITHOUT
 * losing what the cook actually wrote — "shredded sharp cheddar" is what
 * gets read at the stove; "shredded cheese" is what gets bought.
 * ========================================================================= */
import { parseIngredient, splitIngredientBlock } from './parse.js';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
  if (!ok) { console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); fail++; }
  else pass++;
};
const P = l => parseIngredient(l);
const q = l => { const r = P(l); return [r.qty, r.unit, r.name]; };

// --- quantities in every way a cook writes them ---------------------------
eq('plain',           q('2 cups flour'),            [2, 'cups', 'flour']);
eq('mixed number',    q('1 1/2 lbs ground beef'),   [1.5, 'lbs', 'ground beef']);
eq('unicode half',    q('½ tsp salt'),              [0.5, 'tsp', 'salt']);
eq('glued unicode',   q('1½ cups flour'),           [1.5, 'cups', 'flour']);
eq('decimal',         q('0.5 cup milk'),            [0.5, 'cup', 'milk']);
eq('slash',           q('3/4 cup sugar'),           [0.75, 'cup', 'sugar']);

/* A range: shop for the larger. "1-2 onions" means you might need two. */
eq('range dash',      q('1-2 onions, chopped')[0],  2);
eq('range en-dash',   q('1–2 onions')[0],           2);
eq('range "to"',      q('1 to 2 tbsp olive oil'),   [2, 'tbsp', 'olive oil']);

/* An article is a quantity of one. */
eq('a pinch',         q('a pinch of salt'),         [1, 'pinch', 'salt']);
eq('an onion',        q('an onion, diced'),         [1, null, 'onion']);
eq('a can of',        q('a can of black beans'),    [1, 'can', 'black beans']);

// --- a size in parentheses is NOT a count -----------------------------------
eq('can size kept as note', P('2 (14 oz) cans diced tomatoes').note, '14 oz');
eq('...qty is the can count', q('2 (14 oz) cans diced tomatoes'), [2, 'cans', 'diced tomatoes']);

// --- prep notes come off the name ------------------------------------------
eq('comma prep',   P('3 cloves garlic, minced').note, 'minced');
eq('...name clean', q('3 cloves garlic, minced'),     [3, 'cloves', 'garlic']);
eq('cut into',     q('1 lb chicken breast, cut into strips'), [1, 'lb', 'chicken breast']);
eq('bullet stripped', q('• 1 cup milk'),             [1, 'cup', 'milk']);

// --- optional --------------------------------------------------------------
eq('optional flagged', P('fresh cilantro (optional)').optional, true);
eq('...name clean',    P('fresh cilantro (optional)').name, 'fresh cilantro');
eq('not optional',     P('2 eggs').optional, false);

// --- the ORIGINAL survives ---------------------------------------------------
eq('original kept', P('2 cups shredded sharp cheddar').original, '2 cups shredded sharp cheddar');

// --- an ingredient line is ONE item, never split -----------------------------
/* The list parser would cut "diced tomatoes" into two. A recipe line is one
   thing by definition, so the phrase stays whole. */
eq('never split', P('2 (14 oz) cans diced tomatoes').name, 'diced tomatoes');
eq('category still found', P('2 (14 oz) cans diced tomatoes').category, 'produce');

// --- category and store flags come from the shopping parser -------------------
eq('meat',     P('1 lb ground beef').category, 'meat');
eq('dairy',    P('1 cup milk').category, 'dairy');
eq('pick yourself', P('1 lb ground beef').pickYourself, true);
eq('online ok',     P('1 packet taco seasoning').onlineOk, true);

// --- splitting a pasted block --------------------------------------------------
eq('block: headings and blanks dropped',
   splitIngredientBlock('Ingredients\n\nFor the sauce:\n2 cups milk\n1 tbsp butter\n\nFor the top:\n1 cup cheese'),
   ['2 cups milk','1 tbsp butter','1 cup cheese']);

// --- Fire Crackers: the eight lines that broke the Need-to-buy list ---------
/* Live rows, verbatim from Erich's only recipe. "½ tsp. Black pepper" had
   become ". black pepper" (the unit's full stop left on the name), "1 ⅔ C."
   had become qty 1 with "⅔" in the name, four spices had gone to produce and
   been flagged pick-yourself, and two gallon Ziploc bags had become half a
   gallon of bag. */
const F = l => { const r = P(l); return { name: r.name, qty: r.qty == null ? null : +r.qty.toFixed(3), unit: r.unit, category: r.category }; };
eq('½ tsp. Black pepper',   F('½ tsp. Black pepper'),   { name: 'black pepper', qty: 0.5, unit: 'tsp', category: 'baking' });
eq('1 ⅔ C. Olive oil',      F('1 ⅔ C. Olive oil'),      { name: 'olive oil', qty: 1.667, unit: 'cup', category: 'pantry' });
eq('2 Packages of ranch seasoning mix', F('2 Packages of ranch seasoning mix'), { name: 'ranch seasoning mix', qty: 2, unit: 'packages', category: 'condiments' });
eq('1 tsp. Garlic powder',  F('1 tsp. Garlic powder'),  { name: 'garlic powder', qty: 1, unit: 'tsp', category: 'baking' });
eq('3 Tbsp. Red pepper flakes', F('3 Tbsp. Red pepper flakes'), { name: 'red pepper flakes', qty: 3, unit: 'tbsp', category: 'baking' });
eq('1 tsp. Onion powder',   F('1 tsp. Onion powder'),   { name: 'onion powder', qty: 1, unit: 'tsp', category: 'baking' });
eq('1 Box of Saltine crackers', F('1 Box of Saltine crackers'), { name: 'saltine crackers', qty: 1, unit: 'box', category: 'pantry' });
eq('2 Gallon Ziploc Bag',   F('2 Gallon Ziploc Bag'),   { name: 'ziploc bags', qty: 2, unit: null, category: 'household' });
eq('...gallon is the size, in the note', P('2 Gallon Ziploc Bag').note, 'gallon');
eq('spices are not picked by hand', P('1 tsp. Garlic powder').pickYourself, false);

/* Must not regress. */
eq('2 tsp. salt',           F('2 tsp. salt'),           { name: 'salt', qty: 2, unit: 'tsp', category: 'baking' });
eq('1 C. sugar',            F('1 C. sugar'),            { name: 'sugar', qty: 1, unit: 'cup', category: 'pantry' });
eq('1 1/2 cups flour',      F('1 1/2 cups flour'),      { name: 'flour', qty: 1.5, unit: 'cups', category: 'pantry' });
eq('2 lbs. ground beef',    F('2 lbs. ground beef'),    { name: 'ground beef', qty: 2, unit: 'lbs', category: 'meat' });
eq('1 (15 oz) can black beans, drained', F('1 (15 oz) can black beans, drained'), { name: 'black beans', qty: 1, unit: 'can', category: 'canned' });
eq('...size and prep kept as the note', P('1 (15 oz) can black beans, drained').note, '15 oz; drained');
/* The spice rule must leave fresh produce alone. */
eq('green pepper is produce', P('1 green pepper').category, 'produce');
eq('bell pepper is produce',  P('1 bell pepper').category, 'produce');
eq('onions are produce',      P('2 onions').category, 'produce');
eq('garlic cloves are produce', P('3 cloves garlic, minced').category, 'produce');
eq('fresh basil is produce',  P('fresh basil').category, 'produce');
eq('dried basil is a spice',  P('1 tsp dried basil').category, 'baking');
eq('ground turkey is meat',   P('1 lb ground turkey').category, 'meat');
eq('ground cumin is a spice', P('1 tsp ground cumin').category, 'baking');
eq('a quart jar is one jar',  F('1 quart mason jar'), { name: 'mason jar', qty: 1, unit: null, category: 'other' });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
