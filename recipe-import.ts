/* ============================================================================
 * recipe-import — turn a URL or a pasted block into a recipe the app can
 * show for confirmation.
 *
 * WHAT IT DOES
 *   POST {url}   → fetches the page and extracts the recipe.
 *   POST {text}  → treats the block as a pasted recipe (family recipes).
 *   Returns JSON. WRITES NOTHING. The app shows a confirm screen and inserts
 *   on tap — nothing lands in the database without somebody looking at it,
 *   whichever door it came in by.
 *
 * WHY AN EDGE FUNCTION
 *   The app is a static page and cannot fetch another site from the browser
 *   (CORS). This can. It is also the ONLY place a URL is fetched, so this is
 *   where the guards live.
 *
 * HOW THE RECIPE IS FOUND, in order
 *   1. JSON-LD   — <script type="application/ld+json"> with @type Recipe.
 *                  Nearly every recipe blog emits this, because Google reads
 *                  it. It is in the raw HTML; no JavaScript needed.
 *   2. Microdata — itemtype="…/Recipe" with itemprop="recipeIngredient".
 *                  Older sites.
 *   3. Headings  — the <li> items after a heading that says "Ingredients",
 *                  until one that says "Instructions". The SAME code reads
 *                  a pasted block, which is how family recipes come in.
 *   4. Nothing   — the title and image still come back, and the app asks
 *                  for the ingredients to be pasted. Never a blank screen.
 *
 * PINTEREST
 *   A pin is a pointer to a blog, not a recipe. But the pin page's own
 *   JSON-LD is a SocialMediaPosting whose sharedContent.url IS the blog
 *   post — verified against a real pin, no login wall for a plain fetch.
 *   So a pin is resolved to its source and the source is read, all in one
 *   call. The person shares the pin and that is the whole job. pin.it short
 *   links redirect to the pin page and are followed.
 *
 * GUARDS
 *   This is reachable with the public anon key, so it is an open fetch
 *   proxy unless it refuses to be one: http/https only, no loopback, no
 *   private ranges, no supabase hosts, a bounded retry policy (20s an
 *   attempt, 45s overall), 2MB cap, and it returns
 *   extracted JSON — never the raw page.
 *
 * Deploy:  Edge Functions → recipe-import.  Verify JWT can stay ON (the app
 *          sends the anon key).
 * ==========================================================================*/

const BUILD = '2026-09-13a-retry';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

/* @inline fetchpolicy.js — the copy below is that file with the `export `
   keywords removed. drift.test.mjs fails the moment it is not. */
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

function classifyStatus(status) {
  if (status >= 200 && status < 300) return 'ok';
  const named = REASON_BY_STATUS.get(status);
  if (named) return named;
  if (status >= 500) return 'server_error';
  return 'unreadable';
}

/* RFC 9110: Retry-After is either a count of seconds or an HTTP-date.
   Anything else is somebody's idea of a joke and is ignored. */
function parseRetryAfter(value, nowMs = Date.now()) {
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
function backoffMs(attempt, jitter = Math.random()) {
  const base = attempt <= 1 ? 2000 : 5000;
  return base + Math.round(jitter * 400);
}

const DEFAULTS = {
  attempts: 3,          // one try plus two retries
  perAttemptMs: 20000,  // a slow food blog deserves 20s, not 8
  totalMs: 45000,       // and the whole call still has to come back
  maxWaitMs: 15000,     // the longest we will sit on a Retry-After
  maxBytes: 2_000_000,
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class FetchGaveUp extends Error {
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
function humanMessage(reason, host, retryAfterSeconds) {
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
async function fetchWithRetry(fetchImpl, url, opts = {}) {
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
async function readCapped(res, maxBytes) {
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
/* @end fetchpolicy.js */

/* ---- guards ---------------------------------------------------------------*/
function safeUrl(raw: string): { ok: true; url: URL } | { ok: false; why: string } {
  let u: URL;
  try { u = new URL(String(raw).trim()); } catch { return { ok: false, why: 'not a url' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, why: 'http(s) only' };
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return { ok: false, why: 'blocked host' };
  if (/\.supabase\.(co|in)$/.test(h)) return { ok: false, why: 'blocked host' };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0)
      return { ok: false, why: 'blocked host' };
  }
  if (h.includes(':') || h === '[::1]') return { ok: false, why: 'blocked host' };
  return { ok: true, url: u };
}

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/* One page, with the shared policy in front of it. `deadlineAt` is threaded
   through from the handler so a Pinterest two-hop cannot spend the budget
   twice. Throws FetchGaveUp, which carries the reason the app acts on. */
async function fetchPage(u: URL, deadlineAt: number): Promise<string> {
  const r = await fetchWithRetry(fetch, u.toString(), {
    deadlineAt,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  return r.text;
}

/* ---- Pinterest: a pin is a pointer; follow it -------------------------------
   The pin page's JSON-LD is a SocialMediaPosting with sharedContent.url.
   Returns the source URL, or null if this pin has no outbound link (an
   image-only pin, or a pin of another pin). */
const isPinterest = (u: URL) => /(^|\.)pinterest\.[a-z.]+$|^pin\.it$/.test(u.hostname.toLowerCase());

function pinSource(html: string): string | null {
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const d = JSON.parse(m[1].trim());
      const pool = Array.isArray(d) ? d : [d];
      for (const x of pool) {
        const u = x?.sharedContent?.url ?? x?.mainEntityOfPage?.url ?? null;
        if (u && /^https?:\/\//i.test(u)) return u;
      }
    } catch { /* not this block */ }
  }
  /* Older markup: the pin's own link sits in the initial-state JSON. */
  const k = html.match(/"link":"(https?:\/\/[^"]{8,300})"/);
  return k ? k[1].replace(/\\\//g, '/') : null;
}

/* ---- helpers --------------------------------------------------------------*/
/* @inline markup.js — the copy below is that file with the `export `
   keywords removed. drift.test.mjs fails the moment it is not. */
/* ===========================================================================
 * Family Hub — turning somebody's recipe page into text
 *
 * The rule these enforce: nothing that still looks like markup is an
 * ingredient. A loveandlemons import came back as sixty-one ingredients
 * beginning "<div", because a naive /<[^>]+>/ stops at the first '>' and
 * WordPress Recipe Maker writes aria-labels full of them. Rather than chase
 * every tag shape forever, the extractors now check their own output and
 * refuse a harvest that is mostly rubble — the paste box is a better answer
 * than sixty-one rows of garbage.
 *
 * Inlined verbatim into recipe-import.ts; drift.test.mjs keeps them equal.
 * ========================================================================= */

/* A tag, including one whose attribute value contains a '>'. */
const TAG = /<\/?[a-z][a-z0-9-]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>`]+))?)*\s*\/?>/gi;

const decode = (s) => String(s ?? '')
  .replace(TAG, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  /* WordPress Recipe Maker writes fractions as named entities. */
  .replace(/&frac12;/g, '½').replace(/&frac14;/g, '¼').replace(/&frac34;/g, '¾')
  .replace(/&frac13;/g, '⅓').replace(/&frac23;/g, '⅔').replace(/&frac18;/g, '⅛')
  .replace(/&deg;/g, '°').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&hellip;/g, '…')
  .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/\s+/g, ' ').trim();

/* An angle bracket, or a bare attribute like `class=wprm-recipe-ingredient`. */
const looksLikeMarkup = (s) =>
  /[<>]/.test(s) || /\b[a-z-]+=(?:"|'|[a-z0-9-]+[>/])/i.test(s) || /^\s*[a-z-]+=/i.test(s);

function sane(list) {
  return (list || []).map(x => String(x ?? '').trim()).filter(x => x && !looksLikeMarkup(x));
}

/* True when what came back is mostly rubble. A third is generous: one
   stray tag in a long list is a blemish, a third of them is a failure. */
function mostlyMarkup(list) {
  if (!list || !list.length) return false;
  return list.filter(looksLikeMarkup).length / list.length >= 0.34;
}
/* @end markup.js */

/* "PT1H30M" → 90. Also tolerates "30 mins" / "1 hour". */
function minutesOf(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v);
  let m = s.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (m && (m[1] || m[2] || m[3])) return (+(m[1] || 0)) * 1440 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
  let total = 0, hit = false;
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i))) { total += parseFloat(m[1]) * 60; hit = true; }
  if ((m = s.match(/(\d+)\s*(?:m|min|mins|minute|minutes)\b/i)))     { total += +m[1]; hit = true; }
  return hit ? Math.round(total) : null;
}

/* "4 servings" / "Serves 6" / "12 muffins" / ["4"] → 4 */
function servingsOf(v: unknown): number | null {
  if (v == null) return null;
  const s = Array.isArray(v) ? v.map(String).join(' ') : String(v);
  const m = s.match(/(\d+)/);
  return m ? +m[1] : null;
}

function firstStr(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return firstStr(v[0]);
  if (typeof v === 'object') {
    const o = v as any;
    return firstStr(o.url ?? o.contentUrl ?? o['@id'] ?? o.text ?? o.name);
  }
  return String(v);
}

function stepsOf(v: unknown): string[] {
  const out: string[] = [];
  const walk = (x: any) => {
    if (x == null) return;
    if (typeof x === 'string') { const t = decode(x); if (t) out.push(t); return; }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === 'object') {
      if (x['@type'] === 'HowToSection' && x.itemListElement) { walk(x.itemListElement); return; }
      if (x.text) { walk(x.text); return; }
      if (x.itemListElement) { walk(x.itemListElement); return; }
      if (x.name) { walk(x.name); return; }
    }
  };
  walk(v);
  return out;
}

type Found = {
  name: string | null; image: string | null; servings: number | null;
  cook_minutes: number | null; prep_minutes: number | null; total_minutes: number | null;
  ingredients: string[]; instructions: string[]; method: string;
};

/* ---- 1. JSON-LD ---------------------------------------------------------- */
function fromJsonLd(html: string): Found | null {
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  const isRecipe = (t: unknown) => Array.isArray(t) ? t.includes('Recipe') : t === 'Recipe';
  while ((m = re.exec(html))) {
    let data: any;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const pool: any[] = [];
    const push = (x: any) => { if (!x) return; if (Array.isArray(x)) x.forEach(push); else { pool.push(x); if (x['@graph']) push(x['@graph']); } };
    push(data);
    const r = pool.find(x => x && isRecipe(x['@type']));
    if (!r) continue;
    const ing = (r.recipeIngredient ?? r.ingredients ?? []);
    return {
      name: firstStr(r.name), image: firstStr(r.image),
      servings: servingsOf(r.recipeYield),
      cook_minutes: minutesOf(r.cookTime), prep_minutes: minutesOf(r.prepTime), total_minutes: minutesOf(r.totalTime),
      ingredients: sane((Array.isArray(ing) ? ing : [ing]).map((s: any) => decode(String(s)))),
      instructions: sane(stepsOf(r.recipeInstructions)),
      method: 'jsonld',
    };
  }
  return null;
}

/* ---- 2. Microdata --------------------------------------------------------- */
function fromMicrodata(html: string): Found | null {
  if (!/itemtype\s*=\s*["'][^"']*schema\.org\/Recipe/i.test(html)) return null;
  const prop = (name: string) => {
    const out: string[] = [];
    const re = new RegExp(`<([a-z0-9]+)[^>]*itemprop\\s*=\\s*["']${name}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) { const t = decode(m[2]); if (t) out.push(t); }
    return out;
  };
  const ing = [...prop('recipeIngredient'), ...prop('ingredients')];
  if (!ing.length) return null;
  const nameM = html.match(/itemprop\s*=\s*["']name["'][^>]*>([^<]+)</i);
  return {
    name: nameM ? decode(nameM[1]) : null, image: null,
    servings: servingsOf(prop('recipeYield')[0]),
    cook_minutes: null, prep_minutes: null, total_minutes: null,
    ingredients: sane(ing), instructions: sane(prop('recipeInstructions')), method: 'microdata',
  };
}

/* ---- 3. Headings — HTML or plain text --------------------------------------
   Turn the page into lines, find "Ingredients", collect until "Instructions",
   then collect those. Works on a pasted family recipe too, which is the
   point of doing it this way. */
function linesOf(htmlOrText: string): string[] {
  const isHtml = /<[a-z][\s\S]*>/i.test(htmlOrText);
  if (!isHtml) return htmlOrText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const stripped = htmlOrText
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<(?:li|p|h[1-6]|div|br|tr|section|article)\b(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>`]+))?)*\s*\/?>/gi, '\n$&');
  return stripped.split('\n').map(decode).filter(Boolean);
}

function fromHeadings(src: string): Found | null {
  const lines = linesOf(src);
  const ING = /^(?:ingredients?)\b/i;
  const INS = /^(?:instructions?|directions?|method|steps?|preparation|how to make)\b/i;
  const STOP = /^(?:notes?|nutrition|equipment|video|comments?|you might also like|related)\b/i;
  let i = lines.findIndex(l => ING.test(l));
  if (i < 0) return null;
  const ingredients: string[] = []; const instructions: string[] = [];
  let mode: 'ing' | 'ins' | 'off' = 'ing';
  for (let k = i + 1; k < lines.length; k++) {
    const l = lines[k];
    if (INS.test(l))  { mode = 'ins'; continue; }
    if (STOP.test(l)) { if (mode === 'ins') break; mode = 'off'; continue; }
    if (ING.test(l))  { mode = 'ing'; continue; }
    if (l.length > 300) continue;                               // prose, not a line item
    if (/^(?:for the|.+:)$/i.test(l)) continue;                 // sub-headings
    if (mode === 'ing') ingredients.push(l);
    else if (mode === 'ins') instructions.push(l.replace(/^\d+[.)]\s*/, ''));
    if (ingredients.length > 60 || instructions.length > 60) break;
  }
  /* Guessing from headings is the last resort, and the one most likely to
     scrape markup. If a third of what it found is markup, it did not find a
     recipe — say so and let the app offer the paste box. */
  if (mostlyMarkup(ingredients)) return null;
  const clean = sane(ingredients);
  if (!clean.length) return null;
  return { name: null, image: null, servings: null, cook_minutes: null, prep_minutes: null,
           total_minutes: null, ingredients: clean, instructions: sane(instructions), method: 'heading' };
}

/* ---- page-level fallbacks ------------------------------------------------- */
function titleOf(html: string): string | null {
  const og = html.match(/<meta[^>]+property\s*=\s*["']og:title["'][^>]+content\s*=\s*["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']og:title["']/i);
  if (og) return decode(og[1]).replace(/\s*[-|–]\s*[^-|–]+$/, '');
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? decode(t[1]).replace(/\s*[-|–]\s*[^-|–]+$/, '') : null;
}
function imageOf(html: string): string | null {
  const og = html.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']og:image["']/i);
  return og ? og[1] : null;
}

/* A failure the app can act on: `reason` drives the button it shows, the
   sentence is what Erich reads, and the status stays in the payload for us.
   502 throughout — the upstream site failed, not this function. */
function giveUp(e: unknown, u: URL, prefix = '') {
  const g = e as { reason?: string; message?: string; status?: number | null;
                   attempts?: number; retryAfterSeconds?: number | null };
  const reason = g?.reason ?? 'unreadable';
  return json({
    build: BUILD,
    error: 'fetch failed',
    reason,
    message: prefix + (g?.message ?? humanMessage(reason, u.hostname, null)),
    status: g?.status ?? null,
    attempts: g?.attempts ?? 1,
    retry_after_seconds: g?.retryAfterSeconds ?? null,
    host: u.hostname,
  }, 502);
}

/* ---- the handler ----------------------------------------------------------- */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST')    return json({ build: BUILD, error: 'POST only' }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ build: BUILD, error: 'bad json' }, 400); }

  /* Pasted text: the family-recipe door. */
  if (body.text && !body.url) {
    const text = String(body.text).slice(0, 20_000);
    const found = fromHeadings(text) ?? {
      name: null, image: null, servings: null, cook_minutes: null, prep_minutes: null, total_minutes: null,
      ingredients: text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 60),
      instructions: [], method: 'paste',
    };
    const firstLine = text.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? null;
    return json({ build: BUILD, ...found,
                  name: found.name ?? (firstLine && firstLine.length < 80 && !/^ingredients?/i.test(firstLine) ? firstLine : null),
                  source_url: null, method: found.method === 'heading' ? 'paste' : found.method });
  }

  let chk = safeUrl(body.url ?? '');
  if (!chk.ok) return json({ build: BUILD, error: chk.why }, 400);

  /* One budget for the whole call, shared by both hops of a pin. */
  const deadlineAt = Date.now() + DEFAULTS.totalMs;

  let html: string;
  let via: string | null = null;
  try { html = await fetchPage(chk.url, deadlineAt); }
  catch (e) { return giveUp(e, chk.url); }

  /* A pin: find where it points and go there. If the pin has no outbound
     link, fall through and extract what the pin page itself offers (a
     headline and an image), which the app turns into a paste prompt. */
  if (isPinterest(chk.url)) {
    const src = pinSource(html);
    const next = src ? safeUrl(src) : null;
    if (next && next.ok && !isPinterest(next.url)) {
      try {
        via = chk.url.toString();
        chk = next;
        html = await fetchPage(chk.url, deadlineAt);
      } catch (e) {
        return giveUp(e, next.url, `The pin points at ${next.url.hostname}. `);
      }
    }
  }

  const found = fromJsonLd(html) ?? fromMicrodata(html) ?? fromHeadings(html) ?? {
    name: null, image: null, servings: null, cook_minutes: null, prep_minutes: null, total_minutes: null,
    ingredients: [], instructions: [], method: 'none',
  };

  console.log(`recipe-import build=${BUILD} host=${chk.url.hostname} method=${found.method} ing=${found.ingredients.length}`);

  return json({
    build: BUILD,
    ...found,
    name:  found.name  ?? titleOf(html),
    image: found.image ?? imageOf(html),
    source_url: chk.url.toString(),
    via,
  });
});
