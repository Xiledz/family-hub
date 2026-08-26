import { parseQuickAdd } from './parse.js';
const NOW = new Date(2026, 7, 24, 14, 0);            // Monday 24 Aug 2026, 2pm
const M = ['Erich','Jess','Addie','Bryce'];
const P = t => parseQuickAdd(t, { members: M, now: NOW, defaultLead: 30, me: 'Erich' });

let pass=0, fail=0;
const eq=(label,got,want)=>{
  const g=JSON.stringify(got), w=JSON.stringify(want);
  if(g===w) pass++; else { fail++; console.log(`FAIL ${label}\n  got  ${g}\n  want ${w}`); }
};
const R = t => P(t).people.map(p=>p.name+':'+p.role).sort();

eq('single person',      R('Soccer Thursday 5:30 Bryce'), ['Bryce:going']);
eq('going + driver',     R('Soccer Thursday 5:30 Bryce, Jess driving'), ['Bryce:going','Jess:driving']);
eq('drives variant',     R('Soccer Thursday 5:30 Bryce, Jess drives'), ['Bryce:going','Jess:driving']);
eq('is driving variant', R('Soccer Thursday 5:30 Bryce, Jess is driving'), ['Bryce:going','Jess:driving']);
eq('taking variant',     R('Soccer Thursday 5:30 Bryce, Jess taking him'), ['Bryce:going','Jess:driving']);
eq('split dropoff/pickup', R('Dentist Friday 9am Bryce, Jess drops off Erich picks up'),
   ['Bryce:going','Erich:pickup','Jess:dropoff']);
eq('first person = sender', R('Piano Tuesday at 4 Addie, I am taking her'),
   ['Addie:going','Erich:driving']);
eq('helping',            R('Fall festival Saturday Addie, Jess helping'), ['Addie:going','Jess:helping']);
eq('optional',           R('Cookout Sunday 5pm Bryce, Addie maybe'), ['Addie:optional','Bryce:going']);
eq('three bare names',   R('Movie Friday 7pm Bryce Addie Jess'), ['Addie:going','Bryce:going','Jess:going']);

// primary person: the attendee outranks the driver
eq('primary is attendee', P('Soccer Thursday 5:30 Bryce, Jess driving').member, 'Bryce');
eq('primary lone driver', P('Pick up dry cleaning Friday, Jess driving').member, 'Jess');
eq('everyone clears it',  P('Family dinner Sunday 6pm everyone').member, null);
// "everyone" used to clear the cast entirely, which left the event attached to
// nobody and reminded nobody. It now expands to the real member list.
eq('everyone expands',    R('Family dinner Sunday 6pm everyone'),
   ['Addie:going','Bryce:going','Erich:going','Jess:going']);
eq('everyone needs no rides', P('Family dinner Sunday 6pm everyone').needsRides, false);

// the closed vocabulary is never widened
eq('unknown verb -> going', R('Soccer Thursday Bryce, Jess yelling'), ['Bryce:going','Jess:going']);
const roles = new Set(['going','driving','dropoff','pickup','helping','optional']);
const allOk = ['Soccer Thursday 5:30 Bryce, Jess driving, Erich picks up',
               'Dentist Friday 9am Bryce, Jess drops off',
               'Fall festival Saturday Addie, Jess helping']
  .flatMap(t => P(t).people).every(p => roles.has(p.role));
eq('roles always in vocabulary', allOk, true);

// titles stay clean once names and verbs are consumed
eq('title 1', P('Soccer Thursday 5:30 Bryce, Jess driving').title, 'Soccer');
eq('title 2', P('Dentist Friday 9am Bryce, Jess drops off Erich picks up').title, 'Dentist');
eq('title 3', P('Piano Tuesday at 4 Addie, I am taking her').title, 'Piano');

// nothing else regressed
const full = P('Soccer every Monday and Wednesday 5:30 Bryce, Jess driving remind 30 min before');
eq('with recurrence', full.repeat && full.repeat.freq, 'weekly');
eq('with recurrence days', full.repeat && full.repeat.days, [1,3]);
eq('with recurrence people', full.people.map(p=>p.name+':'+p.role).sort(), ['Bryce:going','Jess:driving']);
eq('with recurrence title', full.title, 'Soccer');
eq('with recurrence lead', full.leadMinutes, 30);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
