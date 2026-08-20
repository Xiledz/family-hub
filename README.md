# Family Hub

Private family calendar and household hub. Static site on GitHub Pages, data in
Supabase, installable on iPhone with real push notifications. No build step —
edit a file, push, it's live.

**Try it with no setup:** open `index.html`. Demo mode, code `DEMO`.

## Files
| Path | What |
|---|---|
| `SETUP.md` | **Start here.** 45 minutes to live. |
| `FAMILY-SETUP.md` | Send this to the family. Fill in the link and code first. |
| `PROJECT-BRIEF.md` | Status and decision log. |
| `design-preview.html` | The four design concepts. Bulletin was chosen. |
| `index.html` / `styles.css` / `app.js` | The app. |
| `parse.js` / `parse.test.mjs` | Quick-add parser. `node parse.test.mjs` after any edit. |
| `config.js` | Your Supabase URL + anon key. The only file you edit. |
| `sw.js` / `manifest.webmanifest` / `icons/` | PWA shell. |
| `supabase/schema.sql` | Tables, RLS, cron. Run once. |
| `supabase/functions/` | Reminder dispatcher, .ics feed, Twilio handler. |
| `.claude/agents/family-hub.md` | Project agent. Owns architecture and constraints. |

## How it works
- **Add**: type it the way you'd say it — `Soccer Thursday 5:30 Noah` — and
  confirm. Or tap the keyboard mic and say it.
- **Alerts**: pick a lead time per event (10 min → 2 days). A Supabase cron job
  checks every minute and pushes to every installed phone.
- **Grows**: shopping, meals, purchases, and finance are already modeled in
  `schema.sql`. Each one is a table plus a card.

## Constraints (do not violate)
- No build step. No npm, no bundler, no CI.
- The Supabase anon key is public by design. RLS is the security boundary.
  The `service_role` key never goes in this repo.
- Mobile first. Nothing ships until it works one-handed at 390px.
- Soft deletes only. Family data is never dropped.
