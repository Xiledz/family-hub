/* ============================================================================
 * Family Hub — natural-language quick-add parser
 *
 * "Soccer practice Thursday 5:30 Noah remind 1 hr before"
 *   -> { title:'Soccer practice', date:'2026-08-20', start:'17:30',
 *        member:'Noah', leadMinutes:60 }
 *
 * Deterministic. No network, no API key, no cost. If it cannot parse something
 * it leaves it in the title and flags a warning — it never silently guesses.
 * Everything it produces is shown to the user for one-tap confirmation before
 * it is written, so a wrong parse costs a tap, not a bad calendar entry.
 * ==========================================================================*/

const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const WD_ABBR  = ['sun','mon','tue','tues','wed','weds','thu','thur','thurs','fri','sat'];
const WD_INDEX = {sun:0,sunday:0,mon:1,monday:1,tue:2,tues:2,tuesday:2,wed:3,weds:3,wednesday:3,
                  thu:4,thur:4,thurs:4,thursday:4,fri:5,friday:5,sat:6,saturday:6};
const MONTHS = {jan:0,january:0,feb:1,february:1,mar:2,march:2,apr:3,april:3,may:4,jun:5,june:5,
                jul:6,july:6,aug:7,august:7,sep:8,sept:8,september:8,oct:9,october:9,
                nov:10,november:10,dec:11,december:11};

const pad = n => String(n).padStart(2,'0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const addDays = (d,n) => { const x=new Date(d); x.setDate(x.getDate()+n); return x; };

/**
 * @param {string} input     what the user typed or dictated
 * @param {object} opts
 * @param {string[]} opts.members   member names, for person detection
 * @param {Date}   opts.now         reference time (injectable for tests)
 * @param {number} opts.defaultLead the member's default reminder lead, minutes
 */
export function parseQuickAdd(input, opts = {}) {
  const members = opts.members || [];
  const now = opts.now || new Date();
  const raw = String(input || '').trim();

  const out = {
    title: '', date: null, start: null, end: null, allDay: false,
    member: null, leadMinutes: opts.defaultLead ?? 30,
    recurrence: null, warnings: [], matched: []
  };
  if (!raw) { out.warnings.push('Nothing to add'); return out; }

  const spans = [];                                   // [start,end) consumed
  const take = (m, label) => {
    if (!m) return false;
    spans.push([m.index, m.index + m[0].length]);
    out.matched.push(label);
    return true;
  };
  const find = re => { re.lastIndex = 0; return re.exec(raw); };

  // ---- 1. reminder lead time -------------------------------------------
  // Must run first: "1 hour before" contains a time-like phrase that the time
  // matcher would otherwise steal.
  let m = find(/\b(?:remind|reminder|alert|warn|ping)(?:\s+me)?\s+(\d+)\s*(min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\s*(?:before|ahead|prior)?\b/i);
  if (m) {
    const n = parseInt(m[1], 10), u = m[2].toLowerCase();
    out.leadMinutes = u.startsWith('d') ? n*1440 : u.startsWith('h') ? n*60 : n;
    take(m, 'lead');
  } else if ((m = find(/\b(\d+)\s*(min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\s+(?:before|ahead|prior|warning|heads[- ]?up)\b/i))) {
    const n = parseInt(m[1], 10), u = m[2].toLowerCase();
    out.leadMinutes = u.startsWith('d') ? n*1440 : u.startsWith('h') ? n*60 : n;
    take(m, 'lead');
  } else if ((m = find(/\b(?:no\s+(?:reminder|alert)|don'?t\s+remind)\b/i))) {
    out.leadMinutes = null; take(m, 'lead');
  }

  // ---- 2. recurrence (flagged, not yet built) ---------------------------
  if ((m = find(/\b(every|each)\s+(day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekday|weekend)\b/i))) {
    out.recurrence = m[0].toLowerCase();
    out.warnings.push(`Repeating events aren't supported yet — this will be added once, on the first date.`);
    take(m, 'recurrence');
  }

  // ---- 3. explicit dates ------------------------------------------------
  // 8/21, 8-21-26, 08/21/2026
  if ((m = find(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/))) {
    const mo = +m[1]-1, da = +m[2];
    let yr = m[3] ? +m[3] : now.getFullYear();
    if (yr < 100) yr += 2000;
    const d = new Date(yr, mo, da);
    if (d.getMonth() === mo && d.getDate() === da) {
      if (!m[3] && d < startOfDay(now)) d.setFullYear(yr+1);   // past date -> next year
      out.date = ymd(d); take(m, 'date');
    }
  }
  // "Aug 21", "August 21st", "21 Aug"
  if (!out.date) {
    const mn = Object.keys(MONTHS).sort((a,b)=>b.length-a.length).join('|');
    if ((m = find(new RegExp(`\\b(${mn})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`,'i'))) ||
        (m = find(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${mn})\\b`,'i')))) {
      const a = m[1].toLowerCase(), b = m[2].toLowerCase();
      const mo = MONTHS[a] !== undefined ? MONTHS[a] : MONTHS[b];
      const da = MONTHS[a] !== undefined ? +m[2] : +m[1];
      const d = new Date(now.getFullYear(), mo, da);
      if (d < startOfDay(now)) d.setFullYear(d.getFullYear()+1);
      out.date = ymd(d); take(m, 'date');
    }
  }

  // ---- 4. relative days -------------------------------------------------
  if (!out.date) {
    if ((m = find(/\btoday\b/i)))                    { out.date = ymd(now); take(m,'date'); }
    else if ((m = find(/\btonight\b/i)))             { out.date = ymd(now); out.start = out.start||'19:00'; take(m,'date'); }
    else if ((m = find(/\btomorrow\b|\btmrw\b/i)))   { out.date = ymd(addDays(now,1)); take(m,'date'); }
    else if ((m = find(/\bday\s+after\s+tomorrow\b/i))) { out.date = ymd(addDays(now,2)); take(m,'date'); }
    else if ((m = find(/\bin\s+(\d+)\s+(day|days|week|weeks)\b/i))) {
      out.date = ymd(addDays(now, +m[1] * (/w/i.test(m[2]) ? 7 : 1))); take(m,'date');
    }
  }

  // ---- 5. weekday names -------------------------------------------------
  if (!out.date) {
    const names = [...WEEKDAYS, ...WD_ABBR].sort((a,b)=>b.length-a.length).join('|');
    if ((m = find(new RegExp(`\\b(next|this)?\\s*(${names})\\b`,'i')))) {
      const target = WD_INDEX[m[2].toLowerCase()];
      const base = startOfDay(now);
      let delta = (target - base.getDay() + 7) % 7;
      if (delta === 0) delta = 7;                          // "Thursday" on a Thursday = next one
      if (/next/i.test(m[1] || '') && delta < 7) delta += 7;
      out.date = ymd(addDays(base, delta)); take(m,'date');
    }
  }

  // ---- 6. time ranges: "9-10:30", "2pm to 4pm" --------------------------
  if ((m = find(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i))) {
    const ap1 = m[3], ap2 = m[6];
    let h1 = +m[1], h2 = +m[4];
    const mi1 = m[2] ? +m[2] : 0, mi2 = m[5] ? +m[5] : 0;
    let a, b;
    if (!ap1 && !ap2) {
      // bare "3:30-4:30" — waking-hours heuristic, same rule as single times
      if (h1 >= 1 && h1 <= 6) h1 += 12;
      if (h2 >= 1 && h2 <= 6) h2 += 12;
      a = hm(h1, mi1); b = hm(h2, mi2);
    } else {
      a = hm(h1, mi1, ap1 || ap2); b = hm(h2, mi2, ap2 || ap1);
    }
    if (a && b) { out.start = a; out.end = b; take(m,'time'); }
  }

  // ---- 7. single time ---------------------------------------------------
  if (!out.start) {
    if ((m = find(/\bnoon\b/i)))          { out.start = '12:00'; take(m,'time'); }
    else if ((m = find(/\bmidnight\b/i))) { out.start = '00:00'; take(m,'time'); }
    else if ((m = find(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i))) {
      out.start = hm(+m[1], m[2]?+m[2]:0, m[3]); take(m,'time');
    }
    else if ((m = find(/\b(?:at\s+)?(\d{1,2}):(\d{2})\b/))) {
      // bare "5:30" — assume waking hours, so 1:00-6:59 means PM
      let h = +m[1]; const mi = +m[2];
      if (h >= 1 && h <= 6) h += 12;
      out.start = `${pad(h)}:${pad(mi)}`; take(m,'time');
    }
  }

  // ---- 8. duration: "for 90 minutes", "for 2 hours" ---------------------
  if (out.start && !out.end && (m = find(/\bfor\s+(\d+(?:\.\d+)?)\s*(min|mins|minute|minutes|hr|hrs|hour|hours)\b/i))) {
    const n = parseFloat(m[1]);
    const mins = /^h/i.test(m[2]) ? Math.round(n*60) : Math.round(n);
    out.end = shift(out.start, mins); take(m,'duration');
  }

  // ---- 9. all-day -------------------------------------------------------
  if ((m = find(/\ball[- ]day\b/i))) { out.allDay = true; out.start = null; out.end = null; take(m,'allday'); }
  if (!out.start && !out.allDay) out.allDay = true;

  // ---- 10. person -------------------------------------------------------
  if ((m = find(/\b(?:everyone|everybody|all of us|family|whole family)\b/i))) {
    out.member = null; out.matched.push('member'); take(m,'member');
  } else {
    // longest name first so "Mary Beth" beats "Mary"
    for (const name of [...members].sort((a,b)=>b.length-a.length)) {
      const re = new RegExp(`(?:^|[\\s,])(?:for\\s+)?(${escapeRe(name)})('s|s')?(?=$|[\\s,.!?])`, 'i');
      const mm = re.exec(raw);
      if (mm) {
        out.member = name;
        const at = mm.index + mm[0].indexOf(mm[1]);
        spans.push([at, at + mm[1].length + (mm[2] ? mm[2].length : 0)]);
        out.matched.push('member');
        break;
      }
    }
  }

  // ---- 11. whatever is left is the title --------------------------------
  out.title = strip(raw, spans);
  if (!out.title) { out.title = 'Untitled'; out.warnings.push('No title found — add one before saving.'); }
  if (!out.date)  { out.date = ymd(now); out.warnings.push('No date found — defaulting to today.'); }

  // A timed event whose start already passed today is almost always meant
  // for tomorrow. Flag it rather than silently moving it.
  if (out.start && out.date === ymd(now) && !out.matched.includes('date')) {
    const [h,mi] = out.start.split(':').map(Number);
    if (h*60+mi < now.getHours()*60+now.getMinutes()) {
      out.warnings.push('That time already passed today — did you mean tomorrow?');
    }
  }
  return out;
}

/* ---------------------------------- utils ---------------------------------*/
function startOfDay(d){ const x=new Date(d); x.setHours(0,0,0,0); return x; }
function escapeRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
function hm(h, mi, ap){
  if (h > 23 || mi > 59) return null;
  if (ap) { const p = /^p/i.test(ap.replace(/\./g,'')); if (h === 12) h = p ? 12 : 0; else if (p) h += 12; }
  return `${pad(h)}:${pad(mi)}`;
}
function shift(t, mins){
  const [h,mi] = t.split(':').map(Number);
  const tot = (h*60+mi+mins) % 1440;
  return `${pad(Math.floor(tot/60))}:${pad(tot%60)}`;
}
function strip(raw, spans){
  if (!spans.length) return raw.trim();
  spans.sort((a,b)=>a[0]-b[0]);
  let outp = '', cur = 0;
  for (const [s,e] of spans){ if (s > cur) outp += raw.slice(cur, s); cur = Math.max(cur, e); }
  outp += raw.slice(cur);
  return outp
    .replace(/\s+/g,' ')
    .replace(/\s*[,;]\s*/g,' ')
    .replace(/^\s*(?:on|at|for|with|to|the)\b\s*/i,'')
    .replace(/\s*\b(?:on|at|for|with|to)\s*$/i,'')
    .trim();
}

/** Human-readable summary for the confirm chip. */
export function describe(p, tz='America/Chicago'){
  const d = new Date(p.date + 'T12:00:00');
  const day = d.toLocaleDateString('en-US',{weekday:'long', month:'short', day:'numeric'});
  const time = p.allDay ? 'All day'
    : t12(p.start) + (p.end ? `–${t12(p.end)}` : '');
  const lead = p.leadMinutes == null ? 'no reminder'
    : p.leadMinutes === 0 ? 'alert at start'
    : p.leadMinutes % 1440 === 0 ? `alert ${p.leadMinutes/1440}d before`
    : p.leadMinutes % 60 === 0 ? `alert ${p.leadMinutes/60}h before`
    : `alert ${p.leadMinutes}m before`;
  return { day, time, who: p.member || 'Everyone', lead };
}
function t12(t){
  const [h,mi] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return mi ? `${hh}:${pad(mi)} ${ap}` : `${hh} ${ap}`;
}
