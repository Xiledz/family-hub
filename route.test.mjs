/* ===========================================================================
 * INTENT ROUTING
 *
 * One text, several possible meanings. Until routing existed every message
 * became a calendar event, which is exactly why the number could not be
 * handed to anyone else: "milk" would quietly turn up on the calendar and
 * nobody would notice until the week was wrong.
 *
 * The two failures are not equal. Filing an event as groceries loses an
 * appointment. Filing groceries as an event clutters a calendar. Both are
 * bad enough that where a message is genuinely ambiguous the answer is to
 * ask, once, rather than guess quietly.
 *
 * WHAT CHANGED, AND WHY IT MATTERED
 *   This file used to re-implement the handler's if-chain by hand, with a
 *   comment claiming it "mirrors the handler". It did not. The real chain
 *   runs the correction matcher and the edit matcher BETWEEN the scoped list
 *   and the shopping intents; the copy had neither. So "delete that" routed
 *   to shopping here and to the calendar in production, and every test on
 *   this page passed anyway — a test that reimplements the thing it tests
 *   will agree with itself forever.
 *
 *   routeIntent now lives in parse.js and the handler calls it. This file
 *   imports the real function. When routing order changes, this moves or it
 *   fails; it can no longer quietly disagree.
 * ========================================================================= */
import { routeIntent } from './parse.js';

const NOW = new Date('2026-09-10T12:00:00Z');   // Thursday

const STORES = [
  { id: 'h1', name: 'HEB Harpers Trace', aliases: ['harpers','harper','harpers trace','242'] },
  { id: 'h2', name: 'HEB on 1488',       aliases: ['1488','heb 1488','north woodlands'] },
  { id: 'k',  name: 'Kroger',            aliases: ['krogers','cochrans'] },
  { id: 'c',  name: 'Costco',            aliases: [] },
  { id: 's',  name: 'Sams Club',         aliases: ['sams',"sam's"] },
];

const ROSTER = [
  { name: 'Erich', aliases: ['dad'] }, { name: 'Jess', aliases: ['mom'] },
  { name: 'Addie', aliases: [] },      { name: 'Bryce', aliases: [] },
];

/* Collapse the routed answer to the short label these tests were written
   against, so the existing cases below still read the way they did. */
function route(body) {
  const r = routeIntent(body, { stores: STORES, members: ROSTER, now: NOW, me: 'Erich' });
  switch (r.intent) {
    case 'show':        return r.store ? `show:${r.store.name}` : 'show';
    case 'trip_done':   return 'trip';
    case 'clear':       return r.store ? `clear:${r.store.name}` : 'clear:all';
    case 'shop_remove': return 'remove';
    case 'shop_got':    return 'got';
    /* A correction or an edit cannot be settled from the text alone. These
       tests assert the OUTCOME, which is what the sender experiences: the
       handler goes and looks, finds nothing that answers, and falls through.
       Which stage it was diverted to is asserted separately, below. */
    case 'stateful':    return label(r.otherwise);
    default:            return r.intent;
  }
}

function label(r) {
  switch (r.intent) {
    case 'show':        return r.store ? `show:${r.store.name}` : 'show';
    case 'trip_done':   return 'trip';
    case 'clear':       return r.store ? `clear:${r.store.name}` : 'clear:all';
    case 'shop_remove': return 'remove';
    case 'shop_got':    return 'got';
    case 'stateful':    return label(r.otherwise);
    default:            return r.intent;
  }
}

/* Which stage the handler is sent to FIRST, and what it falls back to. This
   is the half the old hand-written copy did not have at all. */
function diverts(body) {
  const r = routeIntent(body, { stores: STORES, members: ROSTER, now: NOW, me: 'Erich' });
  return r.intent === 'stateful' ? `${r.why}>${label(r.otherwise)}` : label(r);
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
/* A modal plus a clock is still an appointment. "need to" is a todo frame,
   but todos have no due TIME, so routing this as one would drop the 6am. */
is('need to leave for the airport Friday 6am', 'event');
is('get Addie from practice Thursday 5pm', 'event');

// --- unmistakably an event -------------------------------------------------
is('Soccer Thursday 6pm', 'event');
is('Piano every Tuesday 4pm Addie', 'event');
is('Dentist tomorrow 9am Addie', 'event');
is('Soccer Thursday 6-8pm, Addie going, mom there, dad back', 'event');

/* Named people make it an event even with no time — "Addie recital" is not
   something you put in a cart. */
/* DELIBERATE CHANGE. A name plus a bare noun used to become an all-day
   event on that person's calendar. With todos in the mix it is genuinely
   three ways ambiguous — a chore, an event, or something to buy — and the
   old guess was almost never what anyone meant. Ask instead. */
is('Addie recital', 'ask');

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


/* --- ROUTING ORDER --------------------------------------------------------
   The handler runs corrections, then remove/got, then edits, then the final
   call. The old hand-written router in this file had neither the correction
   stage nor the edit stage, so it agreed with itself while production did
   something else. These pin the real order.

   Read "correction>remove" as: goes looking for something to correct, and if
   nothing answers, takes it off the shopping list. */
const order = (body, want) => {
  const got = diverts(body);
  const ok = got === want;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + `order ${JSON.stringify(body)}`);
  if (!ok) { console.log(`      got  "${got}"\n      want "${want}"`); fail++; } else pass++;
};

/* "no" opens a correction AND is a remove verb. Correction wins the look;
   remove catches it when there is nothing to correct. Get this backwards and
   "no bike" stops taking bike off the list. */
order('no bike',        'correction>remove');
order('delete that',    'correction>remove');
order('no make it 4',   'correction>remove');
order('scratch that',   'correction>remove');

/* "to" and "for" make almost anything look like a move, so the edit matcher
   is gated on an actual move verb. Without that gate, what sits behind it is
   a fuzzy title match at 0.5 that REWRITES an event's date — "tell Bryce to
   clean his room" could move a dentist appointment.

   The gate shipped with its stems written /\b(mov|chang|reschedul)\b/, and a
   trailing \b after a stem cannot match "moved" or "change" at all. Only
   push, shift and now ever got through, so editing by text was mostly dead
   in production. These pin both halves: the verbs that must open the gate,
   and the sentences that must not. */
order('practice is moved to 6',      'edit>ask');
order('move soccer to 7',            'edit>ask');
order('change dentist to Friday',    'edit>event');
order('reschedule soccer to 7',      'edit>ask');
/* KNOWN GAP, pinned so it is not mistaken for correct: EDIT_RE only
   understands "to" and "for", so "soccer is now AT 7" — a perfectly normal
   way to say it — never reaches the edit matcher and files a second event
   instead. Widening EDIT_RE to accept "at" is safe now that the verb gate
   exists, but it touches every correction test and wants its own pass. */
order('soccer is now at 7',          'event');

order('add ziploc bags to the shopping list',      'shop');
order('need to leave for the airport Friday 6am',  'event');

/* These two were 'event' before todos existed, and the old answer was simply
   wrong — they are chores, and now route as chores. */
order('tell Bryce to clean his room',              'todo');
order('remind me to call the dentist',             'todo');

/* Plain messages are not diverted at all. */
order('buy milk',            'shop');
order('remove milk',         'remove');
order('list',                'show');
order('Soccer Thursday 6pm', 'event');
order('harpers list',        'show:HEB Harpers Trace');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
