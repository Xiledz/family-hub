/* ===========================================================================
 * Family Hub — how we fetch somebody else's website
 *
 * One policy, one place. Erich pastes a recipe link; the page might be a slow
 * food blog with a 2MB hero image, a site that is briefly rate-limiting us,
 * or a site that blocks readers like this one outright. Those three deserve
 * three different answers, and only the first two deserve a second attempt.
 *
 * The old code gave every one of them the same 8-second deadline and the same
 * dead end ("site returned 429"), which is both too impatient and unhelpful:
 * a 429 means "come back in a moment", not "give up".
 *
 * Pure functions plus one fetch wrapper that takes `fetch` as an argument, so
 * the whole thing runs under Node against a local server in fetch.test.mjs.
 * Inlined verbatim into recipe-import.ts; drift.test.mjs keeps the copies
 * identical.
 * ========================================================================= */

/* Worth another try: the server is busy, throttling, or briefly broken. */
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/* Never worth another try. 403 is the bot wall (Allrecipes and friends):
   retrying it cannot succeed and starts to look like an attack. */
const REASON_BY_STATUS = new Map([
  [401, 'blocked'], [403, 'blocked'], [451, 'blocked'],
  [404, 'not_found'], [410, 'not_found'],
  [429, 'rate_limited'],
]);

export function classifyStatus(status) {
  if (status >= 200 && status < 300) return 'ok';
  const named = REASON_BY_STATUS.get(status);
  if (named) return named;
  if (status >= 500) return 'server_error';
  return 'unreadable';
}

/* RFC 9110: Retry-After is either a count of seconds or an HTTP-date.
   Anything else is somebody's idea of a joke and is ignored. */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  /* Only an HTTP-date from here on, and one always carries a weekday and a
     zone. Without this, Date.parse quietly accepts junk like "-5" as a year
     and we would wait on it. */
  if (!/[A-Za-z]/.test(s)) return null;
  const when = Date.parse(s);
  if (Number.isNaN(when)) return null;
  const secs = Math.ceil((when - nowMs) / 1000);
  return secs > 0 ? secs : 0;
}

/* 2s, then 5s, with a little jitter so two phones retrying together do not
   arrive in lockstep. */
export function backoffMs(attempt, jitter = Math.random()) {
  const base = attempt <= 1 ? 2000 : 5000;
  return base + Math.round(jitter * 400);
}

export const DEFAULTS = {
  attempts: 3,          // one try plus two retries
  perAttemptMs: 20000,  // a slow food blog deserves 20s, not 8
  totalMs: 45000,       // and the whole call still has to come back
  maxWaitMs: 15000,     // the longest we will sit on a Retry-After
  maxBytes: 2_000_000,
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class FetchGaveUp extends Error {
  constructor(reason, message, extra = {}) {
    super(message);
    this.name = 'FetchGaveUp';
    this.reason = reason;                    // rate_limited | blocked | timeout | not_found | server_error | unreadable
    this.status = extra.status ?? null;
    this.attempts = extra.attempts ?? 1;
    this.retryAfterSeconds = extra.retryAfterSeconds ?? null;
    this.host = extra.host ?? null;
  }
}

/* What Erich should read. The host and the next move, never the number. */
export function humanMessage(reason, host, retryAfterSeconds) {
  const site = host || 'that site';
  switch (reason) {
    case 'rate_limited': {
      const when = retryAfterSeconds
        ? (retryAfterSeconds >= 90 ? `in about ${Math.round(retryAfterSeconds / 60)} minutes` : `in about ${Math.max(30, retryAfterSeconds)} seconds`)
        : 'in a minute';
      return `${site} is asking us to slow down. Try again ${when}, or paste the ingredients below.`;
    }
    case 'blocked':
      return `${site} blocks automated readers. Paste the ingredients below — everything else still works.`;
    case 'timeout':
      return `${site} took too long to answer. Try once more, or paste the ingredients below.`;
    case 'not_found':
      return `That page is gone from ${site}. Check the link, or paste the ingredients below.`;
    case 'server_error':
      return `${site} is having trouble right now. Try again shortly, or paste the ingredients below.`;
    default:
      return `Couldn't read ${site}. Paste the ingredients below and everything else still works.`;
  }
}

/**
 * fetchWithRetry(fetchImpl, url, opts) -> { text, status, attempts, host }
 * Throws FetchGaveUp, which carries the reason the app acts on.
 *
 * opts: { headers, attempts, perAttemptMs, totalMs, maxWaitMs, maxBytes,
 *         deadlineAt, onAttempt, sleepImpl, jitter }
 */
export async function fetchWithRetry(fetchImpl, url, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const host = (() => { try { return new URL(String(url)).hostname; } catch { return null; } })();
  const started = Date.now();
  const deadlineAt = o.deadlineAt ?? (started + o.totalMs);
  const nap = o.sleepImpl || sleep;
  let last = null;

  for (let attempt = 1; attempt <= o.attempts; attempt++) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      throw new FetchGaveUp(last?.reason || 'timeout',
        humanMessage(last?.reason || 'timeout', host, last?.retryAfterSeconds),
        { status: last?.status ?? null, attempts: attempt - 1, host, retryAfterSeconds: last?.retryAfterSeconds ?? null });
    }
    const budget = Math.min(o.perAttemptMs, remaining);
    if (o.onAttempt) o.onAttempt(attempt, budget);

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), budget);
    let res = null;
    try {
      res = await fetchImpl(String(url), {
        signal: ctl.signal, redirect: 'follow', headers: o.headers || {},
      });
    } catch (err) {
      clearTimeout(t);
      /* An abort is a timeout; anything else here is the network. Both are
         worth one more go, because both are often the moment, not the site. */
      last = { reason: 'timeout', status: null, retryAfterSeconds: null, err };
      if (attempt < o.attempts && Date.now() < deadlineAt) {
        const wait = Math.min(backoffMs(attempt, o.jitter), Math.max(0, deadlineAt - Date.now()));
        if (wait > 0) await nap(wait);
        continue;
      }
      throw new FetchGaveUp('timeout', humanMessage('timeout', host, null),
        { status: null, attempts: attempt, host });
    }

    const reason = classifyStatus(res.status);
    if (reason === 'ok') {
      /* The deadline stays armed through the body read. `fetch` resolves as
         soon as the headers land, so clearing the timer here would give a
         page that dribbles its body forever an unbounded read — which is the
         same bug as too short a timeout, wearing the opposite hat. */
      try {
        const text = await readCapped(res, o.maxBytes);
        clearTimeout(t);
        return { text, status: res.status, attempts: attempt, host };
      } catch (err) {
        clearTimeout(t);
        last = { reason: 'timeout', status: res.status, retryAfterSeconds: null, err };
        if (attempt < o.attempts && Date.now() < deadlineAt) {
          const wait = Math.min(backoffMs(attempt, o.jitter), Math.max(0, deadlineAt - Date.now()));
          if (wait > 0) await nap(wait);
          continue;
        }
        throw new FetchGaveUp('timeout', humanMessage('timeout', host, null),
          { status: res.status, attempts: attempt, host });
      }
    }

    const retryAfterSeconds = parseRetryAfter(res.headers?.get?.('retry-after'));
    last = { reason, status: res.status, retryAfterSeconds };
    try { await res.body?.cancel?.(); } catch { /* nothing to drain */ }
    clearTimeout(t);

    if (!RETRY_STATUS.has(res.status) || attempt >= o.attempts) {
      throw new FetchGaveUp(reason, humanMessage(reason, host, retryAfterSeconds),
        { status: res.status, attempts: attempt, host, retryAfterSeconds });
    }

    /* How long to wait: what the server asked for, else our backoff. A rude
       Retry-After (five minutes) is not something to sit on inside a request
       — stop now and tell him when to come back. */
    let wait = retryAfterSeconds != null ? retryAfterSeconds * 1000 : backoffMs(attempt, o.jitter);
    if (wait > o.maxWaitMs || Date.now() + wait >= deadlineAt) {
      throw new FetchGaveUp(reason, humanMessage(reason, host, retryAfterSeconds ?? Math.ceil(wait / 1000)),
        { status: res.status, attempts: attempt, host, retryAfterSeconds: retryAfterSeconds ?? Math.ceil(wait / 1000) });
    }
    await nap(wait);
  }

  throw new FetchGaveUp(last?.reason || 'unreadable',
    humanMessage(last?.reason || 'unreadable', host, last?.retryAfterSeconds),
    { status: last?.status ?? null, attempts: o.attempts, host, retryAfterSeconds: last?.retryAfterSeconds ?? null });
}

/* Read at most maxBytes, then stop pulling. A recipe is in the first 2MB. */
export async function readCapped(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) return await res.text();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { chunks.push(value); try { await reader.cancel(); } catch { /* already done */ } break; }
    chunks.push(value);
  }
  const want = Math.min(total, maxBytes);
  const buf = new Uint8Array(want);
  let off = 0;
  for (const c of chunks) {
    if (off >= want) break;
    const n = Math.min(c.byteLength, want - off);
    buf.set(c.subarray(0, n), off); off += n;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}
