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
 * URL: https://<ref>.supabase.co/functions/v1/ics-feed?h=<household-id>&t=<FEED_TOKEN>
 *
 * AUTH: iOS cannot send an Authorization header when subscribing to a calendar
 * feed, so "Verify JWT" must be OFF on this function. The ?t= token is what
 * replaces it — it is checked below against the FEED_TOKEN secret. Without this
 * the feed would be readable by anyone who guessed the household id, which for
 * this household is a trivially guessable all-zeros UUID.
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

const FEED_TOKEN = Deno.env.get('FEED_TOKEN') ?? '';

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const household = url.searchParams.get('h');
  if (!household) return new Response('missing ?h=', { status: 400 });

  // Constant-time-ish check. Deliberately returns 404, not 401, so a wrong
  // token is indistinguishable from a feed that does not exist.
  const t = url.searchParams.get('t') ?? '';
  if (!FEED_TOKEN || t.length !== FEED_TOKEN.length ||
      ![...t].every((c, i) => c === FEED_TOKEN[i])) {
    return new Response('not found', { status: 404 });
  }

  const db = admin();
  const { data: hh } = await db.from('households').select('name,timezone').eq('id', household).single();
  if (!hh) return new Response('not found', { status: 404 });

  const from = new Date(); from.setMonth(from.getMonth() - 2);
  const { data: evs } = await db.from('events')
    .select('*, members(name)').eq('household_id', household).is('deleted_at', null)
    .or(`event_date.gte.${from.toISOString().slice(0,10)},starts_at.gte.${from.toISOString()}`);

  const L = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Family Hub//EN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', `X-WR-CALNAME:${esc(hh.name)}`, `X-WR-TIMEZONE:${hh.timezone}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT30M', 'X-PUBLISHED-TTL:PT30M'
  ];

  for (const e of evs ?? []) {
    L.push('BEGIN:VEVENT', `UID:${e.id}@familyhub`, `DTSTAMP:${z(new Date(e.created_at))}`);
    if (e.all_day) {
      const d = e.event_date.replace(/-/g, '');
      const nx = new Date(e.event_date + 'T00:00:00'); nx.setDate(nx.getDate() + 1);
      L.push(`DTSTART;VALUE=DATE:${d}`,
             `DTEND;VALUE=DATE:${nx.toISOString().slice(0,10).replace(/-/g,'')}`);
    } else {
      L.push(`DTSTART:${z(new Date(e.starts_at))}`,
             `DTEND:${z(new Date(e.ends_at ?? new Date(new Date(e.starts_at).getTime() + 36e5)))}`);
    }
    const who = e.members?.name ?? 'Everyone';
    L.push(`SUMMARY:${esc(e.title)} (${esc(who)})`);
    if (e.location) L.push(`LOCATION:${esc(e.location)}`);
    if (e.notes)    L.push(`DESCRIPTION:${esc(e.notes)}`);
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');

  return new Response(L.map(fold).join('\r\n') + '\r\n', {
    headers: {
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
