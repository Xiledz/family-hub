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
