/* ============================================================================
 * dispatch-reminders  —  runs every minute via Supabase Cron
 *
 * Finds every reminder whose fire_at has arrived and delivers it through the
 * shared chain (push -> sms -> guardian). A reminder points at an event OR a
 * todo, never both; the phrasing differs, the delivery does not.
 *
 * Deploy:  supabase functions deploy dispatch-reminders
 * Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
 *          TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM
 * ==========================================================================*/
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const BUILD = '2026-09-11a-m0';

const admin = () => createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } }
);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC_KEY')  ?? '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:family@example.com';
const TWILIO_SID    = Deno.env.get('TWILIO_SID')   ?? '';
const TWILIO_TOKEN  = Deno.env.get('TWILIO_TOKEN') ?? '';
const TWILIO_FROM   = Deno.env.get('TWILIO_FROM')  ?? '';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}
const ENV = {
  webpush: (VAPID_PUBLIC && VAPID_PRIVATE) ? webpush : null,
  TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM
};

/* How stale a reminder can be and still be worth sending. Past this it is
   marked 'expired' rather than left forever unsent — the old code selected
   only the last 30 minutes and never touched anything older, so a missed cron
   tick left a row that was neither sent nor sendable nor visible. Four of
   those were sitting in the table from August. */
const GRACE_MIN  = 30;
const EXPIRE_MIN = 24 * 60;

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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const db  = admin();
  const now = new Date();
  const nowIso = now.toISOString();

  /* Anything long overdue is closed out first, so it stops being invisible.
     A reminder for something that started yesterday is not worth sending. */
  const { data: stale } = await db.from('reminders')
    .select('id')
    .is('sent_at', null)
    .lt('fire_at', new Date(now.getTime() - GRACE_MIN * 60_000).toISOString())
    .limit(500);

  if (stale?.length) {
    await db.from('reminders')
      .update({ sent_at: nowIso, error: 'expired — not sent' })
      .in('id', stale.map((s: any) => s.id));
  }

  const { data: due, error } = await db
    .from('reminders')
    .select('*, events(*), todos(*), meal_plan(*, recipes(name)), members(*)')
    .is('sent_at', null)
    .lte('fire_at', nowIso)
    .gte('fire_at', new Date(now.getTime() - GRACE_MIN * 60_000).toISOString())
    .limit(200);

  if (error) return json({ build: BUILD, error: error.message }, 500);

  let sent = 0, failed = 0;
  const results: any[] = [];

  for (const r of due ?? []) {
    /* Three subjects, one delivery path. The dispatcher phrases by which. */
    const kind    = r.event_id ? 'event' : r.todo_id ? 'todo' : 'meal';
    const subject = kind === 'event' ? r.events : kind === 'todo' ? r.todos : r.meal_plan;

    if (!subject || subject.deleted_at) {
      await mark(db, r.id, now, null, `${kind} deleted`);
      continue;
    }
    if (kind === 'todo' && subject.completed_at) { await mark(db, r.id, now, null, 'already done'); continue; }
    if (kind === 'meal' && subject.done_at)      { await mark(db, r.id, now, null, 'meal done');    continue; }
    /* A ticked-off occurrence of a series must not ping. */
    if (kind === 'event' && r.occurrence_date) {
      const { data: done } = await db.from('event_done').select('event_id')
        .eq('event_id', r.event_id).eq('occurrence_date', r.occurrence_date).maybeSingle();
      if (done) { await mark(db, r.id, now, null, 'occurrence done'); continue; }
    }

    const tz    = r.members?.timezone || 'America/Chicago';
    let title: string, body: string;
    if (kind === 'event')      { title = subject.title; body = phrase(r.lead_minutes, subject, tz); }
    else if (kind === 'todo')  { title = subject.title; body = duePhrase(subject, tz); }
    else {
      /* "Take the beef out to thaw — tacos, on the table by 5:55" */
      const dish = subject.recipes?.name || subject.freeform || 'Dinner';
      title = r.label || 'Start cooking';
      body  = `${dish}${subject.ready_by ? ` — on the table by ${clock12(subject.ready_by)}` : ''}`;
    }

    const res = await deliver(db, ENV, r.members, {
      householdId: r.household_id,
      title, body,
      kind: 'reminder',
      refId: r.event_id ?? r.todo_id ?? r.meal_id,
      tag:  kind === 'event' ? `ev-${r.event_id}` : kind === 'todo' ? `td-${r.todo_id}` : `ml-${r.meal_id}-${r.label}`,
      url:  './index.html'
    });

    /* channel records what was USED. Null stays null when nothing worked. */
    await mark(db, r.id, now, res.channel, res.ok ? null : res.detail);
    res.ok ? sent++ : failed++;

    /* The nag asked for "DID". Write down who was actually asked — the
       guardian, when the chain went through one — so their bare "did it"
       resolves to THIS chore. sms_last_action is one row per person and
       the newest wins, which is the right answer for a text conversation. */
    if (res.ok && kind === 'todo' && r.members?.id) {
      const recipient = res.detail?.startsWith('via ')
        ? (r.members.notify_via_member_id ?? r.members.id)
        : r.members.id;
      await db.from('sms_last_action').upsert({
        member_id: recipient, household_id: r.household_id,
        todo_id: r.todo_id, event_id: null, occurrence_date: r.occurrence_date ?? null,
        action: 'nag', created_at: nowIso
      }, { onConflict: 'member_id' });
    }
    results.push({ who: r.members?.name, title, channel: res.channel, ok: res.ok });
  }

  console.log(`dispatch build=${BUILD} deliver=${DELIVER_BUILD} ` +
              `checked=${due?.length ?? 0} sent=${sent} failed=${failed} ` +
              `expired=${stale?.length ?? 0}`);

  return json({ build: BUILD, checked: due?.length ?? 0, sent, failed,
                expired: stale?.length ?? 0, results });
});

/* --- phrasing -------------------------------------------------------------*/
function phrase(lead: number, ev: any, tz = 'America/Chicago') {
  const when = ev.all_day
    ? 'today'
    : new Date(ev.starts_at).toLocaleTimeString('en-US',
        { hour: 'numeric', minute: '2-digit', timeZone: tz });
  if (lead === 0)  return `Starting now (${when})`;
  if (lead < 60)   return `In ${lead} minutes — ${when}`;
  if (lead < 1440) return `In ${Math.round(lead / 60)} hour${lead >= 120 ? 's' : ''} — ${when}`;
  const d = Math.round(lead / 1440);
  return `${d === 1 ? 'Tomorrow' : `In ${d} days`} — ${when}`;
}

const clock12 = (t: string) => { const [h, m] = String(t).split(':').map(Number);
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2,'0') : ''}${h < 12 ? 'am' : 'pm'}`; };

/* A todo has no start time, only a day it is wanted by. The last words are
   the instruction: bare "done" is the shopping trip (TRIP_DONE owns it at
   stage 0), so the nag has to say DID — and it goes last, because deliver()
   prefixes the title and, for a guardian, "For Bryce:". The SMS reads
   "For Bryce: Take out the trash — Due today. Reply DID when done". */
function duePhrase(td: any, tz: string) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const when = !td.due_on ? 'On your list'
             : td.due_on === today ? 'Due today'
             : td.due_on < today ? `Overdue since ${td.due_on}` : `Due ${td.due_on}`;
  return `${when}. Reply DID when done`;
}

const mark = (db: any, id: string, at: Date, channel: string | null, err: string | null) =>
  db.from('reminders')
    .update({ sent_at: at.toISOString(), channel, error: err })
    .eq('id', id);

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
