/* ===========================================================================
 * SEASON PASTE
 *
 * The orchestra schedule arrives once a season as twenty dated lines under a
 * header. Typed one at a time, most never got typed. parseSeason reads the
 * block: header carries down, date lists fan out, "@" is the place, and a
 * line it cannot date is kept as skipped — shown, never guessed.
 * ========================================================================= */
import { routeIntent, parseSeason, looksLikeSeason, splitSeasonLines } from './parse.js';

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
const S = b => parseSeason(b, OPTS);
const okRows = s => s.rows.filter(r => r.ok);
const brief = r => `${r.date} ${r.allDay ? 'all-day' : r.start + (r.end ? '-' + r.end : '')} ${r.title}`;

// --- the orchestra schedule ------------------------------------------------
const ORCH = 'Orchestra rehearsals — Addie, Jess driving\nTue 9/15 6:30-8pm\nSept 22, 29 — 6:30 pm\nOct 6 6:30pm\nConcert TBD\n10/13 6:30pm';
const o = S(ORCH);
eq('header title',            o.title, 'Orchestra rehearsals');
eq('header people',           o.people.map(p => `${p.name}:${p.role}`), ['Addie:going', 'Jess:driving']);
eq('five dated rows',         okRows(o).length, 5);
eq('first row: range kept',   brief(okRows(o)[0]), '2026-09-15 18:30-20:00 Orchestra rehearsals');
eq('date list fans out',      okRows(o).slice(1, 3).map(r => r.date), ['2026-09-22', '2026-09-29']);
eq('...each at 6:30pm',       okRows(o).slice(1, 3).map(r => r.start), ['18:30', '18:30']);
eq('title carries down',      okRows(o).every(r => r.title === 'Orchestra rehearsals'), true);
eq('people carry down',       okRows(o)[4].people.map(p => p.name), ['Addie', 'Jess']);
eq('undated line is skipped', o.skipped, ['Concert TBD']);
eq('...and stays in place, unticked', o.rows[4].ok, false);
eq('...with its raw text',    o.rows[4].raw, 'Concert TBD');
eq('weekday prefix is not a title', o.rows[0].title, 'Orchestra rehearsals');

// --- the soccer schedule -----------------------------------------------------
const SOC = 'Bryce soccer fall 2026\nSat Oct 3 vs Tigers 9am @ Bear Branch\nSat Oct 10 vs Lions 11am @ Bear Branch\n10/17 Practice\nFri 10/2 7:00 PM Home vs Oak Ridge\nSat Oct 3 vs Tigers 9am @ Bear Branch';
const s = S(SOC);
eq('season words dropped from the header', s.title, 'Soccer');
eq('owner from the header',   s.who, ['Bryce']);
eq('opponent joins the title', okRows(s)[0].title, 'Soccer vs Tigers');
eq('@ is the place',          okRows(s)[0].location, 'Bear Branch');
eq('...and not the title',    okRows(s)[0].title.includes('Bear'), false);
eq('own title is joined with a dash', okRows(s)[2].title, 'Soccer — Practice');
eq('a bare date is all-day',  okRows(s)[2].allDay, true);
eq('exact duplicate line collapses', okRows(s).length, 4);
eq('Bryce on every row',      okRows(s).every(r => r.people[0]?.name === 'Bryce'), true);

// --- no header, a line naming its own people, all-day holidays ---------------
const NOH = '9/15 6pm\n9/22 6pm Addie\n9/29 6pm';
eq('no header: rows still parse', okRows(S(NOH)).length, 3);
eq('...untitled when nothing says', okRows(S(NOH))[0].title, 'Untitled');
eq('a line\'s own people win',  okRows(S(NOH))[1].people.map(p => p.name), ['Addie']);
const HOL = 'School holidays\n11/26 no school\n11/27 no school\n12/21 winter break starts';
eq('all-day rows',            okRows(S(HOL)).every(r => r.allDay), true);
eq('header — line title',     okRows(S(HOL))[2].title, 'School holidays — winter break starts');

// --- detection ---------------------------------------------------------------
eq('schedule detected',       looksLikeSeason(ORCH, OPTS), true);
eq('two lines is not a season', looksLikeSeason('Orchestra — Addie\n9/15 6pm', OPTS), false);
eq('a grocery list is not a season', looksLikeSeason('milk\neggs\nbananas', OPTS), false);
eq('questions are not a season', looksLikeSeason('anything thursday?\nanything friday?\nanything saturday?', OPTS), false);
eq('semicolons split lines',  splitSeasonLines('a; b; c').length, 3);
eq('bullets are stripped',    splitSeasonLines('- 9/15 6pm\n• 9/22 6pm\n1. 9/29 6pm')[0], '9/15 6pm');
eq('cap at 60 rows',          okRows(S('Team\n' + Array.from({ length: 70 }, (_, i) => `10/${(i % 28) + 1} ${i % 12 + 1}pm ${i}`).join('\n'))).length, 60);

// --- routing -----------------------------------------------------------------
const intent = b => { const r = routeIntent(b, OPTS); return r.intent === 'stateful' ? `${r.why}>${r.otherwise.intent}` : r.intent; };
eq('routes as season',        intent(ORCH), 'season');
eq('...carrying the parse',   routeIntent(ORCH, OPTS).season.rows.length, 6);
eq('grocery paste routes to shop', intent('milk\neggs\nbananas'), 'shop');
eq('three questions are an ask', intent('anything thursday?\nanything friday?\nanything saturday?'), 'ask_day');
eq('one line is still one event', intent('Soccer Thursday 6pm'), 'event');
eq('list is still the list',  intent('list'), 'show');
/* No rides question rides along: every row carries the header's cast, and
   the season insert never calls the per-event nudge. Pinned at the parse:
   rows have people, so needsRides would be false anyway. */
eq('rows carry a cast',       okRows(o).every(r => r.people.length > 0), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
