# Family Hub — roadmap

Written 2026-09-11 from a family walk-through (see "Tester report" in
current-projects.md). Sequenced by **who quits first**, not by what is
technically interesting. Each milestone ends in a state the family can live on.
Sizes are hours for one developer working with an AI.

## Is it done?
The calendar-first v1 from the brief is done and solid, and three of the four
"grow into" modules exist in usable form. What is NOT done is the brief's own
promise — "completely usable, text is a supplement." Today the text side has
the richer grammar and the app the richer views, and neither is complete alone.
The family will hit the seams in the first week, in this order: Addie can't
text (no number), trash becomes a calendar event, Jess can't close Bryce's
chore by reply, the HEB chip hides the list, the beef alert goes to the wrong
parent.

## M0 — "Jess can trust it" (~9 h)
| # | Item | Why here | Size | Done when |
|---|---|---|---|---|
| 0 | Commit/push the 4 modified files | Everything after assumes this build | 0.5 | Pill = 2026-09-11b on Erich's phone |
| 1 | Route "Name(s) + chore verb" to todo (`Bryce take out the trash every Tuesday`) | THE chore; today it makes a calendar event + rides question | 1.5 | route/todo tests pin it; SMS reply "On Bryce's list…" |
| 2 | Guardian can close a dependent's todo by text; `did it` resolves against last nag; nag says "Reply DID when done" | Jess is the only one who can close Bryce's loop | 2 | Jess replies `did trash` → "Done: Take out the trash (Bryce)" |
| 3 | Recurring chores advance by DATE, not by completion; missed week shows "missed" and next one still nags | A missed week must not kill the chore | 2 | Skip a Tuesday in test; next Tuesday nags |
| 4 | Cook picker on Plan sheet + `households.default_cook_id` (Jess); digest names the cook | Beef alert must reach the kitchen, not the planner | 1.5 | Erich plans; thaw alert lands on Jess |
| 5 | Add Addie's number; rewrite FAMILY-SETUP.md (real link, code, text number + its commands, the enter-code-twice note); send Jess's invite | No install, no adoption | 1.5 | Jess has a push device row; Addie's text gets a reply |

## M1 — "Nobody drifts back to paper" (~14 h)
| # | Item | Size | Done when |
|---|---|---|---|
| 6 | Store chip shows its items PLUS "Any store" (labelled); catalog learns `store_id` from where an item was last ticked; recipe push uses it | 2.5 | Jess at HEB sees Erich's milk with an aisle |
| 7 | Read-only SMS intents: `what's <day>`, `what's today`, `who's driving <name> <day>`, `what's for dinner`, `did <name> get <item>`; unrouted "?" gets an answer, never a row | 3 | Five questions → answers; zero garbage events |
| 8 | Roles visible on cards (`whoOf(e,true)`); cast editor in the event sheet | 3 | Jess opens Church, sees and changes "Jess · drives" |
| 9 | Dinner on Today card; 4pm "nothing planned" nudge to the cook; SMS `dinner is leftovers` → meal | 2.5 | Wednesday resolved by one text |
| 10 | Kid ride request → "Who's got this?" to both parents; first `me` claims pickup | 2.5 | Addie's text ends with a parent holding a leave alert |

## M2 — "They tell friends" (~16 h)
11. Bryce mode: `?kid=bryce` — his day, his chores, big ticks, no editing (3)
12. One digest to Jess with her day + "Bryce:" + "Addie:" sections (1.5)
13. Dinner collision: Plan sheet shows that evening's events; tap one → anchor + back-computed ready_by (2)
14. Staples bootstrap: star the obvious ones on first run (1)
15. Share-sheet Shortcut install page (1)
16. Index-card photo → recipe via recipe-import + vision, same confirm sheet (4)
17. Per-person filter chips on calendar views (2)
18. Sunday 10am planning nudge with last week's recipes as one-tap re-plans (1.5)

## M3 — Vision (each 6–20 h)
Aisles for the other four stores (Kroger API from home PC); weekly-ad matching
against the catalog; store walking path; Money behind per-person auth
(`visibility` / `auth_user_id` already reserved); purchase log from `got` ticks.

## Month-two needs nobody has named yet (specific to this house)
- Bulk skip over a range ("no orchestra spring break Mar 9–13")
- Practice streaks — "Bryce practice 20 min daily" with a visible streak
- Headcount → servings ("Addie's at church, 3 for dinner")
- Season paste — orchestra/concert schedules as a block → multi-row confirm
- Second device for Erich (iPad/desktop) — banner logic assumes one phone
- Guest read-only — grandparents/sitter via the existing .ics token feed
- "Which HEB" — per-item store defaults so nobody keeps saying "1488"
- Quiet hours — no 6pm nag SMS to Jess during dinner service; defer to digest
