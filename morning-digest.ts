/* ============================================================================
 * morning-digest — each person's day, texted to them before it starts.
 *
 * Woken every 15 minutes across a two-hour UTC window by Supabase Cron. It
 * decides for itself whether it is 6:30am in the household's timezone, so a
 * clock change in March or November moves nothing. digest_log holds one row
 * per person per day, so a second wake-up inside the window sends nothing.
 *
 * What it says is built on the same recurrence predicate the reminders use
 * (occurrences_on / member_day in SQL). If the calendar shows practice on
 * Tuesday, this says Tuesday, and the phone buzzes on Tuesday. One source.
 *
 * Secrets: DIGEST_SECRET (shared with the cron job's header)
 *          TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM
 *
 * Manual test, any time of day, one person:
 *   POST with header x-digest-secret and body {"force":true,"member":"Jess"}
 * ========================================================================= */
import { createClient } from 'npm:@supabase/supabase-js@2';

const BUILD = '2026-09-09a';

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } }
);

const SECRET       = Deno.env.get('DIGEST_SECRET') ?? '';
const TWILIO_SID   = Deno.env.get('TWILIO_SID')    ?? '';
const TWILIO_TOKEN = Deno.env.get('TWILIO_TOKEN')  ?? '';
const TWILIO_FROM  = Deno.env.get('TWILIO_FROM')   ?? '';

/* Send at or after this local time. The window is wide because the cron
   wakes on quarter-hours and a 15-minute window can be missed entirely if a
   run is slow; digest_log is what actually prevents a double send. */
const SEND_FROM  = { h: 6, m: 30 };
const SEND_UNTIL = { h: 7, m: 45 };
const SEND_WHEN_EMPTY = false;   // a daily "nothing today" is noise

function localParts(tz: string, at = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long'
  }).formatToParts(at);
  const g = (t: string) => p.find(x => x.type === t)!.value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`,
           h: +g('hour'), m: +g('minute'), weekday: g('weekday') };
}

function clock(iso: string, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
    .formatToParts(new Date(iso));
  const g = (t: string) => p.find(x => x.type === t)?.value ?? '';
  return `${g('hour')}:${g('minute')} ${g('dayPeriod')}`;
}

/* The job, in the person's own words. Someone reading this at 6:30am wants
   to know what they have to DO, not what role code is on the row. */
function roleNote(role: string, ev: any, tz: string) {
  switch (role) {
    case 'driving': return ' — you drive';
    case 'dropoff': return ' — you take them';
    case 'pickup':  return ev.ends_at ? ` — you pick up at ${clock(ev.ends_at, tz)}` : ' — you pick up';
    case 'helping': return ' — you are helping';
    case 'optional':return ' — optional';
    default:        return '';
  }
}

function compose(name: string, weekday: string, dateLabel: string, events: any[], tz: string) {
  const lines = events.map(ev => {
    const when = ev.all_day ? 'All day'
      : clock(ev.starts_at, tz) + (ev.ends_at ? `–${clock(ev.ends_at, tz)}` : '');
    return `${when}  ${ev.title}${roleNote(ev.role, ev, tz)}`;
  });
  return `Good morning, ${name}. ${weekday}, ${dateLabel}:\n\n${lines.join('\n')}`;
}

async function sendSMS(to: string, text: string) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`),
               'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: text })
  });
  if (!res.ok) throw new Error(`twilio ${res.status}: ${await res.text()}`);
}

Deno.serve(async (req) => {
  if (!SECRET || req.headers.get('x-digest-secret') !== SECRET) {
    return new Response('Not found', { status: 404 });
  }
  let opts: any = {};
  try { opts = await req.json(); } catch { /* cron sends {} */ }

  const { data: house } = await db.from('households').select('id, timezone').limit(1).single();
  const tz = house?.timezone || 'America/Chicago';
  const now = localParts(tz);

  const inWindow = (now.h > SEND_FROM.h || (now.h === SEND_FROM.h && now.m >= SEND_FROM.m))
                && (now.h < SEND_UNTIL.h || (now.h === SEND_UNTIL.h && now.m < SEND_UNTIL.m));
  if (!opts.force && !inWindow) {
    return Response.json({ build: BUILD, skipped: 'outside window', local: `${now.h}:${now.m}` });
  }
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    return Response.json({ build: BUILD, error: 'TWILIO_SID / TWILIO_TOKEN / TWILIO_FROM not all set' }, { status: 500 });
  }

  let q = db.from('members').select('id, name, phone')
    .eq('household_id', house!.id).is('deleted_at', null).not('phone', 'is', null);
  if (opts.member) q = q.ilike('name', opts.member);
  const { data: members } = await q;

  const dateLabel = new Date(now.date + 'T12:00:00Z')
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  const out: any[] = [];
  for (const m of members ?? []) {
    if (!opts.force) {
      const { data: done } = await db.from('digest_log').select('member_id')
        .eq('member_id', m.id).eq('for_date', now.date).maybeSingle();
      if (done) { out.push({ member: m.name, status: 'already sent' }); continue; }
    }

    const { data: events, error } = await db.rpc('member_day', { p_member: m.id, p_date: now.date });
    if (error) { out.push({ member: m.name, status: 'query failed', error: error.message }); continue; }

    if (!events?.length && !SEND_WHEN_EMPTY) {
      await db.from('digest_log').upsert({ member_id: m.id, for_date: now.date });
      out.push({ member: m.name, status: 'nothing today' });
      continue;
    }

    const text = events?.length
      ? compose(m.name, now.weekday, dateLabel, events, tz)
      : `Good morning, ${m.name}. Nothing on your calendar today.`;

    try {
      await sendSMS(m.phone, text);
      await db.from('digest_log').upsert({ member_id: m.id, for_date: now.date });
      out.push({ member: m.name, status: 'sent', events: events?.length ?? 0 });
    } catch (e) {
      out.push({ member: m.name, status: 'send failed', error: String(e) });
    }
  }
  console.log('morning-digest build=' + BUILD + ' ' + JSON.stringify(out));
  return Response.json({ build: BUILD, local: `${now.h}:${String(now.m).padStart(2,'0')}`, results: out });
});
