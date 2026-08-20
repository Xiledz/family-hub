/* ============================================================================
 * dispatch-reminders  —  runs every minute via Supabase Cron
 *
 * Finds every reminder whose fire_at has arrived and delivers it. Delivery is
 * pluggable: 'push' today, 'sms' the day Twilio is registered. Adding a future
 * module's alerts (deal found, chore overdue) means inserting a reminders row
 * from that module — this function needs no changes.
 *
 * Deploy:  supabase functions deploy dispatch-reminders
 * Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
 *          (+ TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM once SMS is on)
 * ==========================================================================*/
import webpush from 'npm:web-push@3.6.7';
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

const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC_KEY')  ?? '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:family@example.com';
const TWILIO_SID    = Deno.env.get('TWILIO_SID')   ?? '';
const TWILIO_TOKEN  = Deno.env.get('TWILIO_TOKEN') ?? '';
const TWILIO_FROM   = Deno.env.get('TWILIO_FROM')  ?? '';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const db = admin();
  const now = new Date();

  // The one query. Grace window catches anything a missed cron tick skipped.
  const { data: due, error } = await db
    .from('reminders')
    .select('*, events(*), members(*)')
    .is('sent_at', null)
    .lte('fire_at', now.toISOString())
    .gte('fire_at', new Date(now.getTime() - 30 * 60_000).toISOString())
    .limit(200);

  if (error) return json({ error: error.message }, 500);

  let sent = 0, failed = 0;
  for (const r of due ?? []) {
    const ev = r.events;
    if (!ev || ev.deleted_at) { await mark(db, r.id, now, 'event deleted'); continue; }

    const body = phrase(r.lead_minutes, ev, r.members?.timezone);
    const title = ev.title;

    try {
      if (r.channel === 'sms' && TWILIO_SID) await sendSMS(db, r, `${title} — ${body}`);
      else await sendPush(db, r, title, body);
      await mark(db, r.id, now, null);
      sent++;
    } catch (e) {
      await mark(db, r.id, now, String(e).slice(0, 400));
      failed++;
    }
  }
  return json({ checked: due?.length ?? 0, sent, failed });
});

/* --- delivery: web push ---------------------------------------------------*/
async function sendPush(db: any, r: any, title: string, body: string) {
  // member_id null = whole household gets it
  let q = db.from('push_subscriptions').select('*').eq('household_id', r.household_id);
  if (r.member_id) q = q.eq('member_id', r.member_id);
  const { data: subs } = await q;
  if (!subs?.length) throw new Error('no push subscriptions');

  const payload = JSON.stringify({ title, body, tag: `ev-${r.event_id}`, url: './index.html' });

  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      await db.from('push_subscriptions').update({ last_ok_at: new Date().toISOString() }).eq('id', s.id);
    } catch (e: any) {
      // 404/410 = the home-screen icon was deleted. Prune so we stop retrying.
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await db.from('push_subscriptions').delete().eq('id', s.id);
      } else throw e;
    }
  }
}

/* --- delivery: SMS (dormant until SMS_ENABLED + 10DLC approval) -----------*/
async function sendSMS(db: any, r: any, text: string) {
  let phones: string[] = [];
  if (r.member_id) {
    const { data } = await db.from('members').select('phone').eq('id', r.member_id).single();
    if (data?.phone) phones = [data.phone];
  } else {
    const { data } = await db.from('members').select('phone')
      .eq('household_id', r.household_id).not('phone', 'is', null);
    phones = (data ?? []).map((m: any) => m.phone);
  }
  if (!phones.length) throw new Error('no phone numbers on file');

  for (const to of phones) {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: text })
    });
    if (!res.ok) throw new Error(`twilio ${res.status}: ${await res.text()}`);
  }
}

/* --- helpers --------------------------------------------------------------*/
function phrase(lead: number, ev: any, tz = 'America/Chicago') {
  const when = ev.all_day
    ? 'today'
    : new Date(ev.starts_at).toLocaleTimeString('en-US',
        { hour: 'numeric', minute: '2-digit', timeZone: tz });
  if (lead === 0)          return `Starting now (${when})`;
  if (lead < 60)           return `In ${lead} minutes — ${when}`;
  if (lead < 1440)         return `In ${Math.round(lead / 60)} hour${lead >= 120 ? 's' : ''} — ${when}`;
  const d = Math.round(lead / 1440);
  return `${d === 1 ? 'Tomorrow' : `In ${d} days`} — ${when}`;
}
const mark = (db: any, id: string, at: Date, err: string | null) =>
  db.from('reminders').update({ sent_at: at.toISOString(), error: err }).eq('id', id);
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
