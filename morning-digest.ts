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
 * Add "dry":true to see exactly what WOULD be sent, without sending it.
 * ========================================================================= */
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const BUILD = '2026-09-11b-m1';

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } }
);

const SECRET       = Deno.env.get('DIGEST_SECRET') ?? '';
const TWILIO_SID   = Deno.env.get('TWILIO_SID')    ?? '';
const TWILIO_TOKEN = Deno.env.get('TWILIO_TOKEN')  ?? '';
const TWILIO_FROM  = Deno.env.get('TWILIO_FROM')   ?? '';

const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC_KEY')  ?? '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:family@example.com';
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}
const ENV = {
  webpush: (VAPID_PUBLIC && VAPID_PRIVATE) ? webpush : null,
  TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM
};

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

const clock12 = (t: string) => { const [h, m] = String(t).split(':').map(Number);
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2,'0') : ''}${h < 12 ? 'am' : 'pm'}`; };

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

/* ============================================================================
 * Family Hub — the delivery chain
 *
 * ONE answer to "get this message to this person", used by every sender:
 * the reminder dispatcher, the morning digest, and the todo nag.
 *
 * WHY THIS EXISTS
 *   Channel used to be decided when a reminder was WRITTEN — sometimes months
 *   ahead — by counting push subscriptions that did not exist yet. Bryce had
 *   five reminders stamped 'push' against a table that has never held a row.
 *   They were not pending; they were dead on arrival, decided by a fact that
 *   was already false when it was written down.
 *
 *   A channel is not a property of a message. It is a property of the moment
 *   you try to send it. So nothing chooses a channel in advance any more:
 *   deliver() walks a chain at send time and writes down what it actually
 *   used.
 *
 * THE CHAIN, in order, first success wins:
 *   1. push      — every device this person has registered
 *   2. sms       — their own phone
 *   3. guardian  — the person named in members.notify_via_member_id, with the
 *                  message prefixed so the recipient knows who it is about
 *   4. nothing   — recorded as a failure and left alone
 *
 *   A nine-year-old with no phone is the ordinary case in a family app, not
 *   an error. Step 3 is what makes him reachable.
 *
 * NO RETRIES. A failed send is not retried later — the next morning's digest
 * is the retry, and the app itself is the channel of last resort. Retrying a
 * reminder for an event that already started is worse than silence.
 *
 * THIS FILE IS COPIED, NOT IMPORTED. Supabase's bundler refuses remote hosts
 * and its in-browser editor drops second files on deploy, so this block lives
 * verbatim inside each edge function. drift.test.mjs fails the moment the
 * copies stop matching. Same arrangement as parse.js.
 * ==========================================================================*/

const DELIVER_BUILD = '2026-09-10a';

/* Every attempt is written to `deliveries` — successes and failures both.
   This is not a debug log. It is the answer to "was Bryce actually told?",
   and it is what the todo nag reads so it never pings twice in one day. */
async function logDelivery(db: any, row: {
  household_id: string; member_id: string | null; on_behalf_of?: string | null;
  kind: string; ref_id?: string | null; channel: string | null;
  ok: boolean; detail?: string | null;
}) {
  try {
    await db.from('deliveries').insert({
      household_id: row.household_id,
      member_id:    row.member_id,
      on_behalf_of: row.on_behalf_of ?? null,
      kind:         row.kind,
      ref_id:       row.ref_id ?? null,
      channel:      row.channel,
      ok:           row.ok,
      detail:       row.detail ? String(row.detail).slice(0, 500) : null
    });
  } catch (_e) {
    /* Never let bookkeeping sink a send that otherwise worked. */
  }
}

async function pushTo(db: any, webpush: any, memberId: string, title: string,
                      body: string, tag: string, url: string): Promise<number> {
  const { data: subs } = await db.from('push_subscriptions').select('*').eq('member_id', memberId);
  if (!subs?.length) return 0;

  const payload = JSON.stringify({ title, body, tag, url });
  let ok = 0;

  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      await db.from('push_subscriptions')
        .update({ last_ok_at: new Date().toISOString() }).eq('id', s.id);
      ok++;
    } catch (e: any) {
      /* 404/410 means the home-screen icon is gone. Prune it, or we retry a
         dead endpoint forever and the person looks reachable when they are
         not. Any other error is this endpoint's problem, not the chain's —
         another device may still work. */
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await db.from('push_subscriptions').delete().eq('id', s.id);
      }
    }
  }
  return ok;
}

async function smsTo(sid: string, token: string, from: string, to: string, text: string) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${sid}:${token}`),
               'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: from, Body: text })
  });
  if (!res.ok) throw new Error(`twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/* The one entry point.
 *
 *   member  — the members row (needs id, name, phone, notify_via_member_id)
 *   title   — short line; becomes the push title, and is prepended for SMS
 *   body    — the detail
 *   kind    — 'reminder' | 'digest' | 'nag' | 'reply' | 'welcome'
 *   refId   — the event, todo or whatever this is about, for the log
 *
 * Returns what happened. Never throws: a sender that crashes on one person
 * stops delivering to everybody else, and the whole point of a chain is that
 * one broken link is survivable.
 */
async function deliver(db: any, env: {
  webpush?: any; TWILIO_SID: string; TWILIO_TOKEN: string; TWILIO_FROM: string;
}, member: any, msg: {
  householdId: string; title: string; body: string; kind: string;
  refId?: string | null; tag?: string; url?: string;
}, _viaFor?: any): Promise<{ ok: boolean; channel: string | null; detail: string }> {

  const onBehalfOf = _viaFor ? _viaFor.id : null;
  const smsText = _viaFor
    ? `For ${_viaFor.name}: ${msg.title} — ${msg.body}`
    : `${msg.title} — ${msg.body}`;
  const pushTitle = _viaFor ? `${_viaFor.name}: ${msg.title}` : msg.title;

  const log = (channel: string | null, ok: boolean, detail: string) =>
    logDelivery(db, {
      household_id: msg.householdId, member_id: member?.id ?? null,
      on_behalf_of: onBehalfOf, kind: msg.kind, ref_id: msg.refId ?? null,
      channel, ok, detail
    });

  if (!member?.id) {
    await log(null, false, 'no member');
    return { ok: false, channel: null, detail: 'no member' };
  }

  /* 1. push */
  if (env.webpush) {
    try {
      const n = await pushTo(db, env.webpush, member.id, pushTitle, msg.body,
                             msg.tag ?? 'fh', msg.url ?? './index.html');
      if (n > 0) {
        await log('push', true, `${n} device${n === 1 ? '' : 's'}`);
        return { ok: true, channel: 'push', detail: `${n} device(s)` };
      }
    } catch (e) {
      await log('push', false, String(e));
    }
  }

  /* 2. their own phone */
  if (member.phone && env.TWILIO_SID && env.TWILIO_TOKEN && env.TWILIO_FROM) {
    try {
      await smsTo(env.TWILIO_SID, env.TWILIO_TOKEN, env.TWILIO_FROM, member.phone, smsText);
      await log('sms', true, member.phone);
      return { ok: true, channel: 'sms', detail: member.phone };
    } catch (e) {
      await log('sms', false, String(e));
      /* Fall through to the guardian. A Twilio failure for one number is
         exactly the case where somebody else should hear about it. */
    }
  }

  /* 3. the guardian — ONE hop, never a chain of them. Two members pointing at
        each other would otherwise loop until the function times out. */
  if (!_viaFor && member.notify_via_member_id) {
    const { data: g } = await db.from('members')
      .select('id, name, phone, notify_via_member_id')
      .eq('id', member.notify_via_member_id).maybeSingle();

    if (g && g.id !== member.id) {
      const r = await deliver(db, env, g, msg, member);
      if (r.ok) return { ok: true, channel: r.channel, detail: `via ${g.name}` };
    }
  }

  /* 4. nowhere left to go. */
  await log(null, false, 'no route');
  return { ok: false, channel: null, detail: 'no route: no device, no phone, no guardian' };
}
/* ===== end delivery chain ================================================ */

Deno.serve(async (req) => {
  if (!SECRET || req.headers.get('x-digest-secret') !== SECRET) {
    return new Response('Not found', { status: 404 });
  }
  let opts: any = {};
  try { opts = await req.json(); } catch { /* cron sends {} */ }

  const { data: house } = await db.from('households')
    .select('id, timezone, default_cook_id').limit(1).single();
  const tz = house?.timezone || 'America/Chicago';
  const now = localParts(tz);

  const inWindow = (now.h > SEND_FROM.h || (now.h === SEND_FROM.h && now.m >= SEND_FROM.m))
                && (now.h < SEND_UNTIL.h || (now.h === SEND_UNTIL.h && now.m < SEND_UNTIL.m));
  if (!opts.force && !inWindow) {
    return Response.json({ build: BUILD, skipped: 'outside window', local: `${now.h}:${now.m}` });
  }
  if (!ENV.webpush && !(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM)) {
    return Response.json({ build: BUILD,
      error: 'no delivery channel configured: set VAPID keys, Twilio, or both' }, { status: 500 });
  }

  /* Everyone, including the kids with no phone of their own. Filtering on
     phone here is what kept Bryce and Addie out of the digest entirely.

     ONE MESSAGE PER RECIPIENT. Bryce and Addie have no route of their own,
     so deliver() would carry each of their digests to Jess as a separate
     text — three messages before 7am, two of them prefixed "For Bryce:".
     Instead, anyone with no push device and no phone is folded into their
     guardian's message as a named block, in members.sort_order. The test
     for "no route of their own" mirrors deliver()'s actual decision: push
     first, then their own phone, then the guardian. */
  const { data: members } = await db.from('members')
    .select('id, name, phone, notify_via_member_id, sort_order')
    .eq('household_id', house!.id).is('deleted_at', null).order('sort_order');
  const { data: subs } = await db.from('push_subscriptions').select('member_id');
  const hasPush = new Set((subs ?? []).map((s: any) => s.member_id));
  const selfRouted = (m: any) => hasPush.has(m.id) || !!m.phone;

  type Group = { leader: any; wards: any[] };
  const groups: Group[] = [];
  const groupOf = new Map<string, Group>();
  for (const m of members ?? []) {
    const guardian = (!selfRouted(m) && m.notify_via_member_id)
      ? (members ?? []).find((g: any) => g.id === m.notify_via_member_id && g.id !== m.id) : null;
    if (guardian) {
      let g = groupOf.get(guardian.id);
      if (!g) { g = { leader: guardian, wards: [] }; groupOf.set(guardian.id, g); groups.push(g); }
      g.wards.push(m);
    } else if (!groupOf.has(m.id)) {
      const g = { leader: m, wards: [] }; groupOf.set(m.id, g); groups.push(g);
    }
  }

  const dateLabel = new Date(now.date + 'T12:00:00Z')
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  /* Tonight's dinner, once, for everybody's message. The cook is resolved
     exactly as materialize_meal_reminders resolves it: the meal's cook, else
     the household default, else whoever planned it. */
  const { data: meal } = await db.from('meal_plan')
    .select('id, ready_by, freeform, cook_id, created_by, recipes(name)')
    .eq('household_id', house!.id).eq('plan_date', now.date).eq('slot', 'dinner')
    .is('deleted_at', null).is('done_at', null).maybeSingle();
  const cookId = meal ? (meal.cook_id ?? house!.default_cook_id ?? meal.created_by ?? null) : null;
  let cookName = '';
  if (cookId) {
    const { data: c } = await db.from('members').select('name').eq('id', cookId).maybeSingle();
    cookName = c?.name ?? '';
  }
  const dinnerFor = async (m: any) => {
    if (!meal) return '';
    const dish = (meal as any).recipes?.name || meal.freeform || 'Dinner';
    let first = '';
    /* The cook's own line carries the first prep step — the heads-up for
       someone who will not have their phone in hand at 4:25. */
    if (cookId && cookId === m.id) {
      const { data: st } = await db.from('reminders').select('label, fire_at')
        .eq('meal_id', meal.id).is('sent_at', null).neq('label', 'Start cooking')
        .order('fire_at').limit(1).maybeSingle();
      if (st?.label) first = `. First: ${st.label.toLowerCase()} at ${clock(st.fire_at, tz)}`;
    }
    const who = cookName ? ` — ${cookName === m.name ? 'you cook' : `${cookName} cooks`}` : '';
    const by  = meal.ready_by ? `${who ? ',' : ' —'} on the table by ${clock12(meal.ready_by)}` : '';
    return `Dinner: ${dish}${who}${by}${first}`;
  };

  /* Due today and overdue, from the list. The digest IS the nag. */
  const todoLinesFor = async (m: any) => {
    const { data: todos } = await db.rpc('member_todos', { p_member: m.id });
    const lines: string[] = [];
    for (const t of (todos ?? []).filter((t: any) => t.due_on === now.date)) lines.push(`Due today: ${t.title}`);
    for (const t of (todos ?? []).filter((t: any) => t.overdue_days > 0))   lines.push(`Overdue ${t.overdue_days}d: ${t.title}`);
    return lines;
  };

  /* A ward's block: their events as plain lines (no "you drive" — the reader
     is the guardian), their chores, capped so three kids cannot push the
     guardian's own day off the screen. */
  const WARD_MAX = 4;
  const wardBlock = async (w: any) => {
    const { data: events } = await db.rpc('member_day', { p_member: w.id, p_date: now.date });
    const lines = (events ?? []).map((ev: any) => {
      const when = ev.all_day ? 'All day' : clock(ev.starts_at, tz) + (ev.ends_at ? `–${clock(ev.ends_at, tz)}` : '');
      return `${when}  ${ev.title}`;
    }).concat(await todoLinesFor(w));
    if (!lines.length) return null;
    const shown = lines.slice(0, WARD_MAX);
    if (lines.length > WARD_MAX) shown.push(`+${lines.length - WARD_MAX} more`);
    return `${w.name}:\n${shown.join('\n')}`;
  };

  const out: any[] = [];
  for (const g of groups) {
    const m = g.leader;
    if (opts.member && String(m.name).toLowerCase() !== String(opts.member).toLowerCase()) continue;
    if (!opts.force) {
      const { data: done } = await db.from('digest_log').select('member_id')
        .eq('member_id', m.id).eq('for_date', now.date).maybeSingle();
      if (done) { out.push({ member: m.name, status: 'already sent' }); continue; }
    }

    const { data: events, error } = await db.rpc('member_day', { p_member: m.id, p_date: now.date });
    if (error) { out.push({ member: m.name, status: 'query failed', error: error.message }); continue; }

    const extras = [await dinnerFor(m), ...(await todoLinesFor(m))].filter(Boolean);
    const blocks: string[] = [];
    for (const w of g.wards) { const b = await wardBlock(w); if (b) blocks.push(b); }

    const covered = [m, ...g.wards].map((x: any) => ({ member_id: x.id, for_date: now.date }));

    // A forced test should always produce a message, even on an empty day.
    if (!events?.length && !extras.length && !blocks.length && !SEND_WHEN_EMPTY && !opts.force) {
      await db.from('digest_log').upsert(covered);
      out.push({ member: m.name, wards: g.wards.map((w: any) => w.name), status: 'nothing today' });
      continue;
    }

    let text = events?.length
      ? compose(m.name, now.weekday, dateLabel, events, tz)
      : `Good morning, ${m.name}. Nothing on your calendar today.`;
    if (extras.length) text += '\n\n' + extras.join('\n');
    if (blocks.length) text += '\n\n' + blocks.join('\n\n');
    /* One SMS segment is 160 chars; a digest is several. Past ~1000 it is a
       wall nobody reads, so it is cut — the app has the rest. */
    const MAX = 1000;
    if (text.length > MAX) text = text.slice(0, MAX - 1).replace(/\s+\S*$/, '') + '…';

    if (opts.dry) { out.push({ member: m.name, wards: g.wards.map((w: any) => w.name), status: 'dry run', would_send: text }); continue; }

    const res = await deliver(db, ENV, m, {
      householdId: house!.id,
      title: `Today, ${now.weekday}`,
      body:  text,
      kind:  'digest',
      refId: null,
      tag:   `digest-${now.date}`,
      url:   './index.html'
    });

    /* Log the day either way, for the leader AND every ward folded in, so a
       second wake-up in the window sends nothing. A digest that could not
       be delivered should not be retried fifteen minutes later into the same
       dead end — and it is recorded in `deliveries`, so the failure is
       visible rather than silent. */
    await db.from('digest_log').upsert(covered);
    out.push({ member: m.name, wards: g.wards.map((w: any) => w.name),
               status: res.ok ? 'sent' : 'no route',
               via: res.channel, detail: res.detail, events: events?.length ?? 0 });
  }
  console.log('morning-digest build=' + BUILD + ' ' + JSON.stringify(out));
  return Response.json({ build: BUILD, local: `${now.h}:${String(now.m).padStart(2,'0')}`, results: out });
});
