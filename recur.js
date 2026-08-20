/* ============================================================================
 * Family Hub — recurrence expansion
 *
 * Turns one stored series into concrete dated occurrences across a window, then
 * applies the household's exceptions. Shared by the calendar views and by the
 * reminder materializer, so a date that is skipped on screen is also skipped by
 * the notification engine — one source of truth, no drift.
 *
 * Dates are handled as local Y-M-D strings, never Date arithmetic across DST.
 * "Tuesdays at 5:30" must stay 5:30 in November as well as June.
 * ==========================================================================*/

const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
export const parseYmd = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate()+n); return ymd(d); };
const dowOf = s => parseYmd(s).getDay();

/** Local clock time of a series, e.g. "17:30". Null for all-day. */
export function seriesTime(ev){
  if (ev.all_day || !ev.starts_at) return null;
  const d = new Date(ev.starts_at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The date a series begins, whether it's timed or all-day. */
export function seriesStart(ev){
  return ev.all_day ? ev.event_date : ymd(new Date(ev.starts_at));
}

/**
 * Every date this series lands on between `from` and `to` inclusive.
 * Exceptions are NOT applied here — see expand().
 */
export function occurrenceDates(ev, from, to){
  const out = [];
  const start = seriesStart(ev);
  if (!start) return out;

  const hardStop = ev.repeat_until && ev.repeat_until < to ? ev.repeat_until : to;
  if (start > hardStop) return out;

  if (!ev.repeat_freq) return (start >= from && start <= hardStop) ? [start] : [];

  const every = Math.max(1, ev.repeat_interval || 1);

  if (ev.repeat_freq === 'daily') {
    // step from the series start so interval phase stays anchored
    let cur = start;
    if (cur < from) {
      const gap = Math.round((parseYmd(from) - parseYmd(start)) / 86400000);
      cur = addDays(start, Math.ceil(gap / every) * every);
    }
    for (; cur <= hardStop; cur = addDays(cur, every)) if (cur >= from) out.push(cur);
    return out;
  }

  if (ev.repeat_freq === 'weekly') {
    // Empty repeat_days means "same weekday as the start date"
    const days = (ev.repeat_days && ev.repeat_days.length) ? [...ev.repeat_days] : [dowOf(start)];
    // walk week blocks from the start's week so interval phase is stable
    const startWeek = addDays(start, -dowOf(start));      // Sunday of the start week
    let week = startWeek;
    if (week < from) {
      const weeksGap = Math.floor((parseYmd(from) - parseYmd(startWeek)) / (7*86400000));
      week = addDays(startWeek, Math.floor(weeksGap / every) * every * 7);
    }
    for (; week <= hardStop; week = addDays(week, every * 7)) {
      for (const dw of days.slice().sort((a,b)=>a-b)) {
        const d = addDays(week, dw);
        if (d >= from && d <= hardStop && d >= start) out.push(d);
      }
    }
    return out.sort();
  }

  if (ev.repeat_freq === 'monthly') {
    // same day-of-month each time. A 31st in a 30-day month is skipped, not
    // rolled into the 1st — silently moving a family event is worse than missing it.
    const dom = parseYmd(start).getDate();
    let y = parseYmd(from).getFullYear(), m = parseYmd(from).getMonth();
    const sY = parseYmd(start).getFullYear(), sM = parseYmd(start).getMonth();
    let idx = (y - sY) * 12 + (m - sM);
    idx = Math.max(0, Math.ceil(idx / every) * every);
    for (;;) {
      const d = new Date(sY, sM + idx, dom);
      const s = ymd(d);
      if (s > hardStop) break;
      if (d.getDate() === dom && s >= from && s >= start) out.push(s);
      idx += every;
      if (idx > 2400) break;                       // 200 years; runaway guard
    }
    return out;
  }
  return out;
}

/**
 * Concrete occurrences with exceptions applied.
 * @param events      series + one-offs
 * @param exceptions  rows from event_exceptions
 * @returns array of event-shaped objects, each with occurrence_date and is_occurrence
 */
export function expand(events, exceptions, from, to){
  const byEvent = new Map();
  for (const x of exceptions || []) {
    if (!byEvent.has(x.event_id)) byEvent.set(x.event_id, new Map());
    byEvent.get(x.event_id).set(x.occurrence_date, x);
  }

  const out = [];
  for (const ev of events || []) {
    if (ev.deleted_at) continue;
    const ex = byEvent.get(ev.id);
    const time = seriesTime(ev);

    for (const date of occurrenceDates(ev, from, to)) {
      const x = ex && ex.get(date);
      if (x && x.action === 'skip') continue;               // school break, holiday

      const o = {
        ...ev,
        occurrence_date: date,
        is_occurrence: !!ev.repeat_freq,
        is_override: !!(x && x.action === 'override'),
        event_date: date,
        starts_at: ev.all_day ? null : new Date(`${date}T${time}:00`).toISOString()
      };
      if (x && x.action === 'override') {
        if (x.title)     o.title = x.title;
        if (x.notes)     o.notes = x.notes;
        if (x.member_id !== undefined && x.member_id !== null) o.member_id = x.member_id;
        if (x.starts_at) { o.starts_at = x.starts_at; o.all_day = false;
                           o.event_date = ymd(new Date(x.starts_at)); }
        if (x.ends_at)   o.ends_at = x.ends_at;
      }
      out.push(o);
    }
  }
  return out.sort((a,b) =>
    (a.event_date + (a.all_day?'0':'1') + (a.starts_at||''))
    .localeCompare(b.event_date + (b.all_day?'0':'1') + (b.starts_at||'')));
}

/** Human summary for the UI, e.g. "Every Tuesday until May 22". */
export function describeRepeat(ev){
  if (!ev.repeat_freq) return null;
  const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const n = ev.repeat_interval || 1;
  let s;
  if (ev.repeat_freq === 'daily')   s = n === 1 ? 'Every day' : `Every ${n} days`;
  else if (ev.repeat_freq === 'weekly') {
    const days = (ev.repeat_days && ev.repeat_days.length)
      ? ev.repeat_days.slice().sort((a,b)=>a-b).map(d => DOW[d]) : null;
    const list = days ? days.join(' & ') : DOW[dowOf(seriesStart(ev))];
    s = n === 1 ? `Every ${list}` : `Every ${n} weeks on ${list}`;
  }
  else s = n === 1 ? 'Every month' : `Every ${n} months`;
  if (ev.repeat_until) {
    const d = parseYmd(ev.repeat_until);
    s += ` until ${d.toLocaleDateString('en-US',{month:'short', day:'numeric'})}`;
  }
  return s;
}
