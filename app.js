/* ============================================================================
 * Family Hub — application
 * No build step. Native ES modules, loaded straight from GitHub Pages.
 * ==========================================================================*/
import { CONFIG, isDemo } from './config.js';
import { parseQuickAdd, describe, parseShopping } from './parse.js';
import { expand, describeRepeat, ymd as rymd, parseYmd } from './recur.js';

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const pad = n => String(n).padStart(2,'0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const EVERYONE = '#9a7b2f';
/* Role names as a person would say them. Mirrors ROLE_SAY in sms-inbound.ts —
   the database stores 'dropoff', a parent reading this wants "ride there". */
const ROLE_SAY = {
  going: 'going', driving: 'drives both ways', dropoff: 'ride there',
  pickup: 'ride back', helping: 'helping', optional: 'maybe'
};

const LEADS = [
  {v:null,  l:'None'},   {v:0,   l:'At time'}, {v:10,  l:'10 min'},
  {v:30,    l:'30 min'}, {v:60,  l:'1 hour'},  {v:120, l:'2 hours'},
  {v:1440,  l:'1 day'},  {v:2880,l:'2 days'}
];

const state = {
  db: null, demo: isDemo(),
  household: null, members: [], events: [], exceptions: [], me: null,
  module: 'calendar', view: 'today', cursor: null,   // cursor = the date each view is centred on
  editing: null, editingOccurrence: null, parsed: null, pendingScope: null,
  // shopping
  stores: [], shopItems: [], shopCatalog: [], shopAisles: [], shopStore: null, shopCats: []
};

const REPEATS = [
  {v:null,       l:'Once'},   {v:'daily',   l:'Daily'},
  {v:'weekly',   l:'Weekly'}, {v:'monthly', l:'Monthly'}
];
const DOW_SHORT = ['S','M','T','W','T','F','S'];
const DOW_FULL  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

/* ==========================================================================
 * DATA LAYER — one shape for demo and live so no UI code branches on it.
 * ========================================================================*/
const DEMO_MEMBERS = [
  {id:'m1', name:'Erich', color:'#2f6f5e', role:'owner', default_lead_minutes:30, sort_order:1},
  {id:'m2', name:'Jess',  color:'#b4553c', role:'adult', default_lead_minutes:30, sort_order:2},
  {id:'m3', name:'Addie', color:'#7d4a8c', role:'teen',  default_lead_minutes:15, sort_order:3},
  {id:'m4', name:'Bryce', color:'#37588f', role:'child', default_lead_minutes:15, sort_order:4}
];
const DEMO_EXCEPTIONS = [];
function demoEvents(){
  const t = new Date(); const d = n => ymd(new Date(t.getFullYear(),t.getMonth(),t.getDate()+n));
  // a weekly series starting last Monday, with one week skipped — shows both
  // halves of the feature without needing a database
  const mon = (() => { const x = new Date(t); x.setDate(x.getDate() - ((x.getDay()+6)%7)); return ymd(x); })();
  DEMO_EXCEPTIONS.length = 0;
  DEMO_EXCEPTIONS.push({ event_id:'r1', occurrence_date: (()=>{ const x=parseYmd(mon); x.setDate(x.getDate()+14); return rymd(x); })(), action:'skip' });
  const series = { id:'r1', title:'Soccer practice', event_date:mon, all_day:false,
    starts_at:new Date(`${mon}T17:30:00`).toISOString(), member_id:'m3', notes:null,
    lead_minutes:30, repeat_freq:'weekly', repeat_interval:1, repeat_days:[1,3], repeat_until:null };
  return [series,
    ev('e1','Team standup',        d(0),'08:30','m1',30),
    ev('e2','Piano lesson',        d(0),'16:00','m3',30),
    ev('e3',"Dinner at Grandma's", d(0),'18:00',null,60),
    ev('e4','Physical — Dr. Reyes',d(1),'10:15','m4',120),
    ev('e5','Payroll deadline',    d(2),'12:00','m1',60),
    ev('e6','Church picnic',       d(3),null,   null,1440),
    ev('e7','First day of school', d(5),null,   null,1440),
    ev('e8','Parent–teacher conf.',d(7),'15:30','m2',60),
    ev('e9','Quarterly review',    d(9),'09:00','m1',1440)
  ];
}
function ev(id,title,date,time,member_id,lead){
  return {id,title,event_date:date,all_day:!time,
          starts_at: time ? new Date(`${date}T${time}:00`).toISOString() : null,
          member_id, notes:null, lead_minutes:lead};
}

const DB = {
  loadDemo(passcode = 'DEMO'){
    state.demo = true;
    state.exceptions = DEMO_EXCEPTIONS;
    state.household = {id:'demo', name:'Family Hub', passcode, timezone:CONFIG.TIMEZONE};
    state.members = DEMO_MEMBERS;
    state.events  = demoEvents();
  },

  async connect(){
    if (state.demo) { DB.loadDemo(); return; }
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    state.db = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON);

    const { data: hh, error: he } = await state.db
      .from('households').select('*').eq('id', CONFIG.HOUSEHOLD_ID).single();
    if (he) throw he;
    state.household = hh;

    const { data: ms } = await state.db.from('members').select('*')
      .eq('household_id', CONFIG.HOUSEHOLD_ID).is('deleted_at', null).order('sort_order');
    state.members = ms || [];

    await DB.loadEvents();

    // realtime: every phone updates live
    state.db.channel('hub')
      .on('postgres_changes', {event:'*', schema:'public', table:'events'},
          async () => { await DB.loadEvents(); render(); })
      .subscribe();
  },

  async loadEvents(){
    if (state.demo) return;
    const from = new Date(); from.setDate(from.getDate()-14);
    // Series rows have no upper date bound, so they must always be fetched —
    // filtering them by date would hide a weekly event from next month's view.
    const { data } = await state.db.from('events')
      .select('*, reminders(lead_minutes), event_people(member_id, role)')
      .eq('household_id', CONFIG.HOUSEHOLD_ID).is('deleted_at', null)
      .or(`repeat_freq.not.is.null,event_date.gte.${ymd(from)},starts_at.gte.${from.toISOString()}`);
    state.events = (data || []).map(e => ({
      ...e,
      lead_minutes: e.reminders?.[0]?.lead_minutes ?? null,
      people: (e.event_people || []).map(r => ({ member_id: r.member_id, role: r.role }))
    }));

    const { data: ex } = await state.db.from('event_exceptions').select('*')
      .eq('household_id', CONFIG.HOUSEHOLD_ID);
    state.exceptions = ex || [];
  },

  async saveEvent(e){
    if (state.demo) {
      if (e.id) Object.assign(state.events.find(x=>x.id===e.id), e);
      else state.events.push({...e, id:'d'+Math.random().toString(36).slice(2)});
      return;
    }
    const row = {
      household_id: CONFIG.HOUSEHOLD_ID, member_id: e.member_id, title: e.title,
      notes: e.notes || null, all_day: e.all_day,
      event_date: e.event_date, starts_at: e.starts_at, ends_at: e.ends_at || null,
      repeat_freq: e.repeat_freq ?? null,
      repeat_interval: e.repeat_interval ?? 1,
      repeat_days: e.repeat_days ?? [],
      repeat_until: e.repeat_until ?? null,
      reminder_lead_minutes: e.lead_minutes ?? null,
      created_by: state.me?.id || null, source: e.source || 'web'
    };
    const q = e.id
      ? state.db.from('events').update(row).eq('id', e.id).select().single()
      : state.db.from('events').insert(row).select().single();
    const { data, error } = await q;
    if (error) throw error;
    await DB.syncPeople(data.id, e.people, e.lead_minutes, !!e.lead_explicit);
    await DB.setReminder(data, e.lead_minutes);
    await DB.loadEvents();
  },

  /* fire_at is computed here, on write, so the dispatcher only ever runs one
     cheap indexed range scan per minute instead of scanning every event. */
  /* Roles carry different urgency. A driver has to leave the house; a
     passenger only has to be ready. Mirrors role_default_lead() in SQL —
     if you change one, change the other. */
  roleLead(role, memberDefault){
    const d = memberDefault ?? 30;
    if (role === 'driving' || role === 'dropoff') return Math.max(d, 45);
    if (role === 'pickup') return Math.max(d, 30);
    return d;
  },

  /* Replace the cast wholesale. Names arrive resolved against the real member
     list, so nothing enters as free text; anything that does not resolve is
     dropped rather than invented. */
  async syncPeople(eventId, people, lead = null, leadExplicit = false){
    if (state.demo || !eventId) return;
    /* null/undefined means "this caller has nothing to say about the cast".
       The event sheet edits time and title and never touches people, so it
       must not erase them. An explicit [] still means "nobody".

       The delete used to run before this check, which made saving any event
       from the sheet wipe its cast and every per-person reminder with it. */
    if (people == null) return;

    await state.db.from('event_people').delete().eq('event_id', eventId);
    if (!people.length) return;
    const rows = [];
    for (const p of people) {
      // Two shapes reach here: {name, role} from the parser, and
      // {member_id, role} from an event that was read back out of the table.
      const mem = p.member_id
        ? state.members.find(m => m.id === p.member_id)
        : state.members.find(m => m.name === p.name);
      if (!mem) continue;                       // unknown name -> not stored
      rows.push({
        household_id: CONFIG.HOUSEHOLD_ID,
        event_id: eventId,
        member_id: mem.id,
        role: p.role,
        /* An explicit "remind me 2 hours before" outranks the role default.
           It used to be stored on the event and then ignored here, so the
           instruction silently did nothing for anyone in the cast. */
        lead_minutes: p.lead != null ? p.lead
                    : (leadExplicit && lead != null) ? lead
                    : DB.roleLead(p.role, mem.default_lead_minutes)
      });
    }
    if (rows.length) await state.db.from('event_people').insert(rows);
  },

  async setReminder(row, lead){
    if (state.demo) return;
    // Series reminders are generated 14 days at a time by the materializer cron.
    // Writing one here would create a single orphan reminder for the first date.
    if (row.repeat_freq) {
      await state.db.from('reminders').delete().eq('event_id', row.id).is('sent_at', null);
      return;
    }
    await state.db.from('reminders').delete().eq('event_id', row.id).is('sent_at', null);
    if (lead == null) return;
    const start = row.all_day
      ? new Date(`${row.event_date}T09:00:00`)          // all-day -> 9am local
      : new Date(row.starts_at);
    /* Whoever collects is timed off the END. A pickup alert measured from the
       start sends someone out an hour early to sit in a car park. */
    const end = (!row.all_day && row.ends_at) ? new Date(row.ends_at) : null;

    /* ONE REMINDER PER PERSON, each at their own lead.
       This is the whole point of tracking roles. The parent driving needs to
       be told 45 minutes out because they have to leave; the kid being driven
       needs 15. A single reminder on the primary person gets one of them
       wrong every time — usually the one who has to do something about it. */
    const { data: cast } = await state.db.from('event_people')
      .select('member_id, role, lead_minutes').eq('event_id', row.id);

    const rows = (cast && cast.length)
      ? cast.map(c => ({
          member_id: c.member_id,
          lead: c.lead_minutes ?? lead,
          base: (c.role === 'pickup' && end) ? end : start
        }))
      : [{ member_id: row.member_id, lead, base: start }];   // no cast -> old behaviour

    await state.db.from('reminders').insert(rows.map(r => ({
      household_id: CONFIG.HOUSEHOLD_ID, event_id: row.id,
      member_id: r.member_id, lead_minutes: r.lead,
      channel: CONFIG.SMS_ENABLED ? 'sms' : 'push',
      fire_at: new Date(r.base.getTime() - r.lead*60000).toISOString()
    })));
  },

  async deleteEvent(id){
    if (state.demo) { state.events = state.events.filter(e=>e.id!==id); return; }
    await state.db.from('events').update({deleted_at:new Date().toISOString()}).eq('id', id);
    await DB.loadEvents();
  }
};

/* ==========================================================================
 * HELPERS
 * ========================================================================*/
const memberOf = id => state.members.find(m => m.id === id) || null;
const colorOf  = id => memberOf(id)?.color || EVERYONE;
const nameOf   = id => memberOf(id)?.name  || 'Everyone';
/* Who is actually on an event. An event with nobody named is attached to
   nobody and reminds nobody; calling that "Everyone" made an empty cast look
   like a full one. It now says so. Roles are shown where there is room. */
function whoOf(e, withRoles = false){
  const cast = e.people || [];
  if (!cast.length) return memberOf(e.member_id)?.name || 'No one yet';
  const all = state.members.length && cast.length === state.members.length;
  if (all && !withRoles) return 'Everyone';
  return cast.map(c => {
    const n = memberOf(c.member_id)?.name || '?';
    return withRoles && c.role !== 'going' ? `${n} · ${ROLE_SAY[c.role] ?? c.role}` : n;
  }).join(', ');
}
const dateOf   = e  => e.all_day ? e.event_date : ymd(new Date(e.starts_at));

function timeOf(e){
  if (e.all_day) return 'All day';
  const d = new Date(e.starts_at);
  let h = d.getHours(); const mi = d.getMinutes();
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 === 0 ? 12 : h % 12;
  return mi ? `${h}:${pad(mi)} ${ap}` : `${h}:00 ${ap}`;
}
const sortEv = (a,b) => (dateOf(a)+(a.all_day?'0':'1')+(a.starts_at||''))
                      .localeCompare(dateOf(b)+(b.all_day?'0':'1')+(b.starts_at||''));

/* Every read of the calendar goes through here. Series are expanded into real
   dated occurrences and exceptions applied, so no view ever has to know that
   recurrence exists. */
function eventsBetween(from, to){
  return expand(state.events, state.exceptions, from, to);
}
const onDay = d => eventsBetween(d, d);
const addDaysS = (s, n) => { const x = parseYmd(s); x.setDate(x.getDate()+n); return rymd(x); };
const startOfWeek = s => addDaysS(s, -parseYmd(s).getDay());
const monthBounds = s => { const d = parseYmd(s);
  return [rymd(new Date(d.getFullYear(), d.getMonth(), 1)),
          rymd(new Date(d.getFullYear(), d.getMonth()+1, 0))]; };
const leadLabel = v => (LEADS.find(l => l.v === v) || {l:`${v}m`}).l;

function toast(msg){
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(()=>t.classList.remove('on'), 2400);
}

/* ==========================================================================
 * THEME
 * 'auto' follows the phone's own Light/Dark setting (and flips at sunset with
 * it). 'light'/'dark' pin it. The <html data-theme> attribute is set before
 * first paint by an inline script in index.html so there is never a flash.
 * ========================================================================*/
const THEME_KEY = 'fh.theme';
const sysDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
const getTheme = () => { try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; } };

function applyTheme(mode){
  const root = document.documentElement;
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = mode;
  try { localStorage.setItem(THEME_KEY, mode); } catch {}

  // keep the iOS status bar / Android chrome in step with the app
  const dark = mode === 'dark' || (mode === 'auto' && sysDark());
  $$('meta[name="theme-color"]').forEach(m => m.remove());
  const m = document.createElement('meta');
  m.name = 'theme-color';
  m.content = dark ? '#0f1216' : '#f1f3f7';
  document.head.appendChild(m);

  $$('#theme-seg button').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.theme === mode)));
  const hint = $('#theme-hint');
  if (hint) hint.textContent = mode === 'auto'
    ? `Following your phone — currently ${sysDark() ? 'dark' : 'light'}.`
    : mode === 'dark' ? 'Always dark, whatever the phone is set to.'
                      : 'Always light, whatever the phone is set to.';
}

// If we're on auto, react live when the phone flips at sunset.
window.matchMedia('(prefers-color-scheme: dark)')
  .addEventListener('change', () => { if (getTheme() === 'auto') applyTheme('auto'); });

/* ==========================================================================
 * GATE
 * ========================================================================*/
async function boot(){
  applyTheme(getTheme());
  try {
    await DB.connect();
  } catch (err) {
    // Most likely: schema.sql hasn't been run yet, or there's no network.
    // Fall back to sample data so the app is still explorable, and say why.
    console.warn('Supabase unreachable — falling back to demo data.', err);
    DB.loadDemo('DEMO');
    state.demoReason = 'notReady';
  }
  if (state.demo) {
    $('#gate-p').innerHTML = state.demoReason === 'notReady'
      ? 'Not connected to Supabase yet &mdash; showing sample data.<br>Code: <b>DEMO</b>'
      : 'Demo mode &mdash; no database connected yet. Code: <b>DEMO</b>';
    $('#code').value = 'DEMO';
  }
  const saved = localStorage.getItem('fh.code');
  const savedMe = localStorage.getItem('fh.me');
  if (saved && saved === state.household.passcode) {
    if (savedMe && memberOf(savedMe)) { state.me = memberOf(savedMe); return enter(); }
    showWho();
  }
}

$('#code-go').onclick = () => {
  const v = $('#code').value.trim();
  if (!v) return;
  if (v.toUpperCase() !== String(state.household.passcode).toUpperCase()) {
    $('#code-err').textContent = "That code doesn't match."; return;
  }
  localStorage.setItem('fh.code', state.household.passcode);
  showWho();
};
$('#code').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#code-go').click(); } });

function showWho(){
  $('#step-code').classList.add('hide');
  $('#step-who').classList.remove('hide');
  $('#gate-p').textContent = "Who's using this phone?";
  $('#whogrid').innerHTML = state.members.map(m =>
    `<button class="whobtn" data-id="${m.id}"><span class="dot" style="background:${m.color}"></span>${m.name}</button>`
  ).join('');
  $$('#whogrid .whobtn').forEach(b => b.onclick = () => {
    state.me = memberOf(b.dataset.id);
    localStorage.setItem('fh.me', state.me.id);
    enter();
  });
}

function enter(){
  $('#gate').classList.add('hide');
  $('#app').classList.remove('hide');
  $('#fab').classList.remove('hide');
  const other = state.members.find(m => m.id !== state.me.id);
  $('#qa-input').placeholder = `Soccer Thursday 5:30${other ? ' ' + other.name : ''}`;
  $('#me').innerHTML = `<span class="dot" style="background:${state.me.color}"></span><span class="nm">${state.me.name}</span>`;
  if (state.demo) {
    const b = $('#banner');
    b.innerHTML = state.demoReason === 'notReady'
      ? `<b>Sample data.</b> Couldn't reach Supabase — run <code>supabase/schema.sql</code> in the SQL Editor, then reload. Nothing you add here is saved.`
      : `<b>Demo mode.</b> Nothing you add here is saved.`;
    b.classList.remove('hide');
  }
  render();
  initPush();
}

/* ==========================================================================
 * RENDER
 * ========================================================================*/
function render(){
  const now = new Date();
  const hr = now.getHours();
  $('#hello').firstChild.textContent = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  $('#hello-sub').textContent = now.toLocaleDateString('en-US',{weekday:'long', month:'long', day:'numeric'});

  if (state.module === 'shopping') { $('#viewbar').classList.add('hide'); return renderShopping(); }
  if (state.module !== 'calendar') { $('#viewbar').classList.add('hide'); return renderPlaceholder(); }

  $('#viewbar').classList.remove('hide');
  if (!state.cursor) state.cursor = ymd(now);

  if (state.view !== 'today') {
    $('#qa').classList.add('hide');
    $('#bento').className = 'calview';
    $('#bento').innerHTML = state.view === 'month' ? renderMonth()
                          : state.view === 'week'  ? renderWeek()
                          : renderDay();
    bindCalendar();
    return;
  }
  $('#bento').className = 'bento';
  $('#qa').classList.remove('hide');
  const today = ymd(now);
  const todays = onDay(today);

  // week strip: Sunday-anchored week containing today
  const wkStart = new Date(now); wkStart.setDate(now.getDate() - now.getDay());
  const week = [...Array(7)].map((_,i) => { const d = new Date(wkStart); d.setDate(wkStart.getDate()+i); return d; });

  const horizon = addDaysS(today, 45);
  const upcoming = eventsBetween(addDaysS(today, 1), horizon).slice(0, 6);
  const monthAhead = eventsBetween(today, addDaysS(today, 30));

  $('#bento').innerHTML = `
    <div class="col">
      <section class="card">
        <div class="ch"><span>Today</span><b>${todays.length ? todays.length + (todays.length===1?' event':' events') : 'Clear'}</b></div>
        <div class="tdate">${now.toLocaleDateString('en-US',{weekday:'long'})}</div>
        <h2 class="tbig">${now.toLocaleDateString('en-US',{month:'short', day:'numeric'})}</h2>
        ${todays.length ? todays.map(e => `
          <button class="trow" data-ev="${e.id}" style="--c:${colorOf(e.member_id)}">
            <span class="ttime">${timeOf(e)}</span>
            <span class="body"><span class="ttitle">${esc(e.title)}</span><span class="twho">${esc(whoOf(e))}</span></span>
            ${e.lead_minutes != null ? `<span class="bell" title="Reminder ${leadLabel(e.lead_minutes)} before">&#9201;</span>` : ''}
          </button>`).join('')
        : `<div class="empty">Nothing on the calendar today.</div>`}
      </section>

      <section class="card">
        <div class="ch"><span>Who's busy</span><b>Next 30 days</b></div>
        ${state.members.map(m => `<div class="lane"><span class="dot" style="background:${m.color}"></span>
          <span class="nm">${m.name}</span>
          <span class="ct">${monthAhead.filter(e=>e.member_id===m.id).length}</span></div>`).join('')}
        <div class="lane"><span class="dot" style="background:${EVERYONE}"></span>
          <span class="nm">Everyone</span>
          <span class="ct">${monthAhead.filter(e=>!e.member_id).length}</span></div>
      </section>
    </div>

    <div class="col">
      <section class="card">
        <div class="ch"><span>This week</span><b>${week[0].toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${week[6].toLocaleDateString('en-US',{month:'short',day:'numeric'})}</b></div>
        <div class="weekstrip">
          ${week.map(d => { const k = ymd(d); const evs = onDay(k);
            return `<button class="wd ${k===today?'on':''}" data-day="${k}">
              <i>${DOW[d.getDay()]}</i><b>${d.getDate()}</b>
              <span class="pips">${evs.slice(0,3).map(e=>`<span style="background:${colorOf(e.member_id)}"></span>`).join('')}</span>
            </button>`; }).join('')}
        </div>
      </section>

      <section class="card">
        <div class="ch"><span>Coming up</span></div>
        ${upcoming.length ? upcoming.map(e => { const d = new Date(dateOf(e)+'T12:00:00');
          return `<button class="up" data-ev="${e.id}">
            <span class="upd"><i>${DOW[d.getDay()]}</i><b>${d.getDate()}</b></span>
            <span class="body"><span class="upt">${esc(e.title)}</span><span class="upm">${timeOf(e)} · ${esc(whoOf(e))}</span></span>
            <span class="dot" style="background:${colorOf(e.member_id)}"></span>
          </button>`; }).join('')
        : `<div class="empty">Nothing scheduled yet.</div>`}
      </section>

      <section class="card soon">
        <b>Shopping · Meals · Money</b>
        <span>Each one drops in as another card. The database already has room for them.</span>
      </section>
    </div>`;

  $$('[data-ev]').forEach(b => b.onclick = () => openSheet(state.events.find(e => e.id === b.dataset.ev)));
  $$('[data-day]').forEach(b => b.onclick = () => openSheet(null, b.dataset.day));
}


/* ==========================================================================
 * CALENDAR VIEWS
 * One shared pill renderer; each view only decides which dates to show.
 * ========================================================================*/
const pill = (e) => `<button class="pill" data-occ="${e.id}|${e.occurrence_date}" style="--c:${colorOf(e.member_id)}">
  <span class="pt">${timeOf(e)}</span>
  <span class="pb"><span class="pn">${esc(e.title)}${e.is_occurrence
      ? `<span class="rep" title="${esc(describeRepeat(e)||'Repeats')}">&#8635;</span>` : ''}</span>
    <span class="pw">${esc(whoOf(e))}</span></span>
  ${e.lead_minutes != null ? `<span class="bell">&#9201;</span>` : ''}
</button>`;

function navBar(label){
  return `<div class="cal-nav">
    <button data-nav="-1" aria-label="Previous">&#8249;</button>
    <button data-nav="0" class="today">Today</button>
    <button data-nav="1" aria-label="Next">&#8250;</button>
    <span class="lbl">${label}</span>
  </div>`;
}

function renderMonth(){
  const cur = state.cursor;
  const [mStart, mEnd] = monthBounds(cur);
  const first = parseYmd(mStart), lead = first.getDay();
  const gridStart = addDaysS(mStart, -lead);
  const cells = [];
  for (let i = 0; i < 42; i++) cells.push(addDaysS(gridStart, i));
  const evs = eventsBetween(cells[0], cells[41]);
  const byDate = new Map();
  for (const e of evs) { if(!byDate.has(e.event_date)) byDate.set(e.event_date, []); byDate.get(e.event_date).push(e); }

  const today = ymd(new Date());
  const sel = state.selectedDay || (cur.slice(0,7) === today.slice(0,7) ? today : mStart);
  const monthName = parseYmd(cur).toLocaleDateString('en-US',{month:'long', year:'numeric'});

  const grid = DOW_FULL.map(d=>`<div class="mdow">${d[0]}</div>`).join('')
    + cells.map(d => {
       const list = byDate.get(d) || [];
       const out = d < mStart || d > mEnd;
       const show = list.slice(0,3), rest = list.length - show.length;
       return `<button class="mcell ${out?'out':''} ${d===today?'today':''} ${d===sel?'sel':''}" data-day="${d}">
         <span class="mnum">${parseYmd(d).getDate()}</span>
         <span class="mdots">${list.slice(0,4).map(e=>`<span style="background:${colorOf(e.member_id)}"></span>`).join('')}</span>
         <span class="mev">${show.map(e=>`<span class="me" style="--c:${colorOf(e.member_id)}">${esc(e.title)}</span>`).join('')}
           ${rest>0?`<span class="more">+${rest}</span>`:''}</span>
       </button>`; }).join('');

  const dayList = (byDate.get(sel) || []);
  return navBar(monthName) + `<div class="mgrid">${grid}</div>
    <section class="daypanel">
      <h3>${parseYmd(sel).toLocaleDateString('en-US',{weekday:'long', month:'long', day:'numeric'})}</h3>
      ${dayList.length ? dayList.map(pill).join('') : `<div class="empty">Nothing scheduled.</div>`}
    </section>`;
}

function renderWeek(){
  const ws = startOfWeek(state.cursor);
  const days = [...Array(7)].map((_,i)=>addDaysS(ws,i));
  const evs = eventsBetween(days[0], days[6]);
  const byDate = new Map();
  for (const e of evs){ if(!byDate.has(e.event_date)) byDate.set(e.event_date,[]); byDate.get(e.event_date).push(e); }
  const today = ymd(new Date());
  const label = `${parseYmd(days[0]).toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${parseYmd(days[6]).toLocaleDateString('en-US',{month:'short',day:'numeric'})}`;

  // mobile: a readable stack of days
  const stack = days.map(d => {
    const list = byDate.get(d) || [];
    return `<div class="wday ${d===today?'is-today':''}">
      <div class="wh"><b>${parseYmd(d).toLocaleDateString('en-US',{weekday:'long'})}</b>
        <span>${parseYmd(d).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span></div>
      ${list.length ? list.map(pill).join('') : `<div class="none">&mdash;</div>`}
    </div>`; }).join('');

  // desktop: a real time grid. Evenings matter here, so run 6am-10pm.
  const H0 = 6, H1 = 22;
  let grid = `<div></div>` + days.map(d =>
    `<div class="wcol-h ${d===today?'is-today':''}"><i>${DOW_FULL[parseYmd(d).getDay()]}</i><b>${parseYmd(d).getDate()}</b></div>`).join('');
  const allDay = days.map(d => (byDate.get(d)||[]).filter(e=>e.all_day));
  if (allDay.some(l=>l.length)) {
    grid += `<div class="hlab">all&nbsp;day</div>` + allDay.map(list =>
      `<div class="cellw">${list.map(e=>`<button class="we" data-occ="${e.id}|${e.occurrence_date}" style="--c:${colorOf(e.member_id)}">${esc(e.title)}</button>`).join('')}</div>`).join('');
  }
  for (let h = H0; h <= H1; h++){
    const lab = h===12 ? 'noon' : h>12 ? `${h-12} PM` : `${h} AM`;
    grid += `<div class="hlab">${lab}</div>`;
    grid += days.map(d => {
      const list = (byDate.get(d)||[]).filter(e => !e.all_day && new Date(e.starts_at).getHours() === h);
      return `<div class="cellw">${list.map(e=>`<button class="we" data-occ="${e.id}|${e.occurrence_date}" style="--c:${colorOf(e.member_id)}">${timeOf(e).replace(':00','')} ${esc(e.title)}</button>`).join('')}</div>`;
    }).join('');
  }
  return navBar(label) + `<div class="wstack">${stack}</div><div class="wgrid">${grid}</div>`;
}

function renderDay(){
  const d = state.cursor;
  const list = onDay(d);
  const today = ymd(new Date());
  const nowH = new Date().getHours();
  const allDay = list.filter(e=>e.all_day);
  let rows = '';
  if (allDay.length) rows += `<div class="hr"><span class="hl">all day</span><span class="hb">${allDay.map(pill).join('')}</span></div>`;
  for (let h = 6; h <= 22; h++){
    const at = list.filter(e => !e.all_day && new Date(e.starts_at).getHours() === h);
    const lab = h===12 ? 'noon' : h>12 ? `${h-12} PM` : `${h} AM`;
    rows += `<div class="hr ${d===today && h===nowH ? 'now':''}"><span class="hl">${lab}</span>
      <span class="hb">${at.map(pill).join('')}</span></div>`;
  }
  return navBar(parseYmd(d).toLocaleDateString('en-US',{weekday:'long', month:'long', day:'numeric'}))
    + `<div class="tline">${rows}</div>`;
}

function stepCursor(dir){
  if (dir === 0) { state.cursor = ymd(new Date()); state.selectedDay = state.cursor; return; }
  if (state.view === 'day')   state.cursor = addDaysS(state.cursor, dir);
  if (state.view === 'week')  state.cursor = addDaysS(state.cursor, dir*7);
  if (state.view === 'month'){ const d = parseYmd(state.cursor);
    state.cursor = rymd(new Date(d.getFullYear(), d.getMonth()+dir, 1)); state.selectedDay = null; }
}

/* ==========================================================================
 * SHOPPING
 *
 * The list you read standing in an aisle with a cart in one hand. Everything
 * here is one tap: tick it, untick it, take it off. Items sort into walking
 * order for the store you are in — real aisle numbers where we have them
 * (HEB on 1488, from H-E-B's published guide), category order otherwise.
 *
 * Same parser as the text number. Type "milk eggs 2 lbs ground beef" here
 * and it splits exactly the way it does by text.
 * ========================================================================*/
const SHOP = {
  async load(){
    if (state.demo) return;
    const hh = CONFIG.HOUSEHOLD_ID;
    const [st, it, cat, ai, cats] = await Promise.all([
      state.db.from('stores').select('id, name, aliases, sort_order').eq('household_id', hh)
        .is('deleted_at', null).order('sort_order'),
      state.db.from('shopping_items').select('*').eq('household_id', hh).is('cleared_at', null)
        .order('created_at'),
      state.db.from('shopping_catalog').select('name, category, store_id').eq('household_id', hh),
      state.db.from('store_aisles').select('store_id, category, aisle, sort_order, verified_at'),
      state.db.from('shopping_categories').select('name, sort_order')
    ]);
    state.stores = st.data || []; state.shopItems = it.data || [];
    state.shopCatalog = cat.data || []; state.shopAisles = ai.data || [];
    state.shopCats = cats.data || [];
  },

  async add(text){
    const p = parseShopping(text, { stores: state.stores, catalog: state.shopCatalog });
    if (!p.items.length) { toast('Nothing to add'); return; }
    const live = new Set(state.shopItems.filter(i => !i.got)
      .map(i => `${i.store_id ?? ''}|${i.name.toLowerCase()}`));
    const rows = [];
    for (const it of p.items) {
      const sid = it.store?.id ?? state.shopStore ?? null;
      if (live.has(`${sid ?? ''}|${it.name.toLowerCase()}`)) continue;    // already there
      rows.push({
        household_id: CONFIG.HOUSEHOLD_ID, store_id: sid,
        name: it.name, qty: it.qty, note: it.note, category: it.category,
        pick_yourself: !!it.pickYourself, online_ok: !!it.onlineOk,
        added_by: state.me?.id || null, source: 'web'
      });
    }
    if (!rows.length) { toast('Already on the list'); return; }
    const { error } = await state.db.from('shopping_items').insert(rows);
    if (error) { console.error(error); toast('Could not save'); return; }
    // remember what this family buys — same guard as the text number
    for (const it of p.items) {
      const seen = state.shopCatalog.find(c => c.name.toLowerCase() === it.name.toLowerCase());
      if (seen) continue;
      await state.db.from('shopping_catalog').insert({
        household_id: CONFIG.HOUSEHOLD_ID, name: it.name, category: it.category,
        store_id: it.store?.id ?? null
      });
    }
    if (p.corrections.length) toast(`Read "${p.corrections[0].from}" as ${p.corrections[0].name}`);
    await SHOP.load(); render();
  },

  async toggle(id){
    const it = state.shopItems.find(i => i.id === id); if (!it) return;
    const got = !it.got;
    it.got = got;                                            // optimistic
    render();
    await state.db.from('shopping_items').update({
      got, got_at: got ? new Date().toISOString() : null, got_by: got ? state.me?.id : null
    }).eq('id', id);
  },

  /* A mistake, not a purchase: gone, and forgotten by the catalog so it is
     never suggested or merged again. */
  async remove(id){
    const it = state.shopItems.find(i => i.id === id); if (!it) return;
    state.shopItems = state.shopItems.filter(i => i.id !== id); render();
    await state.db.from('shopping_items').delete().eq('id', id);
    await state.db.from('shopping_catalog').delete()
      .eq('household_id', CONFIG.HOUSEHOLD_ID).eq('name', it.name);
  },

  /* Recoverable. Rows move to history; nothing is destroyed. */
  async clear(storeId, boughtOnly){
    let q = state.db.from('shopping_items').update({ cleared_at: new Date().toISOString() })
      .eq('household_id', CONFIG.HOUSEHOLD_ID).is('cleared_at', null);
    if (storeId) q = q.eq('store_id', storeId);
    if (boughtOnly) q = q.eq('got', true);
    await q;
    await SHOP.load(); render();
    toast(boughtOnly ? 'Bought items cleared' : 'List cleared');
  },

  /* Walking order for a store: its aisle table where we have one, category
     order where we do not. */
  order(storeId){
    const cat = new Map(state.shopCats.map(c => [c.name, c.sort_order]));
    const ais = new Map(state.shopAisles.filter(a => a.store_id === storeId)
      .map(a => [a.category, a]));
    return (item) => {
      const a = ais.get(item.category);
      return a && a.sort_order != null ? a.sort_order : 100 + (cat.get(item.category) ?? 999);
    };
  },
  aisleOf(storeId, category){
    return state.shopAisles.find(a => a.store_id === storeId && a.category === category)?.aisle || null;
  }
};

function renderShopping(){
  $('#qa').classList.add('hide');
  const storeName = id => state.stores.find(s => s.id === id)?.name || 'Any store';
  const sel = state.shopStore;                       // null = everything
  const items = state.shopItems.filter(i => !sel || i.store_id === sel);
  const need = items.filter(i => !i.got), got = items.filter(i => i.got);

  // group by store when showing everything; the list is read in ONE store
  const groups = new Map();
  for (const it of need) {
    const k = sel ? sel : (it.store_id || '');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const rowHtml = (it, storeId) => {
    const aisle = SHOP.aisleOf(storeId, it.category);
    return `<li class="shop-row${it.got ? ' got' : ''}" data-id="${it.id}">
      <button class="tick" data-tick="${it.id}" aria-label="${it.got ? 'Not got' : 'Got it'}">${it.got ? '&#10003;' : ''}</button>
      <span class="body">
        <span class="nm">${it.qty ? `<b>${esc(it.qty)}</b> ` : ''}${esc(it.name)}${it.note ? ` <i>(${esc(it.note)})</i>` : ''}</span>
        <span class="meta">${aisle ? `<span class="aisle">Aisle ${esc(aisle)}</span>` : `<span class="aisle dim">${esc(it.category)}</span>`}${it.pick_yourself ? '<span class="pick">pick out</span>' : ''}</span>
      </span>
      <button class="x" data-x="${it.id}" aria-label="Remove">&times;</button>
    </li>`;
  };

  const blocks = [...groups.entries()].map(([k, rows]) => {
    rows.sort((a, b) => SHOP.order(k || null)(a) - SHOP.order(k || null)(b));
    return `${sel ? '' : `<div class="ch" style="margin:14px 0 6px">${esc(storeName(k))}</div>`}
      <ul class="shop-list">${rows.map(r => rowHtml(r, k || null)).join('')}</ul>`;
  });

  const chips = [{ id: null, name: 'All' }, ...state.stores].map(s =>
    `<button class="chip${(s.id ?? null) === sel ? ' on' : ''}" data-store="${s.id ?? ''}">${esc(s.name)}</button>`).join('');

  const hasAisles = sel && state.shopAisles.some(a => a.store_id === sel);

  $('#bento').innerHTML = `<div class="col">
    <section class="card">
      <div class="chips">${chips}</div>
      <form id="shop-add" autocomplete="off">
        <input id="shop-in" placeholder='Add: "milk eggs 2 lbs ground beef"' enterkeyhint="done">
        <button type="submit">Add</button>
      </form>
      ${need.length ? `<div class="ch" style="margin-top:12px">${need.length} to get${sel && !hasAisles ? ' · no aisle map for this store yet' : ''}</div>` : ''}
      ${need.length ? blocks.join('') : `<div class="soon" style="padding:26px 12px;margin-top:12px"><b>Nothing to get</b><span>Add something above, or text the family number.</span></div>`}
      ${got.length ? `<div class="ch" style="margin:14px 0 6px">Got · ${got.length}</div>
        <ul class="shop-list">${got.map(r => rowHtml(r, r.store_id)).join('')}</ul>` : ''}
      ${items.length ? `<div class="acts" style="margin-top:14px">
        <button type="button" id="shop-done" ${got.length ? '' : 'disabled'}>Done shopping</button>
        <button type="button" id="shop-clear" class="danger">Clear ${sel ? esc(storeName(sel)) : 'everything'}</button>
      </div>` : ''}
    </section>
  </div>`;

  $$('#bento [data-store]').forEach(b => b.onclick = () => { state.shopStore = b.dataset.store || null; render(); });
  $('#shop-add').onsubmit = async e => { e.preventDefault(); const v = $('#shop-in').value.trim(); if (!v) return; $('#shop-in').value = ''; await SHOP.add(v); };
  $$('#bento [data-tick]').forEach(b => b.onclick = () => SHOP.toggle(b.dataset.tick));
  $$('#bento [data-x]').forEach(b => b.onclick = () => SHOP.remove(b.dataset.x));
  const done = $('#shop-done'); if (done) done.onclick = () => SHOP.clear(sel, true);
  const clr = $('#shop-clear'); if (clr) clr.onclick = () => {
    /* One confirmation, naming what is about to go. Recoverable either way,
       but a whole list is worth a second tap. */
    if (confirm(`Clear ${sel ? storeName(sel) : 'the whole list'} — ${items.length} item${items.length === 1 ? '' : 's'}? They move to history, not gone.`)) SHOP.clear(sel, false);
  };
}

function renderPlaceholder(){
  const copy = {
    shopping:['Shopping list','A shared, checkable list. Add by typing or by texting the family number. Auto-generated from the week\'s meal plan once Meals is built.'],
    meals:['Meal planner','Pick dinners for the week from recipes you already cook. One tap turns the week into a shopping list, grouped by aisle.'],
    money:['Money','Household accounts and spending. This is the one module that will NOT be visible to everyone — it sits behind a per-person login, which is why every member already has a role.']
  }[state.module];
  $('#qa').classList.add('hide');
  $('#bento').innerHTML = `<div class="col"><section class="card soon" style="padding:38px 22px">
    <b style="font-size:16px">${copy[0]}</b><span style="display:block;max-width:44ch;margin:8px auto 0">${copy[1]}</span>
  </section></div>`;
}

const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function bindCalendar(){
  $$('[data-nav]').forEach(b => b.onclick = () => { stepCursor(+b.dataset.nav); render(); });
  $$('[data-day]').forEach(b => b.onclick = () => {
    if (state.view === 'month') { state.selectedDay = b.dataset.day; render(); }
    else openSheet(null, b.dataset.day);
  });
  $$('[data-occ]').forEach(b => b.onclick = () => {
    const [id, date] = b.dataset.occ.split('|');
    const occ = eventsBetween(date, date).find(e => e.id === id && e.occurrence_date === date);
    if (occ) openSheet(occ, date);
  });
}

$$('#viewbar button').forEach(b => b.onclick = () => {
  state.view = b.dataset.v;
  $$('#viewbar button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  if (state.view !== 'today' && !state.cursor) state.cursor = ymd(new Date());
  render();
});

$$('#tabbar button').forEach(b => b.onclick = async () => {
  state.module = b.dataset.mod;
  if (state.module === 'shopping') await SHOP.load();
  $$('#tabbar button').forEach(x => x.setAttribute('aria-current', String(x === b)));
  render();
});

/* ==========================================================================
 * QUICK ADD
 * ========================================================================*/
const qaIn = $('#qa-input');
qaIn.addEventListener('input', () => {
  $('#qa-send').disabled = !qaIn.value.trim();
  if (!qaIn.value.trim()) { $('#qa-prev').innerHTML = ''; state.parsed = null; }
});
$('#qa-form').addEventListener('submit', e => { e.preventDefault(); preview(); });

/* The clock, said out loud. 12:00 is the number people misread most often,
   in both directions, so it never appears here without the word. */
function clockLabel(t){
  if (!t) return 'All day';
  const [h, mi] = t.split(':').map(Number);
  if (h === 12 && mi === 0) return '12:00 PM (noon)';
  if (h === 0  && mi === 0) return '12:00 AM (midnight)';
  const ap = h >= 12 ? 'PM' : 'AM', hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(mi).padStart(2,'0')} ${ap}`;
}
const dayLabel = d => new Date(d + 'T12:00:00')
  .toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

function preview(){
  const text = qaIn.value.trim(); if (!text) return;
  state.parsed = parseQuickAdd(text, {
    // Names AND aliases — a kid texts "mom is driving", not "Jess is driving".
    members: state.members.map(m => ({ name: m.name, aliases: m.aliases || [] })),
    defaultLead: state.me?.default_lead_minutes ?? 30,
    me: state.me?.name
  });
  renderPreview();
}

/* Split out from preview() so answering a question can redraw the card
   without re-parsing the text — re-parsing would just re-raise the same
   ambiguity and throw the answer away. */
function renderPreview(){
  const p = state.parsed; if (!p) return;
  const d = describe(p);
  const mem = state.members.find(m => m.name === p.member);

  /* Anything the parser refused to guess at. The button stays disabled until
     these are answered, which is the same rule the text number follows —
     one parser, one standard, whichever door you came in by. */
  const asks = [];
  if (p.alsoToday) asks.push({
    key: 'date',
    q: 'Which day did you mean?',
    opts: [ { label: `Today · ${dayLabel(p.alsoToday)}`, val: p.alsoToday },
            { label: dayLabel(p.date),                   val: p.date } ]
  });
  if (p.ambiguousTime) asks.push({
    key: 'time',
    q: p.ambiguousTime.kind === 'noon' ? '12:00 — which one?' : 'Morning or evening?',
    opts: [ { label: clockLabel(p.ambiguousTime.am), val: p.ambiguousTime.am },
            { label: clockLabel(p.ambiguousTime.pm), val: p.ambiguousTime.pm } ]
  });

  const castNote = p.needsCast
    ? 'Nobody on it yet — add names to get reminders to the right phones.'
    : p.needsRides
      ? 'No ride noted. Add "Jess there, me back" if someone needs a lift.'
      : p.needsEnd
        ? 'No end time. Add "6-8pm" or "for 2 hours" — the pickup alert is measured from the end.'
        : '';

  /* Never the word "Everyone". An event with nobody named is attached to
     nobody and reminds nobody, and saying "Everyone" hid exactly that. */
  const who = (p.people ?? []).length
    ? p.people.map(x => x.role === 'going' ? x.name : `${x.name} · ${ROLE_SAY[x.role] ?? x.role}`).join(', ')
    : (p.member || 'No one yet');

  $('#qa-prev').innerHTML = `
    <div class="qa-prev" style="--c:${mem?.color || EVERYONE}">
      <div class="pt">${esc(p.title)}</div>
      ${p.warnings.map(w => `<div class="warn">${esc(w)}</div>`).join('')}
      <div class="meta">
        <span class="mtag">${d.day}</span><span class="mtag">${p.allDay ? 'All day'
          : esc(clockLabel(p.start) + (p.end ? ` – ${clockLabel(p.end)}` : ''))}</span>
        <span class="mtag">${esc(who)}</span><span class="mtag">&#9201; ${d.lead}</span>
        ${d.repeat ? `<span class="mtag">&#8635; ${esc(d.repeat)}</span>` : ''}
      </div>
      ${asks.map((a, i) => `
        <div class="qa-ask">
          <div class="aq">${esc(a.q)}</div>
          <div class="ao">${a.opts.map((o, j) =>
            `<button type="button" data-ask="${i}" data-opt="${j}">${esc(o.label)}</button>`).join('')}</div>
        </div>`).join('')}
      ${castNote ? `<div class="hint">${esc(castNote)}</div>` : ''}
      <div class="acts">
        <button type="button" id="qa-edit">Edit</button>
        <button type="button" class="ok" id="qa-ok"${asks.length ? ' disabled' : ''}>${
          asks.length ? 'Answer above' : 'Add it'}</button>
      </div>
    </div>`;

  $$('#qa-prev [data-ask]').forEach(btn => btn.onclick = () => {
    const a = asks[+btn.dataset.ask], o = a.opts[+btn.dataset.opt];
    if (a.key === 'date') { state.parsed.date = o.val; state.parsed.alsoToday = null; }
    else                  { state.parsed.start = o.val; state.parsed.ambiguousTime = null; }
    renderPreview();
  });

  if (!asks.length) $('#qa-ok').onclick = commitParsed;
  $('#qa-edit').onclick = () => { openSheet(parsedToEvent(p)); clearQA(); };
}

function parsedToEvent(p){
  const mem = state.members.find(m => m.name === p.member);
  return {
    id: null, title: p.title, notes: null,
    all_day: p.allDay, event_date: p.date,
    starts_at: p.allDay ? null : new Date(`${p.date}T${p.start}:00`).toISOString(),
    ends_at:   p.end ? new Date(`${p.date}T${p.end}:00`).toISOString() : null,
    member_id: mem?.id || null, lead_minutes: p.leadMinutes, source: 'web',
    lead_explicit: p.matched?.includes('lead') ?? false,
    // The parser now returns a real recurrence rule. Dropping it here was the
    // bug that made "every Tuesday" silently produce a single event.
    repeat_freq:     p.repeat?.freq     ?? null,
    repeat_interval: p.repeat?.interval ?? 1,
    repeat_days:     p.repeat?.days     ?? [],
    repeat_until:    p.repeat?.until    ?? null,
    people:          p.people ?? []
  };
}
async function commitParsed(){
  try {
    await DB.saveEvent(parsedToEvent(state.parsed));
    clearQA(); render(); toast('Added');
  } catch (err) { console.error(err); toast('Could not save'); }
}
function clearQA(){ qaIn.value = ''; $('#qa-prev').innerHTML = ''; $('#qa-send').disabled = true; state.parsed = null; }

/* ==========================================================================
 * EVENT SHEET
 * ========================================================================*/
const sheet = $('#sheet');
$('#fab').onclick = () => openSheet(null, ymd(new Date()));
$$('[data-close]').forEach(x => x.onclick = closeSheet);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  closeSheet();
  if (typeof closeSettings === 'function') closeSettings();
});

function openSheet(e, presetDate){
  state.editing = e && e.id ? e : null;
  state.editingOccurrence = e && e.occurrence_date ? e.occurrence_date : null;
  $('#sheet-title').textContent = state.editing
    ? (e.is_occurrence ? 'Edit occurrence' : 'Edit event') : 'New event';
  $('#ev-del').classList.toggle('hide', !state.editing);

  const src = e || {};
  $('#ev-title').value = src.title || '';
  $('#ev-notes').value = src.notes || '';
  $('#ev-date').value  = src.event_date || presetDate || ymd(new Date());
  $('#ev-time').value  = src.all_day === false && src.starts_at
    ? new Date(src.starts_at).toTimeString().slice(0,5) : '';

  const who = src.member_id !== undefined ? src.member_id : (state.me?.id || null);
  $('#ev-who').innerHTML = [
    ...state.members.map(m => `<button type="button" class="chip" data-w="${m.id}" aria-pressed="${who===m.id}">
        <span class="dot" style="background:${m.color}"></span>${m.name}</button>`),
    `<button type="button" class="chip" data-w="" aria-pressed="${!who}">
        <span class="dot" style="background:${EVERYONE}"></span>Everyone</button>`
  ].join('');
  $$('#ev-who .chip').forEach(c => c.onclick = () => {
    $$('#ev-who .chip').forEach(x => x.setAttribute('aria-pressed','false'));
    c.setAttribute('aria-pressed','true');
  });

  // repeat controls
  const rf = src.repeat_freq ?? null;
  $('#ev-repeat').innerHTML = REPEATS.map(r =>
    `<button type="button" class="chip" data-r="${r.v ?? ''}" aria-pressed="${r.v === rf}">${r.l}</button>`).join('');
  const seedDays = (src.repeat_days && src.repeat_days.length)
    ? src.repeat_days : [parseYmd(src.event_date || presetDate || ymd(new Date())).getDay()];
  $('#ev-days').innerHTML = DOW_SHORT.map((d,i) =>
    `<button type="button" class="chip" data-d="${i}" aria-pressed="${seedDays.includes(i)}">${d}</button>`).join('');
  $('#ev-until').value = src.repeat_until || '';
  const syncRepeatUI = () => {
    const cur = $('#ev-repeat .chip[aria-pressed="true"]')?.dataset.r || '';
    $('#ev-days-row').classList.toggle('hide', cur !== 'weekly');
    $('#ev-until-row').classList.toggle('hide', cur === '');
  };
  $$('#ev-repeat .chip').forEach(c => c.onclick = () => {
    $$('#ev-repeat .chip').forEach(x => x.setAttribute('aria-pressed','false'));
    c.setAttribute('aria-pressed','true'); syncRepeatUI();
  });
  $$('#ev-days .chip').forEach(c => c.onclick = () => {
    // multi-select: at least one day must stay on
    const on = c.getAttribute('aria-pressed') === 'true';
    if (on && $$('#ev-days .chip[aria-pressed="true"]').length === 1) return;
    c.setAttribute('aria-pressed', String(!on));
  });
  syncRepeatUI();

  const lead = src.lead_minutes !== undefined ? src.lead_minutes : (state.me?.default_lead_minutes ?? 30);
  $('#ev-lead').innerHTML = LEADS.map(l =>
    `<button type="button" class="chip" data-l="${l.v === null ? '' : l.v}" aria-pressed="${l.v === lead}">${l.l}</button>`).join('');
  $$('#ev-lead .chip').forEach(c => c.onclick = () => {
    $$('#ev-lead .chip').forEach(x => x.setAttribute('aria-pressed','false'));
    c.setAttribute('aria-pressed','true');
  });

  sheet.classList.add('on');
  setTimeout(() => $('#ev-title').focus(), 60);
}
function closeSheet(){ sheet.classList.remove('on'); state.editing = null; }

$('#ev-form').addEventListener('submit', async e => {
  e.preventDefault();
  const date = $('#ev-date').value, time = $('#ev-time').value;
  const whoBtn  = $('#ev-who .chip[aria-pressed="true"]');
  const leadBtn = $('#ev-lead .chip[aria-pressed="true"]');
  const repBtn  = $('#ev-repeat .chip[aria-pressed="true"]');
  const freq    = repBtn && repBtn.dataset.r !== '' ? repBtn.dataset.r : null;
  const days    = $$('#ev-days .chip[aria-pressed="true"]').map(c => +c.dataset.d);

  const payload = {
    id: state.editing?.id || null,
    title: $('#ev-title').value.trim(),
    notes: $('#ev-notes').value.trim() || null,
    all_day: !time, event_date: date,
    starts_at: time ? new Date(`${date}T${time}:00`).toISOString() : null,
    ends_at: null,
    member_id: whoBtn?.dataset.w || null,
    lead_minutes: leadBtn && leadBtn.dataset.l !== '' ? +leadBtn.dataset.l : null,
    repeat_freq: freq,
    repeat_interval: 1,
    repeat_days: freq === 'weekly' ? days : [],
    repeat_until: freq ? ($('#ev-until').value || null) : null,
    source: 'web'
  };
  if (!payload.title) return;

  try {
    const series = state.editing;
    const occ = state.editingOccurrence;
    // Editing one date out of a series is the common case (a one-off time change,
    // or a cancelled week) so ask rather than guess.
    if (series && series.is_occurrence && occ) {
      const scope = await askScope('This is a repeating event',
        `${describeRepeat(series)}. Apply your changes to which ones?`);
      if (!scope) return;
      if (scope === 'one')    await applyOne(series, occ, payload);
      else if (scope === 'future') {
        await truncateSeries(series, occ);
        await DB.saveEvent({ ...payload, id: null });
      } else {
        await DB.saveEvent({ ...payload, id: series.id });
      }
      if (state.demo) { /* demo state already mutated */ } else await DB.loadEvents();
    } else {
      await DB.saveEvent(payload);
    }
    closeSheet(); render(); toast(state.editing ? 'Saved' : 'Added');
  } catch (err) { console.error(err); toast('Could not save'); }
});

$('#ev-del').onclick = async () => {
  const series = state.editing, occ = state.editingOccurrence;
  if (!series) return;
  try {
    if (series.is_occurrence && occ) {
      const scope = await askScope('Remove a repeating event',
        `${describeRepeat(series)}. Which ones should come off the calendar?`);
      if (!scope) return;
      if (scope === 'one')         { await skipOne(series, occ); toast('Skipped that one'); }
      else if (scope === 'future') { await truncateSeries(series, occ); toast('Ended the series'); }
      else                         { await DB.deleteEvent(series.id); toast('Deleted'); }
      if (!state.demo) await DB.loadEvents();
      else if (scope === 'all') state.events = state.events.filter(e => e.id !== series.id);
    } else {
      await DB.deleteEvent(series.id); toast('Deleted');
    }
    closeSheet(); render();
  } catch (err) { console.error(err); toast('Could not remove'); }
};


/* ==========================================================================
 * RECURRING EDITS — the three-way choice
 *   one    -> write an exception row for that date only
 *   future -> end the old series the day before, start a new one
 *   all    -> edit the series row itself
 * "future" is a split rather than an in-place edit because history matters:
 * changing a series retroactively would rewrite events that already happened.
 * ========================================================================*/
const scopeSheet = $('#scope');
$$('[data-close-scope]').forEach(x => x.onclick = () => { scopeSheet.classList.remove('on'); state.pendingScope = null; });

function askScope(title, sub){
  return new Promise(resolve => {
    $('#scope-title').textContent = title;
    $('#scope-sub').textContent = sub;
    scopeSheet.classList.add('on');
    const done = v => { scopeSheet.classList.remove('on'); resolve(v); };
    $$('#scope [data-scope]').forEach(b => b.onclick = () => done(b.dataset.scope));
    $$('#scope [data-close-scope]').forEach(b => b.onclick = () => done(null));
  });
}

async function applyOne(series, occDate, payload){
  if (state.demo) {
    state.exceptions = state.exceptions.filter(x => !(x.event_id===series.id && x.occurrence_date===occDate));
    state.exceptions.push({ event_id:series.id, occurrence_date:occDate, action:'override',
      title:payload.title, starts_at:payload.starts_at, member_id:payload.member_id, notes:payload.notes });
    return;
  }
  await state.db.from('event_exceptions').upsert({
    household_id: CONFIG.HOUSEHOLD_ID, event_id: series.id, occurrence_date: occDate,
    action: 'override', title: payload.title, starts_at: payload.starts_at,
    ends_at: payload.ends_at, member_id: payload.member_id, notes: payload.notes,
    created_by: state.me?.id ?? null
  }, { onConflict: 'event_id,occurrence_date' });
}

async function skipOne(series, occDate){
  if (state.demo) {
    state.exceptions = state.exceptions.filter(x => !(x.event_id===series.id && x.occurrence_date===occDate));
    state.exceptions.push({ event_id:series.id, occurrence_date:occDate, action:'skip' });
    return;
  }
  await state.db.from('event_exceptions').upsert({
    household_id: CONFIG.HOUSEHOLD_ID, event_id: series.id, occurrence_date: occDate,
    action: 'skip', created_by: state.me?.id ?? null
  }, { onConflict: 'event_id,occurrence_date' });
  // a skipped date must not still fire a reminder
  await state.db.from('reminders').delete()
    .eq('event_id', series.id).eq('occurrence_date', occDate).is('sent_at', null);
}

/** End the current series the day before `fromDate`. */
async function truncateSeries(series, fromDate){
  const until = addDaysS(fromDate, -1);
  if (state.demo) { const s = state.events.find(e=>e.id===series.id); if (s) s.repeat_until = until; return; }
  await state.db.from('events').update({ repeat_until: until }).eq('id', series.id);
  await state.db.from('reminders').delete()
    .eq('event_id', series.id).gte('occurrence_date', fromDate).is('sent_at', null);
}

/* ==========================================================================
 * SETTINGS SHEET
 * ========================================================================*/
const settings = $('#settings');
$('#me').onclick = openSettings;
$$('[data-close-settings]').forEach(x => x.onclick = closeSettings);
$('#set-done').onclick = closeSettings;
$$('#theme-seg button').forEach(b => b.onclick = () => applyTheme(b.dataset.theme));

$('#set-switch').onclick = () => {
  try { localStorage.removeItem('fh.me'); } catch {}
  location.reload();
};

function openSettings(){
  applyTheme(getTheme());                       // refresh the pressed state + hint
  const cur = state.me?.default_lead_minutes ?? 30;
  $('#set-lead').innerHTML = LEADS.map(l =>
    `<button type="button" class="chip" data-l="${l.v === null ? '' : l.v}" aria-pressed="${l.v === cur}">${l.l}</button>`).join('');
  $$('#set-lead .chip').forEach(c => c.onclick = async () => {
    $$('#set-lead .chip').forEach(x => x.setAttribute('aria-pressed','false'));
    c.setAttribute('aria-pressed','true');
    const v = c.dataset.l === '' ? null : +c.dataset.l;
    state.me.default_lead_minutes = v;
    if (!state.demo) {
      await state.db.from('members').update({ default_lead_minutes: v ?? 0 }).eq('id', state.me.id);
    }
    toast('Default reminder saved');
  });
  settings.classList.add('on');
}
function closeSettings(){ settings.classList.remove('on'); }

/* ==========================================================================
 * WEB PUSH
 * Apple's rule: push only works from the installed home-screen app, never
 * from a Safari tab. So we detect standalone mode and explain accordingly.
 * ========================================================================*/
const standalone = () => window.matchMedia('(display-mode: standalone)').matches
                      || window.navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent);

async function initPush(){
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('SW failed', e); }
  }
  if (state.demo) return;                       // don't stack banners over the demo notice
  const b = $('#banner');
  if (isIOS() && !standalone()) {
    b.innerHTML = `<b>Turn on reminders:</b> tap the Share button below, then <b>Add to Home Screen</b>. ` +
                  `Alerts only work from the home-screen icon — that's an Apple rule, not ours.`;
    b.classList.remove('hide'); return;
  }
  if (!('Notification' in window) || !('PushManager' in window)) return;
  if (Notification.permission === 'granted') return;
  if (Notification.permission === 'denied') return;

  b.innerHTML = `<b>Reminders are off.</b> Turn them on to get alerts before events.
                 <button id="push-on" style="margin-left:6px;border:0;background:transparent;
                 font-weight:700;text-decoration:underline;color:inherit">Turn on</button>`;
  b.classList.remove('hide');
  $('#push-on').onclick = enablePush;   // must be inside a user gesture — iOS requires it
}

async function enablePush(){
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Reminders stay off'); return; }
    $('#banner').classList.add('hide');
    if (state.demo || !CONFIG.VAPID_PUBLIC) { toast('Reminders on (demo)'); return; }

    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64(CONFIG.VAPID_PUBLIC)
    });
    const j = sub.toJSON();
    await state.db.from('push_subscriptions').upsert({
      household_id: CONFIG.HOUSEHOLD_ID, member_id: state.me.id,
      endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth,
      user_agent: navigator.userAgent
    }, { onConflict: 'endpoint' });
    toast('Reminders on');
  } catch (err) { console.error(err); toast('Could not turn on reminders'); }
}

function urlB64(s){
  const p = '='.repeat((4 - s.length % 4) % 4);
  const b = atob((s + p).replace(/-/g,'+').replace(/_/g,'/'));
  return Uint8Array.from([...b].map(c => c.charCodeAt(0)));
}

/* ==========================================================================
 * DAY ROLLOVER
 *
 * "Today" was resolved once, at load. On a phone that is never closed — which
 * is exactly what a home-screen icon encourages — the app would still be
 * showing yesterday's date and yesterday's agenda the next morning, with no
 * hint anything was stale.
 *
 * Re-render whenever the app comes back to the foreground AND the calendar day
 * has actually changed. Gating on the date means waking the phone fifty times
 * in an afternoon costs nothing. The one-minute timer is the backstop for a
 * screen left on across midnight, where no visibility event ever fires.
 * ======================================================================== */
let lastDay = ymd(new Date());
function checkRollover(){
  const today = ymd(new Date());
  if (today === lastDay) return;
  lastDay = today;
  state.cursor = today;                    // a YYYY-MM-DD string, not a Date
  render();
}
document.addEventListener('visibilitychange', () => {
  // The list changes under you while someone else shops. Re-read on return.
  if (document.visibilityState === 'visible' && state.module === 'shopping' && !state.demo) {
    SHOP.load().then(render);
  }
  if (!document.hidden) checkRollover();
});
window.addEventListener('focus', checkRollover);
setInterval(checkRollover, 60_000);

boot();
