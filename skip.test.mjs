/* ===========================================================================
 * ABSENCES AND SKIPS
 *
 * The month's commonest interruption: somebody is not where the calendar
 * says. One grammar for "not happening" — sick, snow day, away, one
 * rehearsal cancelled — and its undo. Ranges reuse the calendar's date
 * grammar; there is no second date parser to drift.
 * ========================================================================= */
import { routeIntent, absenceIntent, dateRange } from './parse.js';

const NOW = new Date('2026-09-10T12:00:00Z');            // Thursday
const ROSTER = [
  { name: 'Erich', aliases: ['dad'] }, { name: 'Jess',  aliases: ['mom'] },
  { name: 'Bryce', aliases: [] },      { name: 'Addie', aliases: [] },
];
const OPTS = { stores: [], members: ROSTER, now: NOW, me: 'Erich' };

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
  if (!ok) { console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); fail++; }
  else pass++;
};
const A = b => { const r = absenceIntent(b, OPTS); if (!r) return null; const { intent, ...rest } = r; return [intent, rest]; };
const intent = b => { const r = routeIntent(b, OPTS); return r.intent === 'stateful' ? `${r.why}>${r.otherwise.intent}` : r.intent; };
const T = '2026-09-10';

// --- sick ------------------------------------------------------------------
eq('is sick',            A('Bryce is sick'),            ['absence', { who: 'Bryce', kind: 'sick', from: T, to: T }]);
eq('is sick today',      A('Bryce is sick today'),      ['absence', { who: 'Bryce', kind: 'sick', from: T, to: T }]);
eq('home sick',          A('Bryce is home sick'),       ['absence', { who: 'Bryce', kind: 'sick', from: T, to: T }]);
eq('stayed home',        A('Addie stayed home'),        ['absence', { who: 'Addie', kind: 'sick', from: T, to: T }]);
eq('is out today',       A('Bryce is out today'),       ['absence', { who: 'Bryce', kind: 'sick', from: T, to: T }]);
eq('sick tomorrow',      A('Bryce is sick tomorrow'),   ['absence', { who: 'Bryce', kind: 'sick', from: '2026-09-11', to: '2026-09-11' }]);
eq('today\'s weekday is today, not next week', A('Bryce is sick Thursday'), ['absence', { who: 'Bryce', kind: 'sick', from: T, to: T }]);
eq('this week runs to Sunday', A('Addie is sick this week'), ['absence', { who: 'Addie', kind: 'sick', from: T, to: '2026-09-13' }]);
eq('numeric range',      A('Bryce is sick 9/15-9/18'),  ['absence', { who: 'Bryce', kind: 'sick', from: '2026-09-15', to: '2026-09-18' }]);
eq('alias',              A('mom is sick'),              ['absence', { who: 'Jess', kind: 'sick', from: T, to: T }]);
/* Not absences. */
eq('sick OF something is a complaint', A('Bryce is sick of soccer'), null);
eq('out OF something is shopping',     A('Bryce is out of milk'), null);
eq('a stranger is nobody',             A('Kevin is sick'), null);

// --- school -------------------------------------------------------------
eq('snow day',           A('snow day'),                 ['absence', { who: null, kind: 'school_closed', from: T, to: T }]);
eq('school is closed',   A('school is closed tomorrow'),['absence', { who: null, kind: 'school_closed', from: '2026-09-11', to: '2026-09-11' }]);
eq('no school Friday',   A('no school Friday'),         ['absence', { who: null, kind: 'school_closed', from: '2026-09-11', to: '2026-09-11' }]);
eq('no school, bare',    A('no school'),                ['absence', { who: null, kind: 'school_closed', from: T, to: T }]);

// --- away ----------------------------------------------------------------
eq('away Tue–Thu',       A('Erich is away Tue–Thu'),    ['absence', { who: 'Erich', kind: 'away', from: '2026-09-15', to: '2026-09-17' }]);
eq('I\'m away (sender)', A("I'm away Mon-Wed"),         ['absence', { who: 'Erich', kind: 'away', from: '2026-09-14', to: '2026-09-16' }]);
eq('traveling next week',A('I am traveling next week'), ['absence', { who: 'Erich', kind: 'away', from: '2026-09-14', to: '2026-09-20' }]);
eq('out of town Mar 9–13', A('Jess is out of town Mar 9–13'), ['absence', { who: 'Jess', kind: 'away', from: '2027-03-09', to: '2027-03-13' }]);
eq('through Friday',     A('Erich is gone through Friday'), ['absence', { who: 'Erich', kind: 'away', from: T, to: '2026-09-11' }]);
eq('until Monday',       A('Erich is away until Monday'), ['absence', { who: 'Erich', kind: 'away', from: T, to: '2026-09-14' }]);

// --- one event -----------------------------------------------------------
eq('no X + range',       A('no orchestra Mar 9–13'),    ['skip_event', { title: 'orchestra', from: '2027-03-09', to: '2027-03-13' }]);
eq('no X today',         A('no orchestra today'),       ['skip_event', { title: 'orchestra', from: T, to: T }]);
eq('no X with no date is NOT a skip', A('no orchestra'), null);
eq('...so "no bike" still removes bike', intent('no bike'), 'correction>shop_remove');
eq('skip X date',        A('skip soccer Saturday'),     ['skip_event', { title: 'soccer', from: '2026-09-12', to: '2026-09-12' }]);
eq('skip X defaults today', A('skip orchestra'),        ['skip_event', { title: 'orchestra', from: T, to: T }]);
eq('X is cancelled',     A('orchestra is cancelled'),   ['skip_event', { title: 'orchestra', from: T, to: T }]);
eq('X is canceled Friday', A('orchestra is canceled Friday'), ['skip_event', { title: 'orchestra', from: '2026-09-11', to: '2026-09-11' }]);
eq('X is off',           A('soccer is off Saturday'),   ['skip_event', { title: 'soccer', from: '2026-09-12', to: '2026-09-12' }]);
eq('cancel X + date is a skip', A('cancel soccer Saturday'), ['skip_event', { title: 'soccer', from: '2026-09-12', to: '2026-09-12' }]);
eq('cancel X bare keeps its old meaning', A('cancel soccer'), null);
eq('multi-word title',   A('no piano lesson Tuesday')[1].title, 'piano lesson');

// --- undo ------------------------------------------------------------------
eq('is fine',            A('Bryce is fine'),            ['unskip', { who: 'Bryce', title: null, from: T, to: T }]);
eq('is back',            A('Bryce is back'),            ['unskip', { who: 'Bryce', title: null, from: T, to: T }]);
eq('going after all',    A('Addie is going after all'), ['unskip', { who: 'Addie', title: null, from: T, to: T }]);
eq('fine WITH something is not an undo', A('Bryce is fine with pizza'), null);
eq('cancel the skip',    A('cancel the skip'),          ['unskip', { who: null, title: null, last: true }]);
eq('never mind, X is on',A('never mind, orchestra is on'), ['unskip', { who: null, title: 'orchestra', from: T, to: T }]);
eq('school is on',       A('school is on'),             ['unskip', { who: null, kind: 'school_closed', from: T, to: T }]);
eq('school is open tomorrow', A('school is open tomorrow'), ['unskip', { who: null, kind: 'school_closed', from: '2026-09-11', to: '2026-09-11' }]);

// --- ranges on their own -----------------------------------------------------
eq('empty is today',     dateRange('', OPTS),           { from: T, to: T });
eq('Tue–Thu',            dateRange('Tue–Thu', OPTS),    { from: '2026-09-15', to: '2026-09-17' });
eq('Mar 9–13 shares the month', dateRange('Mar 9–13', OPTS), { from: '2027-03-09', to: '2027-03-13' });
eq('9/15 to 9/18',       dateRange('9/15 to 9/18', OPTS), { from: '2026-09-15', to: '2026-09-18' });
eq('through Friday',     dateRange('through Friday', OPTS), { from: T, to: '2026-09-11' });
eq('all week',           dateRange('all week', OPTS),   { from: T, to: '2026-09-13' });
eq('next week is Mon–Sun', dateRange('next week', OPTS), { from: '2026-09-14', to: '2026-09-20' });
eq('weekday range wraps forward', dateRange('Fri–Tue', OPTS), { from: '2026-09-11', to: '2026-09-15' });
eq('a backwards date range is nothing', dateRange('9/18-9/15', OPTS), null);
eq('words are not dates', dateRange('of soccer', OPTS), null);

// --- routing order ---------------------------------------------------------
eq('absence routes before remove', intent('no school Friday'), 'absence');
eq('skip routes before the tails', intent('skip soccer Saturday'), 'skip_event');
eq('unskip routes',       intent('Bryce is fine'), 'unskip');
eq('chore still a chore', intent('Bryce clean your room'), 'todo');
eq('event still an event', intent('Soccer Thursday 6pm'), 'event');
eq('remove still removes', intent('remove milk'), 'shop_remove');
eq('correction still first', intent('no make it 4'), 'correction>shop_remove');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
