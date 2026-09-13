/* ============================================================================
 * Family Hub — a kid's chore streak, from the rows that already exist.
 *
 * 020 closes a recurring chore one of two ways: done (completed_at, by a
 * person) or missed (completed_at AND missed_at, by the date). That is the
 * whole scoring system — nothing here invents points. A week is CLEAN when
 * at least one chore closed in it and none was missed; the streak is how
 * many clean weeks run back from the latest one with anything in it. A week
 * with nothing due is neutral (nothing was missed), not a break.
 *
 * Pure, so it can be tested; the kid screen (app.js) phrases the result.
 * ==========================================================================*/
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
/* Sunday-anchored week key for a YYYY-MM-DD. */
export function weekOf(s) {
  const d = parseYmd(s); d.setDate(d.getDate() - d.getDay()); return ymd(d);
}

/**
 * rows  — closed todos of one person: { due_on, completed_at, missed_at, repeat_freq }
 * today — YYYY-MM-DD
 * → { weeks, run, lastMissed, total, chores }
 *   weeks      clean weeks in a row, ending at the latest week with data
 *   run        closed chores in a row without a miss (most recent first)
 *   lastMissed the most recent closed chore was a miss
 *   chores     how many recurring chores have ever closed
 */
export function choreStreak(rows, today) {
  const closed = (rows || []).filter(r => r.completed_at && r.repeat_freq)
    .map(r => ({ day: r.due_on || String(r.completed_at).slice(0, 10), missed: !!r.missed_at }))
    .sort((a, b) => b.day.localeCompare(a.day));
  if (!closed.length) return { weeks: 0, run: 0, lastMissed: false, total: 0, chores: 0 };

  let run = 0;
  for (const c of closed) { if (c.missed) break; run++; }

  const byWeek = new Map();
  for (const c of closed) {
    const w = weekOf(c.day);
    const cur = byWeek.get(w) || { n: 0, missed: 0 };
    cur.n++; if (c.missed) cur.missed++;
    byWeek.set(w, cur);
  }
  /* Walk back week by week from the latest week that has anything, at most
     a year, counting clean weeks; an empty week is skipped, a missed week
     ends it. */
  let weeks = 0;
  const latest = [...byWeek.keys()].sort().pop();
  const d = parseYmd(latest);
  for (let i = 0; i < 53; i++) {
    const w = ymd(d); const cur = byWeek.get(w);
    if (cur) { if (cur.missed) break; weeks++; }
    d.setDate(d.getDate() - 7);
    if (ymd(d) < [...byWeek.keys()].sort()[0]) break;
  }
  return { weeks, run, lastMissed: closed[0].missed, total: closed.length, chores: closed.length };
}

/* The line the kid reads. Weeks beat counts; a miss is said once, kindly. */
export function streakLine(s) {
  if (!s.chores) return 'No chores done yet — the first tick starts your streak.';
  if (s.weeks >= 2) return `${s.weeks} weeks in a row, nothing missed.`;
  if (s.weeks === 1 && !s.lastMissed) return 'This week is clean so far — keep it going.';
  return 'Missed one — a clean week starts a new streak.';
}
