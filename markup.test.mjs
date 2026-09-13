/* ===========================================================================
 * NOTHING THAT LOOKS LIKE MARKUP IS AN INGREDIENT
 *
 * A loveandlemons import came back with sixty-one "ingredients" that were
 * fragments of WordPress Recipe Maker HTML — "<div", "class=wprm-…>". Two
 * causes: a tag regex that stops at the first '>' (their aria-labels are
 * full of them), and an extractor that trusted its own output.
 *
 * The fix is a rule, not a patch for that one site: an extractor checks what
 * it produced, and a harvest that is mostly rubble is a failure, because the
 * paste box is a better answer than sixty-one rows of garbage.
 * ========================================================================= */
import { decode, looksLikeMarkup, sane, mostlyMarkup, TAG } from './markup.js';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
  if (!ok) { console.log('  got  ' + JSON.stringify(got)); console.log('  want ' + JSON.stringify(want)); fail++; } else pass++;
};

/* --- the tag that broke it: a '>' inside a quoted attribute ------------- */
eq('decode: tag with a > inside an attribute',
   decode('<li class="x" aria-label="Dough, 1 rec > more">2 cups flour</li>'), '2 cups flour');
eq('decode: plain tags',        decode('<p>1 tsp <b>salt</b></p>'), '1 tsp salt');
eq('decode: self-closing',      decode('2 eggs<br/>'), '2 eggs');
eq('decode: entities survive',  decode('&frac12; cup sugar &amp; salt'), '½ cup sugar & salt');
eq('decode: numeric entities',  decode('&#189; tsp'), '½ tsp');
eq('decode: nothing to do',     decode('1 box saltine crackers'), '1 box saltine crackers');
eq('decode: null is empty',     decode(null), '');
/* A global regex keeps state between calls; the second call must not skip. */
TAG.lastIndex = 0;
eq('decode: is repeatable',     [decode('<b>a</b>'), decode('<b>a</b>')], ['a', 'a']);

/* --- what counts as rubble --------------------------------------------- */
eq('markup: an open tag',       looksLikeMarkup('<div'), true);
eq('markup: a bare attribute',  looksLikeMarkup('class=wprm-recipe-ingredients>'), true);
eq('markup: an attribute alone', looksLikeMarkup('data-uid=0'), true);
eq('markup: a real ingredient', looksLikeMarkup('2 cups all-purpose flour'), false);
eq('markup: a fraction',        looksLikeMarkup('½ tsp black pepper'), false);
/* Real ingredients that must NOT be mistaken for markup. */
eq('markup: parenthetical size', looksLikeMarkup('1 (15 oz) can black beans'), false);
eq('markup: a temperature',      looksLikeMarkup('bake at 425°'), false);
eq('markup: an ampersand',       looksLikeMarkup('salt & pepper'), false);
eq('markup: a range with a dash', looksLikeMarkup('2-3 cloves garlic'), false);
eq('markup: a price note',       looksLikeMarkup('1 tsp yeast ($0.08)'), false);

/* --- the filter --------------------------------------------------------- */
eq('sane: drops the rubble, keeps the food',
   sane(['<div', '2 cups flour', 'class=wprm>', '1 tsp salt', '   ']),
   ['2 cups flour', '1 tsp salt']);
eq('sane: empty in, empty out', sane([]), []);
eq('sane: undefined in, empty out', sane(undefined), []);

/* --- the failure rule --------------------------------------------------- */
const wprm = ['<div', 'class=wprm-recipe-ingredient-group><ul', 'class=wprm-recipe-ingredients>',
              '<li', 'class=wprm-recipe-ingredient data-uid=0><span', '1 recipe pizza dough'];
eq('mostly markup: the loveandlemons harvest is a failure', mostlyMarkup(wprm), true);
eq('mostly markup: one stray tag in a real list is not',
   mostlyMarkup(['2 cups flour', '1 tsp salt', '½ cup water', '<br', '2 eggs', '1 Tbsp oil']), false);
eq('mostly markup: a clean list is fine',
   mostlyMarkup(['2 cups flour', '1 tsp salt']), false);
eq('mostly markup: nothing is not a failure', mostlyMarkup([]), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
