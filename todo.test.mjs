/* ===========================================================================
 * TODOS — routing and parsing
 *
 * A todo is a verb phrase somebody owes. An event is a noun with a clock.
 * Shopping is a noun you buy. Three intents, one text field, and a family
 * that will not learn a syntax — so the sentence shape has to do the work.
 *
 * The load-bearing distinction is the preposition. Events say AT and ON:
 * "practice at 5", "dentist on Thursday". Todos say BY: "clean your room by
 * Friday". That one word separates them cleanly — but only when what follows
 * is a bare date, because "pick up milk by the register" is groceries and
 * has to stay groceries.
 * ========================================================================= */
import { routeIntent, parseTodo, looksLikeTodo, ROUTE_RE } from './parse.js';

const NOW = new Date('2026-09-10T12:00:00Z');            // Thursday
const STORES = [
  { id: 'k', name: 'Kroger',      aliases: ['krogers','cochrans'] },
  { id: 'h', name: 'HEB on 1488', aliases: ['1488'] },
  { id: 'c', name: 'Costco',      aliases: [] },
];
const ROSTER = [
  { name: 'Erich', aliases: ['dad'] }, { name: 'Jess',  aliases: ['mom'] },
  { name: 'Bryce', aliases: [] },      { name: 'Addie', aliases: [] },
];
const OPTS = { stores: STORES, members: ROSTER, now: NOW, me: 'Erich' };

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
  if (!ok) { console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); fail++; }
  else pass++;
};
const intent = b => { const r = routeIntent(b, OPTS); return r.intent === 'stateful' ? `${r.why}>${r.otherwise.intent}` : r.intent; };
const T = b => parseTodo(b, OPTS);

// --- the deadline preposition ---------------------------------------------
eq('by + date is a todo',      intent('Bryce clean room by Friday'), 'todo');
eq('...even with no verb match', intent('the taxes by Friday'),      'todo');
eq('by + place is shopping',   intent('pick up milk by the register'), 'shop');
/* "by the dozen" is not a date, so it is not a deadline — which is the point.
   It asks rather than filing anything, which it always did. */
eq('by + quantity is not a todo', intent('eggs by the dozen'),      'ask');

/* A clock outranks a chore FRAME but not a chore VERB. "finish" is an
   imperative chore, so this is a to-do that happens to want doing by 8 —
   and todos carry a due_time now, so the hour is kept rather than dropped.
   "I need to leave for the airport Friday 6am" is the other side of the
   line: "need to" is a todo frame, but "leave" is not a chore verb, and the
   6am is the entire point of the message. */
eq('chore verb beats the clock', intent('finish homework by 8pm'),   'todo');
eq('...and keeps the hour',      T('finish homework by 8pm').due_time, '20:00');
eq('a frame does not beat it',   intent('need to leave for the airport Friday 6am'), 'event');
eq('a noun with a clock',        intent('Soccer Thursday 5:30'),     'event');

/* The chore from the screenshots: a weekly job with a preferred hour. It was
   filing itself as a calendar event titled "Take out trash morning ." */
eq('recurring chore with an hour', intent('Take out trash every Tuesday morning at 7.'), 'todo');
eq('...title is clean',  T('Take out trash every Tuesday morning at 7.').title, 'Take out trash');
eq('...hour is kept',    T('Take out trash every Tuesday morning at 7.').due_time, '07:00');
eq('...repeat is kept',  T('Take out trash every Tuesday morning at 7.').repeat.freq, 'weekly');

// --- imperative chore verbs -----------------------------------------------
eq('bare imperative',       intent('mow the lawn'),              'todo');
eq('imperative + date',     intent('mow the lawn Saturday'),     'todo');
eq('imperative + repeat',   intent('take out the trash every Tuesday'), 'todo');
eq('vacuum',                intent('vacuum the stairs'),         'todo');

/* These verbs belong to other intents and must NOT be stolen. Losing them
   would break behaviour the family already relies on. */
eq('get is shopping',       intent('get dog food'),              'shop');
eq('grab is shopping',      intent('grab bananas'),              'shop');
eq('pick up is shopping',   intent('pick up bananas'),           'shop');
eq('remove is remove',      intent('remove milk'),               'shop_remove');
eq('buy is shopping',       intent('buy milk'),                  'shop');

/* "take out the trash" is the archetypal chore. SHOP_REMOVE used to own
   "take out", so this tried to remove trash bags from the shopping list. */
eq('take out the trash is a chore', intent('take out the trash'), 'todo');
eq('take OFF still removes',        intent('take off the milk'),  'shop_remove');

// --- who owes it ----------------------------------------------------------
eq('name first',        T('Bryce clean room').assignees,                    ['Bryce']);
eq('two names fan out', T('Bryce and Addie clean the garage').assignees,    ['Bryce','Addie']);
eq('modal',             T('Bryce needs to clean his room').assignees,       ['Bryce']);
eq('tell X to',         T('tell Bryce to clean his room').assignees,        ['Bryce']);
eq('alias resolves',    T('mom needs to renew the tags').assignees,         ['Jess']);
eq('remind me to',      T('remind me to call the dentist').assignees,       ['Erich']);
eq('no name is me',     T('call the dentist').assignees,                    ['Erich']);

/* "we need to" belongs to the house: nobody is nagged, anyone can close it. */
eq('we need to is shared',   T('we need to fix the fence').house,  true);
eq('...and has no assignee', T('we need to fix the fence').assignees, []);
eq('someone is shared',      T('someone fix the fence').house,     true);

// --- what is owed ---------------------------------------------------------
eq('title drops the name',     T('Bryce clean room by Friday').title,    'Clean room');
eq('title drops the deadline', T('call the dentist by Tuesday').title,   'Call the dentist');
eq('title drops the frame',    T('tell Bryce to clean his room').title,  'Clean his room');
eq('tag form',                 T('todo: mow the lawn').title,            'Mow the lawn');

// --- when ------------------------------------------------------------------
eq('by Friday',        T('Bryce clean room by Friday').due_on,      '2026-09-11');
eq('by Tuesday',       T('call the dentist by Tuesday').due_on,     '2026-09-15');
eq('bare date',        T('mow the lawn Saturday').due_on,           '2026-09-12');
eq('no date is null',  T('clean the garage').due_on,                null);
eq('repeat carries',   T('take out the trash every Tuesday').repeat.freq, 'weekly');
eq('repeat days',      T('take out the trash every Tuesday').repeat.days, [2]);

// --- the lists -------------------------------------------------------------
eq('my list',        intent('my list'),      'todo_show');
eq('todos',          intent('todos'),        'todo_show');
eq('chores',         intent('chores'),       'todo_show');
eq("someone's list", intent("Bryce's list"), 'todo_show');
eq('...names them',  routeIntent("Bryce's list", OPTS).who, 'Bryce');

/* Bare "list" and store lists stay shopping. The family already learned
   these; changing them to mean todos would break a habit for no gain. */
eq('bare list is shopping',  intent('list'),        'show');
eq('store list is shopping', intent('kroger list'), 'show');

// --- completion ------------------------------------------------------------
eq('did X',        intent('did the dishes'),  'todo_done');
eq('finished X',   intent('finished the laundry'), 'todo_done');
eq('checked off',  intent('checked off the taxes'), 'todo_done');

/* Bare "done" must stay the shopping trip. When Jess gets Bryce's nag
   through the guardian chain and replies "done", clearing her grocery list
   would be a genuinely bad outcome — so the nag asks for DID instead. */
eq('bare done is the trip',   intent('done'),          'trip_done');
eq('done shopping is a trip', intent('done shopping'), 'trip_done');
eq('did it needs context',    intent('did it'),        'did>todo_done');

// --- ordering that was already load-bearing --------------------------------
eq('correction still first',  intent('no bike'),         'correction>shop_remove');
eq('edit still gated',        intent('move soccer to 7'), 'edit>ask');
eq('shopping still wins buy', intent('buy milk, eggs'),  'shop');
eq('a real event',            intent('Soccer Thursday 5:30'), 'event');

/* Name plus nothing is three ways ambiguous now. It used to become an
   all-day event on that person's calendar, which was almost never meant. */
eq('name alone asks', intent('Bryce garage'), 'ask');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
