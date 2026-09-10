/* ===========================================================================
 * DRIFT GUARD
 *
 * parse.js exists twice: once as the module the web app imports, and once
 * copied verbatim into the SMS edge function, because Supabase's bundler
 * refuses remote imports and its editor loses second files on deploy.
 *
 * Two copies of a grammar is a bug waiting to happen, and a nasty one: both
 * halves keep working, just differently. The app reads "every other Tuesday"
 * one way and the text number reads it another, and nobody notices until a
 * kid is standing outside a school.
 *
 * This test fails loudly the moment they stop matching.
 * ========================================================================= */
import { readFileSync } from 'fs';

const START = '/* ============================================================================\n * Family Hub';
const END   = 'const admin = () => createClient(';

const repoParser = readFileSync('./parse.js', 'utf8');
const fnSource   = readFileSync('./sms-inbound.ts', 'utf8');

let fail = 0;
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
  if (!ok) { fail++; if (detail) console.log('      ' + detail); }
};

const i = fnSource.indexOf(START);
const j = fnSource.indexOf(END);
check('function contains an inlined parser', i > 0 && j > i,
      'markers not found — did the function get restructured?');

if (i > 0 && j > i) {
  // The only legitimate difference: the copy drops `export` so it can sit
  // inline in a single file.
  const inlined  = fnSource.slice(i, j).trimEnd();
  const expected = repoParser.replace(/^export /gm, '').trimEnd();

  check('inlined parser matches parse.js exactly', inlined === expected);

  if (inlined !== expected) {
    const a = expected.split('\n'), b = inlined.split('\n');
    console.log(`      parse.js: ${a.length} lines, inlined: ${b.length} lines`);
    for (let k = 0; k < Math.max(a.length, b.length); k++) {
      if (a[k] !== b[k]) {
        console.log(`      first difference at line ${k + 1}:`);
        console.log(`        parse.js: ${JSON.stringify(a[k])}`);
        console.log(`        inlined : ${JSON.stringify(b[k])}`);
        break;
      }
    }
    console.log('\n      FIX: copy parse.js into sms-inbound.ts (dropping the');
    console.log('      "export " keywords) and redeploy the function.');
  }
}

/* ===========================================================================
 * The delivery chain is the SECOND thing that exists twice.
 *
 * deliver.ts is copied verbatim into both edge functions, for the same reason
 * parse.js is: Supabase's bundler refuses remote hosts and its in-browser
 * editor loses second files on deploy.
 *
 * Two copies of "how do we reach this person" drifting apart is quieter than
 * a parser drifting, and worse: the reminder would find Bryce through Jess
 * and the morning digest would not, and the only symptom is a kid who
 * sometimes gets told and sometimes does not.
 * ========================================================================= */
const DSTART = '/* ============================================================================\n * Family Hub — the delivery chain';
const DEND   = '/* ===== end delivery chain';

const deliverSrc = readFileSync('./deliver.ts', 'utf8');

for (const fn of ['./dispatch-reminders.ts', './morning-digest.ts']) {
  const src = readFileSync(fn, 'utf8');
  const a = src.indexOf(DSTART);
  const b = src.indexOf(DEND);
  const label = fn.replace('./', '');

  check(`${label} contains the delivery chain`, a >= 0 && b > a,
        'markers not found — was the block edited by hand?');

  if (a >= 0 && b > a) {
    const inlined  = src.slice(a, b).trimEnd();
    const expected = deliverSrc.slice(deliverSrc.indexOf(DSTART),
                                     deliverSrc.indexOf(DEND)).trimEnd();
    check(`${label} delivery chain matches deliver.ts`, inlined === expected);

    if (inlined !== expected) {
      const x = expected.split('\n'), y = inlined.split('\n');
      for (let k = 0; k < Math.max(x.length, y.length); k++) {
        if (x[k] !== y[k]) {
          console.log(`      first difference at line ${k + 1}:`);
          console.log(`        deliver.ts: ${JSON.stringify(x[k])}`);
          console.log(`        ${label}: ${JSON.stringify(y[k])}`);
          break;
        }
      }
      console.log('\n      FIX: re-copy deliver.ts into the function and redeploy.');
    }
  }
}

/* Both functions must also agree on which build of the chain they carry. */
{
  const stamp = (f) => (readFileSync(f, 'utf8').match(/const DELIVER_BUILD = '([^']+)'/) || [])[1];
  const a = stamp('./deliver.ts');
  const b = stamp('./dispatch-reminders.ts');
  const c = stamp('./morning-digest.ts');
  check('delivery build stamps agree', a && a === b && a === c,
        `deliver.ts:${a} dispatch:${b} digest:${c}`);
}

// The role vocabulary must also match what the database will accept.
const dbRoles = ['going','driving','dropoff','pickup','helping','optional'];
const declared = (repoParser.match(/const ROLE_VALUES = \[([^\]]+)\]/) || [])[1];
const parsed = declared ? declared.split(',').map(s => s.trim().replace(/'/g,'')) : [];
check('parser role list matches the database constraint',
      JSON.stringify(parsed) === JSON.stringify(dbRoles),
      `parser: ${JSON.stringify(parsed)}  db: ${JSON.stringify(dbRoles)}`);

console.log(fail ? `\n${fail} check(s) failed` : '\nno drift');
process.exit(fail ? 1 : 0);
