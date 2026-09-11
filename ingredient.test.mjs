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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
