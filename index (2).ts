/* ============================================================================
 * sms-inbound — text the family number to add an event.
 *
 * DORMANT until A2P 10DLC registration clears. Nothing calls this until you
 * point the Twilio number's "A Message Comes In" webhook at it.
 *
 * The sender's phone number is matched against members.phone, so the event is
 * automatically attributed to whoever texted. It uses the SAME parser as the
 * web quick-add bar — one grammar, two front doors.
 *
 * Webhook URL: https://<ref>.supabase.co/functions/v1/sms-inbound
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

/* NOTE: this function imports the shared parser. That works with the Supabase
   CLI (which bundles the whole project directory) but NOT with the dashboard's
   in-browser editor. When Twilio is enabled, either deploy this one with the
   CLI, or add parse.js as a second file in the browser editor and change this
   import to './parse.js'. Never retype the parser by hand — it must stay
   byte-identical to the web app's copy. */
import { parseQuickAdd, describe } from '../../../parse.js';

const HOUSEHOLD = Deno.env.get('HOUSEHOLD_ID')!;

Deno.serve(async (req) => {
  const form = new URLSearchParams(await req.text());
  const from = form.get('From') ?? '';
  const body = (form.get('Body') ?? '').trim();
  const db = admin();

  const { data: members } = await db.from('members').select('*')
    .eq('household_id', HOUSEHOLD).is('deleted_at', null);

  const sender = (members ?? []).find((m: any) => m.phone && norm(m.phone) === norm(from));
  if (!sender) return twiml("This number isn't on the family list yet. Ask Erich to add it.");
  if (!body)   return twiml('Send something like: Soccer Thursday 5:30 Noah');

  if (/^(help|\?)$/i.test(body)) {
    return twiml('Text an event the way you would say it:\n' +
                 '"Soccer Thursday 5:30 Noah"\n"Dentist tomorrow 9am Mia remind 1 hour before"\n' +
                 'Reply STOP to opt out.');
  }

  const p = parseQuickAdd(body, {
    members: (members ?? []).map((m: any) => m.name),
    defaultLead: sender.default_lead_minutes ?? 30
  });
  const member = (members ?? []).find((m: any) => m.name === p.member);

  const { data: ev, error } = await db.from('events').insert({
    household_id: HOUSEHOLD, member_id: member?.id ?? null,
    title: p.title, all_day: p.allDay, event_date: p.date,
    starts_at: p.allDay ? null : new Date(`${p.date}T${p.start}:00`).toISOString(),
    created_by: sender.id, source: 'sms'
  }).select().single();
  if (error) return twiml('Could not save that one. Try again?');

  if (p.leadMinutes != null) {
    const base = p.allDay ? new Date(`${p.date}T09:00:00`) : new Date(ev.starts_at);
    await db.from('reminders').insert({
      household_id: HOUSEHOLD, event_id: ev.id, member_id: ev.member_id,
      lead_minutes: p.leadMinutes, channel: 'sms',
      fire_at: new Date(base.getTime() - p.leadMinutes * 60_000).toISOString()
    });
  }

  const d = describe(p);
  return twiml(`Added: ${p.title}\n${d.day} · ${d.time}\nFor ${d.who} · ${d.lead}` +
               (p.warnings.length ? `\n\n(${p.warnings[0]})` : ''));
});

const norm = (s: string) => s.replace(/\D/g, '').slice(-10);
const twiml = (msg: string) => new Response(
  `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${
    msg.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</Message></Response>`,
  { headers: { 'Content-Type': 'text/xml' } });
