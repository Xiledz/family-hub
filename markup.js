/* ===========================================================================
 * Family Hub — turning somebody's recipe page into text
 *
 * The rule these enforce: nothing that still looks like markup is an
 * ingredient. A loveandlemons import came back as sixty-one ingredients
 * beginning "<div", because a naive /<[^>]+>/ stops at the first '>' and
 * WordPress Recipe Maker writes aria-labels full of them. Rather than chase
 * every tag shape forever, the extractors now check their own output and
 * refuse a harvest that is mostly rubble — the paste box is a better answer
 * than sixty-one rows of garbage.
 *
 * Inlined verbatim into recipe-import.ts; drift.test.mjs keeps them equal.
 * ========================================================================= */

/* A tag, including one whose attribute value contains a '>'. */
export const TAG = /<\/?[a-z][a-z0-9-]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>`]+))?)*\s*\/?>/gi;

export const decode = (s) => String(s ?? '')
  .replace(TAG, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  /* WordPress Recipe Maker writes fractions as named entities. */
  .replace(/&frac12;/g, '½').replace(/&frac14;/g, '¼').replace(/&frac34;/g, '¾')
  .replace(/&frac13;/g, '⅓').replace(/&frac23;/g, '⅔').replace(/&frac18;/g, '⅛')
  .replace(/&deg;/g, '°').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&hellip;/g, '…')
  .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/\s+/g, ' ').trim();

/* An angle bracket, or a bare attribute like `class=wprm-recipe-ingredient`. */
export const looksLikeMarkup = (s) =>
  /[<>]/.test(s) || /\b[a-z-]+=(?:"|'|[a-z0-9-]+[>/])/i.test(s) || /^\s*[a-z-]+=/i.test(s);

export function sane(list) {
  return (list || []).map(x => String(x ?? '').trim()).filter(x => x && !looksLikeMarkup(x));
}

/* True when what came back is mostly rubble. A third is generous: one
   stray tag in a long list is a blemish, a third of them is a failure. */
export function mostlyMarkup(list) {
  if (!list || !list.length) return false;
  return list.filter(looksLikeMarkup).length / list.length >= 0.34;
}
