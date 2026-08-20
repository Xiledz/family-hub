# Setup — start to finish

Two paths. Do **Path A** today (about 45 minutes). **Path B** is texting; start
it whenever, it approves on its own schedule.

---

## Path A — get it live (45 min)

### 1. Look at it first (2 min, no accounts needed)
Open `index.html` in a browser. It runs in **demo mode** with sample data — code
is `DEMO`. Click around, try the quick-add bar. Nothing is saved. This is just to
confirm you like it before spending time on setup.

### 2. Supabase project (5 min)
1. supabase.com → sign in with GitHub → **New project** (Free plan)
2. Name: `family-hub`. Region: **US Central**. Set a database password and save it.
3. Wait ~2 min for provisioning.
4. **Settings → API**. Copy two values:
   - **Project URL** — `https://xxxxx.supabase.co`
   - **anon public** key — the long one labeled `anon` `public`

> The anon key goes in a public file. That is correct and by design. The
> **service_role** key never leaves the Supabase dashboard.

### 3. Create the tables (5 min)
1. **SQL Editor → New query**
2. Open `supabase/schema.sql`. Before pasting, edit the bottom `-- SEED` block:
   real family names, real colors, real passcode. Pick something the family can
   remember and type on a phone.
3. Paste the whole file → **Run**. Should say Success.
4. **Table Editor → members** — confirm your family is listed.

### 4. Push notification keys (4 min)
Double-click **`vapid-keys.html`** and click Generate. The keys are created by
your browser's own crypto, on your machine — nothing uploaded, nothing installed.
Leave the page open until you've pasted everything; a refresh makes a new pair.

(The old `npx web-push generate-vapid-keys` command does the same thing, but
needs Node.js installed. The HTML tool doesn't.)

You get a public and a private key.
- **Public** → `config.js`, the `VAPID_PUBLIC` field.
- **Private** → Supabase dashboard → **Edge Functions → Secrets**:

```
VAPID_PUBLIC_KEY   = <public key>
VAPID_PRIVATE_KEY  = <private key>
VAPID_SUBJECT      = mailto:erich.kelley@gmail.com
HOUSEHOLD_ID       = 00000000-0000-0000-0000-000000000001
```

### 5. Fill in config.js (2 min)
Open `config.js`, replace the two `PASTE_...` lines with your Project URL and
anon key. Save. That is the only file you edit.

### 6. Deploy the server functions (10 min)
Install the CLI with **Scoop** — the documented Windows route, and it doesn't
need Node. In **PowerShell**:

```
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
```

Then:

```
supabase login
supabase link --project-ref rauvytdltnbqrvyiornh
supabase functions deploy dispatch-reminders
supabase functions deploy ics-feed
```

If you'd rather install Node.js from nodejs.org instead, close and reopen the
terminal afterward, then use `npx supabase <command>` in place of `supabase
<command>`. A plain global `npm install -g supabase` is no longer supported.
(`sms-inbound` deploys later, with Path B.)

Then **SQL Editor**, paste this once — it is the last block in `schema.sql`,
with your project ref and anon key filled in:

```sql
select cron.schedule('reminder-dispatch', '* * * * *', $$
  select net.http_post(
    url     := 'https://<PROJECT-REF>.supabase.co/functions/v1/dispatch-reminders',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <ANON-KEY>"}'::jsonb,
    body    := '{}'::jsonb
  );
$$);
```

That is the every-minute check that makes "alert me at 11:30" fire at 11:30.

### 7. GitHub Pages (10 min)
1. New repo on GitHub, e.g. `family-hub`. **Public** (Pages needs public on the
   free plan — the passcode, not repo privacy, is what keeps the family's data out
   of view, and Supabase RLS is what actually enforces it).
2. Push everything **except** `design-preview.html` and the `agents/` folder if
   you'd rather keep those private.
3. **Settings → Pages → Source: main / (root)** → Save.
4. Live in ~1 min at `https://<you>.github.io/family-hub/`

### 8. Your phone (3 min)
Open the URL in **Safari** (not Chrome — iOS only allows Add to Home Screen from
Safari). Share button → **Add to Home Screen**. Open it from the new icon, enter
the code, pick your name, tap **Turn on** when it asks about reminders.

Make a test event 2 minutes out with an "At time" reminder. Confirm it buzzes.

### 9. The family (5 min)
Send them `FAMILY-SETUP.md`. Take a screenshot of the Share sheet with **Add to
Home Screen** circled — that step is where people get stuck, and a screenshot
prevents every support question you'd otherwise field.

---

## Path B — text the number (start anytime, approves in days-to-weeks)

Only needed if you want to add events by text, or want SMS as a backup for
someone who won't install the icon.

1. **twilio.com** → sign up → buy a US local number (~$1.15/mo).
2. **Messaging → Regulatory Compliance → A2P 10DLC** → register as
   **Sole Proprietor** (no EIN required; you need a US address and a mobile
   number for the one-time code).
   - Costs: **$4** brand registration + **$15** campaign vetting, one time, then
     **$2/month**.
   - Use case: *Customer Care*. Sample message:
     `Soccer practice — In 30 minutes, 5:30 PM. Reply STOP to opt out.`
   - Throughput is 1 message/second. Fine for a family; it is why this is not
     the channel for bulk alerts.
3. Vetting takes days, sometimes weeks. Nothing else is blocked while you wait.
4. When approved:
   - Supabase secrets: `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM`
   - `supabase functions deploy sms-inbound`
   - Twilio number → **A Message Comes In** → webhook →
     `https://<ref>.supabase.co/functions/v1/sms-inbound`
   - Add each person's mobile to their row in `members.phone` (E.164:
     `+12145551212`)
   - `config.js` → `SMS_ENABLED: true`

Then texting `Soccer Thursday 5:30 Noah` to the family number adds the event and
texts back a confirmation. Same parser as the web app.

---

## Optional — the native calendar feed

Deploy `ics-feed` (step 6 covers it), then on any iPhone:
**Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar**

```
https://<ref>.supabase.co/functions/v1/ics-feed?h=00000000-0000-0000-0000-000000000001
```

Family events then show up in the built-in Calendar app alongside work calendars.
iOS refreshes it on its own schedule (up to about an hour), so treat it as a
convenience view — the push notifications are the real alerts.

---

## Things that will bite you

- **A Safari tab cannot send notifications.** Only the home-screen icon can.
  That is Apple's rule. If someone says alerts don't work, ask whether they
  opened it from the icon or from a bookmark.
- **Deleting the home-screen icon kills that person's notifications** until they
  re-add it. The server prunes the dead subscription automatically.
- **Supabase free projects pause after 7 days with zero API traffic.** A calendar
  the family uses will never hit this. If it happens, un-pause in the dashboard.
  Do not build a keep-alive job for it.
- **Chrome on iPhone cannot Add to Home Screen.** Safari only.
