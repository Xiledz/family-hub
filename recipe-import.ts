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
 *   private ranges, no supabase hosts, 8s timeout, 2MB cap, and it returns
 *   extracted JSON — never the raw page.
 *
 * Deploy:  Edge Functions → recipe-import.  Verify JWT can stay ON (the app
 *          sends the anon key).
 * ==========================================================================*/

const BUILD = '2026-09-10b-pins';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

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

async function fetchPage(u: URL): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(u.toString(), {
      signal: ctl.signal, redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`site returned ${res.status}`);
    const reader = res.body?.getReader();
    if (!reader) return await res.text();
    const chunks: Uint8Array[] = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 2_000_000) { reader.cancel(); break; }
      chunks.push(value);
    }
    const buf = new Uint8Array(total > 2_000_000 ? 2_000_000 : total);
    let off = 0;
    for (const c of chunks) { const n = Math.min(c.byteLength, buf.byteLength - off); buf.set(c.subarray(0, n), off); off += n; if (off >= buf.byteLength) break; }
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  } finally { clearTimeout(t); }
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
const decode = (s: string) => String(s ?? '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  /* WordPress Recipe Maker writes fractions as named entities. */
  .replace(/&frac12;/g, '½').replace(/&frac14;/g, '¼').replace(/&frac34;/g, '¾')
  .replace(/&frac13;/g, '⅓').replace(/&frac23;/g, '⅔').replace(/&frac18;/g, '⅛')
  .replace(/&deg;/g, '°').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&hellip;/g, '…')
  .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/\s+/g, ' ').trim();

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
      ingredients: (Array.isArray(ing) ? ing : [ing]).map((s: any) => decode(String(s))).filter(Boolean),
      instructions: stepsOf(r.recipeInstructions),
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
    ingredients: ing, instructions: prop('recipeInstructions'), method: 'microdata',
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
    .replace(/<(?:li|p|h[1-6]|div|br|tr|section|article)\b[^>]*>/gi, '\n$&');
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
  if (!ingredients.length) return null;
  return { name: null, image: null, servings: null, cook_minutes: null, prep_minutes: null,
           total_minutes: null, ingredients, instructions, method: 'heading' };
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

  let html: string;
  let via: string | null = null;
  try { html = await fetchPage(chk.url); }
  catch (e) { return json({ build: BUILD, error: 'fetch failed', message: String(e).slice(0, 200) }, 502); }

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
        html = await fetchPage(chk.url);
      } catch (e) {
        return json({ build: BUILD, error: 'fetch failed',
          message: `The pin points at ${next.url.hostname}, which would not load: ${String(e).slice(0, 120)}` }, 502);
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
