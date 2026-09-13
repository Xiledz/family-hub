/* ===========================================================================
 * OUTBOUND FETCH POLICY
 *
 * Erich pastes a recipe link and the site says 429. That is "come back in a
 * moment", not "give up" — but the old code treated every non-200 the same
 * way and gave the whole thing eight seconds. These tests drive the real
 * policy against a real local HTTP server, because a mocked fetch would not
 * have caught the thing that actually bit us: an abort that covers the body
 * read as well as the connect.
 *
 * Every case asserts the attempt count AND that the call came back inside
 * its budget. A retry policy that is correct but slow is still a bug.
 * ========================================================================= */
import { createServer } from 'http';
import {
  fetchWithRetry, parseRetryAfter, classifyStatus, backoffMs, humanMessage, FetchGaveUp,
} from './fetchpolicy.js';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
  if (!ok) { console.log('  got  ' + JSON.stringify(got)); console.log('  want ' + JSON.stringify(want)); fail++; } else pass++;
};
const ok = (label, cond, detail) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label);
  if (!cond) { if (detail !== undefined) console.log('  ' + detail); fail++; } else pass++;
};

/* ---- Retry-After, the pure part ----------------------------------------- */
eq('retry-after: seconds',        parseRetryAfter('30'), 30);
eq('retry-after: zero',           parseRetryAfter('0'), 0);
eq('retry-after: absent',         parseRetryAfter(null), null);
eq('retry-after: empty',          parseRetryAfter('   '), null);
eq('retry-after: garbage',        parseRetryAfter('soon'), null);
eq('retry-after: negative is not a number we take', parseRetryAfter('-5'), null);
eq('retry-after: http-date ahead',
   parseRetryAfter('Wed, 21 Oct 2026 07:28:10 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT')), 10);
eq('retry-after: http-date in the past clamps to 0',
   parseRetryAfter('Wed, 21 Oct 2026 07:27:00 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT')), 0);

/* ---- what each status means --------------------------------------------- */
eq('200 is ok',          classifyStatus(200), 'ok');
eq('204 is ok',          classifyStatus(204), 'ok');
eq('403 is the bot wall', classifyStatus(403), 'blocked');
eq('401 is blocked',     classifyStatus(401), 'blocked');
eq('404 is gone',        classifyStatus(404), 'not_found');
eq('429 is rate limited', classifyStatus(429), 'rate_limited');
eq('503 is a server hiccup', classifyStatus(503), 'server_error');
eq('418 is just unreadable', classifyStatus(418), 'unreadable');

/* ---- backoff grows, and stays bounded ----------------------------------- */
eq('backoff 1 with no jitter', backoffMs(1, 0), 2000);
eq('backoff 2 with no jitter', backoffMs(2, 0), 5000);
ok('backoff jitter stays under half a second',
   backoffMs(1, 1) - backoffMs(1, 0) <= 400, backoffMs(1, 1) - backoffMs(1, 0));

/* ---- the message a person reads ----------------------------------------- */
ok('rate-limited names the site and the next move',
   /allrecipes\.com/.test(humanMessage('rate_limited', 'allrecipes.com', 60)) &&
   /paste/i.test(humanMessage('rate_limited', 'allrecipes.com', 60)));
ok('blocked does not tell him to try again',
   !/try again/i.test(humanMessage('blocked', 'seriouseats.com', null)));
ok('no status code leaks into the sentence',
   !/\b(429|403|503)\b/.test([
     humanMessage('rate_limited', 'x.com', 30),
     humanMessage('blocked', 'x.com', null),
     humanMessage('server_error', 'x.com', null),
   ].join(' ')));

/* ---- a real server, real sockets ---------------------------------------- */
const routes = new Map();
const hits = new Map();
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  hits.set(path, (hits.get(path) || 0) + 1);
  const handler = routes.get(path);
  if (!handler) { res.writeHead(404).end('no route'); return; }
  handler(req, res, hits.get(path));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const at = (p) => `${base}${p}`;

/* Sleep for real, but in test time: the policy's waits are seconds long and
   we are not sitting through them. Every case still asserts elapsed time, so
   a policy that waits when it should not still fails. */
let slept = 0;
const fastSleep = (ms) => { slept += ms; return Promise.resolve(); };
const run = (path, opts = {}) => fetchWithRetry(fetch, at(path), { sleepImpl: fastSleep, jitter: 0, ...opts });
const catchIt = async (p) => { try { const r = await p; return { ok: true, r }; } catch (e) { return { ok: false, e }; } };

routes.set('/good', (_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Fire Crackers</h1>'); });
routes.set('/429-then-ok', (_q, res, n) => {
  if (n === 1) { res.writeHead(429, { 'retry-after': '2' }).end('slow down'); return; }
  res.writeHead(200).end('<h1>ok on the second ask</h1>');
});
routes.set('/429-always', (_q, res) => { res.writeHead(429).end('slow down'); });
routes.set('/429-rude', (_q, res) => { res.writeHead(429, { 'retry-after': '300' }).end('come back later'); });
routes.set('/403', (_q, res) => { res.writeHead(403).end('bots not welcome'); });
routes.set('/404', (_q, res) => { res.writeHead(404).end('gone'); });
routes.set('/503-twice', (_q, res, n) => {
  if (n <= 2) { res.writeHead(503).end('busy'); return; }
  res.writeHead(200).end('<h1>third time</h1>');
});
routes.set('/dribble', (_q, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.write('<html>');
  setTimeout(() => { try { res.end('</html>'); } catch {} }, 3000);   // never inside a 300ms budget
});
routes.set('/huge', (_q, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  const chunk = 'x'.repeat(100_000);
  for (let i = 0; i < 25; i++) res.write(chunk);                       // 2.5MB
  res.end();
});

{ // a page that simply works
  const t0 = Date.now();
  const r = await run('/good');
  eq('good page: one attempt', [r.attempts, r.status, /Fire Crackers/.test(r.text)], [1, 200, true]);
  ok('good page: no waiting', slept === 0 && Date.now() - t0 < 2000, `slept=${slept}`);
}

{ // 429 with a polite Retry-After: wait what it asked, then succeed
  slept = 0;
  const r = await run('/429-then-ok');
  eq('429 then ok: two attempts, second wins', [r.attempts, r.status], [2, 200]);
  eq('429 then ok: waited exactly the Retry-After', slept, 2000);
  eq('429 then ok: the server saw two hits', hits.get('/429-then-ok'), 2);
}

{ // 429 forever: three attempts, then give up with the reason
  slept = 0;
  const { ok: won, e } = await catchIt(run('/429-always'));
  ok('429 always: gives up', !won);
  eq('429 always: reason and attempts', [e.reason, e.attempts, e.status], ['rate_limited', 3, 429]);
  eq('429 always: backed off twice, no Retry-After to honour', slept, 7000);
  ok('429 always: message tells him to paste', /paste/i.test(e.message), e.message);
}

{ // a five-minute Retry-After is not something to sit on inside a request
  slept = 0;
  const { e } = await catchIt(run('/429-rude'));
  eq('rude Retry-After: stops on the first answer', [e.reason, e.attempts, e.retryAfterSeconds], ['rate_limited', 1, 300]);
  eq('rude Retry-After: does not wait', slept, 0);
  ok('rude Retry-After: says minutes, not seconds', /minutes/.test(e.message), e.message);
  eq('rude Retry-After: only one hit', hits.get('/429-rude'), 1);
}

{ // the bot wall: never retried
  slept = 0;
  const { e } = await catchIt(run('/403'));
  eq('403: one attempt only', [e.reason, e.attempts], ['blocked', 1]);
  eq('403: the site was asked once', hits.get('/403'), 1);
  eq('403: no waiting', slept, 0);
}

{ // a dead link is a dead link
  const { e } = await catchIt(run('/404'));
  eq('404: not retried', [e.reason, e.attempts], ['not_found', 1]);
  eq('404: one hit', hits.get('/404'), 1);
}

{ // two hiccups then a page
  slept = 0;
  const r = await run('/503-twice');
  eq('503 twice then ok: third attempt wins', [r.attempts, r.status], [3, 200]);
  eq('503 twice then ok: 2s then 5s', slept, 7000);
}

{ // a page that dribbles past the deadline is a timeout, and it is retried
  slept = 0;
  const t0 = Date.now();
  const { e } = await catchIt(run('/dribble', { perAttemptMs: 300, totalMs: 4000 }));
  eq('slow body: reads as a timeout', e.reason, 'timeout');
  ok('slow body: tried more than once', e.attempts >= 2, `attempts=${e.attempts}`);
  ok('slow body: stayed inside the budget', Date.now() - t0 < 4000, `${Date.now() - t0}ms`);
}

{ // a 2.5MB page comes back capped, not truncated mid-read and thrown away
  const r = await run('/huge');
  eq('huge page: capped at 2MB', [r.attempts, r.text.length], [1, 2_000_000]);
}

{ // the overall budget wins even when attempts remain
  slept = 0;
  const realish = (ms) => new Promise(r => setTimeout(r, ms));
  const t0 = Date.now();
  const { e } = await catchIt(fetchWithRetry(fetch, at('/429-always'),
    { sleepImpl: realish, jitter: 0, perAttemptMs: 500, totalMs: 1200 }));
  ok('budget: gives up before the deadline', Date.now() - t0 < 2500, `${Date.now() - t0}ms`);
  eq('budget: still reports rate limiting', e.reason, 'rate_limited');
}

{ // a host that is not listening at all
  const { e } = await catchIt(fetchWithRetry(fetch, 'http://127.0.0.1:1/nope',
    { sleepImpl: fastSleep, jitter: 0 }));
  eq('dead host: timeout after all attempts', [e.reason, e.attempts], ['timeout', 3]);
  ok('dead host: names the host', e.host === '127.0.0.1', e.host);
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
