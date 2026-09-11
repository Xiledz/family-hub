/* ============================================================================
 * ics-feed — publishes the family calendar as a standard .ics subscription.
 *
 * Subscribe on iPhone: Settings > Calendar > Accounts > Add Account > Other >
 * Add Subscribed Calendar, paste this URL. Family events then appear inside the
 * built-in Calendar app next to work calendars.
 *
 * iOS refreshes subscribed calendars on its own schedule (up to ~1 hour), so
 * this is a convenience layer. The push reminders are the real alert path.
 *
 * One VEVENT per OCCURRENCE, expanded by feed_occurrences() in SQL (022) —
 * the same predicate the reminders and the digest use. No RRULE: iOS would
 * then apply its own recurrence rules and disagree with the app about a
 * skipped or moved Tuesday. Skips are absent; done occurrences get a "✓".
 *
 * URL: https://<ref>.supabase.co/functions/v1/ics-feed?h=<household-id>&t=<FEED_TOKEN>
 *
 * AUTH: iOS cannot send an Authorization header when subscribing to a calendar
 * feed, so "Verify JWT" must be OFF on this function. The ?t= token is what
 * replaces it. Since migration 021 the token lives on households.feed_token,
 * so the app's Settings sheet can show the subscribe link; the FEED_TOKEN
 * secret is still honoured as a fallback so nothing breaks between deploying
 * this and running the migration. Without a token the feed would be readable
 * by anyone who guessed the household id, which for this household is a
 * trivially guessable all-zeros UUID.
 * ==========================================================================*/
/* ---------------------------------------------------------------------------
 * Supabase admin client. Inlined rather than imported from a shared file so
 * this function can be pasted straight into the dashboard's in-browser editor,
 * which cannot resolve imports outside the function's own folder.
 * service_role NEVER reaches the browser — it lives only in Supabase secrets
 * and is injected automatically at runtime.
 * -------------------------------------------------------------------------*/
import { createClient } from 'jsr:@supabase/supabase-js@2';

const admin = () => createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } }
);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

const BUILD = '2026-09-11c-m1';
const FEED_TOKEN = Deno.env.get('FEED_TOKEN') ?? '';

/* Constant-time-ish equality. */
const same = (a: string, b: string) =>
  !!a && !!b && a.length === b.length && [...a].every((c, i) => c === b[i]);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const household = url.searchParams.get('h');
  if (!household) return new Response('missing ?h=', { status: 400, headers: { 'x-build': BUILD } });

  const db = admin();
  /* select('*'), not the column by name: naming feed_token before migration
     021 has run would make the whole select fail and 404 every subscriber. */
  const { data: hh } = await db.from('households')
    .select('*').eq('id', household).maybeSingle();

  // The household's own token first; the env secret as the fallback. A wrong
  // token deliberately returns 404, not 401, so it is indistinguishable from
  // a feed that does not exist.
  const t = url.searchParams.get('t') ?? '';
  const ok = !!hh && (same(t, String((hh as any).feed_token ?? '')) || same(t, FEED_TOKEN));
  if (!ok) return new Response('not found', { status: 404, headers: { 'x-build': BUILD } });

  /* Expansion is the database's job — feed_occurrences (022) walks the
     window over the same occurrences_on() the digest and the reminders use,
     so a Tuesday is a Tuesday in all three. Skips are simply absent,
     overrides carry their moved time, done occurrences arrive flagged.
     60 days back so a grandparent can scroll to last month; 400 forward
     covers a school year. */
  const day = 86_400_000;
  const from = new Date(Date.now() - 60 * day).toISOString().slice(0, 10);
  const to   = new Date(Date.now() + 400 * day).toISOString().slice(0, 10);
  const { data: occ, error } = await db.rpc('feed_occurrences',
    { p_household: household, p_from: from, p_to: to });
  if (error) {
    /* Never swallow this again: the feed was an empty calendar for weeks
       because a refused query looked exactly like a quiet month. */
    console.log(`ics-feed build=${BUILD} feed_occurrences failed: ${error.message}`);
    return new Response('feed error', { status: 500, headers: { 'x-build': BUILD } });
  }

  const L = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Family Hub//EN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', `X-WR-CALNAME:${esc(hh.name)}`, `X-WR-TIMEZONE:${hh.timezone}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT30M', 'X-PUBLISHED-TTL:PT30M'
  ];

  const stamp = z(new Date());
  for (const o of occ ?? []) {
    /* One VEVENT per OCCURRENCE. The UID carries the date so a series is
       many entries, each of which iOS can show, hide or mark on its own. */
    L.push('BEGIN:VEVENT', `UID:${o.event_id}-${o.occurrence_date}@familyhub`, `DTSTAMP:${stamp}`);
    if (o.all_day) {
      const d  = String(o.occurrence_date).replace(/-/g, '');
      const nx = new Date(o.occurrence_date + 'T00:00:00Z'); nx.setUTCDate(nx.getUTCDate() + 1);
      L.push(`DTSTART;VALUE=DATE:${d}`,
             `DTEND;VALUE=DATE:${nx.toISOString().slice(0, 10).replace(/-/g, '')}`);
    } else {
      const st = new Date(o.starts_at);
      const en = o.ends_at ? new Date(o.ends_at) : new Date(st.getTime() + 36e5);
      L.push(`DTSTART:${z(st)}`, `DTEND:${z(en)}`);
    }
    const who = o.people ? ` (${o.people})` : '';
    L.push(`SUMMARY:${o.done ? '✓ ' : ''}${esc(o.title)}${esc(who)}`);
    if (o.location) L.push(`LOCATION:${esc(o.location)}`);
    if (o.notes)    L.push(`DESCRIPTION:${esc(o.notes)}`);
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  console.log(`ics-feed build=${BUILD} occurrences=${occ?.length ?? 0} window=${from}..${to}`);

  return new Response(L.map(fold).join('\r\n') + '\r\n', {
    headers: {
      'x-build': BUILD,
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="family.ics"',
      'Cache-Control': 'public, max-age=300'
    }
  });
});

const z = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = (s: string) => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
// RFC 5545: fold lines longer than 75 octets
const fold = (l: string) => l.length <= 74 ? l
  : l.slice(0, 74) + (l.slice(74).match(/.{1,73}/g) ?? []).map(s => '\r\n ' + s).join('');
