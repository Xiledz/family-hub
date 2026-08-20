# Family Hub — Project Brief

Living document. Every session updates this. Read it first.

## What this is
A private family hub the whole household can read and write, hosted free on
GitHub Pages, installable on iPhone as an app icon with real push notifications.
Calendar first; built to grow into shopping lists, meal planning, purchase
tracking, deal watching, and a finance dashboard visible only to adults.

## Status — 2026-08-19
- [x] Architecture decided
- [x] Four design concepts built; **Bulletin chosen**
- [x] Schema written for all planned modules (`supabase/schema.sql`)
- [x] Natural-language quick-add parser + 21 passing tests (`parse.js`)
- [x] App built: dashboard, quick add, event sheet, reminder lead times
- [x] PWA shell: manifest, service worker, icons, push subscription flow
- [x] Reminder dispatcher, .ics feed, dormant Twilio handler (Edge Functions)
- [x] Night mode + settings sheet
- [x] Supabase project created (`rauvytdltnbqrvyiornh`); `config.js` filled in
- [x] Seed block written: KELLEY2009 / Erich, Jess, Addie, Bryce
- [x] `schema.sql` run — verified: 5 tables, 4 members, correct roles/colors, KELLEY2009
- [x] VAPID keys generated and verified as a matched pair; public key in `config.js`
- [x] Four VAPID/household secrets saved in Supabase
- [x] `dispatch-reminders` deployed — verified returning `{checked:0,sent:0,failed:0}`
- [x] `ics-feed` deployed with a token gate; Verify JWT turned OFF on it
- [x] Cron `reminder-dispatch` scheduled `* * * * *` — verified firing and succeeding
- [ ] `FEED_TOKEN` secret added (calendar feed 404s until then)  ← **next**
- [ ] GitHub repo + Pages
- [ ] Phone install + push test
- [ ] Functions deployed + cron scheduled
- [ ] GitHub repo + Pages enabled
- [ ] Family onboarded (`FAMILY-SETUP.md`)
- [ ] *(optional, no rush)* Twilio A2P 10DLC registration started

**Open it right now:** `index.html` runs in demo mode with sample data, no
accounts required. Code is `DEMO`.

## Architecture (settled — full rationale in `.claude/agents/family-hub.md`)
GitHub Pages (static UI) → Supabase free tier (Postgres + Realtime + Edge
Functions + Cron). Shared family passcode, then pick-your-name. No build step.
Vanilla ES modules. Web Push as the notification backbone; Twilio SMS written
but dormant.

## How the hub grows
Every module is the same shape: a table with `household_id` / `visibility` /
`deleted_at`, the same RLS policy shape, one more card in the bento grid, and —
if it needs to alert anyone — a row inserted into `reminders`. The dispatcher
already handles delivery. Commented-out table definitions for lists, recipes,
meal plans, purchases, and accounts are at the bottom of `schema.sql` so nobody
invents a second pattern later.

## Working agreement
- Hand Erich **numbered click-by-click steps**, never prose, for anything he has
  to do himself. Name buttons exactly as labeled; say what success looks like.
- Use browser automation to verify and diagnose on his behalf. Never to sign in
  or to type secrets.

## Decision log
- **2026-08-19** — Supabase over Google Calendar and over JSON-in-repo. Google
  Calendar can't accept writes from the site and doesn't extend to lists;
  JSON-in-repo requires a GitHub account per family member.
- **2026-08-19** — Shared passcode over magic links. Zero support burden matters
  more than per-person audit trail for a household.
- **2026-08-19** — **Bulletin** design chosen. It's the only one of the four where
  a new module is one more card instead of a redesign.
- **2026-08-19** — Web Push is the notification backbone, not SMS. Push is free
  and unlimited; SMS costs per message *and* requires a registered carrier
  campaign describing what you send. A deal-watch alert over SMS reads as
  marketing and gets the campaign flagged. SMS stays as the calendar's second
  channel and the text-to-add front door.
- **2026-08-19** — Twilio code written now but gated behind `SMS_ENABLED`.
  Registration takes days-to-weeks; nothing else waits on it.
- **2026-08-19** — Natural-language quick add with tap-to-confirm. Deterministic
  parser, no API key, no per-use cost. The iPhone keyboard mic turns it into a
  voice interface for free. Confirmation step means a bad parse costs a tap, not
  a wrong calendar entry.
- **2026-08-19** — `parse.js` is shared by the web app and the SMS webhook.
  One grammar, two front doors. Never fork it.
- **2026-08-19** — **Privacy escalation planned, not deferred.** A finance module
  for "certain members" was named as a future want. Shared passcode gives
  everyone identical access, which is wrong for finance. Rather than force the
  whole family into accounts now (adoption killer), `members.auth_user_id` and a
  `visibility` enum ship in v1 unused. Finance later goes behind per-person auth;
  nothing else changes and no data migrates.
- **2026-08-19** — `.ics` feed published so events also land in the native iPhone
  Calendar. Convenience layer only — iOS refresh lag makes it unfit as the alert
  path.
- **2026-08-20** — **The .ics feed cannot use Supabase JWT verification.** iOS sends
  no Authorization header when subscribing to a calendar feed, so the endpoint
  returned 401 to every phone. Verify JWT is now OFF for `ics-feed` only.
  Replacing it with nothing was not acceptable: this household's id is the
  all-zeros UUID, so an unauthenticated feed would be readable by anyone who
  knew the project ref. The feed is now gated on a `FEED_TOKEN` secret passed as
  `?t=`, and returns 404 (not 401) on a bad token so a wrong guess is
  indistinguishable from a feed that doesn't exist. `dispatch-reminders` keeps
  JWT verification ON — the cron sends the anon bearer.
- **2026-08-20** — Edge Functions deploy from the Supabase **in-browser editor**,
  not the CLI. Erich's work PC has no Node, and the browser path removes the
  Scoop/CLI install entirely. Consequence: every function must be a single
  self-contained file — the in-browser editor cannot resolve imports outside the
  function's own folder. `_shared/db.ts` was inlined into each function and
  deleted. `sms-inbound` still imports `parse.js` and therefore needs the CLI, or
  parse.js added as a second file in the editor; it is dormant so this can wait.
- **2026-08-20** — Night mode with a manual override (Auto / Light / Night) in a
  Settings sheet behind the name chip, not just a system-following media query.
  One palette definition serves both triggers. Theme is applied pre-paint by an
  inline head script to avoid a white flash on launch.
- **2026-08-20** — The name chip is now the settings entry point. It also holds
  the per-person default reminder and "switch person," so future settings have a
  home instead of accreting in the header.
- **2026-08-19** — All-day reminders anchor to 9am local, not midnight, so
  "1 day before" doesn't fire in the middle of the night.

## Open questions
- Real family member names, colors, and roles (placeholders in the seed block)
- Household passcode
- Mobile numbers for `members.phone` (only needed if Twilio gets turned on)
- Custom domain? (~$12/yr, works with GitHub Pages)

## Windows-side cleanup for Erich
- `agents/family-hub.md` must be moved to `.claude/agents/family-hub.md` by hand —
  the Cowork VM is blocked from writing into `.claude`. See `agents/INSTALL-AGENT.txt`.
- `design-preview.html` and `agents/` don't need to go in the public repo.
