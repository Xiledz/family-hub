/* ============================================================================
 * sms-inbound — text the family number to add an event.
 *
 * Webhook: https://rauvytdltnbqrvyiornh.supabase.co/functions/v1/sms-inbound
 * Verify JWT MUST be OFF — Twilio cannot send an Authorization header.
 * Because it is off, the Twilio signature is the ONLY thing standing between
 * this function and anyone who learns the URL. Do not remove that check.
 *
 * The sender's number is matched against members.phone, so the event is
 * attributed to whoever texted. Same parser as the web quick-add bar — one
 * grammar, two front doors.
 * ==========================================================================*/
import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';


/* ===========================================================================
 * PARSER — inlined, not imported.
 *
 * Supabase's bundler refuses remote hosts, and its in-browser editor drops
 * second files on deploy. So the parser lives here as a verbatim copy of
 * parse.js from the repo.
 *
 * THIS IS A DUPLICATE. If parse.js changes, replace this block with the new
 * version and redeploy, or the web quick-add bar and the SMS front door will
 * quietly start speaking different grammars — both working, just differently,
 * which is the hardest kind of bug to notice.
 * ========================================================================= */
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

/* ---------------------------------------------------------------------------
 * ROLE VOCABULARY
 *
 * The database enforces exactly these six values. Everything a person might
 * type has to land on one of them or be dropped — never invented. Longest
 * phrases are matched first, so "is dropping off" beats "dropping".
 * -------------------------------------------------------------------------*/
const ROLE_WORDS = [
  /* Order matters — first match wins. The two-leg phrasings run before the
     catch-all "driving", because "Jess takes her there" is one leg, not both.
     A parent who only drops off should not be told to plan the trip home. */
  [/\b(?:both\s+ways|round\s*trip|there\s+and\s+back)\b/i, 'driving'],
  [/\b(?:is\s+)?(?:taking|takes|driving|drives|dropping|drops|bringing|brings)?\s*(?:him|her|them|us|me)?\s*(?:there|over)\b/i, 'dropoff'],
  [/\b(?:is\s+)?(?:bringing|brings|getting|gets|picking|picks)?\s*(?:him|her|them|us|me)?\s*back\b|\breturn\s+trip\b/i, 'pickup'],
  [/\b(?:is\s+)?(?:dropping|drops|drop)(?:\s+(?:him|her|them|us|me))?\s*off\b|\bdrop[- ]?off\b/i, 'dropoff'],
  [/\b(?:is\s+)?(?:picking|picks|pick)(?:\s+(?:him|her|them|us|me))?\s*up\b|\bpick[- ]?up\b|\b(?:is\s+)?(?:collecting|collects|grabbing|grabs)(?:\s+(?:him|her|them|us|me))?\b/i, 'pickup'],
  [/\b(?:is\s+)?(?:driving|drives|driver|taking|takes|has|got)(?:\s+(?:him|her|them|us|me))?\b/i, 'driving'],
  [/\b(?:is\s+)?(?:helping|helps|volunteering|volunteers|chaperoning|chaperones)\b/i, 'helping'],
  [/\b(?:is\s+)?(?:maybe|might|optional|if\s+free)\b/i, 'optional'],
  [/\b(?:is\s+)?(?:going|attending|attends|coming|comes)\b/i, 'going'],
];
const ROLE_VALUES = ['going','driving','dropoff','pickup','helping','optional'];

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
function parseQuickAdd(input, opts = {}) {

  /* Set by "tonight": a suggested hour, applied only if no clock is found. */
  let tonightDefault = false;
  /* Members arrive either as plain names or as {name, aliases}. Aliases exist
     because a nine-year-old texts "mom is driving", not "Jess is driving", and
     a name the parser cannot resolve is a role silently dropped on the floor.
     Every alias resolves to the one canonical name the database stores. */
  const roster  = (opts.members || []).map(x => typeof x === 'string' ? { name: x, aliases: [] } : x);
  const members = roster.map(x => x.name);
  const terms   = [];
  for (const mem of roster) {
    terms.push({ text: mem.name, name: mem.name });
    for (const a of (mem.aliases || [])) if (a) terms.push({ text: a, name: mem.name });
  }
  // Longest first, so "Mary Beth" is never shadowed by "Mary" and "grandma"
  // is never shadowed by "gran".
  terms.sort((a, b) => b.text.length - a.text.length);
  const now = opts.now || new Date();
  const raw = String(input || '').trim();

  const out = {
    title: '', date: null, start: null, end: null, allDay: false,
    member: null, leadMinutes: opts.defaultLead ?? 30,
    repeat: null, people: [], alsoToday: null, ambiguousTime: null,
    needsCast: false, needsRides: false, needsEnd: false,
    warnings: [], matched: []
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
  /* Like find(), but skips any match that overlaps text already claimed by an
     earlier rule. Without this, "every Tuesday 4pm until 12/31" lets the time
     RANGE matcher read "4pm until 12" as 4:00pm-12:00pm, because it searches
     the raw string and cannot see that "until 12/31" is already spoken for. */
  const overlaps = (s, e) => spans.some(([a, b]) => s < b && e > a);
  const findFree = re => {
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = rx.exec(raw))) {
      if (!overlaps(m.index, m.index + m[0].length)) return m;
      if (m.index === rx.lastIndex) rx.lastIndex++;
    }
    return null;
  };

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

  // ---- 2. recurrence ----------------------------------------------------
  // Runs before date parsing so "every Tuesday" is claimed as a RULE, not
  // misread as the single date "Tuesday". Order inside matters too: the more
  // specific phrases must be tried first, or "every other Tuesday" matches the
  // plain "every <weekday>" rule and silently loses its interval.
  {
    const WD = '(sun|sunday|mon|monday|tue|tues|tuesday|wed|weds|wednesday|' +
               'thu|thur|thurs|thursday|fri|friday|sat|saturday)';
    const set = (freq, interval, days) => ({ freq, interval, days, until: null });
    let r;

    if ((r = find(new RegExp(`\\bevery\\s+other\\s+${WD}\\b`, 'i')))) {
      out.repeat = set('weekly', 2, [WD_INDEX[r[1].toLowerCase()]]); take(r, 'repeat');
    } else if ((r = find(/\bevery\s+other\s+week\b|\bbi-?weekly\b/i))) {
      out.repeat = set('weekly', 2, []); take(r, 'repeat');
    } else if ((r = find(/\bevery\s+other\s+day\b/i))) {
      out.repeat = set('daily', 2, []); take(r, 'repeat');
    } else if ((r = find(/\bevery\s+(\d+)\s+(days?|weeks?|months?)\b/i))) {
      const n = Math.max(1, parseInt(r[1], 10)), u = r[2].toLowerCase();
      out.repeat = set(u.startsWith('d') ? 'daily' : u.startsWith('w') ? 'weekly' : 'monthly', n, []);
      take(r, 'repeat');
    } else if ((r = find(/\bevery\s+weekday\b|\bweekdays\b/i))) {
      out.repeat = set('weekly', 1, [1,2,3,4,5]); take(r, 'repeat');
    } else if ((r = find(/\bevery\s+weekend\b/i))) {
      out.repeat = set('weekly', 1, [0,6]); take(r, 'repeat');
    } else if ((r = find(new RegExp(`\\bevery\\s+${WD}(?:\\s*(?:,|and|&|\\/)\\s*${WD})*\\b`, 'i')))) {
      const days = [...new Set((r[0].match(new RegExp(WD, 'gi')) || [])
        .map(w => WD_INDEX[w.toLowerCase()]))].sort((a,b) => a-b);
      out.repeat = set('weekly', 1, days); take(r, 'repeat');
    } else if ((r = find(/\bevery\s+day\b|\bdaily\b/i))) {
      out.repeat = set('daily', 1, []); take(r, 'repeat');
    } else if ((r = find(/\bevery\s+week\b|\bweekly\b/i))) {
      out.repeat = set('weekly', 1, []); take(r, 'repeat');
    } else if ((r = find(/\bevery\s+month\b|\bmonthly\b/i))) {
      out.repeat = set('monthly', 1, []); take(r, 'repeat');
    }

    // "...until May 30", "...through 12/31". Only meaningful on a series.
    if (out.repeat) {
      const mn = Object.keys(MONTHS).sort((a,b) => b.length-a.length).join('|');
      const ENDS = '(?:until|through|thru|til|till|ending|ends)';
      let u;
      if ((u = find(new RegExp(`\\b${ENDS}\\s+(${mn})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`, 'i')))) {
        const mo = MONTHS[u[1].toLowerCase()], da = +u[2];
        const yr = u[3] ? +u[3] : now.getFullYear();
        const d = new Date(yr, mo, da);
        if (!u[3] && d < startOfDay(now)) d.setFullYear(yr + 1);
        out.repeat.until = ymd(d); take(u, 'until');
      } else if ((u = find(new RegExp(`\\b${ENDS}\\s+(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{2,4}))?\\b`, 'i')))) {
        const mo = +u[1]-1, da = +u[2];
        let yr = u[3] ? +u[3] : now.getFullYear();
        if (yr < 100) yr += 2000;
        const d = new Date(yr, mo, da);
        if (!u[3] && d < startOfDay(now)) d.setFullYear(yr + 1);
        out.repeat.until = ymd(d); take(u, 'until');
      }
    }
  }

  // ---- 3. explicit dates ------------------------------------------------
  // 8/21, 8-21-26, 08/21/2026
  if ((m = findFree(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/))) {
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
    if ((m = findFree(new RegExp(`\\b(${mn})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`,'i'))) ||
        (m = findFree(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${mn})\\b`,'i')))) {
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
    if ((m = findFree(/\btoday\b/i)))                    { out.date = ymd(now); take(m,'date'); }
    /* "tonight" fixes the DAY here and only suggests an hour. Setting the
       clock at this point ran before the time section, so "book club tonight
       at 8" kept 7pm and quietly ignored the 8 — an hour early, every time.
       The default is applied after the clock has had its chance. */
    else if ((m = findFree(/\btonight\b/i)))             { out.date = ymd(now); tonightDefault = true; take(m,'date'); }
    else if ((m = findFree(/\btomorrow\b|\btmrw\b/i)))   { out.date = ymd(addDays(now,1)); take(m,'date'); }
    else if ((m = findFree(/\bday\s+after\s+tomorrow\b/i))) { out.date = ymd(addDays(now,2)); take(m,'date'); }
    else if ((m = findFree(/\bin\s+(\d+)\s+(day|days|week|weeks)\b/i))) {
      out.date = ymd(addDays(now, +m[1] * (/w/i.test(m[2]) ? 7 : 1))); take(m,'date');
    }
  }

  // ---- 5. weekday names -------------------------------------------------
  if (!out.date) {
    const names = [...WEEKDAYS, ...WD_ABBR].sort((a,b)=>b.length-a.length).join('|');
    if ((m = findFree(new RegExp(`\\b(next|this)?\\s*(${names})\\b`,'i')))) {
      const target = WD_INDEX[m[2].toLowerCase()];
      const base = startOfDay(now);
      let delta = (target - base.getDay() + 7) % 7;
      const namedToday = delta === 0;
      if (delta === 0) delta = 7;                          // "Thursday" on a Thursday = next one
      if (/next/i.test(m[1] || '') && delta < 7) delta += 7;
      out.date = ymd(addDays(base, delta)); take(m,'date');
      /* Naming today's own weekday is genuinely ambiguous: "Soccer Monday 6pm"
         sent on a Monday afternoon could mean tonight or next week. Rolling
         forward is a guess that is wrong about half the time, and wrong
         silently. Record the alternative so the caller can ask. "next Monday"
         is explicit and never ambiguous. */
      if (namedToday && !/next/i.test(m[1] || '')) out.alsoToday = ymd(base);
    }
  }

  // ---- 5b. first date of a weekday series -------------------------------
  // "every Tuesday" names no start date. The series has to begin somewhere,
  // and the only sane answer is the next Tuesday that has not happened yet.
  if (out.repeat && !out.matched.includes('date') && out.repeat.days.length) {
    const base = startOfDay(now);
    let best = null;
    for (const dw of out.repeat.days) {
      let delta = (dw - base.getDay() + 7) % 7;
      if (delta === 0) delta = 7;                 // today already started
      const cand = addDays(base, delta);
      if (!best || cand < best) best = cand;
    }
    out.date = ymd(best);
    out.matched.push('date');
  }

  // ---- 6. time ranges: "9-10:30", "2pm to 4pm" --------------------------
  if ((m = findFree(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i))) {
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
  /* Time is where a quiet error does the most damage. A date that is wrong
     looks wrong; a time that is twelve hours off looks perfectly reasonable
     in the confirmation, right up until somebody misses the thing.

     So this section guesses less than it used to, and says so when it cannot.
       - "noon" and "midnight" are words, and words are not ambiguous.
       - A bare 12 IS ambiguous, and famously so: plenty of people read 12:00
         as midnight and plenty read it as noon. It is never guessed.
       - A bare 7 through 11 could be either end of the day. Not guessed.
       - A bare 1 through 6 keeps the waking-hours default. "Soccer at 5"
         meaning five in the morning is not a thing.
     Anything left unresolved is handed up as out.ambiguousTime so the caller
     can ask. A guess is still stored as out.start so the event is never
     empty, but the flag says plainly that it was a guess. */
  const AM_CUE = /\b(?:morning|breakfast|sunrise|before\s+school|before\s+work)\b/i;
  const PM_CUE = /\b(?:evening|tonight|afternoon|dinner|supper|night|after\s+school|after\s+work)\b/i;
  /* Deliberately NOT cues: bare "am" and "pm". "I am driving Addie at 7"
     contains "am" and means nothing of the sort. Where am/pm genuinely
     qualifies a number, the explicit branch below has already caught it. */
  const cueAm = AM_CUE.test(raw), cuePm = PM_CUE.test(raw);
  /* Was a cue actually USED to settle an ambiguous hour? "Take out trash
     Tuesday morning at 7" consults it — 7 could be either — so the word did
     a job and is not part of the name. "Date night Friday 7pm" never
     consults it, because 7pm says so itself, and there "night" IS the name.
     Consuming the cue on that basis is the only rule that gets both. */
  let cueUsed = false;

  const setBare = (h, mi) => {
    if (h === 12) {
      if (cueAm) { out.start = `00:${pad(mi)}`; cueUsed = true; return; }
      if (cuePm) { out.start = `12:${pad(mi)}`; cueUsed = true; return; }
      out.start = `12:${pad(mi)}`;
      out.ambiguousTime = { kind: 'noon', am: `00:${pad(mi)}`, pm: `12:${pad(mi)}` };
      return;
    }
    if (h >= 1 && h <= 6) {
      if (cueAm) cueUsed = true;
      out.start = cueAm ? `${pad(h)}:${pad(mi)}` : `${pad(h + 12)}:${pad(mi)}`;
      return;
    }
    if (h >= 7 && h <= 11) {
      if (cueAm) { out.start = `${pad(h)}:${pad(mi)}`; cueUsed = true; return; }
      if (cuePm) { out.start = `${pad(h + 12)}:${pad(mi)}`; cueUsed = true; return; }
      /* Both readings are real, so this is only a placeholder until the
         question comes back answered. It leans the way the hour usually
         falls: 7 and 8 are evening activities, 9 through 11 are morning
         appointments. */
      out.start = h <= 8 ? `${pad(h + 12)}:${pad(mi)}` : `${pad(h)}:${pad(mi)}`;
      out.ambiguousTime = { kind: 'ampm', am: `${pad(h)}:${pad(mi)}`, pm: `${pad(h + 12)}:${pad(mi)}` };
      return;
    }
    out.start = `${pad(h)}:${pad(mi)}`;               // 0, or 13-23: 24h clock
  };

  if (!out.start) {
    if ((m = findFree(/\b(?:12\s*)?noon\b/i)))          { out.start = '12:00'; take(m,'time'); }
    else if ((m = findFree(/\b(?:12\s*)?midnight\b/i))) { out.start = '00:00'; take(m,'time'); }
    else if ((m = findFree(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i))) {
      out.start = hm(+m[1], m[2]?+m[2]:0, m[3]); take(m,'time');
    }
    else if ((m = findFree(/\bat\s+(\d{1,2})(?!\s*[:\d])\b/i))) {
      // "at 4" — the preposition is what makes this a time and not a quantity.
      setBare(+m[1], 0); take(m,'time');
    }
    else if ((m = findFree(/\b(?:at\s+)?(\d{1,2}):(\d{2})\b/))) {
      setBare(+m[1], +m[2]); take(m,'time');
    }
  }
  /* "tonight" with no clock still means the evening. With a clock, the clock
     wins — which is the whole point of deferring this. */
  if (tonightDefault && !out.start) out.start = '19:00';

  // An all-day event has no clock, so there is nothing to be ambiguous about.
  if (out.allDay || !out.start) out.ambiguousTime = null;

  // ---- 8. duration: "for 90 minutes", "for 2 hours" ---------------------
  if (out.start && !out.end && (m = find(/\bfor\s+(\d+(?:\.\d+)?)\s*(min|mins|minute|minutes|hr|hrs|hour|hours)\b/i))) {
    const n = parseFloat(m[1]);
    const mins = /^h/i.test(m[2]) ? Math.round(n*60) : Math.round(n);
    out.end = shift(out.start, mins); take(m,'duration');
  }

  // ---- 9. all-day -------------------------------------------------------
  if ((m = find(/\ball[- ]day\b/i))) { out.allDay = true; out.start = null; out.end = null; take(m,'allday'); }
  if (!out.start && !out.allDay) out.allDay = true;

  // ---- 10. people and their roles ---------------------------------------
  /* Turns "Soccer Thursday 5:30 Bryce, Jess driving, Erich picks up" into
     typed rows the database can enforce:
        Bryce -> going,  Jess -> driving,  Erich -> pickup
     Every name is resolved against the real member list, so nothing enters
     the system as free text, and every role lands on the closed vocabulary
     or is dropped. Roles are never invented from unrecognised words. */
  if ((m = findFree(/\b(?:everyone|everybody|all of us|the family|whole family)\b/i))) {
    /* "Everyone" is an explicit cast, not the absence of one. Expand it to the
       real member list so the event carries actual names. Otherwise nobody is
       attached, nobody gets a reminder, and the calendar shows an event that
       belongs to no one. */
    out.people = members.map(name => ({ name, role: 'going' }));
    out.member = null; out.matched.push('member'); take(m, 'member');
  } else {
    // 10a. Every mention of every known member, with its position. Longest
    //      names first so "Mary Beth" is not shadowed by "Mary".
    const mentions = [];
    for (const term of terms) {
      const name = term.name;
      const re = new RegExp(`(?:^|[\\s,;&])(${escapeRe(term.text)})('s|s')?(?=$|[\\s,;.&!?])`, 'gi');
      let mm;
      while ((mm = re.exec(raw))) {
        const at = mm.index + mm[0].indexOf(mm[1]);
        const end = at + mm[1].length + (mm[2] ? mm[2].length : 0);
        // skip if this position was already claimed by a longer name
        if (!mentions.some(x => at < x.end && end > x.at)) {
          mentions.push({ name, at, end });
        }
        re.lastIndex = mm.index + 1;
      }
    }

    // 10b. First person singular counts as a mention of the sender, so
    //      "I'm taking her" attributes the drive to whoever sent it.
    /* A name can be the SUBJECT of a transport verb or its OBJECT, and the
       difference is the whole meaning. In "I am taking Addie there", Erich
       drives and Addie rides. Treating Addie as just another name in the list
       splits the sentence at her: Erich keeps "taking" (both ways) and Addie
       inherits "there" (the driver going out). Both wrong, and wrong in the
       direction that leaves a child waiting. */
    const OBJ_OF = /\b(?:takes?|taking|drives?|driving|brings?|bringing|picks?|picking|drops?|dropping|gets?|getting|collects?|collecting|grabs?|grabbing|has|got)\s+$/i;
    const isObject = at => OBJ_OF.test(raw.slice(Math.max(0, at - 14), at));

    if (opts.me) {
      const meRe = /(?:^|[\s,;])(i'm|i am|im|myself|me|i)(?=$|[\s,;.!?])/gi;
      let mm;
      while ((mm = meRe.exec(raw))) {
        const at = mm.index + mm[0].indexOf(mm[1]);
        const end = at + mm[1].length;
        if (isObject(at)) continue;   // "takes me there" — cargo, not driver
        if (!mentions.some(x => at < x.end && end > x.at)) {
          mentions.push({ name: opts.me, at, end, self: true });
        }
      }
    }

    mentions.sort((a, b) => a.at - b.at);
    for (const mn of mentions) if (!mn.self && isObject(mn.at)) mn.obj = true;

    // 10c. A role belongs to the nearest name BEFORE it. The window runs from
    //      the end of one name to the start of the next, so in
    //      "Jess drops off Erich picks up" each verb stays with its own person.
    //      A passenger does not end the window — the verb belongs to whoever
    //      is carrying them, and it sits on the far side of their name.
    for (let k = 0; k < mentions.length; k++) {
      if (mentions[k].obj) continue;
      const from = mentions[k].end;
      let n = k + 1;
      while (n < mentions.length && mentions[n].obj) n++;
      const to = n < mentions.length ? mentions[n].at : raw.length;
      const window = raw.slice(from, to);
      for (const [re, role] of ROLE_WORDS) {
        const hit = re.exec(window);
        re.lastIndex = 0;
        if (hit) {
          mentions[k].role = role;
          spans.push([from + hit.index, from + hit.index + hit[0].length]);
          break;
        }
      }
    }

    /* The verb that carried a passenger belongs to the sentence, not the
       title. Without this, "I am taking Addie there" leaves "taking" behind
       and the event is called "Practice taking". */
    for (const mn of mentions) {
      if (!mn.obj) continue;
      const from = Math.max(0, mn.at - 14);
      const vm = raw.slice(from, mn.at).match(OBJ_OF);
      if (vm) spans.push([from + vm.index, from + vm.index + vm[0].length]);
    }

    // 10d. Anything with no verb attached is simply attending. This is the
    //      safe default: it never silently promotes someone to driver.
    for (const mn of mentions) {
      if (!mn.role) mn.role = 'going';
      spans.push([mn.at, mn.end]);
    }

    // 10e. Collapse duplicates, keeping the most specific role per person.
    const seen = new Map();
    for (const mn of mentions) {
      const key = mn.name + '|' + mn.role;
      if (!seen.has(key)) seen.set(key, { name: mn.name, role: mn.role });
    }
    out.people = [...seen.values()];

    // 10f. The primary person — whose event it is, and what colour it takes.
    //      Whoever is actually attending outranks whoever is driving them.
    const going = out.people.find(x => x.role === 'going');
    out.member = going ? going.name : (out.people[0] ? out.people[0].name : null);
    if (out.people.length) out.matched.push('member');
  }

  /* Two open questions, recorded rather than guessed at: who is actually
     coming, and how they get there and back. Neither one blocks saving — an
     event with no cast is still a real event — but both are worth asking
     about once, in a single follow-up, rather than never. */
  out.needsCast  = out.people.length === 0;
  /* A pickup alert measured from the START of an event is worse than no alert
     at all: it tells you to leave before the thing has even finished. Whoever
     collects needs to know when it ENDS, so an event with a pickup and no end
     time has a question outstanding. */
  out.needsEnd = !out.allDay && !!out.start && !out.end &&
                 out.people.some(x => x.role === 'pickup');
  const wholeFamily = members.length > 0 && out.people.length === members.length;
  const onlyMe      = out.people.length === 1 && out.people[0].name === opts.me;
  out.needsRides = out.people.length > 0 && !wholeFamily && !onlyMe &&
                   !out.people.some(x => x.role === 'driving' ||
                                         x.role === 'dropoff' || x.role === 'pickup');

  // ---- 11. whatever is left is the title --------------------------------
  out.title = strip(raw, spans)
    // "Mom and Dad going" leaves a naked "and" once both names are consumed.
    .replace(/^\s*(?:and|&|with|plus|,)\s*/i, '')
    .replace(/\s*(?:and|&|with|plus|,)\s*$/i, '')
    /* A cue word that did its job settling am-vs-pm is not part of what the
       thing is called: "Take out trash every Tuesday MORNING at 7" was
       titling itself "Take out trash morning".
       But a cue that OPENS the title is the name — "dinner with the Smiths",
       "morning walk" — so only a trailing one is dropped, and only when a
       clock was actually resolved. */
    .replace(cueUsed ? new RegExp(AM_CUE.source + '|' + PM_CUE.source, 'gi') : /(?!)/g,
             (mm, off) => (off === 0 ? mm : ' '))
    /* Trailing punctuation left behind once a span is cut out of the middle
       of a sentence: "…at 7." loses "at 7" and keeps the full stop. */
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/[\s.,;:!?-]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!out.title) { out.title = 'Untitled'; out.warnings.push('No title found — add one before saving.'); }
  if (!out.date)  { out.date = ymd(now); out.warnings.push('No date found — defaulting to today.'); }

  // If the time on today has already gone by, today is not a real option and
  // there is nothing to ask about.
  if (out.alsoToday && out.start) {
    const [ah, am] = out.start.split(':').map(Number);
    if (ah * 60 + am <= now.getHours() * 60 + now.getMinutes()) out.alsoToday = null;
  }

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
function describe(p, tz='America/Chicago'){
  const d = new Date(p.date + 'T12:00:00');
  const day = d.toLocaleDateString('en-US',{weekday:'long', month:'short', day:'numeric'});
  const time = p.allDay ? 'All day'
    : t12(p.start) + (p.end ? `–${t12(p.end)}` : '');
  const rep = !p.repeat ? null : (() => {
    const R = p.repeat, WD = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const every = R.interval === 1 ? '' : R.interval === 2 ? 'other ' : `${R.interval} `;
    let t;
    if (R.freq === 'daily')        t = `every ${every}day${R.interval > 2 ? 's' : ''}`;
    else if (R.freq === 'monthly') t = `every ${every}month${R.interval > 2 ? 's' : ''}`;
    else t = R.days.length
      ? `every ${every}${R.days.map(d => WD[d]).join(', ')}`
      : `every ${every}week${R.interval > 2 ? 's' : ''}`;
    return R.until ? `${t}, until ${new Date(R.until + 'T12:00:00')
      .toLocaleDateString('en-US',{month:'short', day:'numeric'})}` : t;
  })();
  const lead = p.leadMinutes == null ? 'no reminder'
    : p.leadMinutes === 0 ? 'alert at start'
    : p.leadMinutes % 1440 === 0 ? `alert ${p.leadMinutes/1440}d before`
    : p.leadMinutes % 60 === 0 ? `alert ${p.leadMinutes/60}h before`
    : `alert ${p.leadMinutes}m before`;
  return { day, time, who: p.member || 'Everyone', lead, repeat: rep };
}
function t12(t){
  const [h,mi] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return mi ? `${hh}:${pad(mi)} ${ap}` : `${hh} ${ap}`;
}

/* ===========================================================================
 * SHOPPING
 *
 * The same discipline as the event parser, for the same reason: category is a
 * closed vocabulary, and anything that cannot be classified lands on 'other'
 * rather than inventing a value. Aisle order, recipes and sale matching all
 * key off category, so free text here breaks three things at once — and it
 * breaks them a month from now, not today.
 *
 * The household's own catalog is consulted before the dictionary, so a
 * correction made once is remembered. Nobody should have to classify milk
 * twice.
 * ========================================================================= */

const SHOP_CATEGORIES = [
  'produce','bakery','deli','meat','seafood','dairy','eggs','frozen',
  'breakfast','canned','pantry','baking','condiments','snacks','beverages',
  'household','paper','cleaning','personal','baby','pet','pharmacy','other'
];

/* A starter dictionary, not an ontology. It only has to be right often enough
   that correcting it is rare; every correction is remembered in the catalog,
   so the list gets better at this household's actual shopping over time. */
const CATEGORY_WORDS = [
  /* Specific before general, because the general rules are keyed on words the
     specific ones contain. "mac and cheese" is a box in the pantry, not the
     dairy case, and it will match /cheese/ if given the chance. Brands go here
     too: people say the brand, not the product, and "doritos" carries no word
     that any category rule would recognise. */
  [/\b(?:mac(?:aroni)?\s+and\s+cheese|mac\s*&\s*cheese)\b/i, 'pantry'],
  [/\b(?:cheerios|frosted\s*flakes|lucky\s*charms|cinnamon\s*toast|rice\s*krispies|special\s*k|raisin\s*bran|life\s*cereal|chex)\b/i, 'breakfast'],
  [/\b(?:doritos|tostitos|fritos|cheez\s*-?its?|goldfish|oreos?|chips\s*ahoy|ritz|wheat\s*thins|triscuits?|pringles|takis|sun\s*chips)\b/i, 'snacks'],
  [/\b(?:blue\s*bell|ben\s*(?:and|&)\s*jerry|halo\s*top|talenti|drumsticks?|klondike)\b/i, 'frozen'],
  [/\b(?:chobani|yoplait|activia|tillamook|babybel|laughing\s*cow|daisy\b)\b/i, 'dairy'],
  [/\b(?:gatorade|powerade|red\s*bull|coca\s*cola|coke\b|sprite|mountain\s*dew|pepsi|la\s*croix|topo\s*chico|bubly|celsius)\b/i, 'beverages'],
  [/\b(?:tide|gain\b|downy|bounce\b|clorox|lysol|pine\s*sol|fabuloso|dawn\b|cascade|finish\b|febreze|swiffer|mr\.?\s*clean)\b/i, 'cleaning'],
  [/\b(?:charmin|bounty|viva\b|scott\b|angel\s*soft|cottonelle|kleenex|puffs|dixie)\b/i, 'paper'],
  [/\b(?:ziploc|glad\b|hefty|reynolds|saran)\b/i, 'household'],
  [/\b(?:pampers|huggies|luvs|enfamil|similac)\b/i, 'baby'],
  [/\b(?:dove\b|olay|suave|colgate|crest\b|sensodyne|listerine|gillette|venus\b|degree\b|secret\b|axe\b|old\s*spice)\b/i, 'personal'],
  [/\b(?:tylenol|advil|motrin|aleve|zyrtec|claritin|benadryl|pepto|mucinex|robitussin|nyquil|dayquil)\b/i, 'pharmacy'],
  [/\b(?:purina|pedigree|blue\s*buffalo|friskies|fancy\s*feast|tidy\s*cats|iams|greenies)\b/i, 'pet'],
  [/\b(?:dave'?s\s*killer|sara\s*lee|nature'?s\s*own|mrs\.?\s*bairds)\b/i, 'bakery'],
  [/\b(?:jif|skippy|smuckers|nutella|welch'?s)\b/i, 'pantry'],
  [/\b(?:quaker|nature\s*valley|clif\s*bar|kind\s*bars?|rxbar|belvita)\b/i, 'breakfast'],
  [/\b(?:kraft|velveeta|heinz|hellmann'?s|french'?s|sriracha|hidden\s*valley|ranch\s*style)\b/i, 'condiments'],
  /* Dried spices and herbs live on the baking aisle at HEB and Kroger
     ("Baking & Spices"), never with the fresh onions the word rules below
     would send them to. This has to run before produce: "garlic powder" is
     not garlic and "red pepper flakes" are not a pepper. "ground" alone is
     not a spice word — ground beef is meat — so it is named per spice.
     Ranch is a dressing packet, on the condiments aisle, and is claimed
     first so "ranch seasoning mix" does not become a spice. */
  [/\branch(?:\s+(?:seasoning|dressing|dip)(?:\s+mix)?)?\b/i, 'condiments'],
  [/\b(?:paprika|cumin|oregano|thyme|rosemary|sage|dill\s*weed|cinnamon|nutmeg|cayenne|turmeric|allspice|cardamom|coriander|cloves?\b(?!\s+(?:of\s+)?garlic)|bay\s*lea(?:f|ves)|chili\s*powder|curry\s*powder|garlic\s*powder|onion\s*powder|garlic\s*salt|onion\s*salt|black\s*pepper|white\s*pepper|peppercorns?|(?:red\s*|crushed\s*)?pepper\s*flakes|(?:italian|taco|cajun|creole|poultry|steak)\s*seasoning|lemon\s*pepper(?:\s*seasoning)?|celery\s*salt|dried\s+\w+|ground\s+(?:cinnamon|cumin|ginger|cloves|nutmeg|pepper|coriander|mustard|allspice)|\w+\s+extract|kosher\s*salt|sea\s*salt|table\s*salt|\bsalt\b|seasoning|spices?)\b/i, 'baking'],
  /* Every fruit and vegetable stops at a WORD END. Without it "lemonade"
     was a lemon, "butterscotch" was butter, "pineapple" an apple. Plurals
     are spelled out per word (tomatoes, berries, mangoes), never a bare
     \b after the stem — that is the trap that would lose "lemons". */
  [/\b(?:apples?|bananas?|oranges?|lemons?|limes?|grapes?|berr(?:y|ies)|strawberr(?:y|ies)|blueberr(?:y|ies)|raspberr(?:y|ies)|blackberr(?:y|ies)|cherr(?:y|ies)|peach(?:es)?|pears?|plums?|mango(?:e?s)?|pineapples?|watermelons?|cantaloupes?|melons?|kiwis?|avocados?|tomato(?:es)?|potato(?:es)?|onions?|garlic|ginger|jalapen[oñ]s?|lettuce|spinach|kale|carrots?|celery|peppers?|cucumbers?|broccoli|cauliflower|zucchinis?|squash|mushrooms?|cilantro|parsley|basil|green\s+beans|corn\s+on\s+the\s+cob|salad|produce|fruits?|veg(?:gies|etables?)?)\b/i, 'produce'],
  [/\b(?:hot\s*dog\s*buns?|hamburger\s*buns?|cinnamon\s*rolls?|dinner\s*rolls?|crescent\s*rolls?|kaiser\s*rolls?|bread|bagel|bun|roll|tortilla|pita|croissant|muffin|donut|cake|pie|bakery)/i, 'bakery'],
  [/\b(?:deli|lunch\s*meat|sandwich\s*meat|turkey\s*slices|salami|prosciutto|rotisserie)/i, 'deli'],
  [/\b(?:beef|steak|ground\s*(?:beef|turkey|chuck)|chicken|thigh|drumstick|pork|bacon|sausage|ham|brisket|ribs|meat|hot\s*dog)/i, 'meat'],
  [/\b(?:fish|salmon|tilapia|shrimp|crab|lobster|tuna\s*steak|seafood|cod)/i, 'seafood'],
  [/\b(?:milk|cheese|yogurt|butter|cream|sour\s*cream|cottage|half\s*and\s*half|creamer)/i, 'dairy'],
  [/\b(?:egg|eggs)\b/i, 'eggs'],
  [/\b(?:frozen|ice\s*cream|popsicles?|freezer|waffles?|onion\s*rings?|french\s*fries|fries|tater\s*tots|pizza\s*rolls|egg\s*rolls?|pizzas?)\b/i, 'frozen'],
  [/\b(?:cereal|oatmeal|oats|granola|pancake|syrup|pop\s*tart)/i, 'breakfast'],
  [/\b(?:cream\s+of\s+\w+\s+soup|\w+\s+noodle\s+soup|chicken\s+soup|chicken\s*broth|beef\s*broth|chicken\s*stock|beef\s*stock|canned|can\s+of|soup|beans|corn|tomato\s*sauce|tomato\s*paste|broth|stock)/i, 'canned'],
  [/\b(?:bread\s*crumbs|rice|pasta|noodle|spaghetti|flour|sugar|salt|cereal\s*bar|cracker|peanut\s*butter|jelly|jam|honey|olive\s*oil|oil|vinegar)/i, 'pantry'],
  [/\b(?:cream\s+of\s+tartar|baking|yeast|baking\s*(?:soda|powder)|vanilla|(?:butterscotch|white\s*chocolate|peanut\s*butter|choc(?:olate)?)\s*chips?|butterscotch|cocoa|powdered\s*sugar|brown\s*sugar)\b/i, 'baking'],
  [/\b(?:ketchup|mustard|mayo|mayonnaise|ranch|dressing|bbq|hot\s*sauce|salsa|soy\s*sauce|sauce|seasoning|spice)/i, 'condiments'],
  [/\b(?:haribo|skittles|starburst|sour\s*patch|twizzlers|hershey|reese|kit\s*kat|snickers|m\s*&\s*ms|jolly\s*rancher|airheads|swedish\s*fish|gumm(?:y|ies))\b/i, 'snacks'],
  [/\b(?:tortilla\s*chips?|potato\s*chips?|milk\s*chocolate|snack|chips?\b|dorito|tostito|cookie|candy|popcorn|pretzel|nuts?|trail\s*mix|granola\s*bar|fruit\s*snack)/i, 'snacks'],
  [/\b(?:water|soda|coke|sprite|dr\s*pepper|juice|lemonade|limeade|kool\s*-?aid|capri\s*sun|seltzer|sparkling\s*water|coffee|tea|gatorade|beer|wine|drink|la\s*croix)/i, 'beverages'],
  [/\b(?:coffee\s*filters?|battery|batteries|light\s*bulb|bulb|tape|glue|foil|ziploc|bag(?:gie)?s?|storage|trash\s*bag)/i, 'household'],
  [/\b(?:paper\s*towel|toilet\s*paper|tp\b|napkin|tissue|kleenex|plate|(?:paper|solo|plastic|disposable|coffee|red)\s*cups?|paper\s*goods)/i, 'paper'],
  [/\b(?:dryer\s*sheets?|detergent|soap|bleach|clorox|lysol|cleaner|sponge|dishwasher|laundry|softener|windex)/i, 'cleaning'],
  [/\b(?:shampoo|conditioner|toothpaste|toothbrush|deodorant|razor|floss|lotion|body\s*wash|tampon|pad|makeup)/i, 'personal'],
  [/\b(?:diaper|wipes|formula|baby)/i, 'baby'],
  [/\b(?:dog|cat|pet|kibble|litter|treats?\s*for)/i, 'pet'],
  [/\b(?:tylenol|advil|ibuprofen|band\s*aid|bandaid|vitamin|medicine|allergy|benadryl|cough|pharmacy|prescription)/i, 'pharmacy'],
];


/* ---------------------------------------------------------------------------
 * KNOWN THINGS
 *
 * Spoken lists have no commas. "milk eggs 2 pounds of ground beef" is one
 * breath, and splitting it needs to know that "ground beef" is one thing and
 * "milk eggs" is two. No amount of punctuation logic gets there — it takes a
 * lexicon.
 *
 * This list does not have to be complete. It has to cover the things people
 * actually say in one breath, and every item this household buys gets added
 * to their own catalog on first use, which is consulted first. The list gets
 * right for THIS family over a few weeks whatever this file says.
 * -------------------------------------------------------------------------*/
const KNOWN_ITEMS = [
  // produce
  'green onions','green onion','bell pepper','bell peppers','sweet potato','sweet potatoes',
  'baby carrots','romaine lettuce','iceberg lettuce','spring mix','cherry tomatoes',
  'grape tomatoes','russet potatoes','red onion','red onions','yellow onion','yellow onions',
  'green beans','brussels sprouts','snap peas','baby spinach','pineapple','pineapples',
  // flavoured things that are NOT the fruit (see MODIFIERS / HEADS below)
  'lemonade','limeade','orange juice','apple juice','grape juice','cranberry juice',
  'garlic bread','banana bread','onion rings','french fries','sweet potato fries','tater tots',
  'frozen pizza','pizza','butterscotch chips','lemon pepper','apple cider vinegar',
  // meat + seafood
  'ground beef','ground turkey','ground chuck','chicken breast','chicken breasts',
  'chicken thighs','chicken tenders','pork chops','pork loin','beef stew meat',
  'hot dogs','hot dog buns','lunch meat','deli turkey','deli ham','breakfast sausage',
  'bacon strips','salmon fillet','tilapia fillets',
  // dairy + eggs
  'sour cream','cream cheese','heavy cream','whipping cream','half and half',
  'cottage cheese','string cheese','shredded cheese','sliced cheese','greek yogurt',
  'almond milk','oat milk','whole milk','skim milk','chocolate milk','egg whites',
  'buttermilk','butter lettuce','milk chocolate','egg noodles','coconut oil','cream of tartar',
  'cream of mushroom soup','cream of chicken soup','ice cream cones','ice cream cone',
  'pancake mix','buttermilk pancake mix','ranch seasoning','ranch seasoning mix','ranch dressing','dryer sheets',
  // bakery
  'hamburger buns','hot dog buns','sandwich bread','wheat bread','white bread',
  'english muffins','tortilla shells','flour tortillas','corn tortillas','bagels',
  // pantry
  'peanut butter','olive oil','vegetable oil','canola oil','soy sauce','hot sauce',
  'black beans','pinto beans','refried beans','kidney beans','tomato sauce',
  'tomato paste','chicken broth','beef broth','chicken stock','pasta sauce',
  'spaghetti sauce','mac and cheese','macaroni and cheese','brown rice','white rice',
  'chicken noodle soup','maple syrup','brown sugar','powdered sugar','baking soda',
  'baking powder','chocolate chips','vanilla extract','bread crumbs','taco seasoning',
  // breakfast + snacks
  'honey nut cheerios','frosted flakes','granola bars','fruit snacks','trail mix',
  'peanut butter crackers','graham crackers','saltine crackers','tortilla chips',
  'potato chips','ice cream','ice cream sandwiches',
  // beverages
  'orange juice','apple juice','sparkling water','sports drinks','coffee creamer',
  'ground coffee','coffee filters','k cups','iced tea','sweet tea','diet coke',
  'dr pepper','root beer','la croix','topo chico',
  // household + paper + cleaning
  'paper towels','toilet paper','trash bags','ziploc bags','sandwich bags',
  'freezer bags','aluminum foil','plastic wrap','parchment paper','paper plates',
  'paper napkins','paper cups','solo cups','plastic cups','coffee cups','dish soap','dishwasher pods','laundry detergent','fabric softener',
  'dryer sheets','all purpose cleaner','glass cleaner','toilet cleaner','light bulbs',
  'batteries','aa batteries','aaa batteries',
  // personal + baby + pet + pharmacy
  'body wash','hand soap','hand sanitizer','shaving cream','toilet paper',
  'toothpaste','mouthwash','contact solution','cotton balls','q tips',
  'baby wipes','diaper cream','baby formula','dog food','cat food','cat litter',
  'dog treats','flea medicine','allergy medicine','cough drops','band aids',
  'first aid','pain reliever','sleep aid',
];

/* Brands people say instead of the product. Multi-word ones especially need
   to survive as one item — "dave's killer bread" is not three groceries. */
const KNOWN_BRANDS = [
  "dave's killer bread",'daves killer bread','honey nut cheerios','cheerios',
  'frosted flakes','lucky charms','cinnamon toast crunch','rice krispies',
  'doritos','tostitos','fritos','cheez its','cheez-its','goldfish','oreos','oreo',
  'chips ahoy','ritz crackers','wheat thins','triscuits','pringles',
  'blue bell','ben and jerrys',"ben and jerry's",'halo top','talenti',
  'chobani','yoplait','activia','tillamook','babybel','laughing cow',
  'la croix','topo chico','gatorade','powerade','red bull','dr pepper',
  'coca cola','coke zero','diet coke','sprite','mountain dew','pepsi',
  'tide','gain','downy','bounce','clorox','lysol','pine sol','fabuloso',
  'charmin','bounty','viva','scott','angel soft','cottonelle',
  'dawn','cascade','finish','febreze','swiffer','ziploc','glad','hefty',
  'kleenex','puffs','pampers','huggies','luvs','dove','olay','suave',
  'colgate','crest','sensodyne','listerine','gillette','venus','degree',
  'tylenol','advil','motrin','aleve','zyrtec','claritin','benadryl','pepto',
  'purina','pedigree','blue buffalo','friskies','fancy feast','tidy cats',
  'kraft','velveeta','heinz','hellmanns',"hellmann's","french's",'sriracha',
  'ranch style','hidden valley','bushs','jif','skippy','smuckers','nutella',
  'quaker','nature valley','clif bar','kind bars','rxbar',
  'haribo','skittles','starburst','sour patch','twizzlers','hersheys',"hershey's",
  'reeses',"reese's",'kit kat','snickers','m&ms','m and ms','jolly ranchers',
  'airheads','swedish fish','gummy bears','gummy worms','tic tac','mentos',
  'campbells',"campbell's",'progresso','pace','rotel','ro tel','bushs',"bush's",
  'ocean spray','minute maid','simply orange','tropicana','silk','fairlife',
  'sargento','kerrygold','land o lakes','philadelphia','breyers','haagen dazs',
  'eggo','pillsbury','betty crocker','duncan hines','mccormick','old el paso',
  'barilla','prego','ragu','knorr','lipton','folgers','maxwell house','keurig',
  'starbucks','dunkin','community coffee','blue diamond','planters','emerald',
];

/* Leading verbs that mean "put this on the list". Stripped before the items
   are read so "buy milk" is an item called milk, not "buy milk". */
const SHOP_VERB = /^(?:can\s+you\s+)?(?:please\s+)?(?:buy|get|grab|pick\s*up|add|need|we\s+need|i\s+need|put|order)\b\s*(?:me\s+)?/i;
const SHOP_TAIL = /\s*(?:to|on|from)\s+(?:the\s+)?(?:shopping\s+|grocery\s+)?list\.?$/i;
/* Quantities. A bare number can stand alone ("3 apples"), but a WORD only
   counts as a quantity when a unit follows it. Otherwise "half and half"
   parses as half of something called "and half", and "a pineapple" loses
   its fruit. */
/* The SHAPE a thing comes in — sticks, slices, a jug, a carton. Never an
   item on its own ("sticks" is not something you buy), so two things follow:
   after a known item it belongs to the item's NAME ("butter sticks" reads
   the way it was typed; the catalog can hold "butter" and "butter sticks"
   both), and in front of "of" it is a quantity ("sticks of butter" → butter,
   qty "sticks"). Exported so the app can sweep the bare-form rows this bug
   once wrote into the catalog. */
const FORM_WORDS = new Set([
  'stick','sticks','cube','cubes','slice','slices','half','halves','wedge','wedges',
  'block','blocks','bar','bars','loaf','loaves','jug','jugs','carton','cartons','tub','tubs',
  'roll','rolls','bottle','bottles','can','cans','jar','jars','box','boxes','bag','bags',
  'bunch','bunches','head','heads','pack','packs','package','packages','container','containers',
  'cluster','clusters','link','links','fillet','fillets','filet','filets','thigh','thighs','breast','breasts',
  'quarter','quarters','round','rounds','sheet','sheets','pod','pods','dozen',
  /* cuts — "ham steaks", "chicken wings", "turkey patties" */
  'steak','steaks','chop','chops','wing','wings','drumstick','drumsticks','nugget','nuggets',
  'patty','patties','strip','strips','tender','tenders','cutlet','cutlets',
]);
/* The MEASURES a recipe is written in — cups, tbsp, oz, lb, gallons, cans,
   pinches. One list, used by the ingredient parser's unit rule, by the
   shopping splitter's quantity detection, and by isFormOnly. There were
   two lists for a while and the splitter consulted only one, which is how
   "gallon of milk" became an item called "gallon of". */
const UNIT_WORDS = [
  'cups','cup','c','tablespoons','tablespoon','tbsp','tbs','tb','teaspoons','teaspoon','tsp',
  'ounces','ounce','oz','fl oz','pounds','pound','lbs','lb','grams','gram','g','kilograms','kilogram','kg',
  'milliliters','milliliter','ml','liters','liter','litres','litre','l',
  'pints','pint','pt','quarts','quart','qt','gallons','gallon','gal',
  'cans','can','packages','package','pkg','packets','packet','jars','jar','bottles','bottle',
  'boxes','box','bags','bag','bunches','bunch','heads','head','cloves','clove','sticks','stick',
  'slices','slice','pieces','piece','sprigs','sprig','stalks','stalk','ears','ear','loaves','loaf',
  'pinch','pinches','dash','dashes','handful','handfuls','splash','sprinkle','drizzle',
  'cases','case','six pack','six-pack','12 pack','12-pack','twelve pack','dozen',
];
/* Every word that says HOW MUCH or WHAT SHAPE, never WHAT. */
const MEASURE_WORDS = new Set([...UNIT_WORDS, ...FORM_WORDS]);
const MEASURE_ALT = [...MEASURE_WORDS].sort((a, b) => b.length - a.length)
  .map(w => w.replace(/[-]/g, '\\-').replace(/ /g, '\\s+')).join('|');
/* "sticks", "gallon of", "a box of", "cup" — a name that is nothing but a
   measure or a shape. The catalog must never learn one: a learned "sticks"
   would make the splitter treat it as an item again and re-create the
   very bug. And a chunk that is only this is nothing to buy. */
const isFormOnly = name => {
  const n = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim()
    .replace(/^(?:a|an|one|two|three|four|five|six|half\s+a|half|a\s+few|some|\d+(?:\.\d+)?)\s+/, '').replace(/\s+of$/, '');
  return MEASURE_WORDS.has(n) || MEASURE_WORDS.has(n.replace(/-/g, ' '));
};
/* "sticks of", "a box of", "half a dozen" — a shape word (optionally with an
   article or a small number word) followed by "of" is a quantity phrase. */
/* "gallon milk", "dozen eggs" — a bare measure straight before the item.
   Applied only when what follows is a known item (see the splitter), so
   "can opener" keeps its can. */
const BARE_QTY_RE = new RegExp(`^(${MEASURE_ALT})\\s+(?=\\S)`, 'i');
/* "sticks of", "gallon of", "a box of", "2 lbs of" — any measure or shape
   word, with or without a number or article, followed by "of". */
const FORM_OF_RE = new RegExp(`^(?:(?:a|an|one|two|three|four|five|six|couple(?:\\s+of)?|half|half\\s+a|a\\s+few|some|\\d+(?:\\.\\d+)?)\\s+)?(?:${MEASURE_ALT})\\s+of\\s+(?=\\S)`, 'i');

/* A number (with an optional measure) or an article + measure. The measure
   alternation is MEASURE_ALT — the one list. */
const QTY_RE = new RegExp(`^(?:(\\d+(?:\\.\\d+)?\\s*(?:x\\s*)?(?:${MEASURE_ALT})?)|((?:a|an|one|two|three|four|five|six|couple(?:\\s+of)?|half\\s+a|half|a\\s+few)\\s+(?:${MEASURE_ALT})))\\s+(?=\\S)`, 'i');

/* Some things you have to stand in front of and choose. A packaged item is a
   SKU — anyone can grab it, and it can be ordered online without a thought.
   Produce, meat, seafood, bakery and deli are judgement calls: ripeness, cut,
   how brown the bananas are. Those get flagged on the list so whoever shops
   knows which items they cannot delegate to a pickup order. */
const PICK_YOURSELF = new Set(['produce','meat','seafood','bakery','deli']);
const freshness = cat => ({
  pickYourself: PICK_YOURSELF.has(cat),
  onlineOk:     !PICK_YOURSELF.has(cat),
});

/* The MOST SPECIFIC row wins, not the first. First-match-wins in aisle order
   sent "peanut butter" to dairy because the dairy row's bare "butter" sat
   above the pantry row's "peanut butter" — and every fix was another row
   hand-ordered above another, which does not scale ("ranch" above the spice
   row was the last one). Now every row that matches is scored by how much
   of the name it matched; the longest match wins; table order only breaks
   ties, so everything the order used to decide still decides the same way. */
const catOf = (name, catalog) => {
  const hit = (catalog || []).find(c => c.name.toLowerCase() === name.toLowerCase());
  if (hit && hit.category) return hit.category;          // the household's own memory wins
  /* English compounds are head-final: the LAST word is the thing, the
     words before it say which kind. "grape juice" is a juice, "banana
     bread" is a bread, "apple cider vinegar" is a vinegar. So the row
     whose match reaches furthest into the name wins; only among matches
     that end at the same place does the longer one win, and table order
     breaks what is left. (The old rule was longest-match alone, which is
     why every fruit-flavoured thing went to produce.) */
  const score = str => {
    let best = null, bestEnd = -1, bestLen = 0, bestAt = -1;
    for (const [re, cat] of CATEGORY_WORDS) {
      const m = str.match(re);
      if (!m) continue;
      const end = m.index + m[0].length, len = m[0].length;
      if (end > bestEnd || (end === bestEnd && len > bestLen)) { best = cat; bestEnd = end; bestLen = len; bestAt = m.index; }
    }
    return { best, at: bestAt };
  };
  const full = String(name).trim();
  let r = score(full);
  /* A trailing shape or measure word says how it comes, not what it is:
     "toilet paper rolls" is paper, not a bakery roll. When the winning
     match lives entirely inside that last word, score the name without it.
     "trash bags" and "dryer sheets" keep theirs — the row that names them
     starts before the shape word. */
  const cut = full.replace(/\s+\S+$/, '');
  if (cut && cut !== full && MEASURE_WORDS.has(full.slice(cut.length).trim().toLowerCase()) && r.at >= cut.length) {
    const r2 = score(cut);
    if (r2.best) r = r2;
  }
  return r.best || 'other';
};

/* ---------------------------------------------------------------------------
 * HEARING IT WRONG
 *
 * Dictation mangles brand names more than anything else, because they are not
 * words. "Haribo" comes through as "Harbough". No spelling rule recovers
 * that — but both reduce to the same consonant skeleton, h-r-b, and that is
 * recoverable.
 *
 * The skeleton keeps the first letter and the consonants, drops vowels, and
 * folds the spellings English uses for the same sound (ph/f, ck/k, silent gh).
 * Two words that sound alike land on the same key even when nothing about
 * their spelling agrees.
 *
 * Applied ONLY to items nothing else recognised, and only to brand names —
 * the words dictation actually breaks. A correction is always reported back,
 * because a confident wrong guess is worse than no guess.
 * -------------------------------------------------------------------------*/
function skeleton(word) {
  let w = String(word).toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  const first = w[0];
  w = w
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/qu/g, 'k')
    .replace(/c([eiy])/g, 's$1')
    .replace(/c/g, 'k')
    .replace(/z/g, 's')
    .replace(/x/g, 'ks')
    .replace(/(.)gh/g, '$1')        // "ough", "ight" — the gh is silent
    .replace(/[aeiou]/g, '')
    .replace(/(?!^)[hy]/g, '')      // h and y only carry sound at the start
    .replace(/(.)\1+/g, '$1');
  return /^[aeiou]/.test(first) ? first + w : (w || first);
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

let BRAND_BY_SKELETON = null;
function brandIndex() {
  if (BRAND_BY_SKELETON) return BRAND_BY_SKELETON;
  BRAND_BY_SKELETON = new Map();
  for (const b of KNOWN_BRANDS) {
    const k = skeleton(b.replace(/\s+/g, ''));
    if (k.length < 2) continue;
    if (!BRAND_BY_SKELETON.has(k)) BRAND_BY_SKELETON.set(k, []);
    BRAND_BY_SKELETON.get(k).push(b);
  }
  return BRAND_BY_SKELETON;
}

/* Try to repair one mis-heard word against the brand list.
   Returns the corrected brand, or null when nothing is close enough. */
function repairWord(word) {
  const w = String(word).toLowerCase().replace(/[^a-z]/g, '');
  if (w.length < 5) return null;                 // shorter words collide too easily
  const cands = brandIndex().get(skeleton(w));
  if (!cands || !cands.length) return null;
  let best = null, bestD = Infinity;
  for (const c of cands) {
    const d = editDistance(w, c.replace(/[^a-z]/g, ''));
    if (d < bestD) { bestD = d; best = c; }
  }
  // Sounding alike is necessary; looking roughly alike keeps it honest.
  return bestD <= Math.max(2, Math.ceil(w.length * 0.45)) ? best : null;
}

/* Repair an item name. Whole phrase first, then word by word, and only where
   nothing was recognised — a name that already classified is left alone. */
function repairName(name, knownSet) {
  const isKnown = t => (knownSet ? (knownSet.builtin.has(t) || knownSet.learned.has(t))
                                 : BUILTIN.has(t)) || catOf(t, null) !== 'other' || MEASURE_WORDS.has(t);
  const whole = String(name).toLowerCase();
  if (isKnown(whole)) return null;

  const asOne = repairWord(whole.replace(/\s+/g, ''));
  if (asOne && asOne !== whole) return { name: asOne, from: name };

  const toks = String(name).split(/\s+/);
  let changed = false;
  const fixed = toks.map(t => {
    if (isKnown(t.toLowerCase())) return t;
    const r = repairWord(t);
    if (r && r !== t.toLowerCase()) { changed = true; return r; }
    return t;
  });
  return changed ? { name: fixed.join(' '), from: name } : null;
}

const normTok = t => String(t).toLowerCase()
  .replace(/[.,!?;:]+$/, '').replace(/^["']+|["']+$/g, '');

const BUILTIN = new Set([...KNOWN_ITEMS, ...KNOWN_BRANDS]);
const BRAND_SET = new Set(KNOWN_BRANDS);

/* ---------------------------------------------------------------------------
 * A BRAND IS AN ADJECTIVE
 *
 * "Nutella sticks" is one thing to buy. So is "Tide pods", "Dove soap",
 * "Haribo gummies", "Blue Bell vanilla". A brand almost never ends an item —
 * it introduces one. Splitting on the longest known word alone gets this
 * backwards and produces a brand with no product and a product with no
 * meaning: "nutella" and "sticks", neither of which is findable in a store.
 *
 * So a brand absorbs what follows it, until something clearly starts a new
 * item: another brand, a quantity, a filler word, or one of the core
 * groceries below.
 *
 * CORE_STOP is deliberately short, and deliberately excludes the words that
 * normally FOLLOW a brand — soap, detergent, towels, cereal, coffee, cheese.
 * Those are what the brand is. It holds only words that are overwhelmingly
 * their own item and almost never a descriptor, so "doritos milk eggs" still
 * comes apart correctly.
 *
 * Erring toward merging is deliberate. A wrongly merged item is visible on
 * the list and one tap from fixed; a wrongly split one leaves two rows that
 * both look plausible and neither of which is real.
 * -------------------------------------------------------------------------*/
const CORE_STOP = new Set([
  'milk','eggs','bread','bananas','apples','oranges','grapes','lettuce',
  'tomatoes','potatoes','onions','carrots','celery','avocados','lemons','limes',
  'chicken','beef','pork','bacon','salmon','shrimp','turkey',
  'rice','pasta','water','juice','diapers','tylenol','batteries','gas',
]);
/* Long enough for brand + flavour + item ("Blue Bell homemade vanilla ice
   cream" is five words past the brand). CORE_STOP is the real guard against
   runaway merging; this only bounds the damage when nothing else fires. */
const MAX_BRAND_TAIL = 6;

/* Is this token something the parser recognises on its own? */
const knownWord = t => BUILTIN.has(t) || catOf(t, null) !== 'other';

/* A FLAVOUR IN FRONT OF A THING IS PART OF THE THING.
 *
 * "grape juice", "onion rings", "garlic bread", "lemon pepper", "celery
 * salt": two words the lexicon knows separately, one item. The same class
 * as "butter sticks" — and the proof that a lexicon of phrases cannot keep
 * up, because the pattern is open-ended. So it is a rule: a fruit,
 * vegetable or flavour word (MODIFIERS) directly before a word that takes
 * a flavour (HEADS) joins it. One unknown word may sit between ("apple
 * cider vinegar"). "eggs bacon" stays two items — eggs is not a modifier —
 * and "onion garlic" stays two — garlic is not a head. */
const MODIFIERS = new Set([
  'apple','banana','orange','lemon','lime','grape','strawberry','blueberry','raspberry','blackberry',
  'cherry','peach','pear','plum','mango','pineapple','watermelon','melon','coconut','cranberry','pomegranate',
  'tomato','potato','onion','garlic','ginger','jalapeno','jalapeño','carrot','celery','cucumber','pumpkin',
  'spinach','avocado','corn','chili','chile','mushroom','pepper','oatmeal','oat',
  'butterscotch','peanut','chocolate','vanilla','honey','maple','cinnamon','almond','caramel','mint',
  'ranch','buffalo','cheddar','cheese','sour','sweet','hot','bbq','teriyaki','sesame','wheat'
]);
const HEADS = new Set([
  'juice','soda','pop','ade','jam','jelly','preserves','bread','muffin','muffins','pie','cake','cupcakes',
  'chips','rings','vinegar','extract','seltzer','tea','yogurt','candy','pepper','salt','sauce','syrup',
  'bar','bars','water','popsicle','popsicles','smoothie','cider','dressing','salsa','soup','cereal','oatmeal',
  'pudding','cream','sherbet','sorbet','crackers','cookies','pretzels','popcorn','nuts','butter','oil','spread',
  'seasoning','powder','flakes','fries','rolls','sticks','bites','puffs','mix','loaf','pieces','wafers',
  'mustard','ketchup','mayo','chicken','wings','nuggets','pork','beef','sausage','tofu','glaze','marinade'
]);
const isModifier = t => MODIFIERS.has(t);
const isHead = t => HEADS.has(t) || HEADS.has(t.replace(/s$/, ''));
/* "grape juice", "apple cider vinegar": a flavour, an optional bridge word,
   a head. Used by the splitter and by looksMerged, so what one joins the
   other will let the catalog learn. */
function isCompound(phrase) {
  const toks = String(phrase).toLowerCase().split(/\s+/).filter(Boolean);
  if (toks.length < 2 || toks.length > 3) return false;
  return isModifier(toks[0]) && isHead(toks[toks.length - 1]);
}

/* Does this phrase come apart into things already known separately?
 *
 * "milk eggs" does: two groceries, no relationship. "ground beef" does not —
 * "ground" is not a thing you buy. The distinction is what stops a learned
 * phrase from swallowing two real items.
 */
function looksMerged(phrase) {
  const toks = String(phrase).toLowerCase().split(/\s+/).filter(Boolean);
  if (toks.length < 2) return false;
  if (BUILTIN.has(toks.join(' '))) return false;      // a real multi-word product
  /* A phrase that opens with a brand is a product name, however many of its
     other words are recognisable. "Haribo gummies" was being rejected here,
     which meant correcting it once never stuck — the catalog refused to learn
     the very thing the correction was for. */
  for (let n = Math.min(3, toks.length - 1); n >= 1; n--) {
    if (BRAND_SET.has(toks.slice(0, n).join(' '))) return false;
  }
  if (isCompound(toks.join(' '))) return false;       // "grape juice" is one thing
  return toks.every(knownWord);
}

/* Two tiers, and the difference matters.
 *
 * BUILTIN is this file's lexicon — trusted absolutely, because I wrote it.
 * LEARNED is the household's own catalog, which is better than my list at
 * knowing what THIS family buys, and is also where the parser's own mistakes
 * end up. A bad parse once wrote "milk eggs" into the catalog; longest-match
 * then found it and merged those two items on every subsequent list, forever.
 * The system had taught itself its own error.
 *
 * So a learned phrase is only trusted when it does NOT come apart into things
 * already known separately. "Dave's Killer Bread" survives. "milk eggs" does
 * not, whatever the catalog says.
 */
function buildKnown(catalog) {
  const learned = new Set();
  for (const c of (catalog || [])) {
    if (!c || !c.name) continue;
    const n = String(c.name).toLowerCase();
    if (isFormOnly(n)) continue;                 // "sticks" is not a thing this house buys
    if (!looksMerged(n)) learned.add(n);
  }
  return { builtin: BUILTIN, learned };
}

/* Words that carry no item.
 *
 * Two kinds. Filler that dictation sprinkles through a sentence, and the
 * VERBS that mean "put this on the list". A verb is stripped from the front
 * of a message already, but people say them again halfway through — "…Kroger
 * diapers, buy Haribo gummies, add bike" — and mid-sentence they were being
 * read as groceries. "by" is in here because that is what speech-to-text
 * hears when someone says "buy".
 */
const CONNECTOR = /^(?:and|plus|also|then|&|list|um+|uh+|ok|okay|oh|so|please|too|as\s*well)$/i;
const VERB_NOISE = /^(?:buy|by|add|get|gets|got|grab|grabs|need|needs|order|orders|pick|up|want|wants)$/i;
const isNoise = t => CONNECTOR.test(t) || VERB_NOISE.test(t);

/* Break one run of speech into separate items.
 *
 * Dictation arrives without punctuation: "milk eggs 2 pounds of ground beef"
 * is a single string, and the only thing that can tell "ground beef" (one
 * item) from "milk eggs" (two) is knowing what things are called. So this
 * walks left to right taking the LONGEST known phrase at each position, and
 * treats a quantity as the start of a new item.
 *
 * Where it cannot know — two unfamiliar words in a row — it keeps them
 * together rather than guessing a split. A merged item is visible on the list
 * and takes one tap to fix; a wrongly split one produces two half-items that
 * both look plausible and neither of which is real.
 */
function splitRun(part, knownSet) {
  const toks = part.split(/\s+/).filter(Boolean);
  const MAX = 5;

  const phraseAt = (k, n) => normTok(toks.slice(k, k + n).join(' '));
  const knownAt = k => {
    if (k >= toks.length) return 0;
    for (let n = Math.min(MAX, toks.length - k); n >= 1; n--) {
      const ph = phraseAt(k, n);
      if (knownSet.builtin.has(ph)) return n;
      // A learned phrase never outranks two items already known separately.
      if (knownSet.learned.has(ph) && !looksMerged(ph)) return n;
    }
    return knownWord(normTok(toks[k])) ? 1 : 0;
  };
  const qtyLen = k => {
    if (k >= toks.length) return 0;
    const rest = toks.slice(k).join(' ') + ' ';
    const m = QTY_RE.exec(rest) || FORM_OF_RE.exec(rest);
    if (m) return m[0].trim().split(/\s+/).length;
    /* "gallon milk": a bare measure, but only in front of a known item. */
    const b = BARE_QTY_RE.exec(rest);
    if (b) {
      const n = b[0].trim().split(/\s+/).length;
      if (knownAt(k + n) && !MEASURE_WORDS.has(normTok(toks[k + n] || ''))) return n;
    }
    return 0;
  };
  /* A shape word that is not itself an item, not followed by "of". */
  const formAt = k => k < toks.length && FORM_WORDS.has(normTok(toks[k]))
    && !knownSet.builtin.has(normTok(toks[k])) && !knownSet.learned.has(normTok(toks[k]))
    && !(toks[k + 1] && /^of$/i.test(toks[k + 1]));

  /* A brand ahead of position k, at any length it is written. */
  const brandAt = k => {
    for (let n = Math.min(3, toks.length - k); n >= 1; n--) {
      if (BRAND_SET.has(phraseAt(k, n))) return n;
    }
    return 0;
  };

  const chunks = [];
  let i = 0;
  while (i < toks.length) {
    if (isNoise(toks[i])) { i++; continue; }

    /* Quotes settle it outright. "nutella sticks" is one item, whatever any
       rule below would have decided. The escape hatch for anything the
       lexicon has never heard of. */
    const qm = toks[i].match(/^(["'])/);
    if (qm) {
      const mark = qm[1];
      let j = i;
      const acc = [];
      while (j < toks.length) {
        acc.push(toks[j]);
        const t = toks[j];
        const closes = j === i ? (t.length > 1 && t.endsWith(mark)) : t.endsWith(mark);
        if (closes) break;
        j++;
      }
      const quoted = acc.join(' ').replace(/^["']/, '').replace(/["']$/, '').trim();
      i = j + 1;
      if (quoted) { chunks.push(quoted); }
      continue;
    }

    const start = i;
    const q = qtyLen(i);
    if (q) i += q;
    if (toks[i] && /^of$/i.test(toks[i])) i++;

    const k = knownAt(i);
    if (k) {
      const wasBrand = brandAt(i) === k;
      i += k;
      /* ROOT 1. A known item followed by its SHAPE is still one item:
         "butter sticks", "cheese slices", "toilet paper rolls". The chunk
         used to close on "butter" and the orphan "sticks" became a row of
         its own. Up to two shape words ride along, into the name. */
      for (let f = 0; f < 2 && formAt(i); f++) i++;
      /* A flavour word in front of a thing that takes one: "grape juice",
         "garlic bread", "apple cider vinegar" (one bridge word allowed). */
      if (!wasBrand && isModifier(normTok(toks[i - 1] || ''))) {
        /* Up to two heads in a row ("cider vinegar"), or a known phrase that
           ends in one ("ice cream"); one bridge word may sit in front. */
        for (let hops = 0; hops < 2; hops++) {
          const bridge = (i < toks.length && !knownAt(i) && !isNoise(toks[i]) && !qtyLen(i) && !isHead(normTok(toks[i]))
                          && i + 1 < toks.length && isHead(normTok(toks[i + 1]))) ? 1 : 0;
          const h = i + bridge;
          if (h >= toks.length || isNoise(toks[h]) || qtyLen(h)) break;
          const n = Math.max(1, knownAt(h));
          if (!isHead(normTok(toks[h + n - 1]))) break;
          i = h + n;
        }
        for (let f = 0; f < 2 && formAt(i); f++) i++;
      }
      /* A brand introduces a product; it does not end one. Absorb what
         follows until something clearly begins a new item. */
      if (wasBrand) {
        let extra = 0;
        while (i < toks.length && extra < MAX_BRAND_TAIL) {
          if (isNoise(toks[i]) || qtyLen(i) || brandAt(i)) break;
          /* Never cut a known product in half. "Blue Bell homemade vanilla
             ice cream" ends in a two-word item; stopping on a token budget
             mid-phrase left "…vanilla ice" and an orphan "cream". A known
             phrase is taken whole or not at all. */
          let phrase = 0;
          for (let n = Math.min(MAX, toks.length - i); n >= 2; n--) {
            if (knownSet.builtin.has(phraseAt(i, n)) ||
                (knownSet.learned.has(phraseAt(i, n)) && !looksMerged(phraseAt(i, n)))) { phrase = n; break; }
          }
          if (phrase) { i += phrase; extra += phrase; continue; }
          if (CORE_STOP.has(normTok(toks[i]))) break;
          i++; extra++;
        }
      }
    } else {
      i++;
      while (i < toks.length && !knownAt(i) && !qtyLen(i) && !isNoise(toks[i])) i++;
      /* ONE unknown word in front of ONE known word is an adjective, not an
         item: "coconut oil", "fresh basil", "organic milk", "sweet corn". The
         run used to stop dead at the known word and file "coconut" as a
         thing to buy. A brand or a known PHRASE still starts its own item. */
      if (i - start === 1 && i < toks.length && knownAt(i) === 1 && !brandAt(i)
          && !qtyLen(i) && !isNoise(toks[i])) {
        i++;
        for (let f = 0; f < 2 && formAt(i); f++) i++;
      }
    }
    const chunk = toks.slice(start, i).join(' ').trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

/* One trip can cover two stores, and it gets said in one breath:
   "ground beef, list, Kroger, diapers". A store name is a switch, not a
   prefix — everything after it belongs to that store until the next one.
   Looking only at the front of the message turned "Kroger" into an item. */
/* Every way a store gets said, longest first so "HEB Harpers Trace" is never
   cut short as "HEB", and "sams club" is never cut short as "sams". */
function storeTerms(stores) {
  const terms = [];
  for (const st of (stores || [])) {
    terms.push({ store: st, text: st.name });
    for (const a of (st.aliases || [])) if (a) terms.push({ store: st, text: a });
  }
  return terms.sort((a, b) => b.text.length - a.text.length);
}

function storeSections(text, stores) {
  const hits = [];
  for (const { store: st, text: term } of storeTerms(stores)) {
    const re = new RegExp(`(?:^|\\b)(?:at\\s+|from\\s+)?${escapeRe(term)}\\b\\s*[:,-]?\\s*`, 'gi');
    let m;
    while ((m = re.exec(text))) {
      const at = m.index, end = m.index + m[0].length;
      // Longer terms are tried first, so the longer name wins its span.
      if (!hits.some(h => at < h.end && end > h.at)) hits.push({ at, end, store: st });
      if (re.lastIndex <= at) re.lastIndex = at + 1;
    }
  }
  hits.sort((a, b) => a.at - b.at);

  const out = [];
  let cursor = 0, current = null;
  for (const h of hits) {
    const chunk = text.slice(cursor, h.at).trim();
    if (chunk) out.push({ store: current, text: chunk });
    current = h.store;
    cursor = h.end;
  }
  const tail = text.slice(cursor).trim();
  if (tail) out.push({ store: current, text: tail });
  return out.length ? out : [{ store: null, text }];
}

/**
 * Read a shopping message into typed rows.
 *
 * @param {string} input
 * @param {object} opts
 * @param {Array}  opts.stores   [{ id, name }] — matched by name, loosely
 * @param {Array}  opts.catalog  [{ name, category, store_id }] previously bought
 */
function parseShopping(input, opts = {}) {
  const out = { store: null, items: [], corrections: [], warnings: [] };
  let raw = String(input || '').trim();
  if (!raw) { out.warnings.push('Nothing to add'); return out; }

  raw = raw.replace(SHOP_TAIL, '');
  raw = raw.replace(SHOP_VERB, '').trim();
  if (!raw) { out.warnings.push('No items found'); return out; }

  /* Commas and newlines when they are there; the lexicon when they are not.
     Dictated lists have neither, which is the whole reason splitRun exists. */
  const knownSet = buildKnown(opts.catalog);

  for (const section of storeSections(raw, opts.stores || [])) {
    if (!out.store && section.store) out.store = section.store;

    /* The verb can sit after the store: "at HEB 2 grab milk". Strip it per
       section, not just at the very front, or "grab" becomes an item. */
    let body = section.text.replace(SHOP_VERB, '').trim();
    if (!body) continue;

    /* Repair mis-heard words BEFORE splitting. Doing it afterwards let two
       broken brand names merge into one item — "tighed charmen" came out as a
       single row reading "tide charmin". Once each word is recognised, the
       splitter separates them on its own. */
    const bodyToks = body.split(/\s+/);
    /* Which token positions sit inside a brand's product name. Recomputed
       here rather than shared with splitRun, because repair has to run
       BEFORE splitting — otherwise two mis-heard brands merge into one row. */
    const brandRun = new Array(bodyToks.length).fill(false);
    for (let k = 0; k < bodyToks.length; k++) {
      let hit = 0;
      for (let n = Math.min(3, bodyToks.length - k); n >= 1; n--) {
        if (BRAND_SET.has(bodyToks.slice(k, k + n).map(normTok).join(' '))) { hit = n; break; }
      }
      if (!hit) continue;
      for (let j = k + hit; j < bodyToks.length; j++) {
        const t = normTok(bodyToks[j]);
        if (isNoise(bodyToks[j]) || CORE_STOP.has(t)) break;
        if (BRAND_SET.has(t)) break;
        brandRun[j] = true;
      }
      k += hit - 1;
    }
    const inBrandRun = ix => brandRun[ix];

    body = bodyToks.map((tok, ix) => {
      const bare = tok.toLowerCase().replace(/[^a-z]/g, '');
      if (!bare || bare.length < 5) return tok;
      /* A measure word is never a misheard brand: "loaves" is not "Luvs". */
      if (knownWord(bare) || knownSet.builtin.has(bare) || knownSet.learned.has(bare) || MEASURE_WORDS.has(bare)) return tok;
      /* Everything inside a brand's product name is off limits. Those words
         are flavours, sizes and variants, and repairing them corrupts the
         name: "Haribo gold bears" came out as "Haribo glad bears" and then
         "breyers gummy candy", because gold/Glad and bears/Breyers share a
         consonant skeleton. Only a word that could BEGIN an item is a
         candidate for repair. */
      if (inBrandRun(ix)) return tok;
      const r = repairWord(bare);
      if (!r || r === bare) return tok;
      out.corrections.push({ from: tok, name: r });
      return r;
    }).join(' ');

    const parts = body.split(/\s*[;\n]+\s*|\s*,\s*/).map(x => x.trim()).filter(Boolean);
    for (const part of parts) {
      /* A note is pulled off the WHOLE segment before it is split, or the
         splitter turns "milk (whole)" into two items, one being "(whole)".
         It belongs to the last item named in that segment. */
      let text = part, note = null;
      const nm = text.match(/\s*\((.+?)\)\s*$/) || text.match(/\s+\bfor\s+(.+)$/i);
      if (nm) { note = nm[1].trim(); text = text.slice(0, nm.index).trim(); }

      const chunks = splitRun(text, knownSet);
      chunks.forEach((chunk, idx) => {
        let name = chunk.replace(/^(?:and|plus|also)\s+/i, '')
                        .replace(/^(?:some|a\s+few|the)\s+/i, '').trim();
        let qty = null;
        let q = QTY_RE.exec(name) || FORM_OF_RE.exec(name);
        if (!q) {
          const b = BARE_QTY_RE.exec(name);
          const rest = b ? name.slice(b[0].length).trim().toLowerCase() : '';
          if (b && rest && (knownSet.builtin.has(rest) || knownSet.learned.has(rest) || catOf(rest, null) !== 'other')) q = b;
        }
        if (q) {
          /* "2 lbs" from the number path; "sticks" / "a box" from the shape
             path (the "of" is the quantity's, not the name's). */
          qty = (q[1] || q[2] || q[0].replace(/\s+of\s*$/i, '')).trim();
          // "3 bottles of coke" — the preposition belongs to the quantity.
          name = name.slice(q[0].length).replace(/^of\s+/i, '').trim();
        }
        /* One case, always. A phone capitalises the first word of a text, so
           "Milk" and "milk" arrive as different strings and become two rows
           in the catalog that never learn from each other. */
        name = name.replace(/^(?:a|an)\s+/i, '').replace(/[.!]+$/, '').trim().toLowerCase();
        if (!name) return;
        /* "cup", "sticks", "gallon of" — a measure with nothing measured is
           not a thing to buy. Dropped, and said so. */
        if (isFormOnly(name) && catOf(name, opts.catalog) === 'other') {
          out.warnings.push(`nothing to buy in "${name}"`); return;
        }

        /* Dictation breaks brand names more than anything else. Repair only
           what nothing recognised, and always say so — a confident wrong
           guess is worse than leaving it alone. */
        let heardAs = null;
        const fix = /\s/.test(name) ? repairName(name, knownSet) : null;
        if (fix) { heardAs = fix.from; name = fix.name; out.corrections.push(fix); }
        const tokFix = out.corrections.find(c => c.name && name.toLowerCase().includes(c.name));
        if (!heardAs && tokFix) heardAs = tokFix.from;

        const category = catOf(name, opts.catalog);
        /* Where this house last bought it. Kept apart from `store` (what the
           text said) so a caller can rank an explicit store, then the chip
           it is looking at, then this memory — and never mistake one for
           the other. */
        const known = (opts.catalog || []).find(c => c.name.toLowerCase() === name.toLowerCase());
        out.items.push({
          name, qty, heardAs,
          note: idx === chunks.length - 1 ? note : null,
          store: section.store || null,
          catalogStore: known && known.store_id ? known.store_id : null,
          category, ...freshness(category)
        });
      });
    }
  }

  /* Said twice in one breath is still one thing to buy. Keep the mention
     that carries a quantity — "ground beef ... 2 pounds ground beef" means
     two pounds, not two entries. */
  const seen = new Map();
  out.items = out.items.filter(it => {
    const key = `${it.store?.id ?? ''}|${it.name}`;
    const prior = seen.get(key);
    if (!prior) { seen.set(key, it); return true; }
    if (!prior.qty && it.qty) prior.qty = it.qty;
    if (!prior.note && it.note) prior.note = it.note;
    return false;
  });

  if (!out.items.length) out.warnings.push('No items found');
  return out;
}

/* ===========================================================================
 * 12. INTENT ROUTING
 *
 * One text, several possible meanings. Until this existed every message
 * became a calendar event, which is exactly why the number could not be
 * given to anyone else: "milk" would quietly turn up on the calendar and
 * nobody would notice until the week was wrong.
 *
 * The two failures are not equal. Filing an event as groceries loses an
 * appointment. Filing groceries as an event clutters a calendar. Both are
 * bad enough that where a message is genuinely ambiguous the answer is to
 * ask, once, rather than guess quietly.
 *
 * WHY THIS LIVES HERE AND NOT IN THE HANDLER
 *   It used to live in the handler as a chain of if-blocks, and route.test
 *   re-implemented that chain BY HAND to test it. The comment on the copy
 *   said "mirrors the handler". It did not: the real chain runs the
 *   correction and edit matchers between the scoped list and the shopping
 *   intents, and the copy had neither, so "delete that" routed one way in
 *   the test and another way in production. A test that reimplements the
 *   thing it is testing will agree with itself forever.
 *
 * WHAT IS AND IS NOT DECIDED HERE
 *   Decidable from the text alone: the list commands, bulk clear, the scoped
 *   view, remove/got, and the final shopping-vs-event-vs-ask call.
 *
 *   NOT decidable here: corrections and edits. "no, make it 4" means nothing
 *   without knowing what just happened, and "practice is moved to 6" needs
 *   the event looked up before you know whether it is an edit at all. Those
 *   return intent 'stateful' with the reason, and the handler resolves them
 *   against sms_last_action and the calendar — and falls through to the rest
 *   of the chain when nothing matches, which is why 'stateful' carries the
 *   routing that WOULD apply if it does not.
 * ========================================================================= */

const ROUTE_RE = {
  SHOP_STRONG: /\b(?:shopping\s+list|grocery\s+list|groceries)\b|^(?:buy|shop)\b/i,
  SHOP_WEAK  : /^(?:get|grab|need|we\s+need|i\s+need|add|pick\s*up|order)\b/i,
  /* NOT take\s+out on its own: taking out the trash is the archetypal
     chore, and with trash bags on the shopping list the partial matcher
     would have removed them instead. 'take off' and 'take out of' still
     mean the list. */
  SHOP_REMOVE: /^(?:remove|delete|take\s+off|take\s+out\s+of|drop|scratch|erase|clear|wipe|get\s+rid\s+of|no)\s+(.+)$/i,
  SHOP_GOT   : /^(?:got|bought|picked\s+up|grabbed|have)\s+(.+)$/i,
  LIST_CMD   : /^(?:list|the\s+list|shopping(?:\s+list)?|grocer(?:y|ies)(?:\s+list)?|what'?s?\s+on\s+the\s+list)\s*\??$/i,
  LIST_SCOPED: /^(?:show\s+|see\s+|what'?s?\s+on\s+)?(?:the\s+)?(.+?)(?:'s)?\s+list\s*\??$/i,
  TRIP_DONE  : /^(?:new\s+(?:list|trip)|start\s+(?:a\s+)?new\s+(?:list|trip)|done(?:\s+shopping)?|finished(?:\s+shopping)?)\s*[.!]?$/i,
  CLEAR_VERB : /^(?:clear|empty|wipe|reset|remove|delete|erase)\b\s*(.*)$/i,
  BULK_FILLER: /\b(?:the|a|an|whole|entire|all|everything|every|of|from|out|off|items?|things?|stuff|shopping|grocery|groceries|lists?|please)\b/gi,
  KILL       : /^(?:delete|cancel|remove|undo|drop|forget)\s*(?:that|it|the last one|last one|last)?[\s.!]*$/i,
  FIX_PREFIX : /^(?:no+|nope|actually|wait|sorry|oops|whoops|correction|scratch that|nvm|nevermind|never mind)\b[\s,.:;!-]*/i,
  FIX_VERB   : /^(?:make (?:it|that)|change (?:it|that)(?:\s+to)?|change to|move (?:it|that) to|set (?:it|that) to|it'?s|its)\b[\s,:-]*/i,
  EDIT_RE    : /^(?:(?:can you\s+)?(?:move|change|reschedule|resched|shift|push)\s+)?(.+?)\s+(?:is\s+)?(?:moved|changed|rescheduled|shifted|pushed|now)?\s*(?:to|for)\s+(.+)$/i,
  /* EDIT_RE alone matches nearly any sentence containing "to" or "for".
     The handler has always required a move verb as well, and the extraction
     dropped it. What sits behind this gate is a fuzzy title match at 0.5
     that REWRITES an event's date, so "tell Bryce to clean his room" could
     move a dentist appointment. The gate is the only thing preventing it. */
  EDIT_VERB  : /\b(?:move[sd]?|moving|chang(?:e[sd]?|ing)|reschedul(?:e[sd]?|ing)|resched|shift(?:s|ed|ing)?|push(?:es|ed|ing)?|now)\b/i
,

  /* --- TODOS -----------------------------------------------------------
     "my list" is the sender's todos; bare "list" stays shopping, because
     the family already learned it that way. */
  TODO_LIST  : /^(?:my\s+)?(?:to-?\s?dos?|tasks|chores|my\s+list|what(?:'s| do i have)\s+to\s+do)\s*\??$/i,

  /* Completion. Bare "done" is NOT here — TRIP_DONE owns it at stage 0 and
     changing that would clear someone's shopping list when they meant a
     chore. The nag text tells people to reply DID for exactly this reason. */
  TODO_DONE  : /^(?:did|done\s+with|finished|completed|checked\s+off)\s+(.+)$/i,
  DID_LAST   : /^(?:did(?:\s+it)?|done\s+with\s+(?:it|that)|finished(?:\s+it)?)[\s.!]*$/i,

  /* A deadline, not an appointment. "by Friday" is a due date; "by the
     register" is not, which is why the tail must parse to a bare date with
     no time and no title of its own. "before" is deliberately absent — it
     is overwhelmingly used for events ("leave before 7"). */
  DEADLINE   : /\b(?:by|due|no\s+later\s+than)\s+(?:the\s+)?([^:,]+?)\s*(?::|,|$)/i,

  /* Someone is being told to do something. */
  TODO_MODAL : /\b(?:needs?\s+to|has\s+to|have\s+to|should|must|gotta|ought\s+to)\s+(.+)$/i,
  TODO_TELL  : /^(?:tell|ask|have|get|remind)\s+(.+?)\s+to\s+(.+)$/i,
  TODO_SELF  : /^(?:remind\s+me\s+to|i\s+(?:need|have)\s+to|i\s+should|i\s+gotta)\s+(.+)$/i,
  TODO_HOUSE : /^(?:we\s+(?:need|have)\s+to|someone|somebody|anyone)\s+(?:needs?\s+to\s+)?(.+)$/i,
  TODO_TAG   : /^(?:to-?\s?do|task|chore)s?\s*:\s*(.+)$/i,

  /* --- QUESTIONS -------------------------------------------------------
     A question is answered, never filed. "anything Thursday?" used to
     become an event titled "anything". These run at stage 0, before any
     matcher that can write a row, and they need no pending question: they
     answer or they say what they can answer. */
  ASK_DINNER : /^(?:what'?s|whats|what\s+is|what\s+are\s+we\s+having)?\s*(?:for\s+)?dinner(?:\s+(.+?))?\s*\??$/i,
  ASK_GOT    : /^(?:did|has|have)\s+(\w+)\s+(?:get|got|gotten|buy|bought|pick(?:ed)?\s+up|grab(?:bed)?)\s+(?:the\s+|any\s+|some\s+)?(.+?)\s*\??$/i,
  ASK_HAVE   : /^(?:do|did)\s+we\s+(?:have|get|still\s+have|need)\s+(?:the\s+|any\s+|some\s+)?(.+?)\s*\??$/i,
  ASK_DRIVER : /^who(?:'?s|\s+is|\s+has|\s+have)?\s+(?:driving|taking|picking\s+up|getting|bringing|dropping\s+off|got|has|have)\s+(.+?)\s*\??$/i,
  ASK_DAY    : /^(?:what'?s\s+(?:on\s+)?the\s+(?:plan|schedule)|(?:what'?s|what\s+is)\s+(?:on|happening|going\s+on|up)|what\s+do\s+(?:we|i)\s+have|what\s+have\s+(?:we|i)\s+got|what'?s|what\s+is|is\s+there\s+anything|anything|schedule|plans?)\s*(?:on\s+|for\s+)?(.*?)\s*\??$/i
};

/* A fragment that is nothing but a day: "thursday", "tomorrow", "" (today).
   Returns the date, or null when the fragment carries a title or a clock. */
function bareDate(fragment, opts) {
  const f = String(fragment || '').trim();
  const now = opts.now || new Date();
  if (!f || /^(?:today|tonight|now)$/i.test(f)) return ymd(now);
  const q = parseQuickAdd(f, { members: [], now });
  if (!q.matched.includes('date')) return null;
  if (q.matched.includes('time'))  return null;
  if (q.title && q.title !== 'Untitled') return null;
  return q.date;
}

/* opts: { members, now }. Returns an ask_* intent or null. */
function askIntent(body, opts = {}) {
  const text = String(body || '').trim();
  const members = opts.members || [];
  let m;

  if ((m = text.match(ROUTE_RE.ASK_DINNER))) {
    const date = bareDate(m[1], opts);
    /* "dinner is leftovers" has a tail that is not a day — not a question. */
    if (date) return { intent: 'ask_dinner', date };
  }

  if ((m = text.match(ROUTE_RE.ASK_GOT))) {
    const who = whoIn(m[1], members);
    return { intent: 'ask_got', item: m[2].trim(), who: who[0] || null };
  }
  if ((m = text.match(ROUTE_RE.ASK_HAVE))) {
    return { intent: 'ask_got', item: m[1].trim(), who: null };
  }

  if ((m = text.match(ROUTE_RE.ASK_DRIVER))) {
    const who = whoIn(m[1], members);
    let rest = m[1];
    for (const n of who) rest = rest.replace(new RegExp(`\\b${n}\\b`, 'ig'), ' ');
    rest = rest.replace(/\s+/g, ' ').trim();
    /* "who's driving Addie to practice Thursday" — the place is not a day,
       but the question is still about Thursday, so any date in the tail
       counts. No date means today. */
    const q = rest ? parseQuickAdd(rest, { members: [], now: opts.now || new Date() }) : null;
    const date = q && q.matched.includes('date') ? q.date : ymd(opts.now || new Date());
    return { intent: 'ask_driver', who: who[0] || null, date };
  }

  if ((m = text.match(ROUTE_RE.ASK_DAY))) {
    const who = whoIn(m[1], members);
    let rest = m[1];
    for (const n of who) rest = rest.replace(new RegExp(`\\b${n}(?:'s)?\\b`, 'ig'), ' ');
    rest = rest.replace(/\s+/g, ' ').trim();
    const date = bareDate(rest, opts);
    if (date) return { intent: 'ask_day', date, who: who[0] || null };
  }

  return null;
}

/* Does this text name a store? Returns the store row or null. */
function routeStoreIn(stores, text) {
  const hit = storeTerms(stores || []).find(({ text: t }) =>
    new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
  return hit ? hit.store : null;
}

/* A clearing verb followed by nothing but a store and filler is a bulk clear.
   The same verb followed by an item name is not. This is checked BEFORE the
   scoped view or "remove HEB list" reads as "show me the HEB list" — nearly
   the same words, opposite outcomes. */
function bulkClearTarget(body, stores) {
  const cv = body.match(ROUTE_RE.CLEAR_VERB);
  if (!cv) return null;
  const st = routeStoreIn(stores, cv[1] || '');
  let rest = cv[1] || '';
  if (st) for (const { text } of storeTerms([st])) {
    rest = rest.replace(new RegExp(`\\b${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'ig'), ' ');
  }
  rest = rest.replace(ROUTE_RE.BULK_FILLER, ' ').replace(/[^a-z0-9 ]/gi, ' ').trim();
  if (rest) return null;                       // named an item, not a bulk clear
  return { store: st || null };
}

/* opts: { stores, members, now, me }
   Returns { intent, ... }. The order here IS the handler's order; changing
   one without the other is the bug this function exists to prevent.

   `from` continues the chain past a stage that did not resolve. A correction
   that names nothing falls through to shop_remove, NOT past it — getting
   that wrong is how "no bike" would have stopped removing bike. */
function routeIntent(body, opts = {}, from = 0) {
  const text   = String(body || '').trim();
  const stores = opts.stores || [];
  const next   = () => routeIntent(text, opts, from + 1);

  /* 0 */ if (from <= 0) {
    /* A kid asking for a ride (§21). Only when the handler says the sender
       is a kid; an adult's identical words never come here. */
    const ride = rideRequestIntent(text, opts);
    if (ride) return ride;
    if (ROUTE_RE.LIST_CMD.test(text))  return { intent: 'show', store: null };
    /* "my list" / "todos" / "chores". Bare "list" stays shopping above,
       because the family already learned it that way. */
    if (ROUTE_RE.TODO_LIST.test(text)) return { intent: 'todo_show', who: opts.me || null };
    if (ROUTE_RE.TRIP_DONE.test(text)) return { intent: 'trip_done', store: routeStoreIn(stores, text) };
    const bulk = bulkClearTarget(text, stores);
    if (bulk) return { intent: 'clear', store: bulk.store };
    const ls = text.match(ROUTE_RE.LIST_SCOPED);
    if (ls) {
      const st = routeStoreIn(stores, ls[1]);
      if (st) return { intent: 'show', store: st };
      /* Not a store, so try a person. "Bryce's list" used to become an
         EVENT titled "list" on Bryce's calendar. */
      const who = whoIn(ls[1], opts.members || []);
      if (who.length) return { intent: 'todo_show', who: who[0] };
    }
    /* A pasted block. A schedule (≥3 lines, ≥2 dated) becomes many rows
       behind one confirm; a pasted list with no dates at all and mostly
       groceries goes to the shopping list in one go, through the same
       multi-item path a comma list takes. Both before the questions and
       the tails, after the list commands, so "list" alone never gets here. */
    if (splitSeasonLines(text).length >= 3) {
      /* A weekly ad (three or more priced lines) is unmistakable and is
         checked first: its "9/10 thru 9/16" and "10-13 oz" would otherwise
         read as a schedule. Nobody texts an ad; the app reads it. */
      if (looksLikeAd(text)) return { intent: 'ad' };
      if (looksLikeSeason(text, opts)) return { intent: 'season', season: parseSeason(text, opts) };
      const probe = parseShopping(text, { stores, catalog: opts.catalog || [] });
      const known = probe.items.filter(i => i.category !== 'other').length;
      if (probe.items.length >= 3 && known * 2 >= probe.items.length) return { intent: 'shop' };
    }
    /* Not happening: a sick kid, a snow day, a parent away, one rehearsal
       cancelled. Before the questions and before the remove/kill verbs at
       stage 2 — "no school Friday" is not a shopping correction. */
    const abs = absenceIntent(text, opts);
    if (abs) return abs;
    /* "3 for dinner" — the headcount; then "dinner is leftovers" — the meal. */
    const rw = repeatWeekIntent(text);
    if (rw) return rw;
    const hc = headcountIntent(text, opts);
    if (hc) return hc;
    const din = dinnerIntent(text, opts);
    if (din) return din;
    /* Questions. Before anything that can write a row: "anything
       Thursday?" was becoming an event titled "anything". */
    const ask = askIntent(text, opts);
    if (ask) return ask;
  }

  /* 1 — a correction to whatever just happened. Runs before the edit matcher
         on purpose: "no, make it 4" names no event, so the edit matcher would
         either miss it or match something unrelated on the word "make". */
  if (from <= 1) {
    /* "did it" / "finished" with no object: only the last thing they were
       told about can be meant. NOT bare "done" — TRIP_DONE owns that at
       stage 0, and Jess replying "done" to Bryce's nag must not wipe her
       shopping list. The nag text says to reply DID for exactly this. */
    if (ROUTE_RE.DID_LAST.test(text)) {
      return { intent: 'stateful', why: 'did', otherwise: routeIntent(text, opts, 2) };
    }
    const pre  = text.match(ROUTE_RE.FIX_PREFIX);
    const rest = pre ? text.slice(pre[0].length).trim() : text;
    if (pre || ROUTE_RE.FIX_VERB.test(rest) || ROUTE_RE.KILL.test(rest) || ROUTE_RE.KILL.test(text)) {
      return { intent: 'stateful', why: 'correction', otherwise: routeIntent(text, opts, 2) };
    }
  }

  /* 2 — off the shopping list. Before the calendar's delete, because
         "remove milk" is almost never an appointment. */
  if (from <= 2) {
    /* Above shop_remove/got deliberately: "have Bryce clean the garage"
       would otherwise read as "have <item>" and dead-end on the shopping
       list. The "no bike" ordering already proved how much this matters. */
    const td = text.match(ROUTE_RE.TODO_DONE);
    if (td) return { intent: 'todo_done', text: td[1] };
    if (todoStrong(text, opts)) return { intent: 'todo' };

    const rm = text.match(ROUTE_RE.SHOP_REMOVE);
    if (rm) return { intent: 'shop_remove', text: rm[1] };
    const gt = text.match(ROUTE_RE.SHOP_GOT);
    if (gt) return { intent: 'shop_got', text: gt[1] };
  }

  /* 3 — moving something already on the calendar. */
  if (from <= 3) {
    if (ROUTE_RE.EDIT_RE.test(text) && ROUTE_RE.EDIT_VERB.test(text)) {
      return { intent: 'stateful', why: 'edit', otherwise: routeIntent(text, opts, 4) };
    }
  }

  /* 4 — the final call. */
  return routeTail(text, opts);
}

/* The final call, once corrections and edits have been ruled out. Split out
   so 'stateful' can carry it: the handler falls through to exactly this when
   no correction or edit actually resolves. */
function routeTail(text, opts = {}) {
  const stores = opts.stores || [];
  const p = parseQuickAdd(text, {
    members: opts.members || [], now: opts.now, me: opts.me
  });
  const hasWhen = p.matched.includes('date') || p.matched.includes('time') || !!p.repeat;

  /* A question mark that got this far is not a request to file anything.
     "Dentist Thursday?" is genuinely ambiguous — asking about Thursday, or
     adding the dentist? Ask rather than guess: answer the day, and offer
     the add as a numbered reply. Anything else ending in "?" gets told what
     can be answered. Neither writes a row. */
  if (ROUTE_RE.SHOP_STRONG.test(text)) return { intent: 'shop' };

  if (/\?\s*$/.test(text)) {
    const body = text.replace(/\?\s*$/, '').trim();
    const questiony = /^(?:what|who|when|where|why|how|is|are|do|does|did|can|could|any|anything)\b/i.test(p.title || '');
    if (p.matched.includes('date') && !p.repeat) {
      /* "is there soccer Saturday?" names a day and asks: answer the day.
         "Dentist Thursday?" names a day and a thing: answer the day AND
         offer to add the thing, as a numbered reply. */
      if (p.title && p.title !== 'Untitled' && !questiony) {
        return { intent: 'ask_day', date: p.date, who: null, offer: body, offerTitle: p.title };
      }
      return { intent: 'ask_day', date: p.date, who: null };
    }
    return { intent: 'ask_help' };
  }

  /* An imperative chore verb wins even against a clock. "Take out trash every
     Tuesday morning at 7" is a chore that has a preferred hour, not an
     appointment — and todos carry a due_time now, so the 7 is kept rather
     than dropped. This is checked BEFORE the clock rule below. Names in
     front are looked past: "Bryce take out the trash every Tuesday" is the
     same chore with an owner, not a weekly event. */
  if (looksLikeTodo(text, opts.members)) return { intent: 'todo' };

  /* Everything else with a clock is an appointment, whatever frame wraps it.
     "I need to leave for the airport Friday 6am" reads like a todo — "need
     to" is a todo frame — but "leave" is not a chore, and the 6am is the
     whole point of the message. */
  if (p.matched.includes('time')) return { intent: 'event' };

  if (ROUTE_RE.SHOP_WEAK.test(text) && !hasWhen) {
    const probe = parseShopping(text, { stores });
    if (probe.items.some(i => i.category !== 'other')) return { intent: 'shop' };
  }

  if (!hasWhen && parseShopping(text, { stores }).store) return { intent: 'shop' };

  /* Name plus nothing is now three-way ambiguous — "Bryce garage" could be a
     chore, an event, or a shopping run. Ask, rather than file an all-day
     event on Bryce's calendar, which is what used to happen and was almost
     never what anyone meant. */
  if (!hasWhen) return { intent: 'ask' };
  return { intent: 'event' };
}

/* ===========================================================================
 * 13. TODOS
 *
 * A todo is a verb phrase somebody owes. An event is a noun with a clock.
 * "Soccer Thursday 5:30" is an event; "clean your room by Friday" is a todo;
 * "buy milk" is shopping. The three are told apart by the shape of the
 * sentence, and where the shape is genuinely ambiguous the answer is to ask.
 *
 * The deadline preposition is the strongest signal there is and it is the
 * one people actually use. Events say AT and ON — "practice at 5", "dentist
 * on Thursday". Todos say BY — "clean your room by Friday". That single word
 * separates them cleanly, but only if the thing after it is a bare date:
 * "pick up milk by the register" is shopping and must stay shopping.
 * ========================================================================= */

/* The imperative verbs a chore starts with. Every word here was checked
   against the live routing chain: anything that also opens a shopping or
   remove or edit phrase is deliberately absent, because those already have
   an owner and stealing them would break behaviour the family relies on.

   Missing on purpose: get, grab, pick up, add, need, order, buy (shopping);
   remove, delete, drop, clear, wipe, erase, scratch, cancel (remove/kill);
   move, change, reschedule, shift, push (edit); have, got, bought (got);
   show, see, list (the list). So "pick up the dry cleaning" routes to
   shopping — the cost of "pick up" belonging to groceries. Say "needs to
   pick up the dry cleaning" and it lands right. */
const TODO_VERBS = [
  'clean','tidy','wash','fold','iron','vacuum','sweep','mop','dust',
  'mow','rake','water','weed','feed','walk','bathe','brush',
  'take out','throw out','throw away','put away','put up','hang','pack','unpack',
  'load','unload','fix','repair','replace','install','paint','organize','sort',
  'finish','study','read','write','call','text','email','pay',
  /* NOT 'practice'. It is a chore verb ("practice piano") and also the
     noun this family has most on the calendar — soccer practice, orchestra
     practice. "Practice is moved to 6" was routing as a chore. A word that
     is both loses, because the calendar collision is the expensive one. */
  'return','renew','book','schedule','sign','fill out','submit','print',
  'mail','ship','drop off','look up','check','research','plan','set up','start',
];
const TODO_VERB_RE = new RegExp(
  '^(?:please\\s+|can\\s+you\\s+)?(?:' +
  TODO_VERBS.map(v => v.replace(/ /g, '\\s+')).join('|') +
  ')\\b\\s+\\S', 'i');

/* Calendar nouns that happen to START with a chore verb. "Book club Tuesday
   7pm" opens with "book", "study group" with "study", "check up" with
   "check" — and each is an appointment, never a chore. Same rule that took
   "practice" out of the verb list, applied to the compounds this family
   actually says, so the verbs themselves can stay useful ("book the dentist",
   "study for the test", "water the plants"). */
const CAL_NOUN_RE = /^(?:please\s+|can\s+you\s+)?(?:book\s+club|study\s+(?:group|hall|session)|check[\s-]?up|water\s+polo|paint\s+night|(?:walk|read)[\s-]?a[\s-]?thon)\b/i;

/* A deadline only counts when what follows is a bare date. "by Friday" is a
   due date. "by the register", "by the dozen", "by 8pm" are not — the last
   one has a time, which makes it an event with a reminder, and the schema
   has no due time so that is the honest answer. */
function deadlineOf(text, opts) {
  const m = String(text).match(ROUTE_RE.DEADLINE);
  if (!m) return null;
  const q = parseQuickAdd(m[1], { members: [], now: opts.now, me: opts.me });
  if (!q.matched.includes('date')) return null;
  if (q.matched.includes('time'))  return null;
  if (q.title && q.title !== 'Untitled') return null;
  return { date: q.date, span: m[0] };
}

/* Unmistakably a chore: an explicit tag, a modal, someone told to do it, or
   a real deadline. These beat shopping and the edit matcher. */
function todoStrong(text, opts) {
  const t = String(text).trim();
  /* A clock outranks a chore FRAME but not a chore VERB. "I need to leave
     for the airport Friday 6am" is an appointment however it is phrased;
     "take out the trash Tuesday at 7" is a chore with a preferred hour. */
  if (!looksLikeTodo(t, opts.members)) {
    const q = parseQuickAdd(t, { members: [], now: opts.now, me: opts.me });
    if (q.matched.includes('time')) return false;
  }
  if (ROUTE_RE.TODO_TAG.test(t))   return true;
  if (ROUTE_RE.TODO_SELF.test(t))  return true;
  if (ROUTE_RE.TODO_TELL.test(t))  return true;
  if (ROUTE_RE.TODO_MODAL.test(t)) return true;
  if (ROUTE_RE.TODO_HOUSE.test(t)) return true;
  if (deadlineOf(t, opts)) return true;
  return false;
}

/* opts: { members, now, me, senderRole }
   Returns { title, assignees:[name], due_on, repeat, house, warnings:[] } */
function parseTodo(input, opts = {}) {
  let text = String(input || '').trim();
  const out = { title: '', assignees: [], due_on: null, due_time: null,
                repeat: null, house: false, warnings: [] };

  const tag = text.match(ROUTE_RE.TODO_TAG);
  if (tag) text = tag[1].trim();

  /* Pull the deadline out before anything else parses it as an event date. */
  const dl = deadlineOf(text, opts);
  if (dl) { out.due_on = dl.date; text = text.replace(dl.span, ' ').trim(); }

  /* Who owes it. The frames are ordered most-specific first. */
  let body = text;
  const tell = text.match(ROUTE_RE.TODO_TELL);
  const self = text.match(ROUTE_RE.TODO_SELF);
  const hous = text.match(ROUTE_RE.TODO_HOUSE);

  if (self)      { body = self[1]; out.assignees = [opts.me].filter(Boolean); }
  else if (hous) { body = hous[1]; out.house = true; }
  else if (tell) { body = tell[2]; out.assignees = whoIn(tell[1], opts.members); }
  else {
    const modal = text.match(ROUTE_RE.TODO_MODAL);
    if (modal) {
      const before = text.slice(0, text.length - modal[0].length);
      body = modal[1];
      out.assignees = whoIn(before, opts.members);
    } else {
      /* "Bryce clean room" / "Bryce and Addie clean the garage" — names at
         the front, verb phrase after. */
      const lead = leadingNames(text, opts.members);
      if (lead) { out.assignees = lead.names; body = lead.rest; }
    }
  }

  /* A date still in the body ("mow the lawn Saturday") is the due date, and
     a repeat ("every Tuesday") is the recurrence. Names are NOT re-read
     here: the frames above already settled who owes it. */
  const q = parseQuickAdd(body, { members: [], now: opts.now, me: opts.me });
  if (!out.due_on && q.matched.includes('date')) out.due_on = q.date;
  /* A chore can have a preferred hour without being an appointment. Keeping
     it means the nag fires then instead of at the household default. */
  if (q.matched.includes('time') && q.start) {
    out.due_time = q.start;
    /* An hour with no day means today — "finish homework by 8pm" is not a
       chore floating in the calendar with a time attached to nothing. */
    if (!out.due_on) out.due_on = q.date;
  }
  if (q.repeat) {
    out.repeat = q.repeat;
    /* A repeating chore needs a first occurrence or nothing ever nags and
       nothing ever advances. "Feed the dog every day" starts today; "every
       Tuesday" already carries next Tuesday as its date. */
    if (!out.due_on) out.due_on = q.date || null;
  }

  out.title = tidyTodoTitle(q.title && q.title !== 'Untitled' ? q.title : body);
  if (!out.assignees.length && !out.house) out.assignees = [opts.me].filter(Boolean);
  if (!out.title) out.warnings.push('nothing to do');
  return out;
}

/* Names at the front of a sentence, followed by a verb phrase. */
function leadingNames(text, members) {
  const roster = (members || []).map(m => typeof m === 'string' ? { name: m, aliases: [] } : m);
  const found = [];
  let rest = String(text);
  for (;;) {
    let hit = null;
    for (const mem of roster) {
      for (const term of [mem.name, ...(mem.aliases || [])]) {
        if (!term) continue;
        const re = new RegExp(`^\\s*(?:and\\s+|,\\s*)?${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[\\s,:]*`, 'i');
        const m = rest.match(re);
        if (m && (!hit || m[0].length > hit.m[0].length)) hit = { m, name: mem.name };
      }
    }
    if (!hit) break;
    if (!found.includes(hit.name)) found.push(hit.name);
    rest = rest.slice(hit.m[0].length);
  }
  if (!found.length || !rest.trim()) return null;
  return { names: found, rest: rest.trim() };
}

/* Which of the roster appear anywhere in a fragment. */
function whoIn(fragment, members) {
  const roster = (members || []).map(m => typeof m === 'string' ? { name: m, aliases: [] } : m);
  const out = [];
  for (const mem of roster) {
    for (const term of [mem.name, ...(mem.aliases || [])]) {
      if (!term) continue;
      if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(fragment)) {
        if (!out.includes(mem.name)) out.push(mem.name);
        break;
      }
    }
  }
  return out;
}

function tidyTodoTitle(t) {
  let s = String(t || '').replace(/\s+/g, ' ').trim()
    .replace(/^(?:please|can you|to)\s+/i, '')
    /* A dangling deadline preposition: "finish homework by 8pm" has its
       clock taken as a due time, which leaves the "by" behind. */
    .replace(/\s+\b(?:by|due|before|no later than)\s*$/i, '')
    .replace(/[\s,.;:]+$/, '');
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* Is this text shaped like a chore at all? Used by the weak tail.

   Names in front do not change the shape. "Bryce take out the trash every
   Tuesday" is the archetypal chore, and it was filing itself as a CALENDAR
   EVENT on Bryce's Tuesdays because the verb test was anchored at the start
   of the sentence and the name sat in front of it. The names are stripped
   with the same leadingNames() parseTodo uses to assign the chore, so the
   two cannot disagree about where the verb starts. "Bryce soccer practice
   Tuesday at 5" strips to "soccer practice ..." and is still an event. */
function looksLikeTodo(text, members) {
  const t = String(text).trim();
  const chore = s => TODO_VERB_RE.test(s) && !CAL_NOUN_RE.test(s);
  if (chore(t)) return true;
  if (!members || !members.length) return false;
  const lead = leadingNames(t, members);
  return !!lead && chore(lead.rest);
}

/* ===========================================================================
 * 14. INGREDIENTS
 *
 * A recipe line is a quantity, a unit, and a thing — "2 cups shredded sharp
 * cheddar" — written by someone who was not thinking about a database.
 * Fractions come as ½ and as 1/2 and as "1 1/2". Ranges say "1-2". A can
 * size hides inside parentheses: "2 (14 oz) cans" is two cans, not fourteen
 * of anything. This turns each of those into numbers the shopping list can
 * scale, while keeping the ORIGINAL string, because "shredded sharp cheddar"
 * is what the cook needs to read and "shredded cheese" is what the list
 * needs to buy. Losing the first is how someone can no longer follow their
 * own recipe.
 * ========================================================================= */

const VULGAR = { '½':0.5,'⅓':1/3,'⅔':2/3,'¼':0.25,'¾':0.75,'⅛':0.125,'⅜':0.375,'⅝':0.625,'⅞':0.875 };

/* \b BEFORE the optional period. With the period first, "tsp. Black pepper"
   found no word boundary after "." and backtracked to "tsp" + ". Black
   pepper" — and every abbreviated unit in a recipe left its full stop on the
   front of the ingredient's name. */
const UNIT_RE = new RegExp('^(' + UNIT_WORDS.map(u => u.replace(/ /g,'\\s+')).join('|') + ')\\b\\.?\\s*', 'i');
/* Recipe shorthand → the word the scaler knows. "C." is a cup; scale_qty()
   in SQL only rounds to quarters for units it has heard of. */
const UNIT_CANON = { c: 'cup', tb: 'tbsp', tbs: 'tbsp', pkg: 'package', gal: 'gallon', pt: 'pint', qt: 'quart' };

/* A size in front of a container is a SIZE, not a unit. "2 Gallon Ziploc
   Bag" is two bags, gallon-sized — never half a gallon of anything. */
const SIZE_BEFORE_CONTAINER = /^(gallons?|quarts?|pints?|\d+(?:\.\d+)?\s*(?:fl\s*)?(?:oz|ounces?)\.?)\s+(?=(?:ziploc\s+|freezer\s+|storage\s+|mason\s+)?(?:bags?|jars?|containers?|pots?|bottles?|tubs?|cans?)\b)/i;
const CONTAINER_PLURAL = { bag: 'bags', jar: 'jars', container: 'containers', pot: 'pots', bottle: 'bottles', tub: 'tubs', can: 'cans' };

/* "1 1/2", "1½", "½", "1.5", "2", "1-2", "1 to 2" → a number, or null. */
function readQty(s) {
  const t = String(s).trim();
  /* Each helper keeps its own match. Sharing one `m` between the range test
     and the per-side reader meant reading the left side overwrote the match
     the right side still needed. */
  const one = x => {
    x = x.trim(); let k;
    if (VULGAR[x] != null) return VULGAR[x];
    if ((k = x.match(/^(\d+)\s*([½⅓⅔¼¾⅛⅜⅝⅞])$/))) return +k[1] + VULGAR[k[2]];
    if ((k = x.match(/^(\d+)\s+(\d+)\/(\d+)$/)))  return +k[1] + (+k[2] / +k[3]);
    if ((k = x.match(/^(\d+)\/(\d+)$/)))          return +k[1] / +k[2];
    if ((k = x.match(/^\d+(?:\.\d+)?$/)))          return parseFloat(x);
    return null;
  };
  /* A range: shop for the larger. "1-2 onions" means you might need two. */
  const r = t.match(/^(.+?)\s*(?:-|–|\bto\b)\s*(.+)$/);
  if (r) {
    const a = one(r[1]), b = one(r[2]);
    if (a != null && b != null) return Math.max(a, b);
  }
  return one(t);
}

/* "1 ⅔" — a whole number, a space, a vulgar fraction — is how recipe sites
   print one and two-thirds. It was reading as "1" with "⅔" left in the name. */
const QTY_HEAD = /^((?:\d+\s+\d+\/\d+|\d+\s+[½⅓⅔¼¾⅛⅜⅝⅞]|\d+\/\d+|\d+(?:\.\d+)?[½⅓⅔¼¾⅛⅜⅝⅞]?|[½⅓⅔¼¾⅛⅜⅝⅞])(?:\s*(?:-|–|to)\s*(?:\d+\s+\d+\/\d+|\d+\s+[½⅓⅔¼¾⅛⅜⅝⅞]|\d+\/\d+|\d+(?:\.\d+)?[½⅓⅔¼¾⅛⅜⅝⅞]?|[½⅓⅔¼¾⅛⅜⅝⅞]))?)\s*/;

/* opts: { catalog }  — same catalog the shopping parser trusts. */
function parseIngredient(line, opts = {}) {
  const original = String(line || '').replace(/\s+/g, ' ').trim();
  const out = { original, name: '', qty: null, unit: null, note: null, optional: false, category: 'other' };
  if (!original) return out;

  let t = original
    .replace(/^[-•*·•]\s*/, '')                 // bullet
    .replace(/^\d+[.)]\s+(?=\D)/, '');                // "1. " step numbering, not a qty
  const notes = [];

  /* (optional) anywhere. */
  if (/\boptional\b/i.test(t)) { out.optional = true; t = t.replace(/[,(]?\s*optional\)?/i, ' '); }

  /* Quantity at the front. "a pinch", "an onion", "a can of" — an article
     is a quantity of one, and it is how recipes are actually written. */
  let m = t.match(QTY_HEAD);
  if (m) { out.qty = readQty(m[1]); t = t.slice(m[0].length); }
  else if ((m = t.match(/^an?\s+(?=\S)/i))) { out.qty = 1; t = t.slice(m[0].length); }

  /* "(14 oz)" right after the quantity is a SIZE, not a count. Keep it as a
     note so the cook still sees it, but never multiply it. */
  if ((m = t.match(/^\(([^)]*)\)\s*/))) { notes.push(m[1]); t = t.slice(m[0].length); }

  /* A size before a container: "2 Gallon Ziploc Bag" → 2 × "ziploc bags",
     note "gallon". Checked before the unit rule, which would otherwise read
     half a gallon of bag. */
  if ((m = t.match(SIZE_BEFORE_CONTAINER))) {
    notes.push(m[1].toLowerCase().replace(/\.$/, ''));
    t = t.slice(m[0].length);
    if ((out.qty ?? 1) > 1) t = t.replace(/\b(bag|jar|container|pot|bottle|tub|can)\b(?!s)/i, w => CONTAINER_PLURAL[w.toLowerCase()] || w);
  }
  /* Unit. */
  else if ((m = t.match(UNIT_RE))) {
    const u = m[1].toLowerCase().replace(/\s+/g,' ');
    out.unit = UNIT_CANON[u] || u;
    t = t.slice(m[0].length);
  }
  t = t.replace(/^of\s+/i, '');

  /* Trailing prep notes: ", chopped" / ", divided" / "(about 2 cups)". */
  if ((m = t.match(/\(([^)]*)\)/))) { notes.push(m[1]); t = t.replace(m[0], ' '); }
  if ((m = t.match(/,\s*(.+)$/)))    { notes.push(m[1]); t = t.slice(0, m.index); }
  t = t.replace(/\s+/g, ' ').trim();

  if (notes.length) out.note = notes.join('; ');

  /* The thing itself goes through the same normalization the shopping list
     uses, so a recipe's "shredded sharp cheddar" and a text saying "cheese"
     land on the same catalog row. */
  const shop = parseShopping(t, { catalog: opts.catalog || [], stores: [] });
  if (shop.items.length === 1) {
    /* One thing, as expected: take the normalized, brand-repaired name. */
    const it = shop.items[0];
    out.name = it.name; out.category = it.category;
    out.pickYourself = !!it.pickYourself; out.onlineOk = !!it.onlineOk;
  } else {
    /* The list parser split it — "diced tomatoes" into "diced" + "tomatoes".
       An ingredient line is ONE item by definition, so keep the phrase whole.
       Classify the WHOLE phrase first: "black pepper" is a spice, and only
       its second half is a vegetable. Fall back to the most specific
       category any piece produced. */
    out.name = t.toLowerCase().replace(/[.,;:]+$/, '');
    const whole = catOf(out.name, opts.catalog || []);
    if (whole !== 'other') {
      out.category = whole; Object.assign(out, freshness(whole));
    } else {
      const best = shop.items.find(i => i.category !== 'other');
      if (best) {
        out.category = best.category;
        out.pickYourself = !!best.pickYourself; out.onlineOk = !!best.onlineOk;
      }
    }
  }
  return out;
}

/* ===========================================================================
 * 15. SEASONS
 *
 * The orchestra schedule arrives once a season as a PDF or an email: a
 * header line and twenty dated lines. Typed one at a time, most never get
 * typed, and then a kid is standing outside a school with no ride alert.
 * This reads the whole block at once. It is a loop over parseQuickAdd —
 * there is no second date grammar here — plus three things a schedule has
 * that a single message does not:
 *
 *   - a HEADER: "Orchestra rehearsals — Addie, Jess driving". No date. Its
 *     title, people and roles carry down to every dated line that lacks them.
 *   - a DATE LIST: "Sept 15, 22, 29 — 6:30 pm" is three rows, not one.
 *   - a PLACE after "@": "Sat Oct 3 vs Tigers 9am @ Bear Branch". The "@" is
 *     a delimiter, not a location grammar; "at the church" stays in the title.
 *
 * Lines it cannot date come back with ok:false and their raw text, shown
 * unticked and never guessed. Rows are one-off events, never a recurrence —
 * schedules are irregular by nature; that is why they are pasted.
 * ========================================================================= */

const SEASON_MAX = 60;
const WEEKDAY_LEAD = /^(?:(?:sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?\.?,?)\s+/i;
const MN_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
/* "Sept 15, 22, 29" / "Sept 15, 22 & 29" / "9/15, 9/22, 9/29" */
const DATE_LIST_MONTH = new RegExp(`\\b(${MN_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?((?:\\s*(?:,|&|and)\\s*(?:and\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\b)+)`, 'i');
const DATE_LIST_NUM   = /\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)((?:\s*(?:,|&|and)\s*(?:and\s+)?\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b)+)/i;

/* Break a block into candidate lines: newlines, semicolons, bullets. */
function splitSeasonLines(text) {
  return String(text || '')
    .split(/\r?\n|;/)
    .map(l => l.replace(/^\s*(?:[-–•*·]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
}

/* One line that names several dates becomes several lines. */
function expandDateList(line) {
  let m = line.match(DATE_LIST_MONTH);
  if (m) {
    const days = [m[2], ...m[3].match(/\d{1,2}/g)];
    return days.map(d => line.replace(m[0], `${m[1]} ${d}`));
  }
  m = line.match(DATE_LIST_NUM);
  if (m) {
    const dates = [m[1], ...m[2].match(/\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/g)];
    return dates.map(d => line.replace(m[0], d));
  }
  return [line];
}

function tidySeasonTitle(t) {
  return String(t || '')
    .replace(/\s*[—–\-:]+\s*$/, '')
    .replace(/^\s*[—–\-:]+\s*/, '')
    .replace(/\b(?:fall|spring|summer|winter)\s+\d{4}\b|\b20\d{2}\b/ig, '')
    .replace(/\s+/g, ' ').trim();
}

/* Is this block a schedule? ≥3 lines, ≥2 of them carrying a date, and a
   question is never a schedule line. Cheap enough to run on every message. */
function looksLikeSeason(text, opts = {}) {
  const lines = splitSeasonLines(text);
  if (lines.length < 3) return false;
  let dated = 0;
  for (const l of lines) {
    if (/\?\s*$/.test(l)) continue;
    for (const piece of expandDateList(l)) {
      const q = parseQuickAdd(piece.replace(WEEKDAY_LEAD, ''), { members: [], now: opts.now });
      if (q.matched.includes('date')) { dated++; break; }
    }
    if (dated >= 2) return true;
  }
  return false;
}

/* opts: { members, now, me }
   Returns { title, who:[names], people:[{name,role}], rows:[...], skipped:[raw] }.
   Each row: { ok, date, start, end, allDay, title, location, people, raw }. */
function parseSeason(text, opts = {}) {
  const now = opts.now || new Date();
  const lines = splitSeasonLines(text);
  const out = { title: '', who: [], people: [], rows: [], skipped: [] };

  /* The header: the first line, when it carries no date. */
  let start = 0;
  if (lines.length) {
    const h = parseQuickAdd(lines[0], { members: opts.members || [], now, me: opts.me });
    if (!h.matched.includes('date') && !h.repeat) {
      out.title  = tidySeasonTitle(h.title === 'Untitled' ? '' : h.title);
      out.title  = out.title.charAt(0).toUpperCase() + out.title.slice(1);
      out.people = h.people || [];
      out.who    = out.people.map(p => p.name);
      start = 1;
    }
  }

  const seen = new Set();
  for (const raw of lines.slice(start)) {
    if (out.rows.length >= SEASON_MAX) { out.skipped.push(raw); continue; }
    if (/\?\s*$/.test(raw)) {
      out.skipped.push(raw);
      out.rows.push({ ok: false, raw, title: null, date: null, start: null, end: null,
                      allDay: false, location: null, people: [] });
      continue;
    }

    /* "@ Bear Branch" is the place; everything before it is the event. */
    let location = null, body = raw;
    const at = raw.indexOf('@');
    if (at > 0) { location = raw.slice(at + 1).trim() || null; body = raw.slice(0, at).trim(); }

    for (const piece of expandDateList(body)) {
      /* A leading "Tue" is decoration on "Tue 9/15"; only strip it when an
         explicit date remains, so "Saturday 9am" still dates itself. */
      const qopts = { members: opts.members || [], now, me: opts.me };
      let q = parseQuickAdd(piece.replace(WEEKDAY_LEAD, ''), qopts);
      if (!q.matched.includes('date')) q = parseQuickAdd(piece, qopts);
      if (!q.matched.includes('date')) {
        out.skipped.push(raw);
        out.rows.push({ ok: false, raw, title: null, date: null, start: null, end: null,
                        allDay: false, location: null, people: [] });
        break;
      }

      let own = tidySeasonTitle(q.title === 'Untitled' ? '' : q.title)
        .replace(/^(?:home|away)\b/i, s => s.toLowerCase());
      let title;
      if (!own)            title = out.title;
      else if (!out.title) title = own;
      else if (own.toLowerCase().includes(out.title.toLowerCase())) title = own;
      else if (/^(?:vs\.?|v\.?|home|away|at)\b/i.test(own)) title = `${out.title} ${own}`;
      else title = `${out.title} — ${own}`;
      title = title.replace(/\s+/g, ' ').trim();
      if (!title) title = 'Untitled';
      title = title.charAt(0).toUpperCase() + title.slice(1);

      const people = (q.people && q.people.length) ? q.people : out.people;
      const key = `${q.date}|${q.allDay ? 'allday' : q.start}|${title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.rows.push({
        ok: true, date: q.date, start: q.allDay ? null : q.start, end: q.allDay ? null : q.end,
        allDay: q.allDay, title, location, people, raw
      });
    }
  }
  return out;
}

/* ===========================================================================
 * 16. ABSENCES AND SKIPS
 *
 * The month's most common interruption is somebody not being where the
 * calendar says: a sick kid, a snow day, a parent out of town, one rehearsal
 * cancelled. Today the app makes it worse — the driver alert still fires at
 * 3:15 for an orchestra nobody is going to. One grammar for "not happening":
 *
 *   Bryce is sick [today|tomorrow|<date>]       → absence, kind 'sick'
 *   snow day / no school [Friday]               → absence, kind 'school_closed'
 *   Erich is away Tue–Thu / I'm out of town …   → absence, kind 'away'
 *   no orchestra Mar 9–13 / skip soccer Saturday / orchestra is cancelled
 *                                               → skip_event
 *   Bryce is fine / Bryce is back / school is on / cancel the skip
 *                                               → unskip
 *
 * Ranges reuse the date grammar in parseQuickAdd for each end — "Tue–Thu",
 * "Mar 9–13", "9/15-9/18", "through Friday", "this week" — there is no
 * second date parser here. Default is today. "no <thing>" needs a date, or
 * "no bike" would stop taking bike off the shopping list.
 * ========================================================================= */

const ABS_RE = {
  SICK   : /^(.+?)\s+(?:is|are|'s|s)?\s*(?:home\s+sick|out\s+sick|sick|stayed\s+home|staying\s+home|home\s+today|out)(?:\s+(.*))?$/i,
  SCHOOL : /^(?:snow\s+day|ice\s+day|no\s+school|school(?:'s|\s+is)?\s+(?:closed|cancelled|canceled|out|off))(?:\s+(.*))?$/i,
  AWAY   : /^(.+?)\s*(?:is|are|am|'m|'s)?\s*(?:away|traveling|travelling|out\s+of\s+town|gone|on\s+a\s+trip)(?:\s+(.*))?$/i,
  SKIP   : /^skip\s+(?:the\s+)?(.+?)$/i,
  /* "no bike" takes bike off the shopping list and "cancel soccer" removes
     the event; both keep their old meaning. WITH a date they mean one
     occurrence: "no orchestra Friday", "cancel soccer Saturday". */
  NO     : /^(?:no|cancel)\s+(?:the\s+)?(.+?)$/i,
  OFF    : /^(.+?)\s+(?:is|are)\s+(?:cancelled|canceled|off|not\s+happening|not\s+on)(?:\s+(.*))?$/i,
  FINE   : /^(.+?)\s+(?:is|are|'s|s)?\s*(?:fine|better|back|ok|okay|good|going\s+after\s+all|not\s+sick|at\s+school)(?:\s+(.*))?$/i,
  UNSKIP : /^(?:cancel|undo|remove|drop)\s+(?:the\s+|that\s+)?skip$/i,
  ON     : /^(?:never\s*mind|nvm|actually)[,\s]+(.+?)\s+is\s+(?:on|back\s+on|happening|back)(?:\s+(.*))?$/i,
  SCHOOL_ON: /^school(?:'s|\s+is)?\s+(?:on|open|back|back\s+on)(?:\s+(.*))?$/i,
  /* One end of a range, as people write it. */
  RANGE  : /^(.+?)\s*(?:–|—|-|\bto\b|\bthrough\b|\bthru\b|\btil\b|\btill\b|\buntil\b)\s*(.+)$/i,
  THROUGH: /^(?:through|thru|til|till|until|to)\s+(.+)$/i,
  WEEK   : /^(?:this|all|the\s+whole|the\s+rest\s+of\s+the|rest\s+of\s+the|the)\s+week$/i,
  NEXT_WEEK: /^next\s+week$/i,
};

const plusDays = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return ymd(x); };
const dowOf   = d => new Date(d + 'T12:00:00').getDay();

/* One date from a fragment, via the calendar grammar. An absence is about
   NOW, so "Thursday" said on a Thursday is today, not next week. */
function oneDate(fragment, now, base) {
  const f = String(fragment || '').trim();
  if (!f) return null;
  /* A bare day number after "Mar 9–": same month as the left end. */
  if (base && /^\d{1,2}$/.test(f)) {
    const d = new Date(base + 'T12:00:00'); d.setDate(+f);
    return d.getDate() === +f ? ymd(d) : null;
  }
  const q = parseQuickAdd(f, { members: [], now: base ? new Date(base + 'T12:00:00') : now });
  if (!q.matched.includes('date')) return null;
  if (q.title && q.title !== 'Untitled') return null;
  return q.alsoToday || q.date;
}

/* "", "today", "Friday", "Tue–Thu", "Mar 9–13", "through Friday", "this
   week" → { from, to } or null when the tail is not about dates at all. */
function dateRange(tail, opts = {}) {
  const now = opts.now || new Date();
  const today = ymd(now);
  const t = String(tail || '').trim().replace(/^(?:on|for|from)\s+/i, '');
  if (!t) return { from: today, to: today };
  let m;
  if (ABS_RE.WEEK.test(t))      return { from: today, to: plusDays(today, 7 - dowOf(today)) };
  if (ABS_RE.NEXT_WEEK.test(t)) { const mon = plusDays(today, 8 - (dowOf(today) || 7)); return { from: mon, to: plusDays(mon, 6) }; }
  if ((m = t.match(ABS_RE.THROUGH))) {
    const to = oneDate(m[1], now);
    return to ? { from: today, to } : null;
  }
  if ((m = t.match(ABS_RE.RANGE))) {
    const from = oneDate(m[1], now);
    const to   = from ? oneDate(m[2], now, from) : null;
    /* The grammar rolls a past date to next year; "9/18-9/15" would become
       a year-long absence. No absence is that long. */
    if (from && to && to >= from && (new Date(to) - new Date(from)) < 120 * 86400000) return { from, to };
    return null;
  }
  const d = oneDate(t, now);
  return d ? { from: d, to: d } : null;
}

/* Who, from the front of a sentence. "I" / "I'm" is the sender. */
function absWho(fragment, opts) {
  const f = String(fragment || '').trim();
  if (/^(?:i|i'm|im|me)$/i.test(f)) return opts.me ? [opts.me] : [];
  const lead = leadingNames(f + ' x', opts.members || []);
  return lead && lead.rest === 'x' ? lead.names : whoIn(f, opts.members || []).length && f.split(/\s+/).length <= 3 ? whoIn(f, opts.members || []) : [];
}

/* opts: { members, now, me }. Returns an absence / skip / unskip intent or null. */
function absenceIntent(body, opts = {}) {
  const text = String(body || '').trim().replace(/[.!]+$/, '');
  let m, r;

  if ((m = text.match(ABS_RE.SCHOOL))) {
    r = dateRange(m[1], opts);
    if (r) return { intent: 'absence', who: null, kind: 'school_closed', ...r };
  }
  if ((m = text.match(ABS_RE.SCHOOL_ON))) {
    r = dateRange(m[1], opts);
    if (r) return { intent: 'unskip', who: null, kind: 'school_closed', ...r };
  }
  if (ABS_RE.UNSKIP.test(text)) return { intent: 'unskip', who: null, title: null, last: true };
  if ((m = text.match(ABS_RE.ON))) {
    r = dateRange(m[2], opts);
    if (r) return { intent: 'unskip', who: null, title: m[1].trim(), ...r };
  }

  /* People first: "Bryce is sick" / "Erich is away Tue–Thu" / "Bryce is fine".
     The name must be the whole front of the sentence, and the tail must be
     a date or nothing — "Bryce is sick of soccer" is a complaint. */
  if ((m = text.match(ABS_RE.AWAY))) {
    const who = absWho(m[1], opts); r = dateRange(m[2], opts);
    if (who.length && r) return { intent: 'absence', who: who[0], kind: 'away', ...r };
  }
  if ((m = text.match(ABS_RE.SICK))) {
    const who = absWho(m[1], opts); r = dateRange(m[2], opts);
    if (who.length && r) return { intent: 'absence', who: who[0], kind: 'sick', ...r };
  }
  if ((m = text.match(ABS_RE.FINE))) {
    const who = absWho(m[1], opts); r = dateRange(m[2], opts);
    if (who.length && r) return { intent: 'unskip', who: who[0], title: null, ...r };
  }

  /* Events: "skip soccer Saturday", "orchestra is cancelled", "no orchestra
     Mar 9–13". The date is peeled off the end; what is left is the title. */
  const titleAndRange = (rest, needDate) => {
    const words = rest.trim().split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const rr = dateRange(words.slice(i).join(' '), opts);
      if (rr) return { title: words.slice(0, i).join(' '), ...rr };
    }
    if (needDate) return null;
    const today = ymd(opts.now || new Date());
    return { title: rest.trim(), from: today, to: today };
  };
  if ((m = text.match(ABS_RE.OFF))) {
    r = dateRange(m[2], opts);
    if (r) return { intent: 'skip_event', title: m[1].trim(), ...r };
  }
  if ((m = text.match(ABS_RE.SKIP))) {
    const x = titleAndRange(m[1], false);
    if (x && x.title) return { intent: 'skip_event', ...x };
  }
  if ((m = text.match(ABS_RE.NO))) {
    const x = titleAndRange(m[1], true);
    if (x && x.title) return { intent: 'skip_event', ...x };
  }
  return null;
}

/* ===========================================================================
 * 17. DINNER BY TEXT
 *
 * "dinner is leftovers" is the Wednesday message. It is a statement about
 * the meal, not an appointment: "dinner is at 6" and "dinner at grandma's
 * Sunday" carry a clock or a place and stay events. The dish is matched to
 * a saved recipe by the handler; here it is just words and a day.
 * ========================================================================= */
const DINNER_RE = {
  IS     : /^(?:dinner|supper|tonight)(?:\s+(tonight|today|tomorrow|tmrw|(?:on\s+)?(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?))?\s*(?:is|:|=|will\s+be|-|—|—)\s*(.+)$/i,
  HAVING : /^(?:we'?re|we\s+are|were)\s+(?:having|doing|eating|making)\s+(.+?)(?:\s+(?:for\s+dinner|for\s+supper))?(?:\s+(tonight|today|tomorrow|tmrw))?$/i,
};

function dinnerIntent(body, opts = {}) {
  const text = String(body || '').trim().replace(/[.!]+$/, '');
  const now = opts.now || new Date();
  let m, dayWord = null, dish = null;
  if ((m = text.match(DINNER_RE.IS)))          { dayWord = m[1] || (/^tonight/i.test(text) ? 'tonight' : null); dish = m[2]; }
  else if ((m = text.match(DINNER_RE.HAVING))) { dish = m[1]; dayWord = m[2] || null; }
  if (!dish) return null;
  dish = dish.trim().replace(/^(?:going\s+to\s+be|gonna\s+be)\s+/i, '');
  /* A clock in the dish makes it an appointment, not a menu. */
  const q = parseQuickAdd(dish, { members: [], now });
  if (q.matched.includes('time')) return null;
  if (q.matched.includes('date') && (!q.title || q.title === 'Untitled')) return null;
  const date = dayWord ? (oneDate(dayWord.replace(/^on\s+/i, ''), now) || ymd(now)) : ymd(now);
  const clean = dish.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return { intent: 'dinner', dish: clean, date };
}

/* ===========================================================================
 * 18. WEEKLY ADS
 *
 * The weekly ad is a web page, copied. What arrives is messy: a brand-first
 * name on one line and "$2.99 lb" on the next, "2/$5", "BOGO", "save $1.00",
 * a validity line at the top, size strings glued to names. This reads it
 * into rows the shopping list can match against — never a sign-in, never a
 * scrape; the family pastes, the app reads.
 *
 * name_key is the name as the CATALOG would spell it, through the same
 * normalizer the list uses (parseShopping), so "H-E-B Whole Milk 1 gal"
 * keys to "whole milk" and matches the milk already on the list.
 * ========================================================================= */

const AD_MAX = 300;
const AD_RE = {
  /* The offers, most specific first. */
  MULTI  : /\b(\d+)\s*(?:\/\s*\$\s*|for\s+\$?\s*)(\d+(?:\.\d{1,2})?)\b/i,               // 2/$5, 10 for $10 (not 9/10, a date)
  BOGO   : /\b(?:bogo(?:\s*free)?|b1g1(?:\s*free)?|buy\s+(?:one|1)\s*,?\s*get\s+(?:one|1)(?:\s+free)?(?:\s+\d+%?\s*off)?)\b/i,
  SAVE   : /\b(?:save|saves?)\s+\$?\s*(\d+(?:\.\d{1,2})?)(?:\s*(?:on|off))?\b/i,        // save $1.50
  OFF    : /\$\s*(\d+(?:\.\d{1,2})?)\s*off\b|\b(\d+(?:\.\d+)?)\s*%\s*off\b/i,           // $1 off, 25% off
  PRICE  : /(?:^|[\s(])\$?\s*(\d{0,3}\.\d{2})(?!\d)\s*(\/\s*lb|\/\s*ea|per\s+lb|per\s+pound|lb|ea|each|per\s+ea)?\b|(?:^|[\s(])\$\s*(\d{1,3})(?!\.\d)\b\s*(\/\s*lb|lb|ea|each)?/i,
  COUPON : /\b(?:with\s+(?:an?\s+)?(?:in-?store\s+|digital\s+)?coupons?|coupons?|clip(?:ped)?|digital|in-?store\s+coupon|load\s+to\s+card)\b/i,
  CARD   : /\b(?:with\s+card|w\/\s*card|card\s+price|loyalty)\b/i,
  SIZE   : /\b(?:\d+(?:\.\d+)?\s*(?:-|–|to)\s*)?\d+(?:\.\d+)?\s*(?:fl\s*)?(?:oz|ounces?|lbs?|pounds?|ct|count|pk|pack|gal(?:lon)?s?|qt|quarts?|pt|pints?|l|liters?|litres?|ml|g|grams?|kg|rolls?|sheets?|loads?)\b\.?|\b(?:half\s+gallon|gallon|quart|pint|dozen|each|ea|per\s+lb|per\s+pound|lb\.?)\b/i,
  NOISE  : /^(?:weekly\s+ad|digital\s+coupons?|coupons?|this\s+week'?s?\s+deals?|deals?|specials?|page\s+\d+|produce|meat|dairy|bakery|deli|frozen|grocery|pantry|snacks|beverages|household|pharmacy|seafood|view\s+all|see\s+all|shop\s+now|add\s+to\s+list|clip\s+coupon|clip|expires?\s+.*|exp\.?\s+.*|valid\s+.*|limit\s+\d+.*|while\s+supplies\s+last.*|see\s+store.*)$/i,
  VALID  : /\b(?:valid|prices?\s+good|good|effective|sale\s+dates?|offers?\s+good|dates?)\b[:\s]*(.+)$/i,
  DAYNAME: /\b(?:sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?\.?,?\s*/gi,
};

/* Prices shaped like "2.99" with no "$" are still prices in an ad. */
function findDeal(line) {
  const t = String(line);
  let m;
  if ((m = t.match(AD_RE.BOGO)))  return { kind: 'deal', text: /bogo|b1g1/i.test(m[0]) ? 'BOGO' : m[0].replace(/\s+/g, ' '), index: m.index, len: m[0].length };
  if ((m = t.match(AD_RE.MULTI))) return { kind: 'deal', text: `${m[1]}/$${m[2]}`, index: m.index, len: m[0].length };
  if ((m = t.match(AD_RE.SAVE)))  return { kind: 'deal', text: `save $${m[1]}`, index: m.index, len: m[0].length };
  if ((m = t.match(AD_RE.OFF)))   return { kind: 'deal', text: m[1] ? `$${m[1]} off` : `${m[2]}% off`, index: m.index, len: m[0].length };
  if ((m = t.match(AD_RE.PRICE))) {
    const amt = (m[1] || m[3]).replace(/^\./, '0.'); const per = (m[2] || m[4] || '').replace(/\s+/g, '');
    const unit = /lb|pound/i.test(per) ? '/lb' : per ? ' ea' : '';
    return { kind: 'price', text: `$${amt}${unit}`, index: m.index, len: m[0].length };
  }
  return null;
}

/* The name as the catalog would spell it. */
function adNameKey(name, opts) {
  const base = String(name).replace(AD_RE.SIZE, ' ').replace(/[®™]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) return '';
  const r = parseShopping(base, { stores: [], catalog: opts.catalog || [] });
  const items = r.items || [];
  const cat = (opts.catalog || []);
  const exact = items.find(i => cat.some(c => c.name.toLowerCase() === i.name.toLowerCase()));
  if (exact) return exact.name.toLowerCase();
  const known = items.filter(i => i.category !== 'other').sort((a, b) => b.name.length - a.name.length)[0];
  if (known) return known.name.toLowerCase();
  return base.toLowerCase().replace(/[^a-z0-9 &'-]/g, '').trim();
}

/* opts: { stores, catalog, now } */
function parseAd(text, opts = {}) {
  const now = opts.now || new Date();
  const today = ymd(now);
  const out = { store: null, valid_from: today, valid_to: plusDays(today, 6), rows: [], skipped: 0 };
  const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!lines.length) return out;

  /* Header: the store, and the dates the prices hold. */
  const head = lines.slice(0, 12).join('\n');
  const st = routeStoreIn(opts.stores || [], head) || routeStoreIn(opts.stores || [], head.replace(/-/g, ''));
  if (st) out.store = st;
  /* A digital-coupon page is coupons all the way down. */
  const docCoupon = /\b(?:digital\s+coupons?|clip\s+coupons?|coupons?\s+page)\b/i.test(head);
  let validLine = -1;
  lines.slice(0, 12).forEach((l, i) => {
    const m = l.match(AD_RE.VALID);
    if (!m || validLine >= 0) return;
    const tail = m[1].replace(AD_RE.DAYNAME, '').replace(/[.,]$/, '').trim();
    const r = dateRange(tail, { now });
    if (r && r.to > r.from) { out.valid_from = r.from; out.valid_to = r.to; validLine = i; }
  });
  if (validLine >= 0) lines.splice(validLine, 1);

  let pendingName = null, pendingCoupon = false;
  const push = (name, deal, coupon, raw, tail) => {
    if (out.rows.length >= AD_MAX) { out.skipped++; return; }
    let clean = name.replace(/[®™*]/g, ' ').replace(/\s+/g, ' ').replace(/[\s,;:\-–]+$/, '').trim();
    const size = (clean.match(AD_RE.SIZE) || [])[0];
    if (size) clean = clean.replace(AD_RE.SIZE, ' ').replace(/\s+/g, ' ').replace(/[\s,;:\-–]+$/, '').trim();
    if (!clean || /^\d+$/.test(clean)) { out.skipped++; return; }
    const extras = [size, tail].filter(Boolean).map(x => x.trim()).filter(Boolean);
    const row = {
      name: clean, name_key: adNameKey(clean, opts),
      price: deal.kind === 'price' ? deal.text : null,
      deal:  deal.kind === 'deal'  ? deal.text : null,
      coupon: !!coupon || docCoupon, raw
    };
    if (extras.length) {
      const k = row.price != null ? 'price' : 'deal';
      row[k] = `${row[k]} · ${extras.join(' ')}`;
    }
    out.rows.push(row);
  };

  /* "milk 2.49, eggs 3/$5" — two offers on one line are two lines. */
  const flat = [];
  for (const line of lines) {
    const segs = line.split(/\s*[,;]\s*/);
    if (segs.length > 1 && segs.filter(x => findDeal(x)).length >= 2) flat.push(...segs);
    else flat.push(line);
  }

  for (const line of flat) {
    if (AD_RE.NOISE.test(line)) { pendingName = null; pendingCoupon = false; continue; }
    const coupon = AD_RE.COUPON.test(line);
    const deal = findDeal(line);
    if (!deal) {
      /* A name, waiting for its price on the next line. */
      pendingName = line.replace(AD_RE.COUPON, ' ').replace(/\s+/g, ' ').trim() || null;
      pendingCoupon = coupon;
      continue;
    }
    const before = line.slice(0, deal.index).replace(AD_RE.COUPON, ' ').replace(AD_RE.CARD, ' ').replace(/\s+/g, ' ').trim();
    let after = line.slice(deal.index + deal.len).replace(AD_RE.COUPON, ' ').replace(/[,.;]+$/, '').replace(/\s+/g, ' ').trim();
    const card = AD_RE.CARD.test(line) ? 'with card' : '';
    after = after.replace(AD_RE.CARD, ' ').replace(/\s+/g, ' ').trim();
    const tail = [after, card].filter(Boolean).join(' ');
    const nameOnLine = before.replace(/[\s,;:\-–]+$/, '');
    if (nameOnLine && !/^\d+$/.test(nameOnLine)) {
      if (pendingName) out.skipped++;                 // a name that never got its price
      push(nameOnLine, deal, coupon || (pendingCoupon && !pendingName), line, tail);
    } else if (pendingName) {
      push(pendingName, deal, coupon || pendingCoupon, `${pendingName} / ${line}`, tail);
    } else {
      out.skipped++;
    }
    pendingName = null; pendingCoupon = false;
  }
  if (pendingName) out.skipped++;
  return out;
}

/* Is a paste a weekly ad? Three or more priced rows. */
function looksLikeAd(text, opts = {}) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 3) return false;
  let priced = 0;
  for (const l of lines) { if (findDeal(l)) priced++; if (priced >= 3) return true; }
  return false;
}

/* ===========================================================================
 * 19. THE CAST, SAID OUT LOUD — and the headcount
 *
 * "Jess drives", "Erich brings them back": one table for how a role reads,
 * shared by the app's cards and the text number's answers, so they never
 * say it two ways. And the rule for editing a cast: a person is going,
 * helping, or a maybe (one of those) and may hold one ride role on top.
 * ========================================================================= */
function roleVerb(name, role) {
  switch (role) {
    case 'driving': return `${name} drives`;
    case 'dropoff': return `${name} takes them`;
    case 'pickup':  return `${name} brings them back`;
    case 'helping': return `${name} helps`;
    case 'optional':return `${name} maybe`;
    default:        return name;
  }
}

/* The cast as a card reads it: going names first, then the ride and helper
   phrases. people: [{name, role}]. */
function castLine(people) {
  const RIDE = ['driving', 'dropoff', 'pickup'];
  const going = [], other = [];
  for (const p of people || []) {
    if (p.role === 'going') going.push(p.name);
    else if (RIDE.includes(p.role) || p.role === 'helping' || p.role === 'optional') other.push(roleVerb(p.name, p.role));
  }
  return [going.join(', '), ...other].filter(Boolean).join(' · ');
}

const PRESENCE = ['going', 'helping', 'optional'];
const RIDES    = ['driving', 'dropoff', 'pickup'];
/* Toggle one role on a member's set. Presence roles replace each other;
   ride roles replace each other; a ride can sit on top of a presence. */
function toggleCastRole(roles, role) {
  const set = new Set(roles || []);
  if (set.has(role)) { set.delete(role); return [...set]; }
  const group = PRESENCE.includes(role) ? PRESENCE : RIDES.includes(role) ? RIDES : [role];
  for (const g of group) set.delete(g);
  set.add(role);
  return [...PRESENCE, ...RIDES].filter(r => set.has(r));
}

/* "Addie's at church, 3 for dinner" / "dinner for 3" / "just 2 for dinner
   tomorrow" → { intent:'headcount', n, date, note }. A clock in the sentence
   is ignored: "3 for dinner at 6" is a headcount, the time is the meal's
   ready_by and is set elsewhere. */
const HEAD_RE = {
  LEAD : /^(.+?)(?:'s|\s+is|\s+are)\s+(?:at|out|away)\s+(.+?)[,;:—-]+\s*/i,
  N    : /^(?:just|only)?\s*(\d{1,2})\s+(?:people\s+)?for\s+(?:dinner|supper)(?:\s+(tonight|today|tomorrow|tmrw))?(?:\s+at\s+\d.*)?$/i,
  FOR  : /^(?:dinner|supper)\s+(?:is\s+)?for\s+(?:just\s+|only\s+)?(\d{1,2})(?:\s+(tonight|today|tomorrow|tmrw))?(?:\s+at\s+\d.*)?$/i,
};
/* "same as last week" — copy last week's dinners onto the week ahead. */
const REPEAT_WEEK_RE = /^(?:(?:same|repeat|copy|do)\s+(?:as\s+)?last\s+week(?:'s)?(?:\s+(?:dinners|meals|menu))?|last\s+week(?:'s)?\s+(?:dinners|meals|menu)\s+again)[.!]*$/i;
function repeatWeekIntent(body) {
  return REPEAT_WEEK_RE.test(String(body || '').trim()) ? { intent: 'repeat_week' } : null;
}

function headcountIntent(body, opts = {}) {
  let text = String(body || '').trim().replace(/[.!]+$/, '');
  const now = opts.now || new Date();
  let note = null, m;
  if ((m = text.match(HEAD_RE.LEAD))) {
    const who = whoIn(m[1], opts.members || []);
    note = `${who[0] || m[1].trim()} at ${m[2].trim()}`;
    text = text.slice(m[0].length).trim();
  }
  let n = null, dayWord = null;
  if ((m = text.match(HEAD_RE.N)))        { n = +m[1]; dayWord = m[2] || null; }
  else if ((m = text.match(HEAD_RE.FOR))) { n = +m[1]; dayWord = m[2] || null; }
  if (!n) return null;
  const date = dayWord ? (oneDate(dayWord, now) || ymd(now)) : ymd(now);
  return { intent: 'headcount', n, date, note };
}

/* Split a pasted block into ingredient lines. Headings like "For the sauce:"
   are dropped; blank lines are dropped; everything else is an ingredient. */
function splitIngredientBlock(text) {
  return String(text || '').split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !/^(?:for the\b|.*:\s*$)/i.test(l) && !/^ingredients\b/i.test(l));
}

/* ===========================================================================
 * 21. A KID ASKING FOR A RIDE
 *
 * "can someone pick me up at 5" / "I need a ride home from practice" /
 * "need a ride at 5:30". Only a teen or child sends this; the handler
 * passes opts.kid for them and NOTHING else, so an adult typing the same
 * words routes exactly as before (an adult asking "can someone pick me up"
 * is a calendar note, not a request the family number can broker).
 *
 * The clock has no am/pm nearly every time. A ride is asked for after
 * school, so a bare 1–8 is PM, 9–11 is AM, 12 is noon. "now" and
 * "in 20 min" are honoured; no clock at all means "as soon as someone can".
 * Where they are ("from practice", "at school") is kept as a word for the
 * parents' text; "home" is the destination, never the place.
 * ==========================================================================*/
const RIDE_REQ = {
  ASK: /^(?:hey\s+|hi\s+|um\s+)?(?:(?:can|could|will|would|is\s+anyone\s+able\s+to)\s+(?:someone|somebody|anyone|anybody|you|u|mom|dad|mum|mama|papa|\w+)\s+(?:please\s+)?(?:come\s+(?:and\s+)?)?(?:pick\s+me\s+up|get\s+me|grab\s+me|come\s+get\s+me)|(?:i\s+)?(?:need|needs|want)\s+(?:a\s+)?(?:ride|lift|pick\s*up|pickup)|(?:can|could)\s+i\s+get\s+a\s+(?:ride|lift)|(?:pick\s+me\s+up|come\s+get\s+me|come\s+pick\s+me\s+up)|(?:ride|pickup|pick\s*up)\s+(?:please|pls|plz))\b/i,
  CLOCK: /\b(?:at|by|around|about|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|a|p)?\b|\b(\d{1,2}):(\d{2})\s*(am|pm)?\b|\b(\d{1,2})\s*(am|pm)\b/i,
  IN:    /\bin\s+(?:about\s+|like\s+)?(\d{1,3})\s*(min(?:ute)?s?|hours?|hrs?)\b|\bin\s+(?:an?|one)\s+hour\b|\bin\s+half\s+an\s+hour\b/i,
  NOW:   /\b(?:right\s+)?now\b|\basap\b|\bas\s+soon\s+as\b/i,
  WHERE: /\b(?:from|at|outside|in\s+front\s+of)\s+(?:the\s+)?([a-z][a-z' ]*?)(?=\s+(?:at|by|around|about|@|in)\s+\d|\s*[,.!?]|\s+(?:please|pls|plz|now|asap|today|tonight)\b|\s*$)/i,
  NOT_PLACE: /^(?:home|house|me|it|\d+|(?:\d+\s*)?(?:am|pm))$/i
};
function rideRequestIntent(body, opts = {}) {
  if (!opts.kid) return null;
  const text = String(body || '').trim().replace(/\s+/g, ' ');
  if (!RIDE_REQ.ASK.test(text)) return null;
  let time = null, inMin = null, m;
  if ((m = text.match(RIDE_REQ.CLOCK))) {
    let h = +(m[1] ?? m[4] ?? m[7]), mi = +(m[2] ?? m[5] ?? 0);
    const ap = (m[3] ?? m[6] ?? m[8] ?? '').toLowerCase().replace(/\./g, '');
    if (h >= 1 && h <= 12 && mi < 60) {
      if (ap.startsWith('p'))      { if (h !== 12) h += 12; }
      else if (ap.startsWith('a')) { if (h === 12) h = 0; }
      else if (h <= 8)             { h += 12; }               // 5 → 5 PM; 12 → noon stays
      else if (h < 12) {                                       // 9–11: AM unless it has passed
        const nh = (opts.now || new Date()).getHours();
        if (nh >= h) h += 12;
      }
      time = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
    }
  } else if ((m = text.match(RIDE_REQ.IN))) {
    if (/half/.test(m[0])) inMin = 30;
    else if (!m[1]) inMin = 60;
    else inMin = /h/i.test(m[2]) ? +m[1] * 60 : +m[1];
  } else if (RIDE_REQ.NOW.test(text)) {
    inMin = 0;
  }
  let where = null;
  const w = text.replace(RIDE_REQ.CLOCK, ' ').match(RIDE_REQ.WHERE);
  if (w && !RIDE_REQ.NOT_PLACE.test(w[1].trim())) where = w[1].trim().toLowerCase();
  return { intent: 'ride_request', time, inMin, where };
}

const admin = () => createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } }
);

const HOUSEHOLD = Deno.env.get('HOUSEHOLD_ID')!;
const TW_TOKEN  = Deno.env.get('TWILIO_TOKEN') ?? '';

/* Outbound, for the one thing this function says to someone OTHER than the
   sender: a kid's ride request goes to both parents, and the answer goes
   back to the kid. Same chain as the dispatcher and the digest; same
   secrets, which are project-wide. */
const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC_KEY')  ?? '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:family@example.com';
const TWILIO_SID    = Deno.env.get('TWILIO_SID')   ?? '';
const TWILIO_FROM   = Deno.env.get('TWILIO_FROM')  ?? '';
if (VAPID_PUBLIC && VAPID_PRIVATE) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
const OUT_ENV = {
  webpush: (VAPID_PUBLIC && VAPID_PRIVATE) ? webpush : null,
  TWILIO_SID, TWILIO_TOKEN: TW_TOKEN, TWILIO_FROM
};

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


/* ---------------------------------------------------------------------------
 * TIMEZONE
 * Edge functions run in UTC; the family lives in America/Chicago. Two separate
 * conversions, and getting either wrong is a silent five-hour error.
 * -------------------------------------------------------------------------*/
function tzOffsetMs(at: Date, tz: string): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(at)) p[part.type] = part.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - at.getTime();
}
const nowInTz = (tz: string) => new Date(Date.now() + tzOffsetMs(new Date(), tz));
function wallToUtc(date: string, time: string, tz: string): string {
  const naive = Date.parse(`${date}T${time}:00Z`);
  let ms = naive;
  for (let i = 0; i < 2; i++) ms = naive - tzOffsetMs(new Date(ms), tz);
  return new Date(ms).toISOString();
}

/* Twilio signs the EXACT url configured in its console. Rebuilding it from
   request headers does not work: inside the edge runtime the path is
   "/sms-inbound", not "/functions/v1/sms-inbound". */
/* Bumped by hand on every deploy. Text "help" to read it back. Without this
   there is no way to tell a deployed build from an editor draft, and we lost
   an hour to exactly that. */
const BUILD = '2026-09-14b-m2';

const WEBHOOK_URL = 'https://rauvytdltnbqrvyiornh.supabase.co/functions/v1/sms-inbound';

async function signatureOk(url: string, params: URLSearchParams, given: string) {
  if (!TW_TOKEN || !given) return false;
  let data = url;
  for (const k of [...params.keys()].sort()) data += k + params.get(k);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(TW_TOKEN),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const mine = btoa(String.fromCharCode(...new Uint8Array(mac)));
  if (mine.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < mine.length; i++) diff |= mine.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

const norm  = (s: string) => s.replace(/\D/g, '').slice(-10);
const twiml = (msg: string) => new Response(
  `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${
    msg.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Message></Response>`,
  { headers: { 'Content-Type': 'text/xml' } });

const pretty = (d: string) =>
  new Date(d + 'T12:00:00Z').toLocaleDateString('en-US',
    { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/* Roles carry different urgency — a driver has to leave the house. Mirrors
   role_default_lead() in SQL and DB.roleLead() in app.js. All three must agree. */
function roleLead(role: string, memberDefault: number | null) {
  const d = memberDefault ?? 30;
  if (role === 'driving' || role === 'dropoff') return Math.max(d, 45);
  if (role === 'pickup') return Math.max(d, 30);
  return d;
}

/* Write the cast, then one reminder per person at their own lead. A series
   leaves reminders to the nightly materializer.

   Two rules that took a bug each to learn:

   1. AN EXPLICIT INSTRUCTION OUTRANKS A ROLE DEFAULT. "remind me 2 hours
      before" used to be stored on the event and then quietly ignored, because
      every cast member's reminder was recomputed from their role default. If
      you said two hours, you get two hours.

   2. A PICKUP IS MEASURED FROM THE END. Telling someone to leave for pickup
      thirty minutes before the event STARTS is worse than saying nothing —
      they arrive an hour early and the kid is still inside. Whoever collects
      is timed off ends_at when there is one. */
async function writeCastAndReminders(db: any, ev: any, people: any[], members: any[],
                                     lead: number | null, tz: string, isSeries: boolean,
                                     leadExplicit = false) {
  await db.from('event_people').delete().eq('event_id', ev.id);
  const rows = [];
  for (const p of people ?? []) {
    const mem = members.find((m: any) => m.name === p.name);
    if (!mem) continue;                                  // unknown -> not stored
    const own = p.lead != null ? p.lead
              : (leadExplicit && lead != null) ? lead
              : roleLead(p.role, mem.default_lead_minutes);
    rows.push({ household_id: HOUSEHOLD, event_id: ev.id, member_id: mem.id,
                role: p.role, lead_minutes: own });
  }
  if (rows.length) await db.from('event_people').insert(rows);

  await db.from('reminders').delete().eq('event_id', ev.id).is('sent_at', null);
  if (lead == null || isSeries) return;

  const startIso = ev.all_day ? wallToUtc(ev.event_date, '09:00', tz) : ev.starts_at;
  const endIso   = ev.all_day ? null : (ev.ends_at ?? null);
  const cast = rows.length ? rows
             : [{ member_id: ev.member_id, lead_minutes: lead, role: 'going' }];
  const reminders = [];
  for (const c of cast) {
    if (!c.member_id) continue;
    const base = (c.role === 'pickup' && endIso) ? endIso : startIso;
    const { count } = await db.from('push_subscriptions')
      .select('id', { count: 'exact', head: true }).eq('member_id', c.member_id);
    reminders.push({
      household_id: HOUSEHOLD, event_id: ev.id, member_id: c.member_id,
      lead_minutes: c.lead_minutes ?? lead,
      channel: (count ?? 0) > 0 ? 'push' : 'sms',
      fire_at: new Date(Date.parse(base) - (c.lead_minutes ?? lead) * 60_000).toISOString()
    });
  }
  if (reminders.length) await db.from('reminders').insert(reminders);
}

/* An end time on the same calendar day, unless the clock says otherwise —
   "9pm to 1am" ends tomorrow, not fourteen hours before it started. */
function endInstant(date: string, start: string, end: string, tz: string) {
  let iso = wallToUtc(date, end, tz);
  if (Date.parse(iso) <= Date.parse(wallToUtc(date, start, tz))) {
    const d = new Date(date + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    iso = wallToUtc(d.toISOString().slice(0, 10), end, tz);
  }
  return iso;
}

async function createEvent(db: any, p: any, members: any[], sender: any, tz: string, date: string,
                           extra: Record<string, any> = {}) {
  const member   = members.find((m: any) => m.name === p.member);
  const startsAt = p.allDay ? null : wallToUtc(date, p.start, tz);
  // Dropped on the floor until now, which is why "Soccer 6-8pm" lost the 8.
  const endsAt   = (!p.allDay && p.end) ? endInstant(date, p.start, p.end, tz) : null;
  const { data: ev, error } = await db.from('events').insert({
    household_id: HOUSEHOLD, member_id: member?.id ?? null,
    title: p.title, all_day: p.allDay, event_date: date,
    starts_at: startsAt, ends_at: endsAt,
    reminder_lead_minutes: p.leadMinutes ?? null,
    repeat_freq:     p.repeat?.freq     ?? null,
    repeat_interval: p.repeat?.interval ?? 1,
    repeat_days:     p.repeat?.days     ?? [],
    repeat_until:    p.repeat?.until    ?? null,
    created_by: sender.id, source: 'sms', ...extra
  }).select().single();
  if (error) return null;
  await writeCastAndReminders(db, ev, p.people, members, p.leadMinutes, tz, !!p.repeat,
                              p.matched.includes('lead'));
  return ev;
}

/* ---------------------------------------------------------------------------
 * SEASONS — a pasted schedule, N one-off events behind one question.
 *
 * Never a recurrence: schedules are irregular, that is why they get pasted.
 * Never the rides question: the header named the cast once for all of them,
 * and twenty "Rides?" texts is how a family learns to ignore the number.
 * -------------------------------------------------------------------------*/
const SEASON_SHOW = 12;

function seasonCast(people: any[]) {
  const going = (people ?? []).filter((x: any) => !['driving','dropoff','pickup'].includes(x.role)).map((x: any) => x.name);
  const rides = (people ?? []).filter((x: any) =>  ['driving','dropoff','pickup'].includes(x.role))
    .map((x: any) => roleVerb(x.name, x.role));
  return [going.join(', '), rides.length ? `(${rides.join(', ')})` : ''].filter(Boolean).join(' ');
}

function seasonRowLine(r: any) {
  const when = r.allDay ? 'all day'
    : `${clock(r.start).replace(/ \(.*\)$/, '')}${r.end ? `–${clock(r.end).replace(/ \(.*\)$/, '')}` : ''}`;
  return `${prettyShort(r.date)} ${when}${r.title && r.title !== 'Untitled' ? ` ${r.title}` : ''}${r.location ? ` @ ${r.location}` : ''}`;
}

async function offerSeason(db: any, season: any, sender: any) {
  const rows = season.rows.filter((r: any) => r.ok);
  if (!rows.length) {
    return twiml(`I couldn't read a date on any of those ${season.rows.length} lines. ` +
                 `One per line, like "Tue 9/15 6:30-8pm".`);
  }
  const shown = rows.slice(0, SEASON_SHOW).map((r: any, i: number) => `${i + 1}. ${seasonRowLine(r)}`);
  if (rows.length > SEASON_SHOW) shown.push(`+${rows.length - SEASON_SHOW} more`);
  const bad = season.skipped.length
    ? `\n${season.skipped.length} line${season.skipped.length === 1 ? '' : 's'} I couldn't read: ` +
      season.skipped.slice(0, 3).map((x: string) => `"${x}"`).join(', ') + (season.skipped.length > 3 ? '…' : '')
    : '';
  const head = [season.title, seasonCast(season.people)].filter(Boolean).join(' — ');

  /* Keys: "1"/"yes"/"all" adds everything; any other row number (or "skip")
     opens the skip path, which re-reads every number in the reply. Row 1
     cannot be skipped by number alone — "skip 1" does it. */
  const options: any[] = [];
  for (let i = 2; i <= rows.length; i++) options.push({ keys: [String(i)], value: 'skip' });
  options.push({ keys: ['skip', 'not', 'except'], value: 'skip' });
  options.push({ keys: ['1', 'yes', 'all', 'add', 'y'], value: 'all' });
  options.push({ keys: ['cancel', 'stop', 'no', 'n'], value: 'cancel' });

  await db.from('sms_pending').upsert({
    household_id: HOUSEHOLD, member_id: sender.id, kind: 'season_confirm',
    payload: { title: season.title, people: season.people, rows },
    options,
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString()
  }, { onConflict: 'member_id' });

  return twiml(`${head ? head + '\n' : ''}${shown.join('\n')}${bad}\n\n` +
               `Reply 1 to add all ${rows.length}, the numbers to skip (e.g. 3 5), or cancel.`);
}

async function insertSeason(db: any, pl: any, skip: Set<number>, sender: any, members: any[], tz: string) {
  let added = 0;
  for (let i = 0; i < pl.rows.length; i++) {
    if (skip.has(i + 1)) continue;
    const r = pl.rows[i];
    const people = r.people ?? [];
    const going = people.find((x: any) => x.role === 'going');
    const p = {
      title: r.title || 'Untitled', allDay: !!r.allDay, start: r.start, end: r.end,
      member: going ? going.name : (people[0] ? people[0].name : null),
      people, leadMinutes: sender.default_lead_minutes ?? 30, repeat: null, matched: [] as string[]
    };
    const ev = await createEvent(db, p, members, sender, tz, r.date,
                                 { source: 'season', location: r.location ?? null });
    if (ev) added++;
  }
  const who = seasonCast(pl.people);
  return twiml(`Added ${added} to the calendar${who ? ` for ${who}` : ''}` +
               (skip.size ? `, skipped ${skip.size}` : '') + '.');
}

/* ---------------------------------------------------------------------------
 * SAYING THE TIME OUT LOUD
 *
 * "6:00" is not an answer to "when". Noon and midnight are the two most
 * reliably misread numbers on a clock, and a twelve-hour error is the kind
 * that reads as perfectly correct right up until somebody misses the thing.
 * So every time this number quotes a clock back at you, it names which half
 * of the day it means.
 * -------------------------------------------------------------------------*/
function clock(t: string | null) {
  if (!t) return 'All day';
  const [h, mi] = t.split(':').map(Number);
  if (h === 12 && mi === 0) return '12:00 PM (noon)';
  if (h === 0  && mi === 0) return '12:00 AM (midnight)';
  const ap = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  const part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  return `${hh}:${String(mi).padStart(2, '0')} ${ap} (${part})`;
}

/* Role names as a person would say them. The database stores 'dropoff'; a
   parent reading a text at a red light wants "ride there". */
const ROLE_SAY: Record<string, string> = {
  going:   'going',
  driving: 'drives both ways',
  dropoff: 'ride there',
  pickup:  'ride back',
  helping: 'helping',
  optional:'maybe',
};

/* One line per person, for the confirmation text. (castLine, one-line
   compact, lives in the inlined parser.) */
function castLines(people: any[]) {
  if (!people?.length) return 'Nobody on it yet';
  return people.map((x: any) => `${x.name} — ${ROLE_SAY[x.role] ?? x.role}`).join('\n');
}

function confirmText(p: any, date: string, verb = 'Added') {
  const d = describe({ ...p, date });
  return `${verb}: ${p.title}\n${pretty(date)} · ${p.allDay ? 'All day' : clock(p.start)}` +
         (d.repeat ? `\n${d.repeat}` : '') +
         `\n${castLines(p.people)}\n${d.lead}`;
}

/* The follow-up, and deliberately not a blocking question. The event is
   already saved; ignoring this costs nothing. Asking who is coming and who
   covers each leg is worth one line. Making somebody answer before their
   event is allowed to exist is not. */
function nudge(p: any) {
  if (p.needsCast)  return '\n\nWho’s going? Reply: "Addie going, Jess there, me back"';
  /* Numbered, because most of the time the answer is "nobody needs a lift"
     and typing a sentence to say nothing is the kind of friction that makes
     people stop answering. 1 is the common case and comes first. */
  if (p.needsRides) return '\n\nRides?\n1 = no ride needed\n2 = I drive both ways\n' +
                           '3 = I take them, someone brings them back\n' +
                           '4 = someone takes them, I bring them back\n' +
                           'Or say it: "Jess there, me back"';
  if (p.needsEnd)   return '\n\nHow long does it run? Reply "2 hours" or "til 8pm" — ' +
                           'the pickup alert is measured from the end.';
  return '';
}

/* Remember what this person last touched, so their next message can correct
   it without naming it again. One row per person; the newest wins. */
async function remember(db: any, sender: any, eventId: string, date: string, action: string) {
  await db.from('sms_last_action').upsert({
    member_id: sender.id, household_id: HOUSEHOLD,
    event_id: eventId, occurrence_date: date, action,
    created_at: new Date().toISOString()
  }, { onConflict: 'member_id' });
}

function askTime(title: string, a: any) {
  return a.kind === 'noon'
    ? `${title} — 12:00 which one?\n1 = noon (12:00 PM)\n2 = midnight (12:00 AM)`
    : `${title} — morning or evening?\n1 = ${clock(a.am)}\n2 = ${clock(a.pm)}`;
}

function timeOptions(a: any) {
  return a.kind === 'noon'
    ? [ { keys: ['1','noon','12pm','pm','midday','afternoon'], value: a.pm },
        { keys: ['2','midnight','12am','am','night'],          value: a.am },
        { keys: ['cancel','stop','no'],                        value: 'cancel' } ]
    : [ { keys: ['1','am','morning'],                          value: a.am },
        { keys: ['2','pm','evening','afternoon','night'],      value: a.pm },
        { keys: ['cancel','stop','no'],                        value: 'cancel' } ];
}

/* A new event can have more than one thing wrong with it at once — an
   ambiguous weekday AND an ambiguous clock. This runs again after every
   answer instead of assuming a single round trip. */
async function advance(db: any, p: any, date: string, members: any[], sender: any, tz: string) {
  if (p.ambiguousTime) {
    await db.from('sms_pending').upsert({
      household_id: HOUSEHOLD, member_id: sender.id, kind: 'confirm_time',
      payload: { mode: 'create', parsed: p, date },
      options: timeOptions(p.ambiguousTime),
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString()
    }, { onConflict: 'member_id' });
    return twiml(askTime(p.title, p.ambiguousTime));
  }

  const ev = await createEvent(db, p, members, sender, tz, date);
  if (!ev) return twiml('Could not save that one. Try again?');
  await remember(db, sender, ev.id, date, 'create');

  /* If we are asking about rides, leave a numbered question open so a bare
     "1" means something. This is safe precisely because an unmatched reply
     drops the question and routes normally — the event is already saved, so
     ignoring the whole thing costs nothing. */
  if (p.needsRides) {
    await db.from('sms_pending').upsert({
      household_id: HOUSEHOLD, member_id: sender.id, kind: 'rides',
      payload: { eventId: ev.id, date },
      options: [
        { keys: ['1','none','no','no ride','nobody'], value: 'none' },
        { keys: ['2','both','both ways'],             value: 'both' },
        { keys: ['3','there'],                        value: 'there' },
        { keys: ['4','back'],                         value: 'back' },
      ],
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString()
    }, { onConflict: 'member_id' });
  }

  return twiml(confirmText(p, date) + nudge(p) +
               (p.warnings.length ? `\n\n(${p.warnings[0]})` : ''));
}

/* The clock reading of an instant, in the household's own timezone. Needed
   when a correction moves the day but leaves the time alone. */
function utcToWall(iso: string, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find(x => x.type === t)!.value;
  return `${g('hour')}:${g('minute')}`;
}

/* ---------------------------------------------------------------------------
 * SHOPPING
 *
 * Until now every text became a calendar event, which is why nobody else could
 * be given this number: "milk" would quietly appear on the calendar. Routing
 * decides between the two, and where it genuinely cannot tell, it asks once
 * rather than filing something in the wrong place silently.
 * -------------------------------------------------------------------------*/
const SHOP_STRONG = /\b(?:shopping\s+list|grocery\s+list|groceries)\b|^(?:buy|shop)\b/i;
const SHOP_WEAK   = /^(?:get|grab|need|we\s+need|i\s+need|add|pick\s*up|order)\b/i;
/* Taking something OFF the list. Until this existed there was no way to undo
   a mis-heard item by text: "remove bike" matched no calendar event, fell
   through every other branch, and was read as new input — so the mistake was
   added a second time instead of taken away.

   "got" is the other half. An item you have picked up is not a mistake; it
   stays on the list struck through so nobody asks whether you got the milk. */
const SHOP_REMOVE = /^(?:remove|delete|take\s+(?:off|out)|drop|scratch|erase|clear|wipe|get\s+rid\s+of|no)\s+(.+)$/i;
const SHOP_GOT    = /^(?:got|bought|picked\s+up|grabbed|have)\s+(.+)$/i;

const LIST_CMD    = /^(?:list|the\s+list|shopping(?:\s+list)?|grocer(?:y|ies)(?:\s+list)?|what'?s?\s+on\s+the\s+list)\s*\??$/i;
/* "HEB list", "show the Kroger list" — the same question, narrowed. */
const LIST_SCOPED = /^(?:show\s+|see\s+|what'?s?\s+on\s+)?(?:the\s+)?(.+?)(?:'s)?\s+list\s*\??$/i;

/* TWO different things, and the difference matters enough to keep the words
   apart.
 *
 *   TRIP_DONE  — you shopped. What was bought drops off; what is still needed
 *                carries over, because it is still needed.
 *   CLEAR_ALL  — take the whole thing down, bought or not. Cleanup.
 *
 * Both are RECOVERABLE: they set cleared_at, moving rows into history rather
 * than destroying them. Only a single "remove X" hard-deletes, because that
 * one means "this was never real". A mis-heard word must not be able to wipe
 * a list nobody can get back. */
const TRIP_DONE   = /^(?:new\s+(?:list|trip)|start\s+(?:a\s+)?new\s+(?:list|trip)|done(?:\s+shopping)?|finished(?:\s+shopping)?)\s*[.!]?$/i;
/* A clearing verb followed by NOTHING but a store, "list", and filler is a
   bulk operation. The same verb followed by an actual item name is not.
   "remove HEB list" empties a list; "remove milk" takes one thing off it.
   That single distinction covers every phrasing without a separate rule for
   each one. */
const CLEAR_VERB  = /^(?:clear|empty|wipe|reset|remove|delete|erase)\b\s*(.*)$/i;
const BULK_FILLER = /\b(?:the|a|an|whole|entire|all|everything|every|of|from|out|off|items?|things?|stuff|shopping|grocery|groceries|lists?|please)\b/gi;

async function shopContext(db: any) {
  const { data: stores }  = await db.from('stores').select('id, name, flyer_group, sort_order, aliases')
    .eq('household_id', HOUSEHOLD).is('deleted_at', null).order('sort_order');
  const { data: catalog } = await db.from('shopping_catalog')
    .select('name, category, store_id, times_added').eq('household_id', HOUSEHOLD);
  return { stores: stores ?? [], catalog: catalog ?? [] };
}

async function addShopping(db: any, body: string, sender: any) {
  const { stores, catalog } = await shopContext(db);
  const p = parseShopping(body, { stores, catalog });
  if (!p.items.length) return twiml('Did not catch an item there. Try "buy milk, eggs".');

  /* Already on the list is not a new item. Two rows for milk means someone
     buys two, or someone crosses one off and leaves the other standing. */
  const { data: live } = await db.from('shopping_items')
    .select('name, store_id').eq('household_id', HOUSEHOLD)
    .is('cleared_at', null).eq('got', false);
  const already = new Set((live ?? []).map((r: any) => `${r.store_id ?? ''}|${String(r.name).toLowerCase()}`));
  const dupes = p.items.filter((it: any) =>
    already.has(`${it.store?.id ?? p.store?.id ?? it.catalogStore ?? ''}|${it.name.toLowerCase()}`));
  p.items = p.items.filter((it: any) => !dupes.includes(it));

  if (!p.items.length) {
    return twiml(dupes.length
      ? `Already on the list: ${dupes.map((d: any) => d.name).join(', ')}`
      : 'Did not catch an item there.');
  }

  const rows = p.items.map((it: any) => ({
    household_id: HOUSEHOLD,
    /* What the text said, else where this house last bought it. */
    store_id: it.store?.id ?? p.store?.id ?? it.catalogStore ?? null,
    name: it.name, qty: it.qty, note: it.note, category: it.category,
    pick_yourself: !!it.pickYourself, online_ok: !!it.onlineOk,
    added_by: sender.id, source: 'sms'
  }));
  const { error } = await db.from('shopping_items').insert(rows);
  if (error) return twiml('Could not save that. Try again?');

  /* Remember what this household buys, and what they call it. The catalog is
     what stops anyone classifying milk twice. */
  for (const it of p.items) {
    /* Never learn a name that comes apart into two things already known.
       This is how "milk eggs" got into the catalog in the first place, and
       once it was there the splitter found it and merged those two items on
       every list afterwards. The parser was teaching itself its own error. */
    if (looksMerged(it.name) || isFormOnly(it.name)) continue;
    const seen = catalog.find((c: any) => c.name.toLowerCase() === it.name.toLowerCase());
    if (seen) {
      await db.from('shopping_catalog')
        .update({ times_added: (seen.times_added ?? 1) + 1, last_added_at: new Date().toISOString() })
        .eq('household_id', HOUSEHOLD).eq('name', seen.name);
    } else {
      await db.from('shopping_catalog').insert({
        household_id: HOUSEHOLD, name: it.name, category: it.category,
        store_id: p.store?.id ?? null
      });
    }
  }

  /* Say what was heard wrong. Dictation mangles brand names, and a silent
     correction is only useful until the one time it is wrong. */
  const multiStore = new Set(p.items.map((i: any) => i.store?.name ?? '')).size > 1;
  const lines = p.items.map((i: any) =>
    (multiStore && i.store ? `[${i.store.name}] ` : '') +
    `${i.qty ? i.qty + ' ' : ''}${i.name}` +
    (i.heardAs ? ` (heard "${i.heardAs}")` : '') +
    (i.note ? ` (${i.note})` : '') +
    (i.pickYourself ? ' — pick out' : ''));
  const where = (!multiStore && p.store) ? ` · ${p.store.name}` : '';
  return twiml(`Added to the list${where}:\n${lines.join('\n')}` +
    (dupes.length ? `\n\nAlready there: ${dupes.map((d: any) => d.name).join(', ')}` : ''));
}

const esc = (x: string) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/* Every way a store gets said — its name and its aliases — as one pattern,
   longest first. "Harpers" has to find HEB Harpers Trace. */
const storeRe = (st: any) =>
  new RegExp(`\\b(?:${[st.name, ...(st.aliases ?? [])].filter(Boolean)
    .sort((a: string, b: string) => b.length - a.length).map(esc).join('|')})\\b`, 'ig');

/* Find a store named ANYWHERE in a phrase. Longest term wins, so "HEB on
   1488" is never cut short to "HEB". */
function storeIn(stores: any[], text: string) {
  const t = String(text);
  const hits = storeTerms(stores).filter(({ text: term }) =>
    new RegExp(`\\b${esc(term)}\\b`, 'i').test(t));
  return hits.length ? hits[0].store : null;
}
const stripStore = (st: any, text: string) => String(text).replace(storeRe(st), ' ');

/* Match a store by name, loosely — "heb", "the HEB", "H-E-B". */
function findStore(stores: any[], text: string) {
  const norm = (n: string) => String(n).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const t = norm(text);
  if (!t) return null;
  for (const { store, text: term } of storeTerms(stores)) if (norm(term) === t) return store;
  return storeIn(stores, text);
}

/* ===========================================================================
 * TODOS
 *
 * The third thing a text can be. An event has a clock; shopping has a store;
 * a todo has neither — just somebody who owes it and, sometimes, a day it is
 * wanted by. Order is whatever that person dragged it into, because a list
 * that silently re-sorts itself is not a list anyone trusts.
 * ========================================================================= */

async function showTodos(db: any, who: any) {
  const { data: rows } = await db.rpc('member_todos', { p_member: who.id });
  if (!rows?.length) return twiml(`${who.name} has nothing on the list.`);

  const line = (t: any) => {
    const bits = [];
    if (t.overdue_days > 0) bits.push(`${t.overdue_days}d late`);
    else if (t.due_on)      bits.push(prettyShort(t.due_on));
    if (t.shared)           bits.push('shared');
    return `• ${t.title}${bits.length ? `  (${bits.join(', ')})` : ''}`;
  };

  return twiml(`${who.name}'s list:\n` + rows.map(line).join('\n') +
               `\n\nReply "did <thing>" when one is done.`);
}

async function addTodo(db: any, body: string, sender: any, members: any[], tz: string, now: Date) {
  const roster = members.map((m: any) => ({ name: m.name, aliases: m.aliases ?? [] }));
  const p = parseTodo(body, { members: roster, now, me: sender.name });

  if (!p.title) return twiml('What needs doing?');

  /* Only adults hand out work. A kid naming someone else is not ambiguous,
     it is policy — so file it on their own list and say so plainly. A
     pending question for a nine-year-old is worse than a sentence. */
  const isAdult = ['owner','adult'].includes(sender.role);
  let assignedElsewhere = false;
  let assignees = p.assignees;
  if (!isAdult && (p.house || assignees.some((n: string) => n !== sender.name))) {
    assignees = [sender.name];
    assignedElsewhere = true;
  }

  const idOf = (n: string) => (members.find((m: any) =>
    m.name.toLowerCase() === String(n).toLowerCase()) || {}).id || null;

  /* One row per owner, sharing a batch. Two people responsible for different
     portions is two things, each with its own checkbox and its own nag. */
  const batch = crypto.randomUUID();
  const targets = (p.house && isAdult) ? [null] : assignees.map(idOf).filter(Boolean);
  if (!targets.length) targets.push(sender.id);

  const rows = targets.map((mid: any) => ({
    household_id: HOUSEHOLD, title: p.title, assignee_id: mid,
    assigned_by: sender.id, batch_id: batch, due_on: p.due_on, due_time: p.due_time,
    repeat_freq: p.repeat?.freq ?? null,
    repeat_interval: p.repeat?.interval ?? 1,
    repeat_days: p.repeat?.days ?? [],
    repeat_until: p.repeat?.until ?? null,
    source: 'sms', created_by: sender.id
  }));

  const { data: made, error } = await db.from('todos').insert(rows).select('id');
  if (error) return twiml(`Could not save that: ${error.message}`);

  if (made?.length) {
    /* created_at is set explicitly: an upsert only touches the columns it
       names, and "delete that" compares this timestamp against the newest
       shopping row to decide which one you meant. */
    await db.from('sms_last_action').upsert({
      member_id: sender.id, household_id: HOUSEHOLD,
      todo_id: made[0].id, event_id: null, occurrence_date: null, action: 'create',
      created_at: new Date().toISOString()
    }, { onConflict: 'member_id' });
  }

  const whoLabel = (p.house && isAdult) ? 'the house'
                 : assignees.length ? assignees.join(' and ') : sender.name;
  const when = p.due_on ? ` · by ${prettyShort(p.due_on)}` : '';
  /* describe() renders the repeat phrase and is already inlined here;
     describeRepeat lives in recur.js, which is not. allDay:true because
     a todo has no clock and describe() would try to format one. */
  const rep  = p.repeat
    ? ` · ${describe({ repeat: p.repeat, date: p.due_on, allDay: true }).repeat}` : '';

  return twiml(`On ${whoLabel === sender.name ? 'your' : whoLabel + "'s"} list: ` +
               `${p.title}${when}${rep}` +
               (assignedElsewhere
                 ? `\n\nAdded to your list — only a parent can give someone else a to-do.`
                 : ''));
}

/* Whose chore is this, said out loud when it is not the sender's own. Jess
   closing Bryce's trash must read back "(Bryce)" or a wrong pick is
   invisible. A shared one says so; the sender's own says nothing. */
function ownerTag(t: any, sender: any, members: any[]) {
  if (t.assignee_id == null) return ' (house)';
  if (t.assignee_id === sender.id) return '';
  const m = members.find((x: any) => x.id === t.assignee_id);
  return m ? ` (${m.name})` : '';
}

/* Everything this person is allowed to close by text: their own list, the
   house's shared items, the lists of anyone whose alerts route to them
   (Bryce has no phone; his nag lands on Jess; her "did trash" has to reach
   his row), and — for an adult — anything they handed out themselves. */
async function closableTodos(db: any, sender: any, members: any[]) {
  const isAdult = ['owner','adult'].includes(sender.role);
  const wards = members.filter((m: any) =>
    m.notify_via_member_id === sender.id && m.id !== sender.id).map((m: any) => m.id);
  const ors = [`assignee_id.eq.${sender.id}`, 'assignee_id.is.null'];
  if (wards.length) ors.push(`assignee_id.in.(${wards.join(',')})`);
  if (isAdult)      ors.push(`assigned_by.eq.${sender.id}`);
  const { data } = await db.from('todos')
    .select('id, title, assignee_id, assigned_by, due_on')
    .eq('household_id', HOUSEHOLD)
    .is('deleted_at', null).is('cleared_at', null).is('completed_at', null)
    .or(ors.join(','));
  return data ?? [];
}

/* The one way a todo gets closed by text. Records it as the sender's last
   action so a second "did it" says "already done" instead of closing
   something else. */
async function completeTodo(db: any, t: any, sender: any, members: any[]) {
  await db.from('todos').update({
    completed_at: new Date().toISOString(), completed_by: sender.id
  }).eq('id', t.id);
  await db.from('reminders').delete().eq('todo_id', t.id).is('sent_at', null);
  await db.from('sms_last_action').upsert({
    member_id: sender.id, household_id: HOUSEHOLD,
    todo_id: t.id, event_id: null, occurrence_date: null, action: 'done',
    created_at: new Date().toISOString()
  }, { onConflict: 'member_id' });
  return twiml(`Done: ${t.title}${ownerTag(t, sender, members)}`);
}

async function finishTodo(db: any, needle: string, sender: any, members: any[]) {
  const rows = await closableTodos(db, sender, members);
  if (!rows.length) return twiml('Nothing open on your list.');

  const scored = rows.map((t: any) => ({ t, s: scoreTitle(needle, t.title) }))
                     .filter((x: any) => x.s >= 0.5)
                     .sort((a: any, b: any) => b.s - a.s);

  if (!scored.length) return twiml(`Nothing open called "${needle}".`);

  /* A clear winner is taken and echoed — completion is one tap to undo and
     the echo makes a wrong pick obvious. A tie is asked about, because
     guessing between two real chores just moves the problem. Each option
     names its owner: two "Unload the dishwasher" rows are two people. */
  if (scored.length > 1 && scored[1].s === scored[0].s) {
    const few = scored.slice(0, 4);
    const opts = few.map((x: any, i: number) => ({ keys: [String(i + 1)], value: x.t.id }));
    opts.push({ keys: ['cancel','stop','no'], value: 'cancel' });
    await db.from('sms_pending').upsert({
      household_id: HOUSEHOLD, member_id: sender.id, kind: 'pick_todo',
      payload: {}, options: opts,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString()
    }, { onConflict: 'member_id' });
    return twiml('Which one?\n' +
      few.map((x: any, i: number) => `${i + 1} = ${x.t.title}${ownerTag(x.t, sender, members)}`).join('\n'));
  }

  return await completeTodo(db, scored[0].t, sender, members);
}

/* ===========================================================================
 * QUESTIONS
 *
 * "anything Thursday?" is answered from the same expander the morning digest
 * reads (member_day → occurrences_on → event_cast), so the text number and
 * the 6:30 message can never disagree about what Thursday holds. Nothing in
 * this section writes a row, and nothing here touches sms_last_action.
 * ========================================================================= */

/* One day for the whole house: every member's member_day merged by
   occurrence, plus any occurrence with nobody on it (member_id null, no
   cast) which member_day cannot see. */
async function householdDay(db: any, members: any[], date: string) {
  const byKey = new Map<string, any>();
  const key = (r: any) => `${r.title}|${r.all_day ? 'allday' : r.starts_at}`;
  for (const m of members) {
    const { data: rows } = await db.rpc('member_day', { p_member: m.id, p_date: date });
    for (const r of rows ?? []) {
      const k = key(r);
      if (!byKey.has(k)) byKey.set(k, { ...r, cast: [] });
      byKey.get(k).cast.push({ id: m.id, name: m.name, role: r.role });
    }
  }
  const { data: all } = await db.rpc('occurrences_on', { p_date: date });
  for (const o of all ?? []) {
    const k = key(o);
    if (!byKey.has(k)) byKey.set(k, { ...o, role: null, cast: [] });
  }
  return [...byKey.values()].sort((a: any, b: any) =>
    a.all_day !== b.all_day ? (a.all_day ? -1 : 1)
    : String(a.starts_at ?? '').localeCompare(String(b.starts_at ?? '')));
}

/* roleVerb() — "Jess drives", "Erich brings them back" — lives in the
   inlined parser (parse.js §19) so the app's cards say it the same way. */
const RIDE_ROLES = ['driving', 'dropoff', 'pickup'];

function dayLine(o: any, tz: string) {
  const when = o.all_day ? 'All day' : clock(utcToWall(o.starts_at, tz)).replace(/ \(.*\)$/, '');
  const going  = o.cast.filter((c: any) => !RIDE_ROLES.includes(c.role)).map((c: any) => roleVerb(c.name, c.role));
  const riding = o.cast.filter((c: any) =>  RIDE_ROLES.includes(c.role)).map((c: any) => roleVerb(c.name, c.role));
  const who = [going.length ? going.join(', ') : (o.cast.length ? '' : 'Everyone'), riding.join(', ')]
    .filter(Boolean).join('; ');
  return `${when}  ${o.title}${who ? ` — ${who}` : ''}`;
}

/* Tonight's dinner, phrased exactly as the digest phrases it. */
async function dinnerLine(db: any, house: any, date: string) {
  const { data: meal } = await db.from('meal_plan')
    .select('id, ready_by, freeform, cook_id, created_by, done_at, headcount_override, recipes(name)')
    .eq('household_id', HOUSEHOLD).eq('plan_date', date).eq('slot', 'dinner')
    .is('deleted_at', null).maybeSingle();
  if (!meal) return null;
  const dish = (meal as any).recipes?.name || meal.freeform || 'Dinner';
  const cookId = meal.cook_id ?? house?.default_cook_id ?? meal.created_by ?? null;
  let cookName = '';
  if (cookId) {
    const { data: c } = await db.from('members').select('name').eq('id', cookId).maybeSingle();
    cookName = c?.name ?? '';
  }
  const who = cookName ? ` — ${cookName} cooks` : '';
  const by  = meal.ready_by ? `${who ? ',' : ' —'} on the table by ${clock12(meal.ready_by)}` : '';
  return `Dinner: ${dish}${who}${by}${meal.done_at ? ' (done)' : ''}${await homeNote(db, date, meal.headcount_override)}`;
}

/* "(3 home — Addie at Church 6:30)" when not everyone is at the table (027). */
async function homeNote(db: any, date: string, override: number | null = null) {
  const { data: rows } = await db.rpc('home_for_dinner', { p_household: HOUSEHOLD, p_date: date });
  if (!rows?.length) return '';
  const home = rows.filter((r: any) => r.home).length;
  const out  = rows.filter((r: any) => !r.home).map((r: any) => `${r.name} ${r.why || 'out'}`);
  const n = override ?? home;
  if (n === rows.length && !out.length) return '';
  return ` (${n} home${out.length ? ` — ${out.join(', ')}` : ''})`;
}

const clock12 = (t: string) => { const [h, m] = String(t).split(':').map(Number);
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2,'0') : ''}${h < 12 ? 'am' : 'pm'}`; };

async function answerDay(db: any, house: any, members: any[], routed: any, sender: any, tz: string) {
  const date = routed.date;
  const who  = routed.who
    ? members.find((m: any) => m.name.toLowerCase() === String(routed.who).toLowerCase()) : null;
  let day = await householdDay(db, members, date);
  if (who) day = day.filter((o: any) => o.cast.some((c: any) => c.id === who.id));

  const head = `${who ? who.name + ', ' : ''}${pretty(date)}:`;
  const lines = day.map((o: any) => dayLine(o, tz));
  const dinner = await dinnerLine(db, house, date);
  let text = lines.length
    ? `${head}\n${lines.join('\n')}`
    : `${who ? who.name + ' has nothing' : 'Nothing'} on ${pretty(date)}.`;
  if (dinner) text += `\n${dinner}`;

  /* "Dentist Thursday?" — answered above; the add is one reply away, through
     the route_intent question that already exists, so no new pending kind. */
  if (routed.offer) {
    await db.from('sms_pending').upsert({
      household_id: HOUSEHOLD, member_id: sender.id, kind: 'route_intent',
      payload: { body: routed.offer },
      options: [ { keys: ['1','yes','add','y'], value: 'event' },
                 { keys: ['cancel','stop','no','n'], value: 'cancel' } ],
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString()
    }, { onConflict: 'member_id' });
    text += `\n\nReply 1 to add "${routed.offerTitle}" on ${prettyShort(date)}.`;
  }
  return twiml(text);
}

async function answerDriver(db: any, members: any[], routed: any, tz: string) {
  if (!routed.who) return twiml('Who? Say "who\'s driving Addie Monday".');
  const who = members.find((m: any) => m.name.toLowerCase() === String(routed.who).toLowerCase());
  if (!who) return twiml(`I don't know ${routed.who}.`);
  const day = (await householdDay(db, members, routed.date))
    .filter((o: any) => o.cast.some((c: any) => c.id === who.id));
  if (!day.length) return twiml(`${who.name} has nothing on ${pretty(routed.date)}.`);
  const lines = day.map((o: any) => {
    const when = o.all_day ? 'All day' : clock(utcToWall(o.starts_at, tz)).replace(/ \(.*\)$/, '');
    const rides = o.cast.filter((c: any) => RIDE_ROLES.includes(c.role)).map((c: any) => roleVerb(c.name, c.role));
    return `${when}  ${o.title} — ${rides.length ? rides.join(', ') : "nobody's driving yet"}`;
  });
  return twiml(`${who.name}, ${pretty(routed.date)}:\n${lines.join('\n')}`);
}

async function answerDinner(db: any, house: any, routed: any) {
  const line = await dinnerLine(db, house, routed.date);
  const when = routed.date === nowYmd(house?.timezone) ? 'tonight' : `on ${prettyShort(routed.date)}`;
  if (!line) return twiml(`Nothing planned for dinner ${when}.`);
  return twiml(line.replace(/^Dinner:/, `Dinner ${when}:`));
}

const nowYmd = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Chicago',
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/* "did Jess get the milk" — on the list unbought, bought (by whom, when), or
   not on the list at all. The item goes through the shopping parser so
   "the milk" and "2% milk" land on the same catalog name. */
async function answerGot(db: any, members: any[], routed: any, tz: string) {
  const { stores, catalog } = await shopContext(db);
  const parsed = parseShopping(routed.item, { stores, catalog });
  const wanted = (parsed.items.length ? parsed.items.map((i: any) => i.name) : [routed.item])
    .map((s: string) => s.toLowerCase());
  const { data: live } = await db.from('shopping_items')
    .select('name, got, got_at, got_by').eq('household_id', HOUSEHOLD).is('cleared_at', null);
  const lower = (r: any) => String(r.name).toLowerCase();
  let hits = (live ?? []).filter((r: any) => wanted.includes(lower(r)));
  if (!hits.length) hits = (live ?? []).filter((r: any) =>
    wanted.some(w => lower(r).includes(w) || w.includes(lower(r))));
  if (!hits.length) return twiml(`"${wanted.join(', ')}" isn't on the list.`);

  const nameOf = (id: string | null) => members.find((m: any) => m.id === id)?.name ?? 'Someone';
  const today = nowYmd(tz);
  const lines = hits.map((h: any) => {
    if (!h.got) return `${h.name} — on the list, not bought yet.`;
    const d = h.got_at ? new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(h.got_at)) : null;
    const when = !d ? '' : d === today ? ` today at ${clock(utcToWall(h.got_at, tz)).replace(/ \(.*\)$/, '')}` : ` on ${prettyShort(d)}`;
    return `${nameOf(h.got_by)} got ${h.name}${when}.`;
  });
  return twiml(lines.join('\n'));
}

/* ===========================================================================
 * NOT HAPPENING — absences and skips
 *
 * The SQL (024) does the work: apply_absence writes the skips, pauses the
 * reminders and nags, and hands back what it did; the text here only says
 * it out loud. A single cancelled occurrence is a skip exception with no
 * absence behind it.
 * ========================================================================= */
const KIND_SAY: Record<string, string> = { sick: 'home sick', away: 'away', school_closed: 'no school' };

function rangeSay(from: string, to: string) {
  return from === to ? prettyShort(from) : `${prettyShort(from)}–${prettyShort(to)}`;
}
function occSay(o: any, tz: string, withDate: boolean) {
  const when = o.all_day ? '' : ` ${clock(utcToWall(o.starts_at, tz)).replace(/ \(.*\)$/, '')}`;
  return `${withDate ? prettyShort(o.date) + ' ' : ''}${o.title}${when}`;
}

async function recordAbsence(db: any, routed: any, sender: any, members: any[], tz: string) {
  const who = routed.who
    ? members.find((m: any) => m.name.toLowerCase() === String(routed.who).toLowerCase()) : null;
  if (routed.who && !who) return twiml(`I don't know ${routed.who}.`);

  const { data: row, error } = await db.from('member_absences').insert({
    household_id: HOUSEHOLD, member_id: who?.id ?? null, kind: routed.kind,
    from_date: routed.from, to_date: routed.to, created_by: sender.id
  }).select('id').single();
  if (error || !row) return twiml(`Could not save that: ${error?.message ?? 'unknown'}`);

  const { data: res } = await db.rpc('apply_absence', { p_absence: row.id });
  const multi = routed.from !== routed.to;
  const head = who
    ? `${who.name} ${KIND_SAY[routed.kind]} ${rangeSay(routed.from, routed.to)}.`
    : `${routed.kind === 'school_closed' ? 'No school' : 'Noted'} ${rangeSay(routed.from, routed.to)}.`;
  const lines: string[] = [head];
  const skipped = res?.skipped ?? [], uncovered = res?.uncovered ?? [];
  if (skipped.length) {
    lines.push('Skipped: ' + skipped.slice(0, 8).map((o: any) =>
      `${occSay(o, tz, multi)}${!who && o.who ? ` (${o.who})` : ''}${o.driver ? ` (${o.driver} was driving)` : ''}`).join(', ')
      + (skipped.length > 8 ? ` +${skipped.length - 8} more` : ''));
  }
  if (uncovered.length) {
    lines.push('Uncovered: ' + uncovered.slice(0, 8).map((o: any) =>
      `${occSay(o, tz, true)} ${o.role === 'driving' ? 'drive' : o.role}${o.who && who?.id !== o.who ? ` (${o.who})` : ''}`).join(', ')
      + '. Someone else will need to take it.');
  }
  if (res?.nags_paused > 0) lines.push(`${res.nags_paused === 1 ? 'Chore nag' : `${res.nags_paused} chore nags`} paused.`);
  if (!skipped.length && !uncovered.length) lines.push('Nothing on the calendar to skip.');
  lines.push(`Say "${who ? who.name + ' is fine' : 'school is on'}" to undo.`);
  return twiml(lines.join('\n'));
}

/* Every occurrence in a range whose title answers to the needle. */
async function findOccurrences(db: any, title: string, from: string, to: string) {
  const out: any[] = [];
  const start = new Date(from + 'T12:00:00Z'), end = new Date(to + 'T12:00:00Z');
  for (let d = new Date(start), i = 0; d <= end && i < 62; d.setUTCDate(d.getUTCDate() + 1), i++) {
    const date = d.toISOString().slice(0, 10);
    const { data: occ } = await db.rpc('occurrences_on', { p_date: date });
    for (const o of occ ?? []) {
      const sc = scoreTitle(title, o.title);
      if (sc >= 0.5) out.push({ ...o, date, score: sc });
    }
  }
  const best = Math.max(0, ...out.map(o => o.score));
  return out.filter(o => o.score === best);
}

async function skipOccurrences(db: any, occ: any[], sender: any, tz: string) {
  const rows = occ.map((o: any) => ({
    household_id: HOUSEHOLD, event_id: o.event_id, occurrence_date: o.date,
    action: 'skip', created_by: sender.id
  }));
  const { error } = await db.from('event_exceptions')
    .upsert(rows, { onConflict: 'event_id,occurrence_date' });
  if (error) return twiml(`Could not skip that: ${error.message}`);
  const multi = new Set(occ.map((o: any) => o.date)).size > 1 || occ.length > 1;
  return twiml(`Skipped: ${occ.slice(0, 10).map((o: any) => occSay(o, tz, multi)).join(', ')}` +
               (occ.length > 10 ? ` +${occ.length - 10} more` : '') +
               `.\nSay "never mind, ${occ[0].title.toLowerCase()} is on" to undo.`);
}

async function skipEvent(db: any, routed: any, sender: any, tz: string) {
  const occ = await findOccurrences(db, routed.title, routed.from, routed.to);
  if (!occ.length) return twiml(`Nothing called "${routed.title}" ${rangeSay(routed.from, routed.to)}.`);
  const titles = [...new Set(occ.map((o: any) => o.title))];
  if (titles.length > 1) {
    /* Two different things answer to the name. Ask, through the question
       kind that already exists; the answer picks one title. */
    const few = titles.slice(0, 4);
    await db.from('sms_pending').upsert({
      household_id: HOUSEHOLD, member_id: sender.id, kind: 'route_intent',
      payload: { body: routed.title, skip: { from: routed.from, to: routed.to, titles: few } },
      options: [ ...few.map((t: string, i: number) => ({ keys: [String(i + 1)], value: `skip:${i}` })),
                 { keys: ['cancel','stop','no'], value: 'cancel' } ],
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString()
    }, { onConflict: 'member_id' });
    return twiml('Which one?\n' + few.map((t: string, i: number) => `${i + 1} = ${t}`).join('\n'));
  }
  return await skipOccurrences(db, occ, sender, tz);
}

async function unskip(db: any, routed: any, sender: any, members: any[], tz: string) {
  const restore = async (xs: any[]) => {
    let n = 0;
    for (const x of xs) {
      await db.from('event_exceptions').delete().eq('id', x.id);
      await db.rpc('rematerialize_occurrence', { p_event: x.event_id, p_date: x.occurrence_date });
      n++;
    }
    return n;
  };

  /* "cancel the skip": the newest thing this person did — an absence, or a
     lone skip — within the last day. */
  if (routed.last) {
    const { data: ab } = await db.from('member_absences').select('id, kind, member_id, created_at')
      .eq('household_id', HOUSEHOLD).eq('created_by', sender.id).is('deleted_at', null)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    const { data: ex } = await db.from('event_exceptions').select('id, event_id, occurrence_date, created_at, events(title)')
      .eq('household_id', HOUSEHOLD).eq('created_by', sender.id).eq('action', 'skip').is('absence_id', null)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    const tA = ab ? Date.parse(ab.created_at) : 0, tX = ex ? Date.parse(ex.created_at) : 0;
    if (!tA && !tX) return twiml('Nothing of yours to undo.');
    if (tA >= tX) {
      await db.rpc('revoke_absence', { p_absence: ab.id });
      const m = members.find((x: any) => x.id === ab.member_id);
      return twiml(`Undone — ${m ? m.name + ' is' : 'the kids are'} back on the calendar.`);
    }
    await restore([ex]);
    return twiml(`Undone — ${ex.events?.title ?? 'it'} is back on ${prettyShort(ex.occurrence_date)}.`);
  }

  /* "Bryce is fine" / "school is on": the live absence that covers the day. */
  if (routed.who || routed.kind === 'school_closed') {
    const who = routed.who
      ? members.find((m: any) => m.name.toLowerCase() === String(routed.who).toLowerCase()) : null;
    if (routed.who && !who) return twiml(`I don't know ${routed.who}.`);
    let q = db.from('member_absences').select('id, kind, from_date, to_date')
      .eq('household_id', HOUSEHOLD).is('deleted_at', null)
      .lte('from_date', routed.to).gte('to_date', routed.from)
      .order('created_at', { ascending: false });
    q = who ? q.eq('member_id', who.id) : q.is('member_id', null).eq('kind', 'school_closed');
    const { data: abs } = await q;
    if (!abs?.length) return twiml(who ? `${who.name} wasn't marked out ${rangeSay(routed.from, routed.to)}.`
                                        : `School wasn't marked closed ${rangeSay(routed.from, routed.to)}.`);
    let n = 0;
    for (const a of abs) { const { data: k } = await db.rpc('revoke_absence', { p_absence: a.id }); n += k ?? 0; }
    return twiml(`${who ? who.name + ' is' : 'The kids are'} back on the calendar` +
                 (n ? ` — ${n} thing${n === 1 ? '' : 's'} un-skipped, reminders back.` : '.'));
  }

  /* "never mind, orchestra is on": lone skips matching the title in range. */
  if (routed.title) {
    const { data: xs } = await db.from('event_exceptions').select('id, event_id, occurrence_date, events(title)')
      .eq('household_id', HOUSEHOLD).eq('action', 'skip')
      .gte('occurrence_date', routed.from).lte('occurrence_date', routed.to);
    const hits = (xs ?? []).filter((x: any) => scoreTitle(routed.title, x.events?.title ?? '') >= 0.5);
    if (!hits.length) return twiml(`Nothing called "${routed.title}" is skipped ${rangeSay(routed.from, routed.to)}.`);
    const n = await restore(hits);
    return twiml(`${hits[0].events?.title ?? routed.title} is back on ${hits.map((x: any) => prettyShort(x.occurrence_date)).join(', ')} (${n} restored).`);
  }
  return twiml('Undo what? Say "Bryce is fine", "school is on", or "never mind, orchestra is on".');
}

/* "dinner is leftovers" — tonight's meal, said once. A saved recipe whose
   name answers to the words is planned as that recipe (servings by the same
   rule as the app: a batch recipe is made as a batch); anything else is a
   freeform meal. The cook is left null so the household default applies. */
async function setDinner(db: any, routed: any, sender: any, house: any) {
  const { data: recipes } = await db.from('recipes').select('id, name, servings')
    .eq('household_id', HOUSEHOLD).is('deleted_at', null);
  const scored = (recipes ?? []).map((r: any) => ({ r, s: scoreTitle(routed.dish, r.name) }))
    .filter((x: any) => x.s >= 0.6).sort((a: any, b: any) => b.s - a.s);
  const recipe = scored[0]?.r ?? null;
  const dflt = house?.default_servings ?? 4;
  const servings = recipe?.servings && recipe.servings >= 2 * dflt ? recipe.servings : dflt;
  /* A week's meals, not seven fixed days (029). "We're having tacos
     tonight" when tacos are planned for Thursday MOVES Thursday's tacos to
     tonight; whatever tonight had goes back into the week's tray. Nothing is
     overwritten and nothing is deleted. Only a night that already holds the
     same dish is updated in place. */
  const ws = weekStartOf(routed.date);
  const { data: week } = await db.from('meal_plan')
    .select('id, plan_date, freeform, recipe_id, recipes(name)')
    .eq('household_id', HOUSEHOLD).eq('slot', 'dinner').is('deleted_at', null).eq('week_start', ws);
  const nameOf = (m: any) => m.recipes?.name || m.freeform || '';
  const same = (m: any) => (recipe && m.recipe_id === recipe.id) || scoreTitle(routed.dish, nameOf(m)) >= 0.6;
  const onNight = (week ?? []).find((m: any) => m.plan_date === routed.date);
  const elsewhere = (week ?? []).find((m: any) => m.plan_date !== routed.date && same(m));
  const movedFrom = elsewhere?.plan_date ?? null;      // before anything changes
  let bumped: any = null, error: any = null;
  if (onNight && same(onNight)) {
    ({ error } = await db.from('meal_plan').update({ servings, updated_at: new Date().toISOString() }).eq('id', onNight.id));
  } else if (elsewhere) {
    const r = await db.rpc('meal_move', { p_meal: elsewhere.id, p_date: routed.date });
    error = r.error; bumped = (week ?? []).find((m: any) => m.id === r.data) ?? null;
  } else {
    const row: any = {
      household_id: HOUSEHOLD, plan_date: null, week_start: ws, slot: 'dinner',
      recipe_id: recipe?.id ?? null, freeform: recipe ? null : routed.dish,
      servings, created_by: sender.id, updated_at: new Date().toISOString()
    };
    const ins = await db.from('meal_plan').insert(row).select('id').single();
    error = ins.error;
    if (!error) {
      const r = await db.rpc('meal_move', { p_meal: ins.data.id, p_date: routed.date });
      error = r.error; bumped = (week ?? []).find((m: any) => m.id === r.data) ?? null;
    }
  }
  if (error) return twiml(`Could not save that: ${error.message}`);
  const line = await dinnerLine(db, house, routed.date);
  const when = routed.date === nowYmd(house?.timezone) ? 'tonight' : `on ${prettyShort(routed.date)}`;
  return twiml((line ?? `Dinner: ${routed.dish}`).replace(/^Dinner:/, `Dinner ${when}:`) +
               (recipe ? ' (from your recipes)' : '') +
               (movedFrom ? ` — moved from ${prettyShort(movedFrom)}` : '') +
               (bumped ? `. ${nameOf(bumped) || 'The other dinner'} is back in the week's tray.` : ''));
}

/* The Sunday a date belongs to (029 week_start). */
const weekStartOf = (d: string) => {
  const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() - x.getUTCDay());
  return x.toISOString().slice(0, 10);
};

/* "Addie's at church, 3 for dinner" — the number wins over the calendar's
   count, and the servings follow it. A freeform "Dinner" row is made when
   nothing is planned yet, so the number has somewhere to live. */
async function setHeadcount(db: any, routed: any, sender: any, house: any) {
  const { data: existing } = await db.from('meal_plan').select('id')
    .eq('household_id', HOUSEHOLD).eq('plan_date', routed.date).eq('slot', 'dinner')
    .is('deleted_at', null).maybeSingle();
  const patch = { headcount_override: routed.n, servings: routed.n, updated_at: new Date().toISOString() };
  const { error } = existing
    ? await db.from('meal_plan').update(patch).eq('id', existing.id)
    : await db.from('meal_plan').insert({ household_id: HOUSEHOLD, plan_date: routed.date, slot: 'dinner',
                                          freeform: 'Dinner', created_by: sender.id, ...patch });
  if (error) return twiml(`Could not save that: ${error.message}`);
  const when = routed.date === nowYmd(house?.timezone) ? 'tonight' : `on ${prettyShort(routed.date)}`;
  return twiml(`Dinner ${when} for ${routed.n}${routed.note ? ` (${routed.note})` : ''}.`);
}

/* The week ahead is Monday through Sunday, starting tomorrow when today is
   Sunday; last week is the seven days before it. Shared by the Sunday nudge
   (morning-digest) and this reply, so "last week" means the same days. */
function weekAhead(todayYmd: string) {
  const t = new Date(todayYmd + 'T12:00:00Z');
  const dow = t.getUTCDay();                       // 0 = Sunday
  const mon = new Date(t); mon.setUTCDate(t.getUTCDate() + (dow === 0 ? 1 : 8 - dow));
  const days: string[] = [];
  for (let i = 0; i < 7; i++) { const d = new Date(mon); d.setUTCDate(mon.getUTCDate() + i); days.push(d.toISOString().slice(0, 10)); }
  return days;
}
const DOW3 = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

/* "same as last week": copy last week's dinners onto the week ahead where
   nothing is planned. Servings and cook come along; the countdown rebuilds
   itself through meal_resync. */
async function repeatLastWeek(db: any, sender: any, house: any) {
  const today = nowYmd(house?.timezone);
  const ahead = weekAhead(today);
  const back  = ahead.map(d => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() - 7); return x.toISOString().slice(0, 10); });
  const { data: src } = await db.from('meal_plan')
    .select('plan_date, recipe_id, freeform, servings, cook_id, ready_by, recipes(name)')
    .eq('household_id', HOUSEHOLD).eq('slot', 'dinner').is('deleted_at', null)
    .gte('plan_date', back[0]).lte('plan_date', back[6]);
  if (!src?.length) return twiml('Nothing was planned last week to repeat.');
  const { data: have } = await db.from('meal_plan').select('plan_date')
    .eq('household_id', HOUSEHOLD).eq('slot', 'dinner').is('deleted_at', null)
    .gte('plan_date', ahead[0]).lte('plan_date', ahead[6]);
  const taken = new Set((have ?? []).map((m: any) => m.plan_date));
  const rows: any[] = [], said: string[] = [];
  for (const m of src) {
    const i = back.indexOf(m.plan_date);
    if (i < 0 || taken.has(ahead[i])) continue;
    rows.push({ household_id: HOUSEHOLD, plan_date: ahead[i], slot: 'dinner',
                recipe_id: m.recipe_id, freeform: m.recipe_id ? null : m.freeform,
                servings: m.servings, cook_id: m.cook_id, ready_by: m.ready_by, created_by: sender.id });
    said.push(`${DOW3[new Date(ahead[i] + 'T12:00:00Z').getUTCDay()]} ${(m as any).recipes?.name || m.freeform || 'Dinner'}`);
  }
  /* Last week's tray comes along too, still undated (029). */
  const thisWs = weekStartOf(ahead[0]), lastWs = weekStartOf(back[0]);
  const { data: tray } = await db.from('meal_plan')
    .select('recipe_id, freeform, servings, cook_id, recipes(name)')
    .eq('household_id', HOUSEHOLD).eq('slot', 'dinner').is('deleted_at', null)
    .is('plan_date', null).eq('week_start', lastWs);
  const { data: haveTray } = await db.from('meal_plan').select('recipe_id, freeform')
    .eq('household_id', HOUSEHOLD).eq('slot', 'dinner').is('deleted_at', null)
    .is('plan_date', null).eq('week_start', thisWs);
  for (const m of tray ?? []) {
    if ((haveTray ?? []).some((h: any) => (m.recipe_id && h.recipe_id === m.recipe_id) || (!m.recipe_id && h.freeform === m.freeform))) continue;
    rows.push({ household_id: HOUSEHOLD, plan_date: null, week_start: thisWs, slot: 'dinner',
                recipe_id: m.recipe_id, freeform: m.recipe_id ? null : m.freeform,
                servings: m.servings, cook_id: m.cook_id, created_by: sender.id });
    said.push(`(no day) ${(m as any).recipes?.name || m.freeform || 'Dinner'}`);
  }
  if (!rows.length) return twiml('This week is already planned — nothing to copy.');
  const { error } = await db.from('meal_plan').insert(rows);
  if (error) return twiml(`Could not plan that: ${error.message}`);
  return twiml(`Planned: ${said.join(' · ')}.`);
}

const ASK_HELP = 'I can answer: "what\'s Thursday", "who\'s driving Addie Monday", ' +
                 '"what\'s for dinner", "did Jess get the milk". To add something, leave off the "?".';

const prettyShort = (d: string) =>
  new Date(d + 'T12:00:00Z').toLocaleDateString('en-US',
    { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

async function showShopping(db: any, store: any = null) {
  const { stores } = await shopContext(db);
  let q = db.from('shopping_items')
    .select('name, qty, category, note, got, store_id, pick_yourself')
    .eq('household_id', HOUSEHOLD).is('cleared_at', null);
  if (store) q = q.eq('store_id', store.id);
  const { data: items } = await q;

  const scope = store ? ` — ${store.name}` : '';
  if (!items?.length) return twiml(`The list${scope} is empty.`);

  const { data: cats } = await db.from('shopping_categories').select('name, sort_order');
  const order = new Map((cats ?? []).map((c: any) => [c.name, c.sort_order]));
  const storeName = (id: string | null) =>
    stores.find((s: any) => s.id === id)?.name ?? 'Any store';

  const need = items.filter((i: any) => !i.got);
  const got  = items.filter((i: any) => i.got);
  const label = (i: any) =>
    `${i.qty ? i.qty + ' ' : ''}${i.name}${i.pick_yourself ? ' *' : ''}`;

  if (!need.length) {
    return twiml(`Nothing left to get${scope}.` +
      (got.length ? `\n\nGot: ${got.map(label).join(', ')}` : ''));
  }

  /* Grouped by store when a trip covers more than one, because the list is
     read standing in ONE of them. */
  const groups = new Map<string, any[]>();
  for (const it of need) {
    const k = store ? '' : storeName(it.store_id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(it);
  }

  const blocks = [...groups.entries()].map(([k, rows]) => {
    rows.sort((a: any, b: any) => (order.get(a.category) ?? 999) - (order.get(b.category) ?? 999));
    return (k ? `${k}:\n` : '') + rows.map(label).join('\n');
  });

  let out = `Shopping${scope} — ${need.length} to get\n` + blocks.join('\n\n');
  if (need.some((i: any) => i.pick_yourself)) out += '\n\n* = pick it out yourself';
  if (got.length) out += `\n\nGot: ${got.map(label).join(', ')}`;
  return twiml(out);
}

/* Soft clear. Rows move to history; nothing is destroyed. */
async function clearList(db: any, store: any, boughtOnly: boolean) {
  let q = db.from('shopping_items').select('id, name, got')
    .eq('household_id', HOUSEHOLD).is('cleared_at', null);
  if (store) q = q.eq('store_id', store.id);
  if (boughtOnly) q = q.eq('got', true);
  const { data: rows } = await q;
  if (!rows?.length) {
    return twiml(store ? `Nothing on the ${store.name} list to clear.`
                       : 'Nothing on the list to clear.');
  }
  await db.from('shopping_items').update({ cleared_at: new Date().toISOString() })
    .in('id', rows.map((r: any) => r.id));

  const scope = store ? ` from the ${store.name} list` : '';
  if (boughtOnly) {
    const { count } = await db.from('shopping_items')
      .select('id', { count: 'exact', head: true })
      .eq('household_id', HOUSEHOLD).is('cleared_at', null).eq('got', false);
    return twiml(`Started a new list. ${rows.length} bought item${rows.length === 1 ? '' : 's'} ` +
                 `cleared${scope}; ${count ?? 0} still needed carried over.`);
  }
  return twiml(`Cleared ${rows.length} item${rows.length === 1 ? '' : 's'}${scope}. ` +
               `They are in history, not gone.`);
}

/* ---------------------------------------------------------------------------
 * CORRECTING WHAT YOU JUST SENT
 *
 * Nobody composes a text and then proofreads it. They send it, read the
 * confirmation back, and go "no, four". So the last thing each person touched
 * stays correctable by their next message, with no need to name it again.
 * -------------------------------------------------------------------------*/
const FIX_PREFIX = /^(?:no+|nope|actually|wait|sorry|oops|whoops|correction|scratch that|nvm|nevermind|never mind)\b[\s,.:;!-]*/i;
const FIX_VERB   = /^(?:make (?:it|that)|change (?:it|that)(?:\s+to)?|change to|move (?:it|that) to|set (?:it|that) to|it'?s|its)\b[\s,:-]*/i;
const KILL       = /^(?:delete|cancel|remove|undo|drop|forget)\s*(?:that|it|the last one|last one|last)?[\s.!]*$/i;

/* "2 hours" and "til 8pm" are answers to the how-long question, and nothing
   else. Neither is a plausible event title, so both are safe to read as a
   correction to the last thing you touched. */
const LENGTH_RE = /^(?:for\s+|about\s+|abt\s+)?(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\.?$/i;
const UNTIL_RE  = /^(?:til|till|until|thru|through|to|ends?(?:\s+at)?|done(?:\s+at)?)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\.?$/i;

/* Set how long the last event runs, and re-time anyone collecting. */
async function applyEnd(db: any, ev: any, endWall: string, members: any[],
                        sender: any, tz: string) {
  const startWall = ev.all_day ? '09:00' : utcToWall(ev.starts_at, tz);
  const endsAt = endInstant(ev.event_date, startWall, endWall, tz);
  await db.from('events').update({ ends_at: endsAt }).eq('id', ev.id);

  const { data: existing } = await db.from('event_people')
    .select('member_id, role, lead_minutes').eq('event_id', ev.id);
  const cast = (existing ?? []).map((r: any) => {
    const mem = members.find((m: any) => m.id === r.member_id);
    return mem ? { name: mem.name, role: r.role, lead: r.lead_minutes } : null;
  }).filter(Boolean);

  await writeCastAndReminders(db, { ...ev, ends_at: endsAt }, cast, members,
    ev.reminder_lead_minutes, tz, !!ev.repeat_freq);
  await remember(db, sender, ev.id, ev.event_date, 'edit');

  const pickers = cast.filter((c: any) => c.role === 'pickup').map((c: any) => c.name);
  return twiml(`${ev.title}\n${pretty(ev.event_date)} · ${clock(startWall)} to ${clock(endWall)}` +
    (pickers.length ? `\n${pickers.join(', ')} — pickup alert now set from the end.` : ''));
}

async function applyFix(db: any, ev: any, w: any, members: any[], sender: any, tz: string) {
  if (w.ambiguousTime) {
    await db.from('sms_pending').upsert({
      household_id: HOUSEHOLD, member_id: sender.id, kind: 'confirm_time',
      payload: { mode: 'fix', eventId: ev.id, w },
      options: timeOptions(w.ambiguousTime),
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString()
    }, { onConflict: 'member_id' });
    return twiml(askTime(ev.title, w.ambiguousTime));
  }

  const movedDate = w.matched.includes('date');
  const movedTime = w.matched.includes('time');
  const date  = movedDate ? w.date : ev.event_date;
  const patch: any = {};
  if (movedDate) patch.event_date = date;
  if (movedTime) { patch.starts_at = wallToUtc(date, w.start, tz); patch.all_day = false; }
  else if (movedDate && !ev.all_day && ev.starts_at) {
    // The day moved and the clock did not. Recompute the instant on the new
    // day rather than dragging the old UTC value across a DST boundary.
    patch.starts_at = wallToUtc(date, utcToWall(ev.starts_at, tz), tz);
  }
  if (w.matched.includes('lead')) patch.reminder_lead_minutes = w.leadMinutes;
  // A corrected end time, or one dragged along by a change of day/time.
  if (movedTime && w.end)      patch.ends_at = endInstant(date, w.start, w.end, tz);
  else if (ev.ends_at && (movedDate || movedTime)) {
    const shift = Date.parse(patch.starts_at ?? ev.starts_at) - Date.parse(ev.starts_at);
    patch.ends_at = new Date(Date.parse(ev.ends_at) + shift).toISOString();
  }
  if (Object.keys(patch).length) await db.from('events').update(patch).eq('id', ev.id);

  // Merge the cast by name: a correction naming one person must not silently
  // drop everybody else off the event.
  const { data: existing } = await db.from('event_people')
    .select('member_id, role, lead_minutes').eq('event_id', ev.id);
  const byName = new Map<string, any>();
  for (const r of existing ?? []) {
    const mem = members.find((m: any) => m.id === r.member_id);
    // Carry each person's own lead across, or a correction to the time would
    // quietly reset everybody to their role default.
    if (mem) byName.set(mem.name, { name: mem.name, role: r.role, lead: r.lead_minutes });
  }
  for (const p of w.people ?? []) byName.set(p.name, p);
  const merged = [...byName.values()]
    .map((c: any) => w.matched.includes('lead') ? { ...c, lead: null } : c);

  const evNow = { ...ev, ...patch };
  await writeCastAndReminders(db, evNow, merged, members,
    evNow.reminder_lead_minutes, tz, !!ev.repeat_freq, w.matched.includes('lead'));
  await remember(db, sender, ev.id, date, 'edit');

  const shown = { title: ev.title, allDay: evNow.all_day,
                  start: evNow.all_day ? null : utcToWall(evNow.starts_at, tz),
                  people: merged, repeat: null,
                  leadMinutes: evNow.reminder_lead_minutes };
  return twiml(confirmText(shown, date, 'Updated'));
}

/* ---------------------------------------------------------------------------
 * EDITING
 * "planning committee moved to Monday at 4" has to find the event you mean,
 * work out the change, and — if it repeats — ask whether you meant one
 * occurrence or all of them. Never guess that one.
 * -------------------------------------------------------------------------*/
const EDIT_RE = /^(?:(?:can you\s+)?(?:move|change|reschedule|resched|shift|push)\s+)?(.+?)\s+(?:is\s+)?(?:moved|changed|rescheduled|shifted|pushed|now)?\s*(?:to|for)\s+(.+)$/i;

function scoreTitle(needle: string, hay: string) {
  const a = needle.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const b = hay.toLowerCase();
  if (!a.length) return 0;
  return a.filter(w => b.includes(w)).length / a.length;
}

/* ===========================================================================
 * A KID ASKING FOR A RIDE  (parse.js §21)
 *
 * "can someone pick me up at 5" from Addie. Both parents get ONE text —
 * "Addie needs a pickup at 5:00 PM. Reply ME to take it." — as an open
 * question (sms_pending kind 'rides', the kind 016 added; payload.ask tells
 * the two uses apart). First ME wins:
 *   - the claimer gets the leave alert: a pickup role on her occurrence when
 *     one of hers ends (or starts) within 45 minutes of the time and is not
 *     a series — a role on a series row would make them the pickup for every
 *     practice — otherwise a small event "Pick up Addie" at that time with
 *     the claimer as pickup, which is what carries the reminder (013 says a
 *     reminder must have a subject).
 *   - Addie hears "Dad's got you at 5:00 PM."; the other parent hears
 *     "Erich has it." and their copy of the question is closed, so a late
 *     ME gets "Erich already has it" instead of filing an event called Me.
 * Nobody in 20 minutes: the dispatcher (which runs every minute) finds the
 * stale question and tells Addie "Nobody has answered yet — call Mom."
 * nudge_log (kind 'ride:<id>', member = the kid) is the single record of
 * "this request is settled", written by whichever of claim / nag gets
 * there first; the other one sees the conflict and stays quiet.
 * ========================================================================= */
const isKidRole = (m: any) => ['teen', 'child'].includes(String(m?.role ?? ''));
const RIDE_CLAIM_KEYS = ['me', 'i got it', 'i got this', 'i can', 'i will', "i'll", 'ill', 'i got her', 'i got him',
                         'got it', 'got her', 'got him', 'mine', 'on it', 'yes', 'ok', 'sure', 'i have it', 'i have her', 'i have him'];
const RIDE_PASS_KEYS  = ["can't", 'cant', 'cannot', 'not me', 'no', 'nope', 'busy', "i can't", 'i cant'];

/* "Dad" if the family calls them that, else the name. */
function familyName(m: any) {
  const al = (m?.aliases ?? []).map((a: string) => a.toLowerCase());
  if (al.includes('dad') || al.includes('daddy') || al.includes('papa')) return 'Dad';
  if (al.includes('mom') || al.includes('mommy') || al.includes('mama') || al.includes('mum')) return 'Mom';
  return m?.name ?? 'someone';
}
const parentsOf = (members: any[], kid: any) =>
  (members ?? []).filter((m: any) => ['owner', 'adult'].includes(m.role) && m.phone && m.id !== kid.id)
    .sort((a: any, b: any) => (a.id === kid.notify_via_member_id ? -1 : 0) - (b.id === kid.notify_via_member_id ? -1 : 0));
const clockShort = (iso: string, tz: string) => clock(utcToWall(iso, tz)).replace(/ \(.*\)$/, '');
const rideWhen = (pl: any, tz: string) => pl.at ? `at ${clockShort(pl.at, tz)}` : 'as soon as someone can';

async function requestRide(db: any, routed: any, sender: any, members: any[], tz: string, now: Date) {
  const parents = parentsOf(members, sender);
  const guardian = members.find((m: any) => m.id === sender.notify_via_member_id && m.id !== sender.id);
  if (!parents.length) return twiml(`Nobody to ask from here — call ${guardian ? familyName(guardian) : 'a parent'}.`);

  const date = ymd(now);
  let at: string | null = null;
  if (routed.time) at = wallToUtc(date, routed.time, tz);
  else if (routed.inMin != null) at = new Date(Date.now() + routed.inMin * 60_000).toISOString();
  const reqId = crypto.randomUUID();
  const askedAt = new Date().toISOString();
  const payload = { ask: 'kid_ride', reqId, kidId: sender.id, kidName: sender.name, date, at,
                    where: routed.where ?? null, askedAt };
  const options = [
    { keys: RIDE_CLAIM_KEYS, value: 'claim' },
    { keys: RIDE_PASS_KEYS,  value: 'pass' },
  ];
  const text = `${sender.name} needs a pickup ${rideWhen(payload, tz)}` +
               `${payload.where ? ` from ${payload.where}` : ''}. Reply ME to take it.`;

  const asked: string[] = [];
  for (const p of parents) {
    /* 30 minutes on the row; the dispatcher nags the kid at 20 and closes
       it, so the inbound sweep never deletes it first. */
    await db.from('sms_pending').upsert({
      household_id: HOUSEHOLD, member_id: p.id, kind: 'rides', payload, options,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString()
    }, { onConflict: 'member_id' });
    /* A question that needs a texted reply goes by text, not by push. */
    try {
      if (TWILIO_SID && TW_TOKEN && TWILIO_FROM) {
        await smsTo(TWILIO_SID, TW_TOKEN, TWILIO_FROM, p.phone, text);
        await logDelivery(db, { household_id: HOUSEHOLD, member_id: p.id, on_behalf_of: sender.id,
                                kind: 'ride_ask', ref_id: reqId, channel: 'sms', ok: true, detail: p.phone });
        asked.push(familyName(p));
      } else {
        await logDelivery(db, { household_id: HOUSEHOLD, member_id: p.id, on_behalf_of: sender.id,
                                kind: 'ride_ask', ref_id: reqId, channel: null, ok: false, detail: 'no twilio env' });
      }
    } catch (e) {
      await logDelivery(db, { household_id: HOUSEHOLD, member_id: p.id, on_behalf_of: sender.id,
                              kind: 'ride_ask', ref_id: reqId, channel: 'sms', ok: false, detail: String(e) });
    }
  }
  if (!asked.length) return twiml(`Couldn't reach anyone from here — call ${guardian ? familyName(guardian) : 'a parent'}.`);
  return twiml(`Asked ${asked.join(' and ')}. I'll tell you who's coming` +
               `${at ? ` — you said ${clockShort(at, tz)}` : ''}.`);
}

/* The occurrence this ride is for, if one of the kid's things ends (or
   starts) within 45 minutes of the time and is a one-off. */
async function rideOccurrence(db: any, kidId: string, date: string, at: string | null) {
  if (!at) return null;
  const { data: occ } = await db.rpc('occurrences_on', { p_date: date });
  const t = Date.parse(at);
  let best: any = null, bestGap = 46 * 60_000;
  for (const o of occ ?? []) {
    if (o.all_day) continue;
    const { data: cast } = await db.rpc('event_cast', { p_event: o.event_id });
    if (!(cast ?? []).some((c: any) => c.member_id === kidId)) continue;
    const gap = Math.min(Math.abs(Date.parse(o.ends_at ?? o.starts_at) - t), Math.abs(Date.parse(o.starts_at) - t));
    if (gap < bestGap) { best = o; bestGap = gap; }
  }
  if (!best) return null;
  const { data: ev } = await db.from('events').select('id, title, repeat_freq').eq('id', best.event_id).maybeSingle();
  if (!ev || ev.repeat_freq) return null;      // a series: never put a role on every week
  return ev;
}

async function claimRide(db: any, pl: any, claimer: any, members: any[], tz: string) {
  const kid = members.find((m: any) => m.id === pl.kidId);
  if (!kid) return twiml('That one is already gone.');
  /* First writer wins. (kind, for_date, member_id) is the primary key. */
  const { error: dup } = await db.from('nudge_log')
    .insert({ kind: `ride:${pl.reqId}`, for_date: pl.date, member_id: kid.id });
  if (dup) {
    return twiml(`Someone already has ${kid.name}'s ride.`);
  }

  const lead = claimer.default_lead_minutes ?? 30;
  let attached = '';
  if (pl.at) {
    const ev = await rideOccurrence(db, kid.id, pl.date, pl.at);
    if (ev) {
      await db.from('event_people').upsert({
        household_id: HOUSEHOLD, event_id: ev.id, member_id: claimer.id, role: 'pickup'
      }, { onConflict: 'event_id,member_id,role' });
      /* One-off event, so no occurrence_date (reminders_unique_occurrence is
         partial on it). Replace any unsent alert of theirs rather than add. */
      await db.from('reminders').delete().eq('event_id', ev.id).eq('member_id', claimer.id).is('sent_at', null);
      await db.from('reminders').insert({
        household_id: HOUSEHOLD, event_id: ev.id, member_id: claimer.id, lead_minutes: lead,
        fire_at: new Date(Date.parse(pl.at) - lead * 60_000).toISOString()
      });
      /* Touching the row fires resync_reminders(), which times a pickup off the end. */
      await db.from('events').update({ updated_at: new Date().toISOString() }).eq('id', ev.id);
      attached = ` (${ev.title})`;
    } else {
      const title = `Pick up ${kid.name}${pl.where ? ` from ${pl.where}` : ''}`;
      const { data: ev2 } = await db.from('events').insert({
        household_id: HOUSEHOLD, member_id: kid.id, title, all_day: false,
        event_date: pl.date, starts_at: pl.at, source: 'sms', created_by: claimer.id
      }).select('id').single();
      if (ev2) {
        await db.from('event_people').upsert([
          { household_id: HOUSEHOLD, event_id: ev2.id, member_id: kid.id,     role: 'going'  },
          { household_id: HOUSEHOLD, event_id: ev2.id, member_id: claimer.id, role: 'pickup' }
        ], { onConflict: 'event_id,member_id,role' });
        await db.from('reminders').insert({
          household_id: HOUSEHOLD, event_id: ev2.id, member_id: claimer.id, lead_minutes: lead,
          fire_at: new Date(Date.parse(pl.at) - lead * 60_000).toISOString()
        });
        await remember(db, claimer, ev2.id, pl.date, 'create');
      }
    }
  }

  const when = pl.at ? clockShort(pl.at, tz) : 'as soon as you can';
  const me = familyName(claimer);
  /* Tell the kid; tell the other parent(s) and close their copy of the question. */
  await deliver(db, OUT_ENV, kid, { householdId: HOUSEHOLD, title: 'Ride',
    body: `${me}'s got you ${pl.at ? `at ${when}` : 'soon'}.`, kind: 'ride', refId: pl.reqId, tag: `ride-${pl.reqId}` });
  for (const p of parentsOf(members, kid)) {
    if (p.id === claimer.id) continue;
    await db.from('sms_pending').upsert({
      household_id: HOUSEHOLD, member_id: p.id, kind: 'rides',
      payload: { ...pl, claimedBy: claimer.name }, options: [{ keys: RIDE_CLAIM_KEYS, value: 'claim' }],
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString()
    }, { onConflict: 'member_id' });
    await deliver(db, OUT_ENV, p, { householdId: HOUSEHOLD, title: 'Ride',
      body: `${claimer.name} has it — ${kid.name}${pl.at ? ` at ${when}` : ''}.`, kind: 'ride', refId: pl.reqId, tag: `ride-${pl.reqId}` });
  }
  return twiml(`You've got ${kid.name} ${pl.at ? `at ${when}` : 'as soon as you can'}${attached}.` +
               (pl.at ? ` I'll remind you ${lead} min before.` : ''));
}

/* "can't" from one parent: fine, the other still has the question. From the
   last one standing, the kid should not wait twenty minutes to hear it. */
async function passRide(db: any, pl: any, passer: any, members: any[]) {
  const kid = members.find((m: any) => m.id === pl.kidId);
  const { data: still } = await db.from('sms_pending').select('member_id, payload').eq('kind', 'rides');
  const open = (still ?? []).filter((r: any) => r.payload?.reqId === pl.reqId && r.member_id !== passer.id && !r.payload?.claimedBy);
  if (kid && !open.length) {
    const { error: dup } = await db.from('nudge_log')
      .insert({ kind: `ride:${pl.reqId}`, for_date: pl.date, member_id: kid.id });
    if (!dup) {
      const guardian = members.find((m: any) => m.id === kid.notify_via_member_id && m.id !== kid.id);
      await deliver(db, OUT_ENV, kid, { householdId: HOUSEHOLD, title: 'Ride',
        body: `Nobody can right now — call ${guardian ? familyName(guardian) : 'a parent'}.`, kind: 'ride', refId: pl.reqId });
    }
  }
  return twiml(`OK${open.length ? ` — ${open.map((r: any) => members.find((m: any) => m.id === r.member_id)?.name ?? '?').join(' and ')} still ha${open.length === 1 ? 's' : 've'} the question` : ''}.`);
}

Deno.serve(async (req) => {
  const raw  = await req.text();
  const form = new URLSearchParams(raw);

  const sig = req.headers.get('x-twilio-signature') ?? '';
  if (!await signatureOk(WEBHOOK_URL, form, sig)) {
    console.log('sms-inbound REJECTED ' + JSON.stringify({
      hasSignature: !!sig, hasToken: !!TW_TOKEN, requestUrl: req.url }));
    return new Response('Not found', { status: 404 });   // 404, not 403
  }

  const from = form.get('From') ?? '';
  const body = (form.get('Body') ?? '').trim();
  const db   = admin();
  console.log('sms-inbound ACCEPTED build=' + BUILD + ' from ' + from);

  const { data: house } = await db.from('households').select('timezone, default_cook_id, default_servings').eq('id', HOUSEHOLD).single();
  const tz = house?.timezone || 'America/Chicago';
  const { data: members } = await db.from('members').select('*')
    .eq('household_id', HOUSEHOLD).is('deleted_at', null);

  const sender = (members ?? []).find((m: any) => m.phone && norm(m.phone) === norm(from));
  if (!sender) return twiml("This number isn't on the family list yet. Ask Erich to add it.");
  if (!body)   return twiml('Send something like: Soccer Thursday 5:30 Bryce');

  // An unanswered question must not still be waiting tomorrow.
  await db.from('sms_pending').delete().lt('expires_at', new Date().toISOString());

  const { data: pend } = await db.from('sms_pending').select('*')
    .eq('member_id', sender.id).maybeSingle();

  if (pend) {
    const answer = String(body).trim().toLowerCase().replace(/[\s.!]+$/, '');
    const opts: any[] = pend.options ?? [];
    const hit = opts.find((o: any) =>
      o.keys.some((k: string) => answer === k || answer.startsWith(k + ' ')));

    if (hit) {
      await db.from('sms_pending').delete().eq('id', pend.id);
      const pl = pend.payload as any;

      if (pend.kind === 'confirm_date') {
        if (hit.value === 'cancel') return twiml('Dropped it.');
        // The day is settled. The clock may still be an open question.
        return await advance(db, pl.parsed, hit.value, members ?? [], sender, tz);
      }

      if (pend.kind === 'rides' && pl.ask === 'kid_ride') {
        if (pl.claimedBy) return twiml(`${pl.claimedBy} already has it.`);
        if (hit.value === 'claim') return await claimRide(db, pl, sender, members ?? [], tz);
        return await passRide(db, pl, sender, members ?? []);
      }

      if (pend.kind === 'rides') {
        const evId = (pend.payload as any).eventId;
        if (hit.value === 'none') {
          /* Nobody needs a lift. Recording that is the point — it stops the
             question coming back, and an event with a cast and no driver is
             a real answer, not a gap. */
          return twiml('Got it — no ride needed.');
        }
        const role = hit.value === 'both' ? 'driving'
                   : hit.value === 'there' ? 'dropoff' : 'pickup';
        /* The unique key is (event, member, ROLE) — the same person can be
           both going and driving — so an upsert has to name all three or it
           writes a duplicate. */
        await db.from('event_people').upsert({
          household_id: HOUSEHOLD, event_id: evId, member_id: sender.id, role
        }, { onConflict: 'event_id,member_id,role' });
        /* resync_reminders() is a TRIGGER function, not callable. Touching
           the event fires it, which is what recomputes the lead. */
        await db.from('events').update({ updated_at: new Date().toISOString() }).eq('id', evId);
        const said = hit.value === 'both' ? 'you drive both ways'
                   : hit.value === 'there' ? 'you take them'
                   : 'you bring them back';
        return twiml(`Got it — ${said}.`);
      }

      if (pend.kind === 'season_confirm') {
        if (hit.value === 'cancel') return twiml('Dropped it — nothing added.');
        const skip = new Set<number>();
        if (hit.value === 'skip') {
          for (const d of answer.match(/\d+/g) ?? []) skip.add(+d);
        }
        return await insertSeason(db, pl, skip, sender, members ?? [], tz);
      }

      /* "Which one?" after an ambiguous "did the dishes". This kind was
         written by finishTodo and never read here, so a reply of "1" fell
         through and was routed as a brand-new message. */
      if (pend.kind === 'pick_todo') {
        if (hit.value === 'cancel') return twiml('Left it open.');
        const { data: t } = await db.from('todos')
          .select('id, title, assignee_id, completed_at')
          .eq('id', hit.value).is('deleted_at', null).maybeSingle();
        if (!t) return twiml('That one is already gone.');
        if (t.completed_at) return twiml(`Already done: ${t.title}${ownerTag(t, sender, members ?? [])}`);
        return await completeTodo(db, t, sender, members ?? []);
      }

      if (pend.kind === 'route_intent') {
        if (hit.value === 'cancel') return twiml('Dropped it.');
        if (pl.skip && String(hit.value).startsWith('skip:')) {
          const title = pl.skip.titles[+String(hit.value).slice(5)];
          const occ = (await findOccurrences(db, title, pl.skip.from, pl.skip.to))
            .filter((o: any) => o.title === title);
          if (!occ.length) return twiml('That one is already gone.');
          return await skipOccurrences(db, occ, sender, tz);
        }
        if (hit.value === 'shop')   return await addShopping(db, pl.body, sender);
        if (hit.value === 'todo')   return await addTodo(db, pl.body, sender, members ?? [], tz, nowInTz(tz));
        const rp = parseQuickAdd(pl.body, {
          members: (members ?? []).map((m: any) => ({ name: m.name, aliases: m.aliases ?? [] })),
          defaultLead: sender.default_lead_minutes ?? 30, now: nowInTz(tz), me: sender.name });
        return await advance(db, rp, rp.date, members ?? [], sender, tz);
      }

      if (pend.kind === 'confirm_time') {
        if (hit.value === 'cancel') return twiml('Dropped it.');
        if (pl.mode === 'create') {
          return await advance(db, { ...pl.parsed, start: hit.value, ambiguousTime: null },
                               pl.date, members ?? [], sender, tz);
        }
        const { data: fev } = await db.from('events').select('*')
          .eq('id', pl.eventId).is('deleted_at', null).maybeSingle();
        if (!fev) return twiml('That one is already gone.');
        return await applyFix(db, fev, { ...pl.w, start: hit.value, ambiguousTime: null },
                              members ?? [], sender, tz);
      }

      if (pend.kind === 'edit_scope') {
        if (hit.value === 'cancel') return twiml('Left it as it was.');
        const { data: ev } = await db.from('events').select('*').eq('id', pl.eventId).single();
        if (!ev) return twiml('That event is gone now.');

        if (hit.value === 'one') {
          // One occurrence moves via an exception row; the series is untouched.
          await db.from('event_exceptions').upsert({
            household_id: HOUSEHOLD, event_id: ev.id,
            occurrence_date: pl.fromDate, action: 'override',
            starts_at: pl.allDay ? null : wallToUtc(pl.date, pl.start, tz),
            created_by: sender.id
          }, { onConflict: 'event_id,occurrence_date' });
          await remember(db, sender, ev.id, pl.date, 'edit');
          return twiml(`Moved just that one.\n${ev.title}\n${pretty(pl.date)}` +
                       (pl.start ? ` · ${clock(pl.start)}` : ''));
        }

        // 'all' — the series itself changes from here on.
        const patch: any = { event_date: pl.date };
        if (!pl.allDay && pl.start) patch.starts_at = wallToUtc(pl.date, pl.start, tz);
        if (pl.weekday != null && ev.repeat_freq === 'weekly') patch.repeat_days = [pl.weekday];
        await db.from('events').update(patch).eq('id', ev.id);
        await db.from('reminders').delete().eq('event_id', ev.id).is('sent_at', null);
        await remember(db, sender, ev.id, pl.date, 'edit');
        return twiml(`Updated the whole series.\n${ev.title}\n${pretty(pl.date)}` +
                     (pl.start ? ` · ${clock(pl.start)}` : ''));
      }
    }
    // Not an answer to what we asked. Drop the question rather than let a
    // stale conversation swallow a new instruction. A kid's ride question is
    // the exception: it never blocks anything, and it must outlive "buy milk"
    // so that a ME five minutes later still counts (and the dispatcher's
    // twenty-minute nag still finds it).
    if (!(pend.kind === 'rides' && (pend.payload as any)?.ask === 'kid_ride')) {
      await db.from('sms_pending').delete().eq('id', pend.id);
    }
  }

  if (/^(help|\?)$/i.test(body)) {
    return twiml('Text an event the way you would say it:\n' +
      '"Soccer Thursday 5:30 Bryce, Jess driving"\n' +
      '"Dentist tomorrow 9am Addie remind 1 hour before"\n' +
      '"Piano every Tuesday 4pm Addie"\n' +
      'To change one: "planning committee moved to Monday at 4"\n' +
      'Just sent it wrong? "no, make it 4pm" or "delete that"\n' +
      'Shopping: "buy milk, eggs" or "kroger: diapers"\n' +
      'Say "list" or "HEB list" to see it\n' +
      '"new list" after shopping, "clear the HEB list" to wipe one\n' +
      'Wrong item? "remove bike". Bought it? "got milk"\n' +
      'Chores: "Bryce take out the trash every Tuesday"\n' +
      'See them: "my list" or "Bryce\'s list". Finished: "did the trash"\n' +
      'Ask: "what\'s Thursday", "who\'s driving Addie Monday", "what\'s for dinner"\n' +
      'A whole schedule: paste it, one date per line, with a first line like "Orchestra — Addie, Jess driving"\n' +
      'Not happening: "Bryce is sick", "snow day", "I\'m away Tue-Thu", "no orchestra Friday". Undo: "Bryce is fine"\n' +
      'Dinner: "dinner is leftovers", "we\'re having tacos", "Addie\'s at church, 3 for dinner", "same as last week"\n' +
      'Kids: "need a ride at 5" asks both parents; the first to reply ME has it\n' +
      'Reply STOP to opt out.\n' +
      `build ${BUILD}`);
  }

  /* Names AND aliases. A member the parser cannot resolve is a role silently
     dropped, and "mom is driving" is how this actually gets texted. */
  const names = (members ?? []).map((m: any) => ({ name: m.name, aliases: m.aliases ?? [] }));

  /* ---- WHAT KIND OF MESSAGE IS THIS? ------------------------------------
     routeIntent lives in parse.js and is the single source of routing order.
     route.test.mjs used to re-implement this chain by hand and claim in a
     comment that it "mirrors the handler" — it did not, because the real
     chain runs corrections and edits between the scoped list and the
     shopping intents and the copy had neither. A test that reimplements the
     thing it tests agrees with itself forever.

     The decidable branches are answered here. Corrections and edits come
     back as 'stateful' and keep their own matchers below, because "no, make
     it 4" means nothing without knowing what just happened. */
  const now = nowInTz(tz);
  const shopCtx  = await shopContext(db);
  const routeCtx = { stores: shopCtx.stores, catalog: shopCtx.catalog,
                     members: names, now, me: sender.name, kid: isKidRole(sender) };
  const routed = routeIntent(body, routeCtx);

  /* ---- a kid asking for a ride ------------------------------------------------
     Only a teen or child gets here (routeCtx.kid); a parent's same words
     route as they always did. */
  if (routed.intent === 'ride_request') return await requestRide(db, routed, sender, members ?? [], tz, now);

  /* ---- a pasted weekly ad ------------------------------------------------------
     Nobody texts an ad, but a paste that is one must not fall through to the
     event path and file thirty "Strawberries $2.99" appointments. */
  if (routed.intent === 'ad') {
    return twiml('That looks like a weekly ad. Paste it in the app: Shopping → "Paste a weekly ad" — it matches the sales to your list.');
  }

  /* ---- dinner, said once -----------------------------------------------------*/
  if (routed.intent === 'repeat_week') return await repeatLastWeek(db, sender, house);
  if (routed.intent === 'headcount') return await setHeadcount(db, routed, sender, house);
  if (routed.intent === 'dinner') return await setDinner(db, routed, sender, house);

  /* ---- not happening -------------------------------------------------------
     Sick, snow day, away, one rehearsal cancelled, and the undo. */
  if (routed.intent === 'absence')    return await recordAbsence(db, routed, sender, members ?? [], tz);
  if (routed.intent === 'skip_event') return await skipEvent(db, routed, sender, tz);
  if (routed.intent === 'unskip')     return await unskip(db, routed, sender, members ?? [], tz);

  /* ---- a pasted schedule ---------------------------------------------------
     Many rows, one question, no rides follow-up. */
  if (routed.intent === 'season') return await offerSeason(db, routed.season, sender);

  /* ---- QUESTIONS -----------------------------------------------------------
     Answered from the same expander the digest reads. No row is written. */
  if (routed.intent === 'ask_day')    return await answerDay(db, house, members ?? [], routed, sender, tz);
  if (routed.intent === 'ask_driver') return await answerDriver(db, members ?? [], routed, tz);
  if (routed.intent === 'ask_dinner') return await answerDinner(db, house, routed);
  if (routed.intent === 'ask_got')    return await answerGot(db, members ?? [], routed, tz);
  if (routed.intent === 'ask_help')   return twiml(ASK_HELP);

  if (routed.intent === 'show' && !routed.store) return await showShopping(db);
  if (routed.intent === 'trip_done') return await clearList(db, routed.store, true);
  if (routed.intent === 'clear')     return await clearList(db, routed.store, false);

  if (routed.intent === 'show' && routed.store) return await showShopping(db, routed.store);

  /* ---- TODOS -------------------------------------------------------------
     Some things just need doing. No time, no calendar entry — a list, per
     person, in the order they want to see it. */
  if (routed.intent === 'todo_show') {
    const who = (members ?? []).find((m: any) =>
      m.name.toLowerCase() === String(routed.who || '').toLowerCase()) || sender;
    return await showTodos(db, who);
  }

  if (routed.intent === 'todo') {
    return await addTodo(db, body, sender, members ?? [], tz, now);
  }

  if (routed.intent === 'todo_done') {
    return await finishTodo(db, routed.text, sender, members ?? []);
  }

  /* ---- "did it" / "finished" with nothing named ---------------------------
     Only the last thing this person was told about can be meant: the nag
     they just received, the todo they just added, or the event they just
     made. routeIntent flags it as stateful/did; until now nothing consumed
     that flag, so "did it" fell all the way through to "which did you
     mean? 1 = calendar event ..." — after a nag that had just asked for
     exactly this reply. */
  if (routed.intent === 'stateful' && routed.why === 'did') {
    const { data: la } = await db.from('sms_last_action').select('*')
      .eq('member_id', sender.id).maybeSingle();

    if (la?.todo_id) {
      const { data: t } = await db.from('todos')
        .select('id, title, assignee_id, completed_at')
        .eq('id', la.todo_id).is('deleted_at', null).maybeSingle();
      if (!t) return twiml('That one is already gone.');
      if (t.completed_at) return twiml(`Already done: ${t.title}${ownerTag(t, sender, members ?? [])}`);
      return await completeTodo(db, t, sender, members ?? []);
    }

    if (la?.event_id) {
      const { data: ev } = await db.from('events').select('id, title, repeat_freq, done_at')
        .eq('id', la.event_id).is('deleted_at', null).maybeSingle();
      if (!ev) return twiml('That one is already gone.');
      /* One occurrence of a series is ticked in event_done; a one-off gets
         done_at. Same two facts the app's check-box writes. */
      if (ev.repeat_freq && la.occurrence_date) {
        await db.from('event_done').upsert({
          household_id: HOUSEHOLD, event_id: ev.id,
          occurrence_date: la.occurrence_date, done_by: sender.id
        }, { onConflict: 'event_id,occurrence_date' });
      } else {
        if (ev.done_at) return twiml(`Already done: ${ev.title}`);
        await db.from('events').update({
          done_at: new Date().toISOString(), done_by: sender.id
        }).eq('id', ev.id);
      }
      return twiml(`Done: ${ev.title}`);
    }

    return twiml('Nothing recent to mark done. Say what you did — "did the trash".');
  }

  /* ---- a correction to whatever just happened? ---------------------------
     This runs before the edit matcher on purpose. "no, make it 4" names no
     event, so the edit matcher would either miss it or, worse, match some
     unrelated event on the word "make". */
  {
    const pre   = body.match(FIX_PREFIX);
    let   rest  = pre ? body.slice(pre[0].length).trim() : body;
    const verb  = rest.match(FIX_VERB);
    if (verb) rest = rest.slice(verb[0].length).trim();

    const wantsKill = KILL.test(rest) || KILL.test(body);

    /* How long does it run? Answered as a length or as a finish time. */
    const lm = rest.match(LENGTH_RE), um = rest.match(UNTIL_RE);
    if (lm || um) {
      const { data: la } = await db.from('sms_last_action').select('*')
        .eq('member_id', sender.id).maybeSingle();
      const { data: ev } = la?.event_id
        ? await db.from('events').select('*').eq('id', la.event_id)
            .is('deleted_at', null).maybeSingle()
        : { data: null };
      if (!ev) return twiml("Nothing recent of yours to set that on.");
      if (ev.all_day) return twiml(`${ev.title} is an all-day event — no end time to set.`);

      let endWall: string;
      if (lm) {
        const n = parseFloat(lm[1]);
        const mins = /^h/i.test(lm[2]) ? Math.round(n * 60) : Math.round(n);
        endWall = shift(utcToWall(ev.starts_at, tz), mins);
      } else {
        const h = +um![1], mi = um![2] ? +um![2] : 0, ap = um![3];
        const hh = hm(h, mi, ap) ?? (h >= 1 && h <= 6 ? `${pad(h + 12)}:${pad(mi)}`
                                                      : `${pad(h)}:${pad(mi)}`);
        endWall = ap ? hh : (h >= 1 && h <= 6 ? `${pad(h + 12)}:${pad(mi)}` : hh);
      }
      return await applyEnd(db, ev, endWall, members ?? [], sender, tz);
    }

    const w = rest ? parseQuickAdd(rest, {
      members: names, now, defaultLead: null, me: sender.name }) : null;

    /* A bare list of people — "Addie going, Jess there, me back" — is the
       answer to the follow-up question, and is safe to read as a correction
       because a real new event always carries a title of its own. */
    const castOnly = !!w && w.people.length > 0 &&
                     !w.matched.includes('date') && !w.matched.includes('time');
    const changed  = !!w && (w.matched.includes('date') || w.matched.includes('time') ||
                             w.matched.includes('lead') || w.people.length > 0);
    const isFix    = wantsKill || castOnly || ((!!pre || !!verb) && changed);

    if (isFix) {
      const { data: la } = await db.from('sms_last_action').select('*')
        .eq('member_id', sender.id).maybeSingle();

      /* "delete that" means the last thing YOU did, and that is not always a
         calendar event. Only events were tracked, so saying it after adding
         groceries would have deleted an appointment instead. Compare the two
         timestamps and act on whichever is actually newer. */
      if (wantsKill) {
        const { data: recent } = await db.from('shopping_items')
          .select('id, name, created_at').eq('household_id', HOUSEHOLD)
          .eq('added_by', sender.id).is('cleared_at', null)
          .order('created_at', { ascending: false }).limit(20);
        const newestShop = recent?.[0] ? Date.parse(recent[0].created_at) : 0;
        const newestEv   = la?.created_at ? Date.parse(la.created_at) : 0;

        if (newestShop && newestShop > newestEv) {
          // Everything added in the same breath, not just the final row.
          const batch = (recent ?? []).filter((r: any) =>
            newestShop - Date.parse(r.created_at) < 5000);
          await db.from('shopping_items').delete().in('id', batch.map((b: any) => b.id));
          await db.from('shopping_catalog').delete().eq('household_id', HOUSEHOLD)
            .in('name', batch.map((b: any) => String(b.name).toLowerCase()));
          return twiml(`Removed: ${batch.map((b: any) => b.name).join(', ')}`);
        }
      }
      if (!la?.event_id) {
        return twiml("Nothing recent of yours to change. Name the event and I'll find it.");
      }
      const { data: ev } = await db.from('events').select('*')
        .eq('id', la.event_id).is('deleted_at', null).maybeSingle();
      if (!ev) return twiml('That one is already gone.');

      if (wantsKill) {
        /* Soft delete. Everything else in this app treats deleted_at as gone,
           and a text sent by mistake should not be able to destroy a row. */
        await db.from('events').update({ deleted_at: new Date().toISOString() })
          .eq('id', ev.id);
        await db.from('reminders').delete().eq('event_id', ev.id).is('sent_at', null);
        await db.from('sms_last_action').delete().eq('member_id', sender.id);
        return twiml(`Removed ${ev.title}.`);
      }

      return await applyFix(db, ev, w, members ?? [], sender, tz);
    }
  }

  /* ---- take something off the shopping list -----------------------------
     Checked before the calendar's delete, because "remove milk" is almost
     never an appointment. If nothing on the list answers to that name, this
     falls through and the calendar gets its turn. */
  {
    const rm = body.match(SHOP_REMOVE);
    const gt = body.match(SHOP_GOT);
    if (rm || gt) {
      const { stores, catalog } = await shopContext(db);
      const want = parseShopping((rm || gt)![1], { stores, catalog });
      const wanted = want.items.map((i: any) => i.name.toLowerCase());

      if (wanted.length) {
        const { data: live } = await db.from('shopping_items')
          .select('id, name, got, store_id').eq('household_id', HOUSEHOLD).is('cleared_at', null);

        /* Exact first. Only widen to a partial match when nothing matched
           exactly, or "milk" quietly takes the almond milk with it. */
        const lower = (r: any) => String(r.name).toLowerCase();
        let hits = (live ?? []).filter((r: any) => wanted.includes(lower(r)));
        if (!hits.length) {
          hits = (live ?? []).filter((r: any) =>
            wanted.some(w => lower(r).includes(w) || w.includes(lower(r))));
        }

        if (hits.length) {
          const ids   = hits.map((h: any) => h.id);
          const shown = hits.map((h: any) => h.name).join(', ');

          if (rm) {
            await db.from('shopping_items').delete().in('id', ids);
            /* A mistake must not be remembered. Leaving it in the catalog is
               how the parser learned "milk eggs" and merged them forever. */
            await db.from('shopping_catalog').delete()
              .eq('household_id', HOUSEHOLD).in('name', hits.map(lower));
            return twiml(`Removed: ${shown}`);
          }

          await db.from('shopping_items')
            .update({ got: true, got_at: new Date().toISOString(), got_by: sender.id })
            .in('id', ids);
          /* The tick teaches the catalog where a thing is bought. Over text
             there is no store on screen, so only an item that already has
             one can teach (last tick wins) — same rule as the app. */
          for (const h of hits) {
            if (!h.store_id) continue;
            const c = catalog.find((x: any) => String(x.name).toLowerCase() === lower(h));
            if (c && c.store_id !== h.store_id) {
              await db.from('shopping_catalog').update({ store_id: h.store_id })
                .eq('household_id', HOUSEHOLD).eq('name', c.name);
            }
          }
          return twiml(`Got: ${shown}`);
        }

        if (gt) return twiml(`Nothing on the list called "${wanted.join(', ')}".`);
        // rm with no match — let the calendar try.
      }
    }
  }

  /* ---- delete something by name -----------------------------------------
     Without this, "cancel soccer" falls through to the new-event path and
     cheerfully creates an event called "cancel soccer". A series is never
     removed on a single word: wiping months of a repeating event by accident
     is exactly the kind of mistake that has no undo worth the name. */
  {
    const dm = body.match(/^(?:delete|cancel|remove|drop)\s+(?:the\s+)?(all\s+|every\s+)?(.+?)[\s.!]*$/i);
    if (dm) {
      const wantsAll = !!dm[1];
      const needle   = dm[2].trim();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
      const { data: cands } = await db.from('events').select('*')
        .eq('household_id', HOUSEHOLD).is('deleted_at', null)
        .or(`repeat_freq.not.is.null,event_date.gte.${todayStr}`);
      const scored = (cands ?? []).map((e: any) => ({ e, s: scoreTitle(needle, e.title) }))
        .filter((x: any) => x.s >= 0.5).sort((a: any, b: any) => b.s - a.s);

      if (scored.length) {
        const target = scored[0].e;
        if (target.repeat_freq && !wantsAll) {
          return twiml(`${target.title} repeats.\n` +
                       `Text "delete all ${target.title}" to remove the whole series.`);
        }
        await db.from('events').update({ deleted_at: new Date().toISOString() })
          .eq('id', target.id);
        await db.from('reminders').delete().eq('event_id', target.id).is('sent_at', null);
        await db.from('sms_last_action').delete().eq('member_id', sender.id);
        return twiml(`Removed ${target.title}.`);
      }
      // Nothing matched. Fall through — it may well be a real event title
      // that simply starts with one of those words.
    }
  }

  // ---- an edit? -----------------------------------------------------------
  const em = body.match(EDIT_RE);
  /* The stems used to carry a trailing \b — /\b(mov|chang|...)\b/ — which
     cannot match "moved", "move", "change" or "reschedule" at all, because
     a word character follows the stem. Only push, shift and now ever got
     through, so editing an event by text has been mostly dead since it
     shipped. The gate itself is right and must stay: behind it is a fuzzy
     title match at 0.5 that rewrites an event's date. */
  if (em && ROUTE_RE.EDIT_VERB.test(body)) {
    const needle = em[1].trim();
    const when   = em[2].trim();
    const w = parseQuickAdd(when, { members: names, now, defaultLead: null, me: sender.name });

    const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const { data: cands } = await db.from('events').select('*')
      .eq('household_id', HOUSEHOLD).is('deleted_at', null)
      .or(`repeat_freq.not.is.null,event_date.gte.${todayStr}`);

    const scored = (cands ?? []).map((e: any) => ({ e, s: scoreTitle(needle, e.title) }))
      .filter((x: any) => x.s >= 0.5).sort((a: any, b: any) => b.s - a.s);

    if (!scored.length) return twiml(`Could not find anything called "${needle}".`);
    const target = scored[0].e;

    const payload = { eventId: target.id, date: w.date, start: w.start,
                      allDay: w.allDay, weekday: new Date(w.date + 'T12:00:00Z').getUTCDay(),
                      fromDate: target.event_date };

    if (target.repeat_freq) {
      // THE question. Guessing here rewrites months of a series by accident.
      await db.from('sms_pending').upsert({
        household_id: HOUSEHOLD, member_id: sender.id, kind: 'edit_scope',
        payload,
        options: [ { keys: ['1','one','just this','this one'], value: 'one' },
                   { keys: ['2','all','every','series'],      value: 'all' },
                   { keys: ['cancel','stop','no'],            value: 'cancel' } ],
        expires_at: new Date(Date.now() + 15*60_000).toISOString()
      }, { onConflict: 'member_id' });

      return twiml(`${target.title} repeats. Move which?\n` +
                   `1 = just ${pretty(target.event_date)}\n` +
                   `2 = the whole series from here`);
    }

    const patch: any = { event_date: w.date };
    if (!w.allDay && w.start) patch.starts_at = wallToUtc(w.date, w.start, tz);
    await db.from('events').update(patch).eq('id', target.id);
    await db.from('reminders').delete().eq('event_id', target.id).is('sent_at', null);
    await remember(db, sender, target.id, w.date, 'edit');
    return twiml(`Moved ${target.title}\n${pretty(w.date)}` + (w.start ? ` · ${clock(w.start)}` : ''));
  }

  // ---- event, or shopping? ------------------------------------------------
  const p = parseQuickAdd(body, {
    members: names, defaultLead: sender.default_lead_minutes ?? 30, now, me: sender.name
  });

  /* A message with a day or a clock in it is an event, whatever verb it
     opens with — "add dentist Thursday 3pm" is not groceries. Without a time,
     an opening verb like "grab" or "need" means the list. With neither, and
     nobody named, it is genuinely ambiguous: "milk" and "Groceries" are both
     plausible either way, and guessing wrong files it somewhere nobody looks. */
  const hasWhen = p.matched.includes('date') || p.matched.includes('time') || !!p.repeat;

  if (SHOP_STRONG.test(body)) return await addShopping(db, body, sender);

  /* "add" and "get" are weak signals — they open plenty of sentences that are
     not groceries. If nothing in the message classifies as a grocery either,
     there is no shopping signal at all, and "add bike" is as likely to be a
     reminder as an item. Ask. */
  if (SHOP_WEAK.test(body) && !hasWhen) {
    const { stores, catalog } = await shopContext(db);
    const probe = parseShopping(body, { stores, catalog });
    if (probe.items.some((i: any) => i.category !== 'other')) {
      return await addShopping(db, body, sender);
    }
  }

  /* A store named up front is as clear an intent as any verb: nobody puts
     "kroger:" in front of a dentist appointment. */
  if (!hasWhen) {
    const { stores } = await shopContext(db);
    if (parseShopping(body, { stores }).store) return await addShopping(db, body, sender);
  }

  if (!hasWhen) {
    /* Three kinds of thing now, not two. This question offered only calendar
       and shopping, which meant anything that was really a chore had nowhere
       to go — the commonest case in a house, and the one with no clock. */
    const ask = p.title || body;
    await db.from('sms_pending').upsert({
      household_id: HOUSEHOLD, member_id: sender.id, kind: 'route_intent',
      payload: { body },
      options: [ { keys: ['1','event','calendar'],        value: 'event' },
                 { keys: ['2','shopping','list','shop'],  value: 'shop'  },
                 { keys: ['3','todo','to-do','task','chore'], value: 'todo' },
                 { keys: ['cancel','stop','no'],          value: 'cancel' } ],
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString()
    }, { onConflict: 'member_id' });
    return twiml(`"${ask}" — which did you mean?\n1 = calendar event\n` +
                 `2 = shopping list\n3 = to-do (no time needed)`);
  }

  // Naming today's own weekday is ambiguous. Ask rather than guess.
  if (p.alsoToday) {
    await db.from('sms_pending').upsert({
      household_id: HOUSEHOLD, member_id: sender.id, kind: 'confirm_date',
      payload: { parsed: p },
      options: [ { keys: ['1','today','tonight'], value: p.alsoToday },
                 { keys: ['2','next','next week'], value: p.date },
                 { keys: ['cancel','stop','no'],   value: 'cancel' } ],
      expires_at: new Date(Date.now() + 15*60_000).toISOString()
    }, { onConflict: 'member_id' });

    return twiml(`${p.title} — which did you mean?\n` +
                 `1 = today, ${pretty(p.alsoToday)}\n` +
                 `2 = ${pretty(p.date)}`);
  }

  return await advance(db, p, p.date, members ?? [], sender, tz);
});
