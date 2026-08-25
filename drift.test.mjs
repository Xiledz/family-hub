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

// The role vocabulary must also match what the database will accept.
const dbRoles = ['going','driving','dropoff','pickup','helping','optional'];
const declared = (repoParser.match(/const ROLE_VALUES = \[([^\]]+)\]/) || [])[1];
const parsed = declared ? declared.split(',').map(s => s.trim().replace(/'/g,'')) : [];
check('parser role list matches the database constraint',
      JSON.stringify(parsed) === JSON.stringify(dbRoles),
      `parser: ${JSON.stringify(parsed)}  db: ${JSON.stringify(dbRoles)}`);

console.log(fail ? `\n${fail} check(s) failed` : '\nno drift');
process.exit(fail ? 1 : 0);
