/* ===========================================================================
 * INTENT ROUTING
 *
 * Until this existed, every text became a calendar event — which is exactly
 * why the number could not be given to anyone else: "milk" would quietly turn
 * up on the calendar and nobody would notice until the week was wrong.
 *
 * The two failures are not equal. Filing an event as groceries loses an
 * appointment. Filing groceries as an event clutters the calendar. Both are
 * bad enough that where the message is genuinely ambiguous, the right answer
 * is to ask — once — rather than guess quietly.
 *
 * Constants are read out of sms-inbound.ts rather than copied, so this tests
 * what actually deploys.
 * ========================================================================= */
import { readFileSync } from 'fs';
import { parseQuickAdd, parseShopping } from './parse.js';

const src = readFileSync('./sms-inbound.ts', 'utf8');
const grab = name => {
  const m = src.match(new RegExp(`^const ${name}\\s*=\\s*(/.*/[a-z]*);`, 'm'));
  if (!m) throw new Error(`${name} not found in sms-inbound.ts`);
  return eval(m[1]);
};
const SHOP_STRONG = grab('SHOP_STRONG');
const SHOP_WEAK   = grab('SHOP_WEAK');
const LIST_CMD    = grab('LIST_CMD');
const SHOP_REMOVE = grab('SHOP_REMOVE');
const SHOP_GOT    = grab('SHOP_GOT');
const LIST_SCOPED = grab('LIST_SCOPED');
const TRIP_DONE   = grab('TRIP_DONE');
const CLEAR_VERB  = grab('CLEAR_VERB');
const BULK_FILLER = grab('BULK_FILLER');

import { storeTerms } from './parse.js';
const storeIn = t => (storeTerms(STORES).find(({ text }) =>
  new RegExp(`\\b${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)) || {}).store || null;

const ROSTER = [
  { name: 'Erich', aliases: ['dad'] }, { name: 'Jess', aliases: ['mom'] },
  { name: 'Addie', aliases: [] }, { name: 'Bryce', aliases: [] },
];
const NOW = new Date('2026-08-26T10:00:00');

/* Mirrors the handler. If the handler changes shape and this stops matching,
   that mismatch is the point. */
const STORES = [
  { id: 'h1', name: 'HEB Harpers Trace', aliases: ['harpers','harper','harpers trace','242'] },
  { id: 'h2', name: 'HEB on 1488',       aliases: ['1488','heb 1488','north woodlands'] },
  { id: 'k',  name: 'Kroger',            aliases: ['krogers','cochrans'] },
  { id: 'c',  name: 'Costco',            aliases: [] },
  { id: 's',  name: 'Sams Club',         aliases: ['sams',"sam's"] },
];

function route(body) {
  if (LIST_CMD.test(body)) return 'show';
  if (TRIP_DONE.test(body)) return 'trip';

  /* A clearing verb followed by nothing but a store and filler is bulk. The
     same verb followed by an item name is not. Checked BEFORE the scoped
     view, or "remove HEB list" reads as "show me the HEB list" — nearly the
     same words, opposite outcomes. */
  const cv = body.match(CLEAR_VERB);
  if (cv) {
    const st = storeIn(cv[1] || '');
    let rest = cv[1] || '';
    if (st) for (const { text } of storeTerms([st]))
      rest = rest.replace(new RegExp(`\\b${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'ig'), ' ');
    rest = rest.replace(BULK_FILLER, ' ').replace(/[^a-z0-9 ]/gi, ' ').trim();
    if (!rest) return st ? `clear:${st.name}` : 'clear:all';
  }

  const ls = body.match(LIST_SCOPED);
  if (ls && storeIn(ls[1])) return `show:${storeIn(ls[1]).name}`;

  if (SHOP_REMOVE.test(body)) return 'remove';
  if (SHOP_GOT.test(body))    return 'got';
  const p = parseQuickAdd(body, { members: ROSTER, now: NOW, me: 'Erich' });
  const hasWhen = p.matched.includes('date') || p.matched.includes('time') || !!p.repeat;
  if (SHOP_STRONG.test(body)) return 'shop';
  if (SHOP_WEAK.test(body) && !hasWhen) {
    const probe = parseShopping(body, { stores: STORES });
    if (probe.items.some(i => i.category !== 'other')) return 'shop';
  }
  if (!hasWhen && parseShopping(body, { stores: STORES }).store) return 'shop';
  if (!hasWhen && !p.people.length)     return 'ask';
  return 'event';
}

let pass = 0, fail = 0;
const is = (body, want) => {
  const got = route(body);
  const ok = got === want;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + `${want.padEnd(5)} ${JSON.stringify(body)}`);
  if (!ok) { console.log(`      got "${got}"`); fail++; } else pass++;
};

// --- unmistakably shopping -------------------------------------------------
is('buy milk', 'shop');
is('buy milk, eggs, bread', 'shop');
is('we need paper towels', 'shop');
is('grab dog food', 'shop');
is('add ziploc bags to the shopping list', 'shop');
is('kroger: tylenol and diapers', 'shop');
is('harpers: bananas', 'shop');
is('at 1488 grab milk', 'shop');
is('pick up bananas', 'shop');
is('groceries: milk and eggs', 'shop');

/* A day or a clock makes it an event no matter how it opens. "add dentist
   Thursday 3pm" is an appointment, not a grocery run. */
is('add dentist Thursday 3pm', 'event');
is('need to leave for the airport Friday 6am', 'event');
is('get Addie from practice Thursday 5pm', 'event');

// --- unmistakably an event -------------------------------------------------
is('Soccer Thursday 6pm', 'event');
is('Piano every Tuesday 4pm Addie', 'event');
is('Dentist tomorrow 9am Addie', 'event');
is('Soccer Thursday 6-8pm, Addie going, mom there, dad back', 'event');

/* Named people make it an event even with no time — "Addie recital" is not
   something you put in a cart. */
is('Addie recital', 'event');

// --- commands --------------------------------------------------------------
is('list', 'show');
is('the list', 'show');
is('shopping list', 'show');
is("what's on the list", 'show');
is('new list', 'trip');
is('done shopping', 'trip');
is('start a new list', 'trip');

/* --- genuinely ambiguous: ask, never guess -------------------------------
   A bare noun with no day, no clock and nobody named is exactly as plausible
   either way. Guessing wrong here is the failure that made this whole routing
   layer necessary. */
is('milk', 'ask');
/* A weak verb is not a shopping signal on its own. "add bike" opens exactly
   like "add milk" and means something entirely different — nothing in it
   classifies as a grocery, so it gets asked about rather than filed. */
is('add bike', 'ask');
is('get a haircut', 'ask');
is('add milk', 'shop');
is('add ziploc bags', 'shop');
is('Groceries', 'show');   // bare word = show me the list
is('dentist', 'ask');
is('haircut', 'ask');

/* --- taking things off ----------------------------------------------------
   There was no removal path for shopping at all. "remove bike" matched no
   calendar event, fell through every branch, and was read as new input — so
   the mistake got added a second time instead of taken away. */
is('remove bike', 'remove');
is('remove milk and eggs', 'remove');
is('delete haribo', 'remove');
is('take off gummies', 'remove');
is('drop the bike', 'remove');
is('scratch diapers', 'remove');
is('no bike', 'remove');

/* Bought is not the same as wrong. One leaves the list struck through so
   nobody has to ask whether you got the milk; the other never happened. */
is('got milk', 'got');
is('bought the ground beef', 'got');
is('picked up diapers', 'got');
is('grabbed bananas', 'got');

/* And these must still be what they were. */
is('buy milk', 'shop');
is('list', 'show');
is('new list', 'trip');
is('Soccer Thursday 6pm', 'event');

/* --- clearing a whole list ------------------------------------------------
   Two different things, kept apart by the words used:

     "new list"  — you shopped. Bought drops off, still-needed carries over.
     "clear ..." — take the whole thing down, bought or not.

   Both are recoverable; they move rows to history. Only a single "remove X"
   hard-deletes, because that one means it was never real. A mis-heard word
   must not be able to destroy a list nobody can get back. */
is('clear', 'clear:all');
is('remove all', 'clear:all');
is('delete everything', 'clear:all');
is('clear out the whole list', 'clear:all');
is('wipe the list', 'clear:all');

is('remove harpers list', 'clear:HEB Harpers Trace');
is('clear the kroger list', 'clear:Kroger');
is('remove everything from the costco list', 'clear:Costco');
is('wipe the sams club list', 'clear:Sams Club');
is('empty 1488 list', 'clear:HEB on 1488');

/* Nearly the same words, opposite outcomes. Showing must not clear, and
   clearing must not merely show. */
is('harpers list', 'show:HEB Harpers Trace');
is('1488 list', 'show:HEB on 1488');
is('show the kroger list', 'show:Kroger');
is("what's on the costco list", 'show:Costco');

/* A named item is never a bulk operation, whatever verb precedes it. */
is('remove milk', 'remove');
is('delete haribo', 'remove');
is('remove milk and eggs', 'remove');
is('clear the milk', 'remove');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
