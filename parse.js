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
export function parseQuickAdd(input, opts = {}) {
  const members = opts.members || [];
  const now = opts.now || new Date();
  const raw = String(input || '').trim();

  const out = {
    title: '', date: null, start: null, end: null, allDay: false,
    member: null, leadMinutes: opts.defaultLead ?? 30,
    repeat: null, people: [], alsoToday: null, ambiguousTime: null,
    needsCast: false, needsRides: false, warnings: [], matched: []
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
    else if ((m = findFree(/\btonight\b/i)))             { out.date = ymd(now); out.start = out.start||'19:00'; take(m,'date'); }
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

  const setBare = (h, mi) => {
    if (h === 12) {
      if (cueAm) { out.start = `00:${pad(mi)}`; return; }
      if (cuePm) { out.start = `12:${pad(mi)}`; return; }
      out.start = `12:${pad(mi)}`;
      out.ambiguousTime = { kind: 'noon', am: `00:${pad(mi)}`, pm: `12:${pad(mi)}` };
      return;
    }
    if (h >= 1 && h <= 6) {
      out.start = cueAm ? `${pad(h)}:${pad(mi)}` : `${pad(h + 12)}:${pad(mi)}`;
      return;
    }
    if (h >= 7 && h <= 11) {
      if (cueAm) { out.start = `${pad(h)}:${pad(mi)}`; return; }
      if (cuePm) { out.start = `${pad(h + 12)}:${pad(mi)}`; return; }
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
    for (const name of [...members].sort((a, b) => b.length - a.length)) {
      const re = new RegExp(`(?:^|[\\s,;&])(${escapeRe(name)})('s|s')?(?=$|[\\s,;.&!?])`, 'gi');
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
    if (opts.me) {
      const meRe = /(?:^|[\s,;])(i'm|i am|im|myself|me|i)(?=$|[\s,;.!?])/gi;
      let mm;
      while ((mm = meRe.exec(raw))) {
        const at = mm.index + mm[0].indexOf(mm[1]);
        const end = at + mm[1].length;
        if (!mentions.some(x => at < x.end && end > x.at)) {
          mentions.push({ name: opts.me, at, end, self: true });
        }
      }
    }

    mentions.sort((a, b) => a.at - b.at);

    // 10c. A role belongs to the nearest name BEFORE it. The window runs from
    //      the end of one name to the start of the next, so in
    //      "Jess drops off Erich picks up" each verb stays with its own person.
    for (let k = 0; k < mentions.length; k++) {
      const from = mentions[k].end;
      const to = k + 1 < mentions.length ? mentions[k + 1].at : raw.length;
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
  const wholeFamily = members.length > 0 && out.people.length === members.length;
  const onlyMe      = out.people.length === 1 && out.people[0].name === opts.me;
  out.needsRides = out.people.length > 0 && !wholeFamily && !onlyMe &&
                   !out.people.some(x => x.role === 'driving' ||
                                         x.role === 'dropoff' || x.role === 'pickup');

  // ---- 11. whatever is left is the title --------------------------------
  out.title = strip(raw, spans);
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
export function describe(p, tz='America/Chicago'){
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
