/* ===========================================================================
 * ALIASES
 *
 * The parser only records people it can resolve against the member list. That
 * is what keeps free text out of the database — but it means an unrecognised
 * name is not an error. The event saves, the role vanishes, and nobody finds
 * out until a kid is standing outside a school.
 *
 * So "mom is driving" has to resolve, and it has to resolve to exactly one
 * canonical name.
 * ========================================================================= */
import { parseQuickAdd } from './parse.js';

const ROSTER = [
  { name: 'Erich', aliases: ['dad','daddy','papa','pop'] },
  { name: 'Jess',  aliases: ['mom','mommy','mama','jessica'] },
  { name: 'Addie', aliases: [] },
  { name: 'Bryce', aliases: [] },
];
const NOW = new Date('2026-08-26T10:00:00');
const P = (s, me) => parseQuickAdd(s, { members: ROSTER, now: NOW, me: me ?? 'Addie' });
const R = (s, me) => P(s, me).people.map(p => p.name + ':' + p.role);

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
  if (!ok) { console.log('  got  ' + JSON.stringify(got)); console.log('  want ' + JSON.stringify(want)); fail++; } else pass++;
};

// --- an alias is the person -----------------------------------------------
eq('mom resolves',        R('Soccer Thursday 6pm, mom is driving'), ['Jess:driving']);
eq('dad resolves',        R('Soccer Thursday 6pm, dad is driving'), ['Erich:driving']);
eq('mommy resolves',      R('Soccer Thursday 6pm, mommy driving'),  ['Jess:driving']);
eq('long form resolves',  R('Recital Friday 7pm, Jessica driving'), ['Jess:driving']);
eq('case insensitive',    R('Game Saturday 2pm, MOM going'),        ['Jess:going']);
eq('stored name is canonical', P('Soccer Thursday 6pm, mom is driving').people[0].name, 'Jess');

// --- both legs, in the kids' words ----------------------------------------
eq('mom there dad back',  R('Choir Friday 7pm, mom there, dad back'), ['Jess:dropoff','Erich:pickup']);
eq('two aliases going',   R('Game Saturday 2pm, Mom and Dad going'),  ['Jess:going','Erich:going']);
eq('and is not the title',P('Game Saturday 2pm, Mom and Dad going').title, 'Game');

/* --- subject vs object ----------------------------------------------------
   The difference between who drives and who rides. Counting the passenger as
   just another name splits the sentence at them, and the verb lands on the
   wrong person — in the direction that leaves a child waiting. */
eq('me is cargo, not driver',
   R('Practice Thu 5pm, mommy takes me there, daddy brings me back'),
   ['Jess:dropoff','Erich:pickup']);
eq('named passenger rides',
   R('Practice Thu 5pm, I am taking Addie there, Jess brings her back', 'Erich'),
   ['Erich:dropoff','Addie:going','Jess:pickup']);
eq('passenger after driving',
   R('Soccer Thursday 6pm, mom is driving Bryce'), ['Jess:driving','Bryce:going']);
eq('passenger after picks up',
   R('Pickup Friday 3pm, dad picks up Addie'), ['Erich:pickup','Addie:going']);
eq('the verb leaves the title',
   P('Practice Thu 5pm, I am taking Addie there, Jess brings her back', 'Erich').title,
   'Practice');

// --- an alias never widens what gets stored -------------------------------
eq('unknown name is dropped', R('Soccer Thursday 6pm, Grandma driving'), []);
eq('plain names still work',  R('Soccer Thursday 5:30 Bryce, Jess driving'),
   ['Bryce:going','Jess:driving']);
eq('string roster still works',
   parseQuickAdd('Soccer Thursday 5:30 Bryce', { members: ['Bryce','Addie'], now: NOW })
     .people.map(p => p.name + ':' + p.role), ['Bryce:going']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
