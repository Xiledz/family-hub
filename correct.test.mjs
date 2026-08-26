/* ===========================================================================
 * CORRECTION CLASSIFIER
 *
 * The riskiest thing in the SMS front door is a message read as the wrong
 * kind of message. "no, make it 4" must rewrite the last event. "Soccer
 * Thursday 4pm" must NOT — it has to create a new one. Get that backwards and
 * a text quietly overwrites something that was already right.
 *
 * These constants are read straight out of sms-inbound.ts rather than copied,
 * so this tests what actually deploys.
 * ========================================================================= */
import { readFileSync } from 'fs';
import { parseQuickAdd } from './parse.js';

const src = readFileSync('./sms-inbound.ts', 'utf8');
const grab = name => {
  const m = src.match(new RegExp(`^const ${name}\\s*=\\s*(/.*/[a-z]*);`, 'm'));
  if (!m) throw new Error(`${name} not found in sms-inbound.ts`);
  return eval(m[1]);
};
const FIX_PREFIX = grab('FIX_PREFIX');
const FIX_VERB   = grab('FIX_VERB');
const KILL       = grab('KILL');

const M = ['Erich','Jess','Addie','Bryce'];
const NOW = new Date('2026-08-25T10:00:00');

/* A faithful copy of the branch in the handler. If the handler changes shape,
   this stops matching and the mismatch is the point. */
function classify(body) {
  const pre  = body.match(FIX_PREFIX);
  let rest   = pre ? body.slice(pre[0].length).trim() : body;
  const verb = rest.match(FIX_VERB);
  if (verb) rest = rest.slice(verb[0].length).trim();

  const wantsKill = KILL.test(rest) || KILL.test(body);
  const w = rest ? parseQuickAdd(rest, { members: M, now: NOW, defaultLead: null, me: 'Erich' }) : null;
  const castOnly = !!w && w.people.length > 0 &&
                   !w.matched.includes('date') && !w.matched.includes('time');
  const changed  = !!w && (w.matched.includes('date') || w.matched.includes('time') ||
                           w.matched.includes('lead') || w.people.length > 0);

  if (wantsKill) return 'kill';
  if (castOnly || ((!!pre || !!verb) && changed)) return 'fix';
  return 'new';
}

let pass = 0, fail = 0;
const is = (body, want) => {
  const got = classify(body);
  const ok = got === want;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + `${want.padEnd(4)} ${JSON.stringify(body)}`);
  if (!ok) { console.log(`      got "${got}"`); fail++; } else pass++;
};

// --- corrections -----------------------------------------------------------
is('no, make it 4pm', 'fix');
is('No 4pm', 'fix');
is('actually 5:30', 'fix');
is('wait, Thursday instead', 'fix');
is('sorry, make that 7pm', 'fix');
is('nvm 6pm', 'fix');
is('make it 4pm', 'fix');
is('change it to Monday', 'fix');
is("it's 4pm", 'fix');
is('oops, remind me 2 hours before', 'fix');

// --- answering the follow-up question --------------------------------------
is('Addie going, Jess there, me back', 'fix');
is('Jess there, me back', 'fix');
is('Addie and Bryce', 'fix');
is('Jess driving', 'fix');

// --- removals --------------------------------------------------------------
is('delete that', 'kill');
is('cancel that', 'kill');
is('undo', 'kill');
is('nevermind, delete it', 'kill');
is('forget it', 'kill');

// --- NOT corrections: these must still create events -----------------------
is('Soccer Thursday 4pm', 'new');
is('Dentist tomorrow 9am Addie', 'new');
is('Piano every Tuesday 4pm Addie', 'new');
is('Planning committee moved to Monday at 4', 'new');
is('Groceries', 'new');
is('help', 'new');

/* The trap: a correction prefix on a message that changes nothing real.
   "no thanks" must not be read as an instruction to edit anything. */
is('no thanks', 'new');
is('nope', 'new');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
