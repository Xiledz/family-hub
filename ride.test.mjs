/* ===========================================================================
 * A KID ASKING FOR A RIDE  (parse.js §21, sms-inbound requestRide)
 *
 * Addie has a phone now. "can someone pick me up at 5" from her is a request
 * the family number brokers: both parents are asked, the first ME wins.
 * The same words from a parent are NOT a request — opts.kid is what the
 * handler sets for a teen or child, and only then does §21 run.
 * ========================================================================= */
import { routeIntent, rideRequestIntent } from './parse.js';

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
};
const NOW = new Date(2026, 8, 10, 15, 0);          // Thu 3:00 PM local
const ROSTER = [{ name: 'Erich', aliases: ['dad'] }, { name: 'Jess', aliases: ['mom'] },
                { name: 'Addie', aliases: [] }, { name: 'Bryce', aliases: [] }];
const kid   = t => routeIntent(t, { kid: true,  members: ROSTER, now: NOW, me: 'Addie' });
const adult = t => routeIntent(t, { kid: false, members: ROSTER, now: NOW, me: 'Erich' });
const rr = (time, where = null, inMin = null) => ({ intent: 'ride_request', time, inMin, where });

/* The three lines from the brief, plus the shapes a teen actually types. */
const CASES = [
  ['can someone pick me up at 5',                 rr('17:00')],
  ['I need a ride home from practice',            rr(null, 'practice')],
  ['need a ride at 5:30',                         rr('17:30')],
  ['Can you pick me up at 5 please',              rr('17:00')],
  ['pick me up at school at 4:15',                rr('16:15', 'school')],
  ['can mom get me from church at 8pm',           rr('20:00', 'church')],
  ['can somebody grab me from the mall around 3', rr('15:00', 'mall')],
  ['could anyone come get me at 6',               rr('18:00')],
  ['i need a ride home',                          rr(null)],
  ['ride please',                                 rr(null)],
  ['come get me now',                             rr(null, null, 0)],
  ['need a ride in 20 min',                       rr(null, null, 20)],
  ['pick me up in an hour',                       rr(null, null, 60)],
  ['can you pick me up at 12',                    rr('12:00')],          // noon, not midnight
  ['need a ride at 9',                            rr('21:00')],          // 9 AM has passed at 3 PM
  ['need a ride at 9am tomorrow',                 rr('09:00')],
  ['pick me up at 7:45',                          rr('19:45')],
  ['can dad pick me up from practice at 5:15',    rr('17:15', 'practice')],
];
for (const [t, want] of CASES) ok(`kid: ${t}`, kid(t), want);

/* Not rides, even from a kid: her other texts still route normally. */
for (const [t, want] of [
  ['buy milk', 'shop'], ['need milk', 'shop'], ['I need to clean my room', 'todo'],
  ["what's thursday", 'ask_day'], ['soccer thursday 5:30', 'event'], ['my list', 'todo_show'],
  ['did the trash', 'todo_done'], ["what's for dinner", 'ask_dinner'], ['I need a haircut', 'ask'],
]) ok(`kid non-ride: ${t}`, kid(t).intent, want);

/* An adult's identical words never become a request. */
for (const t of ['can someone pick me up at 5', 'I need a ride home from practice', 'need a ride at 5:30', 'ride please'])
  ok(`adult: ${t}`, adult(t).intent !== 'ride_request', true);
ok('rideRequestIntent without kid flag', rideRequestIntent('need a ride at 5'), null);
ok('rideRequestIntent with kid flag', rideRequestIntent('need a ride at 5', { kid: true, now: NOW }), rr('17:00'));

/* AM/PM without a meridiem: 1–8 is PM; 9–11 is AM until that hour has passed. */
const at = h => new Date(2026, 8, 10, h, 0);
ok('9 at 8am → 9 AM', rideRequestIntent('need a ride at 9', { kid: true, now: at(8) }).time, '09:00');
ok('9 at 9am → 9 PM', rideRequestIntent('need a ride at 9', { kid: true, now: at(9) }).time, '21:00');
ok('11 at 10am → 11 AM', rideRequestIntent('pick me up at 11', { kid: true, now: at(10) }).time, '11:00');
ok('3 at 8am → 3 PM', rideRequestIntent('pick me up at 3', { kid: true, now: at(8) }).time, '15:00');
ok('"home" is never a place', rideRequestIntent('need a ride home at 5', { kid: true, now: NOW }).where, null);

console.log(`\n${pass} passed, ${fail} failed`);
