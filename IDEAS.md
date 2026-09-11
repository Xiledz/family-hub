# Family Hub — ideas, judged against this house

Written 2026-09-11 after M0 shipped. Every idea below was tested against four
people, not "families": Erich (owner, office, swing-trades, texts from the
car, plans on Sunday night), Jess (default cook, HEB with Bryce in the cart,
receives every kid alert, replies in one word), Addie (teen, orchestra,
church Monday 6:30, no phone until her number is added), Bryce (9, trash
Tuesday, daily practice, no device — everything routes to Jess). And against
this architecture: one parser over SMS and app, `deliver()` push→SMS→guardian,
pg_cron, a catalog that learns, closed vocabularies, ask-don't-guess, one row
is one thing, the digest is the nag channel.

The #1 way a family app dies is noise. Every idea carries a noise score:
**0** adds no message, **1** adds a message only when asked, **2** adds a
scheduled message, **3** adds unsolicited pings. Anything at 3 is NO unless it
replaces a text the family already sends each other.

---

## A. A school month, lived

| Scenario | What they do today | What the app would need | Idea # |
|---|---|---|---|
| **First day of school.** Two start times, a supply list PDF, the orchestra season schedule as a PDF, a photo on the porch. | School email stays in Jess's inbox; supply list printed; schedule dates typed in one at a time — or not at all. | Paste a schedule → one confirm screen, N rows. Paste a supply list → shopping items. Per-kid "school starts" events with a leave alert. | 1, 24, 2 |
| **Sick kid (Bryce, Tuesday).** Who stays home, cancel orchestra, no trash nag today, dinner is whoever's here. | Phone call Erich↔Jess at 7am; Jess texts the orchestra parent; the 6pm trash nag still fires; the thaw alert still fires for a dinner nobody wants. | `Bryce is sick today` → skip his occurrences today, pause his nags, tell the driver, tell the cook the headcount, put "Bryce home" on both digests. | 5, 4 |
| **Addie's birthday.** Gift ideas the kids must not see, a party, a cake, grandparents to invite. | Notes app on Jess's phone; a group text with the grandparents; the cake ingredients on the paper list. | Yearly date; an adults-only list (the `visibility` enum already exists on events, not on lists); guests as headcount for the meal. | 11, 12, 4 |
| **Grandparents visit for 4 days.** Airport pickup, guest room, 6 for dinner, they want to know the week. | Erich forwards screenshots; Jess says the plan out loud twice. | Read-only .ics for grandparents (exists, needs the token and one line in the doc); headcount 6 → servings; a "guest room" house todo. | 16, 4 |
| **Erich travels Tue–Thu.** His driving roles are uncovered; his nags are useless; Jess needs to know what she inherited. | Erich reads the calendar on the plane and texts Jess "can you get Addie Thursday". | `I'm away Tue–Thu` → every role of his in that range is flagged, Jess is asked once per gap, his todo nags defer, both digests say "Erich away". | 7 |
| **Thanksgiving.** Five dishes, 12 people, turkey out of the freezer Sunday, three stores. | Pinterest board + a legal pad + Costco run from memory. | One meal slot with several recipes; steps measured in DAYS before cook; consolidated shopping across dishes; headcount 12. | 15, 4 |
| **Snow day.** School closed at 6am; everything school-linked is off; kids are home; Jess works. | Group text; each parent cancels their own things; the driver alert for orchestra still fires at 3:15. | `snow day` = skip everything tagged school today, everyone home for dinner, kids' chores stay. Same grammar as sick day. | 5, 6 |
| **Lost permission slip.** "Where's the orchestra form? It was due Friday." | It was on the fridge under the HEB list. | `sign the orchestra form by Friday` already works as a todo; what's missing is the photo of the form attached to it, and the form deadline surfacing in Jess's digest two days early. | 10, 38 |
| **Allowance argument.** "I did the trash three weeks in a row." "You missed one." | Memory versus memory. | The data already exists: `todos.completed_at` vs `missed_at` per child. A weekly tally per kid in the Sunday digest ends the argument; whether money hangs off it is Erich's call. | 13, 14 |
| **"Who has the car" Saturday.** Soccer 9, Costco run, orchestra 1, church youth 5. Two drivers, one car free. | Kitchen negotiation at breakfast. | Overlapping `driving` roles across events are a conflict the calendar can see and nobody else can. Show it on the day view; ask at plan time. | 8, 21 |
| **Wednesday, nothing planned.** | "What's for dinner?" ×3. | `dinner is leftovers` by text; 4pm "nothing planned" to the cook only. | 19 |
| **Sunday planning.** | Pinterest, ~60 taps, staples unstarred. | Last week's dinners as one-tap re-plans; staples pre-starred; recent items as chips. | 18, 22, 20 |

---

## B. Ideas, ranked

Format: what it is in family terms · who benefits · touches · size (h) ·
depends on · noise (0–3) · **verdict**.

### BUILD NEXT

**1. Season paste → one confirm, many rows.**
Addie's orchestra schedule and Bryce's soccer schedule arrive as a PDF or an
email once a season. Today each date is typed separately, so most are not
typed at all — and then a kid is outside a school with no ride alert. Paste
the block (or the text of the PDF) into the calendar box; the parser splits
lines, reads a date and time from each, carries the title, person and roles
from the first line ("Orchestra rehearsals, Addie, Jess driving") down to
the rest, and shows ONE confirm sheet: a list of rows with a tick each, one
"Add all" button. Rows it could not date are shown unticked with the raw
line, never guessed. Over SMS: same paste, reply "1" adds all, "3 5" skips
those lines. · Everyone; Jess most. · parser (`parseSeason(text)` — a line
splitter over the existing `parseQuickAdd`, carrying context), app (confirm
sheet), SMS (`season_confirm` pending kind, list reply). · **4 h** · none ·
noise 0 · **BUILD NEXT** — the single biggest reason the calendar stays
incomplete, and it is a loop over a parser that already exists.

**2. Questions by text that get an answer, never a row.**
`anything Thursday?` currently creates an event titled "anything". Read-only
intents: `what's today`, `what's Thursday`, `who's driving Addie Monday`,
`what's for dinner`, `did Jess get the milk`, `Bryce's list` (exists). Stage
0 in `routeIntent`, before anything can file a row: a question mark or a
question opener (`what's|whats|who's|whos|anything|is there|did .* get`) →
`{intent:'ask_*'}`. Answers come from `member_day`, `meal_plan`,
`shopping_items`. Unrouted text that ends in "?" gets "I only add things —
ask 'what's Thursday' or 'who's driving Addie Monday'". · Addie and Jess. ·
parser, SMS. · **3 h** · none · noise 1 · **BUILD NEXT** (was M1 #7; it is
the difference between Addie using the number and Addie texting Jess).

**3. Skip grammar: sick day, snow day, a range.**
One vocabulary for "not happening": `Bryce is sick today`, `snow day`,
`no orchestra spring break Mar 9–13`, `skip soccer Saturday`. Effects, all
via rows that exist: `event_exceptions` (action `skip`) for each occurrence
in scope; unsent reminders for those occurrences deleted (the trigger from
018 does this per occurrence); for a sick/snow day, the person's todo nags
for today are deleted too and the digest says "Bryce home today". "Sick"
scopes to a person; "snow day" scopes to events tagged school (a `tags
text[]` on events, set by the season paste and editable in the sheet — or,
simpler for v1, everything with a kid on the cast). Undo: `Bryce is fine` /
`school's on` re-opens the day. · Jess; the drivers. · parser (SKIP_RE stage
0), schema (`events.tags`, optional), SMS + app (a "Skip" chip row on the
day view: today / this week / range). · **4 h** · none · noise 1 (it removes
pings) · **BUILD NEXT** — it is the month's most common interruption and the
app currently makes it worse by nagging through it.

**4. Who's home tonight → headcount → servings.**
Derived, not entered: for a given dinner, anyone with an event overlapping
`ready_by` (church 6:30 for Addie) is out; a sick/snow/away mark counts; the
rest are home. `meal_plan.servings` defaults to that count plus guests. The
Plan sheet shows "4 home (Addie at church)" and the cook's countdown says
"3 for dinner". `Addie's at church, 3 for dinner` by text overrides. ·
Jess. · SQL (`home_for_dinner(p_date) returns table(member, reason)`), app
Plan sheet, digest dinner line. · **3 h** · idea 3 for sick/away marks ·
noise 0 · **BUILD NEXT** — it makes the Meals tab true without anyone
typing a number.

**5. Kitchen mode: `?kid=bryce` and `?display=kitchen`.**
The kids have no phones; an old iPad on the counter (or Jess's phone handed
over) opens the same URL with `?kid=bryce`: his day, his chores as big
ticks, tonight's dinner, no editing, no other tabs, a streak count. `?display=
kitchen` is the wall-display view: this week for everyone, dinner each day,
the shopping list count, rotating nothing — Skylight without the $300 frame.
Both are read-mostly views over data the app already loads; the kid mode
writes only `completed_at`. · Bryce, Addie; Jess stops being the screen. ·
app only (two render branches, a stripped nav), `localStorage` pins the kid.
· **3 h** (kid) + **2 h** (display) · none · noise 0 · **BUILD NEXT** (was
M2 #11; pulled forward because it is the only Bryce-facing surface and every
chore feature is invisible to the person doing the chore until it exists).

**6. One digest per guardian.**
Jess gets three morning texts: hers, then "For Addie: …", then "For Bryce:
…". One message: her day, then a "Bryce:" block, then an "Addie:" block —
chores due, rides, dinner once at the bottom. `digest_log` keys stay per
person so nothing double-sends. · Jess. · morning-digest.ts (group members
by `notify_via_member_id` when the ward has no push device of their own). ·
**1.5 h** · none · noise −1 (three messages become one) · **BUILD NEXT**.

**7. Store chip shows its items PLUS "Any store"; catalog learns the store.**
As ROADMAP M1 #6. When Jess ticks milk at HEB 1488, `shopping_catalog.store_id`
learns it; next time "milk" lands under HEB with the aisle. Recipe pushes use
it. · Jess at HEB. · app, schema (`shopping_catalog.store_id`). · **2.5 h** ·
none · noise 0 · **BUILD NEXT** (kept).

**8. Dinner on the Today card; `dinner is leftovers` by text; 4pm nudge to the cook only.**
As ROADMAP M1 #9, plus the SMS path into Meals that the tester scored
MISSING: `dinner is leftovers`, `tacos tonight`, `pizza night Friday` →
`meal_plan` freeform/recipe (recipe if the name matches one at ≥0.6). The
4pm nudge is a cron `dinner-nudge` (`*/15 20-22 * * *` UTC, the function
checking for 4:00–4:15pm household time the way morning-digest does, so DST
moves nothing) that inserts ONE reminder for the default cook only when no
dinner row exists for today, and only on weekdays. · Jess, and everyone asking her. · parser (`DINNER_RE`
stage 0), SMS, app, cron. · **2.5 h** · none · noise 2 (one scheduled
message, only on empty days) · **BUILD NEXT** (kept).

**9. Kid ride request → "Who's got this?"**
As ROADMAP M1 #10. Addie: `i need a ride to practice thursday 4` → event on
her calendar with `needsRides`; both parents get one push/SMS "Addie needs a
ride Thu 4:00 — reply ME"; the first `me` claims `driving`; the other parent
is told who took it. Needs Addie's number on file (M0 #5, still open). ·
Addie; both parents. · SMS (a `claim_ride` pending kind on BOTH parents'
rows; first answer wins, second gets "Jess has it"), deliver(). · **2.5 h** ·
Addie's number · noise 2 (replaces the "can you get Addie" text) · **BUILD
NEXT** (kept).

**10. Grandparents on the calendar feed.**
`ics-feed` exists with a token gate; the token was never set and nobody has
the URL. Set `FEED_TOKEN`, add a "Share the calendar" row in Settings that
shows the subscribe URL with a copy button, and one paragraph in
FAMILY-SETUP.md for the grandparents (iPhone: Settings → Calendar → Accounts
→ Add Subscribed Calendar). Per-person feeds (`?m=addie`) are a 20-minute
addition for the sitter. · Grandparents, sitter. · settings screen, docs. ·
**1 h** · none · noise 0 · **BUILD NEXT** — it is finished code with no door.

**11. Roles visible on cards; cast editor in the event sheet.**
As ROADMAP M1 #8. Without it the driver collision below (#17) cannot be
seen. · Jess. · app. · **3 h** · none · noise 0 · **BUILD NEXT** (kept).

**12. Recent items as chips; staples pre-starred on first run.**
Shopping box gets a row of the 12 most-ticked catalog items as one-tap chips
("milk", "eggs", "bananas"); the meals have/need screen pre-stars the
obvious staples (salt, pepper, oil, flour, sugar, butter, garlic) once, on
first open, from a fixed list — the settled no-pantry rule is untouched,
this is only the default for the ★. · Jess. · app, one SQL seed. · **1.5 h**
· none · noise 0 · **BUILD NEXT** — cheapest tap-count win on the list.

### BUILD LATER

**13. Away mode for a parent.** `I'm away Tue–Thu` / `Erich out of town Mar 3–6`
→ a `member_away (member, from, to)` row; every `driving/dropoff/pickup`
role of his in range becomes a gap: Jess is asked ONCE, one message listing
the gaps with numbered replies ("1 = I'll take Thursday orchestra"); his
todo nags defer to the digest; both digests carry "Erich away" on those
days; the cook default is unaffected (it is already Jess). · Jess. · schema,
parser (AWAY_RE), SMS, digest, `materialize_series` (skip his reminders in
range). · **4 h** · #11 for the roles to be visible · noise 1 · **LATER** —
real, but a few times a year; #3 covers the one-day version (`Erich is out
Thursday`) if the skip grammar accepts a parent.

**14. Driver collision on the day view ("who has the car").** Two `driving`
roles whose events overlap (start-to-end, or ±45 min when no end) show a
red "2 drivers, 1 car?" pill on both cards, and the ride reply asks about it
at plan time. Assumes the household has N cars (a `households.cars int`,
default 2; Saturday collisions happen when one is at the shop). · Both
parents. · SQL view `driver_overlaps(p_date)`, app day view. · **2.5 h** ·
#11 · noise 0 · **LATER** — after roles are visible; until then nobody can
fix what it finds.

**15. Photo on a thing.** A camera button on the event and todo sheets;
image to Supabase Storage (free tier 1 GB; resize client-side to ≤400 KB);
shown as a thumbnail on the card; by SMS, an MMS attachment lands on the
last-created row. The permission slip, the supply list, the practice
schedule photo before #1 has parsed it. · Jess. · schema (`attachments`),
Storage bucket + RLS policy, app, sms-inbound (Twilio `MediaUrl0`). · **4 h**
· none · noise 0 · **LATER** — genuinely useful, but the "lost slip" case is
mostly solved by the todo + deadline that already work.

**16. Multi-dish meals and multi-day prep (Thanksgiving).** `meal_dishes
(meal_id, recipe_id, servings)` so one slot holds five recipes; countdown
steps allow `minutes_before_cook` up to 7 days (constraint is 4320 = 3 days
today); the have/need screen consolidates ingredients across dishes (sum
same catalog name); pushed items keep `meal_id`. · Jess, once or twice a
year plus every "tacos + rice + beans" night. · schema, app, materializer. ·
**5 h** · none · noise 0 · **LATER** — build in late October so it is real
for Thanksgiving; ship #4 (headcount) first because it is the half of this
that matters weekly.

**17. Birthdays and yearly dates with an adults-only gift list.** Birthdays
as `yearly` events (the recurrence exists) with a 7-day lead reminder to
both adults; a "Gifts" list whose rows carry `visibility='adults'` — the
enum exists on events and needs adding to `shopping_items` plus a policy
change: today's RLS is `using (true)` for the whole household with one
passcode, so "adults-only" is a UI filter until per-person auth exists.
Honest label in the UI: "hidden from the kids' screens", not "private". ·
Both adults. · schema, app filter, kid mode respects it. · **3 h** · #5 (so
"hidden from kids" means something) · noise 2 (birthday lead) · **LATER**.

**18. Chore tally and allowance ledger.** Sunday digest to each adult: "Bryce
this week: 6 of 7 done (missed Tue trash). Addie: 4 of 4." From
`completed_at`/`missed_at` — no new data. The ledger half — points per chore,
a running balance, "paid" by a parent — is a `ledger` table behind the
adults-only rule and is the first Money-module row. Kid mode shows the
streak and the count, never the money. · Bryce (fairness), both adults. ·
digest (tally: **1 h**), schema + app (ledger: **4 h**). · **LATER** for the
ledger pending Erich's answer (D1); the tally alone is cheap and could ride
with #6.

**19. Practice streaks in kid mode.** `Bryce practice 20 min daily` is a
daily todo already; the streak is `count(consecutive completed_at)` shown as
a number and a row of dots in `?kid=bryce`, reset by a `missed_at`. · Bryce.
· app (kid mode). · **1.5 h** · #5 · noise 0 · **LATER**, first thing after
kid mode ships.

**20. Sunday 10am planning nudge with last week's dinners as one-tap re-plans.**
As ROADMAP M2 #18. Cron `sunday-plan` (`0 15 * * 0` UTC) → one push/SMS to the
default cook: "Plan the week? Last week: tacos, sheet-pan chicken, leftovers,
pizza" with the Meals tab opening to a "Repeat last week" button. · Jess. ·
cron, app. · **1.5 h** · none · noise 2 · **LATER** — after #4 and #8 make
the Meals tab worth opening on Sunday.

**21. Index-card photo → recipe.** As ROADMAP M2 #16, through recipe-import
with a vision call; the same confirm screen. · Jess. · recipe-import.ts,
app. · **4 h** · #15's upload path · noise 0 · **LATER**.

**22. Chore rotation.** `dishes rotate Addie and Bryce weekly` → a
`rotation` on the todo (assignee cycles when the successor spawns, in
`todos_spawn_next`). One row is still one thing; the row just changes hands.
· Both kids. · parser (`rotate|alternate|take turns`), schema
(`todos.rotate_ids uuid[]`), trigger. · **2 h** · none · noise 0 · **LATER**
— the day Erich says "they take turns".

**23. District calendar subscription.** A `sources` row with the school
district's public .ics; cron `school-calendar` nightly imports "no school"
days as all-day household events tagged `school`, and #3's skip grammar
skips school-tagged series on those days automatically. No more snow-day
typing for scheduled holidays. · Everyone. · schema, cron + a small edge
function (ics parse), #3. · **3 h** · #3 · noise 0 · **LATER** — after a
season with #3 shows how often it is needed.

**24. Supply-list paste → shopping.** A pasted school list is a shopping
list with quantities and no store; `parseShopping` already splits lines.
Add "paste a list" to the Shopping box (multi-line → N items, confirm count)
and route a multi-line SMS with no dates to shopping. · Jess in August. ·
app, SMS. · **1 h** · none · noise 0 · **LATER** — ride along with #1 since
the line-splitter is shared.

**25. Cook mode.** Open a planned meal on the counter: directions one step
per screen, big type, a timer per step ("simmer 20 min" → a running clock,
a push when it ends), screen stays awake (`wakeLock`). Paprika's best
feature, and the only one this house lacks. · Jess. · app. · **3 h** · none
· noise 1 · **LATER**.

**26. Sitter / guest link.** A tokenised read-only page: this week, dinner,
the kids' bedtimes and allergies (two text fields on `members`), emergency
numbers. The .ics (#10) is the calendar half; this is the rest. · Sitter,
grandparents. · app (`?guest=<token>`), schema (`households.guest_token`,
`members.notes_for_sitter`). · **2.5 h** · #10 · noise 0 · **LATER**.

**27. Quiet hours for the 6pm nag.** The 6pm chore nag lands on Jess during
dinner service. Option: `households.quiet_from/quiet_to` (e.g. 17:30–19:00);
`queue_todo_nags` moves any fire_at inside the window to `quiet_to`. ·
Jess. · SQL only. · **0.5 h** · none · noise −1 · **LATER pending D2** —
trivial to build, but whether 6pm or 7pm is right is Jess's call, not code's.

**28. Purchase log from `got` ticks; weekly ad matching.** As ROADMAP M3.
· Erich (money). · schema, cron. · 6–20 h · Money auth · noise 0 · **LATER
(M3)** — unchanged.

### NO

**29. In-app chat / family feed / photo wall (Cozi, Skylight).** iMessage
already exists and the kids have no devices; a second inbox is noise. NO.
**30. Screen-time and location controls (Family Link, Apple Screen Time).**
No kid phones; Apple already does it when they get one. NO.
**31. Geofenced reminders ("when you're at HEB").** iOS PWAs cannot run
background location; the store chip + catalog store (#7) gives Jess the
same outcome by hand in one tap. NO.
**32. Meal voting / "what do you want for dinner" polls to the kids.** It
moves the decision from one person to four and the cook still decides. Kid
mode shows dinner; that is the whole feature. NO.
**33. Rewards store / points marketplace (OurHome).** Points are a ledger
(#18); a catalogue of prizes is admin work Jess will not do. NO.
**34. Pantry inventory.** Settled: the data rots in weeks. NO.
**35. Medication schedules ("Tylenol every 6 hours").** A real need on a
sick day, but hour-interval repeats are a new recurrence type across the
parser, `todo_next_due` and the nag queue, and a wrong dose reminder is not
a bug you want to own. A one-off todo with a time (`give Bryce Tylenol at
2pm`) already works. NO.
**36. School lunch menu, weather, news widgets (Skylight).** Nobody in this
house asked, and a widget is a reason to stop reading the screen. NO.
**37. Shared budget dashboard in this app now (Hearth/Cozi Gold).** Reserved
behind per-person auth (`visibility`, `auth_user_id`); one passcode for the
household means "adults only" is not real yet. NO until Money auth (M3).
**38. Native iOS app / App Store.** Push works from the PWA; the App Store
adds Apple's review cycle to every fix. NO.
**39. Siri / Shortcuts integration as a feature.** Free already: a Shortcut
that sends a text to the family number, or the `?import=` share-sheet path
(M2 #15). Document, don't build. NO as a feature.
**40. AI "suggest a meal plan".** The household has ~10 recipes it actually
cooks; #20 (repeat last week) beats a generator, and a wrong suggestion is
noise. NO for now.

---

## C. Revised roadmap

### M1 — "Nobody drifts back to paper" (~22 h, was 14)
| # | Item | Size | From |
|---|---|---|---|
| 1 | Season paste → multi-row confirm (+ supply-list paste #24) | 5 | new |
| 2 | Questions by text (`what's Thursday`, `who's driving`, `what's for dinner`, `did Jess get`) | 3 | M1 #7 |
| 3 | Skip grammar: `Bryce is sick today`, `snow day`, `no orchestra Mar 9–13` | 4 | month-two "bulk skip", extended |
| 4 | One digest per guardian | 1.5 | M2 #12, pulled forward |
| 5 | Store chip + "Any store" + catalog learns store | 2.5 | M1 #6 |
| 6 | Dinner on Today, `dinner is leftovers`, 4pm nudge | 2.5 | M1 #9 |
| 7 | Grandparents .ics: token, Settings row, doc | 1 | new |
| 8 | Recent-item chips; staples pre-starred | 1.5 | M2 #14, pulled forward |
| — | Addie's number + Jess's invite (M0 #5, still open) | 0.5 | M0 |
Done when: Addie texts `anything thursday?` and gets her day; Jess texts `Bryce is sick today` and the orchestra driver alert does not fire; the orchestra season is on the calendar from one paste.

### M2 — "They tell friends" (~19 h)
| # | Item | Size | From |
|---|---|---|---|
| 9 | Kid mode `?kid=bryce` + kitchen display `?display=kitchen` | 5 | M2 #11, widened |
| 10 | Who's home tonight → headcount → servings | 3 | month-two, promoted |
| 11 | Roles on cards + cast editor | 3 | M1 #8, demoted one milestone (nothing in M1 depends on it) |
| 12 | Kid ride request → "Who's got this?" | 2.5 | M1 #10, demoted: needs Addie's number and #11's roles to be visible |
| 13 | Practice streaks in kid mode | 1.5 | month-two |
| 14 | Chore tally in the Sunday digest | 1 | new |
| 15 | Sunday planning nudge + repeat last week | 1.5 | M2 #18 |
| 16 | Share-sheet Shortcut install page | 1 | M2 #15 |
Demoted from M2 to M3: dinner collision anchor UI (M2 #13) — #10 covers the
headcount half; the anchor exists in the schema and can wait. Index-card
vision (M2 #16) → M3 behind the upload path. Per-person calendar filter
chips (M2 #17) → M3; kid mode is the per-person view that matters.

### M3 — "The house runs on it" (each 2–6 h unless noted)
Away mode (#13) · driver collision (#14) · photo on a thing (#15) ·
Thanksgiving multi-dish + multi-day prep (#16, build in October) · birthdays
+ adults-only gift list (#17) · allowance ledger (#18, pending D1) · chore
rotation (#22) · district calendar (#23) · cook mode (#25) · sitter link (#26)
· quiet hours (#27, pending D2) · index-card vision · per-person filter chips
· dinner-collision anchor UI · second device for Erich · then the original
M3: aisles for four stores, weekly ads, purchase log, Money behind auth.

---

## D. Three questions only Erich can answer

1. **Allowance:** does money hang off chores in this house (e.g. $X per
   completed week, docked per missed one), or is the weekly tally enough and
   allowance stays separate? — *one line: "tally only" / "$__ per week, minus $__ per miss" / "no allowance"*
2. **The 6pm nag:** Jess is cooking at 6. Keep the chore nag at 6pm, move
   the household default to 7pm, or fold it into the next morning's digest
   and never ping in the evening? — *one line: "6pm" / "7pm" / "digest only"*
3. **A kitchen screen:** is there an old iPad or a spare phone that can live
   on the counter for kid mode, or does Bryce only ever see the app on
   Jess's phone? — *one line: "yes, an iPad" / "Jess's phone only"*
