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

export const SHOP_CATEGORIES = [
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
  [/\b(?:apple|banana|orange|lemon|lime|grape|berry|berries|strawberr|blueberr|melon|avocado|tomato|potato|onion|garlic|lettuce|spinach|kale|carrot|celery|pepper|cucumber|broccoli|cauliflower|zucchini|squash|mushroom|cilantro|parsley|basil|salad|produce|fruit|veg)/i, 'produce'],
  [/\b(?:bread|bagel|bun|roll|tortilla|pita|croissant|muffin|donut|cake|pie|bakery)/i, 'bakery'],
  [/\b(?:deli|lunch\s*meat|sandwich\s*meat|turkey\s*slices|salami|prosciutto|rotisserie)/i, 'deli'],
  [/\b(?:beef|steak|ground\s*(?:beef|turkey|chuck)|chicken|thigh|drumstick|pork|bacon|sausage|ham|brisket|ribs|meat|hot\s*dog)/i, 'meat'],
  [/\b(?:fish|salmon|tilapia|shrimp|crab|lobster|tuna\s*steak|seafood|cod)/i, 'seafood'],
  [/\b(?:milk|cheese|yogurt|butter|cream|sour\s*cream|cottage|half\s*and\s*half|creamer)/i, 'dairy'],
  [/\b(?:egg|eggs)\b/i, 'eggs'],
  [/\b(?:frozen|ice\s*cream|popsicle|freezer|waffles?)\b/i, 'frozen'],
  [/\b(?:cereal|oatmeal|oats|granola|pancake|syrup|pop\s*tart)/i, 'breakfast'],
  [/\b(?:canned|can\s+of|soup|beans|corn|tomato\s*sauce|tomato\s*paste|broth|stock)/i, 'canned'],
  [/\b(?:rice|pasta|noodle|spaghetti|flour|sugar|salt|cereal\s*bar|cracker|peanut\s*butter|jelly|jam|honey|olive\s*oil|oil|vinegar)/i, 'pantry'],
  [/\b(?:baking|yeast|baking\s*(?:soda|powder)|vanilla|choc(?:olate)?\s*chip|cocoa|powdered\s*sugar|brown\s*sugar)/i, 'baking'],
  [/\b(?:ketchup|mustard|mayo|mayonnaise|ranch|dressing|bbq|hot\s*sauce|salsa|soy\s*sauce|sauce|seasoning|spice)/i, 'condiments'],
  [/\b(?:haribo|skittles|starburst|sour\s*patch|twizzlers|hershey|reese|kit\s*kat|snickers|m\s*&\s*ms|jolly\s*rancher|airheads|swedish\s*fish|gumm(?:y|ies))\b/i, 'snacks'],
  [/\b(?:snack|chips?\b|dorito|tostito|cookie|candy|popcorn|pretzel|nuts?|trail\s*mix|granola\s*bar|fruit\s*snack)/i, 'snacks'],
  [/\b(?:water|soda|coke|sprite|dr\s*pepper|juice|coffee|tea|gatorade|beer|wine|drink|la\s*croix)/i, 'beverages'],
  [/\b(?:battery|batteries|light\s*bulb|bulb|tape|glue|foil|ziploc|bag(?:gie)?s?|storage|trash\s*bag)/i, 'household'],
  [/\b(?:paper\s*towel|toilet\s*paper|tp\b|napkin|tissue|kleenex|plate|cup|paper\s*goods)/i, 'paper'],
  [/\b(?:detergent|soap|bleach|clorox|lysol|cleaner|sponge|dishwasher|laundry|softener|windex)/i, 'cleaning'],
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
  'green beans','brussels sprouts','snap peas','baby spinach',
  // meat + seafood
  'ground beef','ground turkey','ground chuck','chicken breast','chicken breasts',
  'chicken thighs','chicken tenders','pork chops','pork loin','beef stew meat',
  'hot dogs','hot dog buns','lunch meat','deli turkey','deli ham','breakfast sausage',
  'bacon strips','salmon fillet','tilapia fillets',
  // dairy + eggs
  'sour cream','cream cheese','heavy cream','whipping cream','half and half',
  'cottage cheese','string cheese','shredded cheese','sliced cheese','greek yogurt',
  'almond milk','oat milk','whole milk','skim milk','chocolate milk','egg whites',
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
  'paper napkins','dish soap','dishwasher pods','laundry detergent','fabric softener',
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
const QTY_RE = /^(?:(\d+(?:\.\d+)?\s*(?:x\s*)?(?:lbs?|pounds?|oz|ounces?|gal(?:lons?)?|qts?|quarts?|pints?|liters?|l|cans?|jars?|boxes|box|bags?|bunch(?:es)?|heads?|dozen|packs?|packages?|cartons?|loaves|loaf|bottles?|cases?|sticks?|rolls?|containers?)?)|((?:a|an|one|two|three|four|five|six|couple(?:\s+of)?|half|a\s+few)\s+(?:lbs?|pounds?|oz|ounces?|gal(?:lons?)?|qts?|quarts?|pints?|liters?|l|cans?|jars?|boxes|box|bags?|bunch(?:es)?|heads?|dozen|packs?|packages?|cartons?|loaves|loaf|bottles?|cases?|sticks?|rolls?|containers?)))\s+(?=\S)/i;

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

const catOf = (name, catalog) => {
  const hit = (catalog || []).find(c => c.name.toLowerCase() === name.toLowerCase());
  if (hit && hit.category) return hit.category;          // the household's own memory wins
  for (const [re, cat] of CATEGORY_WORDS) if (re.test(name)) return cat;
  return 'other';
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
export function skeleton(word) {
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
export function repairName(name, knownSet) {
  const isKnown = t => (knownSet ? (knownSet.builtin.has(t) || knownSet.learned.has(t))
                                 : BUILTIN.has(t)) || catOf(t, null) !== 'other';
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

/* Does this phrase come apart into things already known separately?
 *
 * "milk eggs" does: two groceries, no relationship. "ground beef" does not —
 * "ground" is not a thing you buy. The distinction is what stops a learned
 * phrase from swallowing two real items.
 */
export function looksMerged(phrase) {
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
    const m = QTY_RE.exec(toks.slice(k).join(' ') + ' ');
    return m ? m[0].trim().split(/\s+/).length : 0;
  };

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
export function storeTerms(stores) {
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
export function parseShopping(input, opts = {}) {
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
      if (knownWord(bare) || knownSet.builtin.has(bare) || knownSet.learned.has(bare)) return tok;
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
        const q = QTY_RE.exec(name);
        if (q) {
          qty = (q[1] || q[2]).trim();
          // "3 bottles of coke" — the preposition belongs to the quantity.
          name = name.slice(q[0].length).replace(/^of\s+/i, '').trim();
        }
        /* One case, always. A phone capitalises the first word of a text, so
           "Milk" and "milk" arrive as different strings and become two rows
           in the catalog that never learn from each other. */
        name = name.replace(/^(?:a|an)\s+/i, '').replace(/[.!]+$/, '').trim().toLowerCase();
        if (!name) return;

        /* Dictation breaks brand names more than anything else. Repair only
           what nothing recognised, and always say so — a confident wrong
           guess is worse than leaving it alone. */
        let heardAs = null;
        const fix = /\s/.test(name) ? repairName(name, knownSet) : null;
        if (fix) { heardAs = fix.from; name = fix.name; out.corrections.push(fix); }
        const tokFix = out.corrections.find(c => c.name && name.toLowerCase().includes(c.name));
        if (!heardAs && tokFix) heardAs = tokFix.from;

        const category = catOf(name, opts.catalog);
        out.items.push({
          name, qty, heardAs,
          note: idx === chunks.length - 1 ? note : null,
          store: section.store || null,
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
