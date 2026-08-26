/* ===========================================================================
 * TIME AMBIGUITY + CAST SIGNALS
 *
 * A wrong date looks wrong. A wrong time looks fine — 6:00 reads perfectly
 * well whether it meant morning or evening — and only announces itself when
 * somebody misses the thing. So the rule here is that the parser guesses less
 * and flags more, and these tests pin down exactly where that line sits.
 * ========================================================================= */
import { parseQuickAdd } from './parse.js';

const M = ['Erich','Jess','Addie','Bryce'];
const NOW = new Date('2026-08-25T10:00:00');            // Tuesday
const P = s => parseQuickAdd(s, { members: M, now: NOW, me: 'Erich' });

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
  if (!ok) { console.log('  got  ' + JSON.stringify(got)); console.log('  want ' + JSON.stringify(want)); fail++; } else pass++;
};
const amb = s => { const p = P(s); return p.ambiguousTime ? p.ambiguousTime.kind : null; };

// --- the noon/midnight trap ------------------------------------------------
eq('bare 12 is never guessed',   amb('Soccer at 12'), 'noon');
eq('bare 12:30 is never guessed',amb('Soccer at 12:30'), 'noon');
eq('the word noon is clear',     amb('Lunch at noon'), null);
eq('the word midnight is clear', amb('Party at midnight'), null);
eq('noon means midday',          P('Lunch at noon').start, '12:00');
eq('midnight means 00:00',       P('Party at midnight').start, '00:00');
eq('12 noon reads as one thing', P('Lunch at 12 noon').start, '12:00');
eq('12 with a morning cue',      P('Feeding at 12 in the morning').start, '00:00');
eq('12 with an evening cue',     P('Lunch at 12 this afternoon').start, '12:00');

// --- morning or evening ----------------------------------------------------
eq('bare 9 is ambiguous',        amb('Meeting at 9'), 'ampm');
eq('bare 7 is ambiguous',        amb('Practice at 7'), 'ampm');
eq('explicit am is not',         amb('Meeting at 9am'), null);
eq('explicit pm is not',         amb('Meeting at 9pm'), null);
eq('1-6 keeps waking hours',     amb('Soccer at 5'), null);
eq('...and means evening',       P('Soccer at 5').start, '17:00');
eq('morning cue settles it',     P('Breakfast at 9').start, '09:00');
eq('night cue settles it',       P('Game Friday night at 7').start, '19:00');
eq('after school settles it',    P('Practice at 4 after school').start, '16:00');

/* "I am going" contains the letters a-m. An earlier draft treated that as a
   morning cue and moved a 7pm pickup to 7am. */
eq('"I am" is not a morning cue', P('Pickup at 7, I am driving Addie').start, '19:00');

// --- explicit 24h and all-day ---------------------------------------------
eq('13:00 needs no question',    amb('Meeting at 13:00'), null);
eq('all day has no clock',       amb('Vacation Friday all day'), null);

// --- who is coming, and how they get there and back -----------------------
const cast = s => P(s).people.map(x => x.name + ':' + x.role);
eq('there is one leg',           cast('Soccer Thu 6pm, Jess there'), ['Jess:dropoff']);
eq('back is the other leg',      cast('Soccer Thu 6pm, Jess back'), ['Jess:pickup']);
eq('both legs split cleanly',    cast('Soccer Thu 6pm, Addie going, Jess there, me back'),
   ['Addie:going','Jess:dropoff','Erich:pickup']);
eq('both ways is one person',    cast('Soccer Thu 6pm, Addie going, Jess both ways'),
   ['Addie:going','Jess:driving']);
eq('round trip likewise',        cast('Soccer Thu 6pm, Jess round trip'), ['Jess:driving']);
eq('takes her there is a leg',   cast('Soccer Thu 6pm, Addie going, Jess takes her there'),
   ['Addie:going','Jess:dropoff']);
eq('brings her back is a leg',   cast('Soccer Thu 6pm, Addie going, Jess brings her back'),
   ['Addie:going','Jess:pickup']);
eq('plain driving still works',  cast('Soccer Thu 6pm, Addie going, Jess driving'),
   ['Addie:going','Jess:driving']);

// --- when to ask -----------------------------------------------------------
eq('nobody named -> ask',        [P('Dentist Thursday 3pm').needsCast, P('Dentist Thursday 3pm').needsRides], [true, false]);
eq('kid named, no ride -> ask',  [P('Recital Friday 7pm, Addie going').needsCast, P('Recital Friday 7pm, Addie going').needsRides], [false, true]);
eq('ride given -> no question',  P('Recital Friday 7pm, Addie going, Jess driving').needsRides, false);
eq('just me -> no ride question',P('Dentist Thursday 3pm, I am going').needsRides, false);
eq('whole family -> no question',P('Picnic Saturday 2pm everyone').needsRides, false);

// --- end times, and when one is missing ------------------------------------
eq('range gives an end',   [P('Soccer Thu 6-8pm').start, P('Soccer Thu 6-8pm').end], ['18:00','20:00']);
eq('duration gives an end',[P('Soccer Thu 6pm for 2 hours').start, P('Soccer Thu 6pm for 2 hours').end], ['18:00','20:00']);
eq('pickup with no end',   P('Soccer Thu 6pm, Addie going, me back').needsEnd, true);
eq('pickup with an end',   P('Soccer Thu 6-8pm, Addie going, me back').needsEnd, false);
eq('no pickup, no question',P('Soccer Thu 6pm, Addie going, Jess driving').needsEnd, false);
eq('dropoff only, no question', P('Soccer Thu 6pm, Addie going, Jess there').needsEnd, false);
eq('all day has no end question', P('Field trip Friday all day, Addie going, me back').needsEnd, false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
