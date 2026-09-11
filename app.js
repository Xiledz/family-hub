/* ============================================================================
 * Family Hub — application
 * No build step. Native ES modules, loaded straight from GitHub Pages.
 * ==========================================================================*/
import { CONFIG, isDemo } from './config.js';
import { parseQuickAdd, describe, parseShopping, parseTodo, parseIngredient, splitIngredientBlock,
         parseSeason, looksLikeSeason, splitSeasonLines } from './parse.js';
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

const APP_BUILD = '2026-09-11f';

const state = {
  db: null, demo: isDemo(),
  household: null, members: [], events: [], exceptions: [], me: null,
  module: 'calendar', view: 'today', cursor: null,   // cursor = the date each view is centred on
  editing: null, editingOccurrence: null, parsed: null, pendingScope: null,
  // shopping
  stores: [], shopItems: [], shopCatalog: [], shopAisles: [], shopStore: null, shopCats: [],
  // meals
  recipes: [], meals: [], mealWeek: null, importing: null
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
      location: e.location || null,
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
  const ver = $('#ver'); if (ver) ver.textContent = 'v' + APP_BUILD;

  if (state.module === 'shopping') { $('#viewbar').classList.add('hide'); return renderShopping(); }
  if (state.module === 'todos')    { $('#viewbar').classList.add('hide'); return renderTodos(); }
  if (state.module === 'meals')    { $('#viewbar').classList.add('hide'); return renderMeals(); }
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
          <div class="trow${EV.isDone(e) ? ' evdone' : ''}" style="--c:${colorOf(e.member_id)}">
            <button class="tick" data-evtick="${e.id}" aria-label="Done">${EV.isDone(e) ? '✓' : ''}</button>
            <button class="trowbody" data-ev="${e.id}">
              <span class="ttime">${timeOf(e)}</span>
              <span class="body"><span class="ttitle">${esc(e.title)}</span><span class="twho">${esc(whoOf(e))}</span></span>
              ${e.lead_minutes != null ? `<span class="bell" title="Reminder ${leadLabel(e.lead_minutes)} before">&#9201;</span>` : ''}
            </button>
          </div>`).join('')
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
  $$('[data-evtick]').forEach(b => b.onclick = e => { e.stopPropagation(); EV.toggle(b.dataset.evtick); });
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


/* ==========================================================================
 * TO-DO
 *
 * The third kind of thing. An event has a clock; a shopping item has a
 * store; a to-do has neither — just somebody who owes it and, sometimes, a
 * day it is wanted by. Most of what a household owes has no time at all:
 * the fence, the filter, the thank-you note. Those are not events and
 * pretending they are is how a calendar fills up with things that never
 * happen at the hour they claim.
 *
 * Order is the priority. Erich chose drag-to-reorder over high/medium/low,
 * and he was right: a priority field is one nobody fills in, and once half
 * the list is unset the sort stops meaning anything. Position is a number
 * the hand sets. Due dates are badges, never sort keys — a list that
 * silently re-sorts itself is not a list anyone trusts.
 *
 * Everyone's is their own. The person chips switch whose list you are
 * looking at; "House" is the shared one, which shows up on everybody's.
 * ======================================================================== */

/* ==========================================================================
 * CHECKING AN EVENT OFF
 *
 * A one-off thing that has happened should not sit on the calendar looking
 * exactly like one that has not. That is the difference between a calendar
 * you trust and one you scroll past.
 *
 * A single event carries done_at. An OCCURRENCE of a recurring event cannot —
 * ticking this Tuesday's practice must not mark every Tuesday — so that
 * writes an event_exceptions row for the one date, which is the same
 * mechanism a skipped or moved occurrence already uses.
 * ======================================================================== */
const EV = {
  /* The date being ticked is the occurrence on screen, not "today" — you can
     be looking at next Tuesday. */
  dateOf(e){ return e.occurrence_date || e.event_date || ymd(new Date()); },

  isDone(e){
    if (e.repeat_freq) {
      const d = EV.dateOf(e);
      return (state.evDone || []).some(x => x.event_id === e.id && x.occurrence_date === d);
    }
    return !!e.done_at;
  },

  async loadDone(){
    if (state.demo) { state.evDone = []; return; }
    const { data } = await state.db.from('event_done')
      .select('event_id, occurrence_date').eq('household_id', CONFIG.HOUSEHOLD_ID);
    state.evDone = data || [];
  },

  async toggle(id){
    const e = state.events.find(x => x.id === id); if (!e) return;
    const done = !EV.isDone(e);

    if (e.repeat_freq) {
      const d = EV.dateOf(e);
      if (done) {
        await state.db.from('event_done').upsert({
          household_id: CONFIG.HOUSEHOLD_ID, event_id: id, occurrence_date: d,
          done_by: state.me?.id || null
        }, { onConflict: 'event_id,occurrence_date' });
        state.evDone = [...(state.evDone||[]), { event_id: id, occurrence_date: d }];
      } else {
        await state.db.from('event_done').delete()
          .eq('event_id', id).eq('occurrence_date', d);
        state.evDone = (state.evDone||[]).filter(x =>
          !(x.event_id === id && x.occurrence_date === d));
      }
      render(); return;
    }

    e.done_at = done ? new Date().toISOString() : null;      // optimistic
    render();
    await state.db.from('events').update({
      done_at: e.done_at, done_by: done ? (state.me?.id || null) : null
    }).eq('id', id);
  }
};

const TODO = {
  async load(){
    if (state.demo) { state.todos = state.todos || []; return; }
    const { data, error } = await state.db.from('todos')
      .select('*')
      .eq('household_id', CONFIG.HOUSEHOLD_ID)
      .is('deleted_at', null).is('cleared_at', null)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) { console.warn('todos load failed', error); return; }
    state.todos = data || [];
  },

  /* New things go to the TOP. A default of 0 would drop them into the
     middle of a ranked list, which is the one place nobody looks. */
  topOf(assigneeId){
    const mine = (state.todos || []).filter(t =>
      !t.completed_at && (t.assignee_id ?? null) === (assigneeId ?? null));
    return mine.length ? Math.min(...mine.map(t => t.sort_order)) - 1000 : 0;
  },

  async add(text){
    const who = state.todoWho === 'house' ? null : (state.todoWho || state.me?.id || null);
    const p = parseTodo(text, {
      members: state.members.map(m => ({ name: m.name, aliases: m.aliases || [] })),
      now: new Date(), me: state.me?.name
    });
    if (!p.title) { toast('What needs doing?'); return; }

    const idOf = n => (state.members.find(m =>
      m.name.toLowerCase() === String(n).toLowerCase()) || {}).id || null;

    /* Named people win over the chip you happen to be looking at: typing
       "Bryce clean room" while on your own list means Bryce. */
    let targets = p.house ? [null]
                : p.assignees.length ? p.assignees.map(idOf).filter(Boolean)
                : [who];
    if (!targets.length) targets = [who];

    const batch = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    const rows = targets.map(mid => ({
      household_id: CONFIG.HOUSEHOLD_ID, title: p.title,
      assignee_id: mid, assigned_by: state.me?.id || null, batch_id: batch,
      sort_order: TODO.topOf(mid), due_on: p.due_on, due_time: p.due_time,
      repeat_freq: p.repeat?.freq ?? null,
      repeat_interval: p.repeat?.interval ?? 1,
      repeat_days: p.repeat?.days ?? [],
      repeat_until: p.repeat?.until ?? null,
      source: 'web', created_by: state.me?.id || null
    }));

    const { error } = await state.db.from('todos').insert(rows);
    if (error) { console.error(error); toast('Could not save'); return; }
    await TODO.load(); render();
  },

  async toggle(id){
    const t = (state.todos || []).find(x => x.id === id); if (!t) return;
    const done = !t.completed_at;
    t.completed_at = done ? new Date().toISOString() : null;   // optimistic
    if (!done) t.missed_at = null;   // re-opened by hand: no longer "missed"
    render();
    await state.db.from('todos').update({
      completed_at: t.completed_at,
      completed_by: done ? (state.me?.id || null) : null,
      ...(done ? {} : { missed_at: null })
    }).eq('id', id);
    /* A repeating todo spawns its successor in a trigger, so the list has to
       come back from the server to see it. */
    await TODO.load(); render();
  },

  /* Hard delete, matching shopping: a to-do removed is a mistake, not a
     completion. "Clear done" is the recoverable one. */
  async remove(id){
    state.todos = (state.todos || []).filter(t => t.id !== id); render();
    await state.db.from('todos').delete().eq('id', id);
  },

  async clearDone(){
    const ids = (state.todos || []).filter(t => t.completed_at).map(t => t.id);
    if (!ids.length) return;
    await state.db.from('todos')
      .update({ cleared_at: new Date().toISOString() }).in('id', ids);
    await TODO.load(); render();
  },

  /* Drop `id` immediately before `beforeId` (or at the end when null).
     Sparse doubles mean one write per drag instead of renumbering the list;
     when two neighbours get too close to split, renumber that person's rows
     in thousands and carry on. */
  async move(id, beforeId){
    const list = TODO.visible().filter(t => !t.completed_at);
    const moving = list.find(t => t.id === id); if (!moving) return;
    const rest = list.filter(t => t.id !== id);
    const at = beforeId ? rest.findIndex(t => t.id === beforeId) : rest.length;
    const prev = at > 0 ? rest[at - 1].sort_order : null;
    const next = at < rest.length ? rest[at].sort_order : null;

    let pos;
    if (prev === null && next === null) pos = 0;
    else if (prev === null) pos = next - 1000;
    else if (next === null) pos = prev + 1000;
    else pos = (prev + next) / 2;

    if (prev !== null && next !== null && Math.abs(next - prev) < 1e-6) {
      const renum = rest.slice(); renum.splice(at, 0, moving);
      for (let i = 0; i < renum.length; i++) {
        renum[i].sort_order = i * 1000;
        await state.db.from('todos').update({ sort_order: i * 1000 }).eq('id', renum[i].id);
      }
      await TODO.load(); render(); return;
    }

    moving.sort_order = pos; render();                        // optimistic
    await state.db.from('todos').update({ sort_order: pos }).eq('id', id);
    await TODO.load(); render();
  },

  /* Whose list is on screen: their own rows plus anything shared. */
  visible(){
    const who = state.todoWho ?? state.me?.id ?? null;
    return (state.todos || []).filter(t =>
      who === 'house' ? t.assignee_id === null
                      : (t.assignee_id === who || t.assignee_id === null));
  }
};

function renderTodos(){
  if (state.todoWho === undefined) state.todoWho = state.me?.id ?? null;
  $('#qa').classList.add('hide');

  const rows  = TODO.visible();
  const open  = rows.filter(t => !t.completed_at)
                    .sort((a,b) => a.sort_order - b.sort_order);
  const done  = rows.filter(t =>  t.completed_at);
  const today = ymd(new Date());

  const chips = [
    ...state.members.map(m => ({ id: m.id, name: m.name, color: m.color })),
    { id: 'house', name: 'House', color: '#6b7280' }
  ].map(c => `<button class="pchip${state.todoWho === c.id ? ' on' : ''}" data-who="${c.id}"
      style="--c:${c.color || '#888'}">${esc(c.name)}</button>`).join('');

  const hhmm = t => {
    if (!t.due_time) return '';
    const [h, mi] = String(t.due_time).split(':').map(Number);
    const ap = h < 12 ? 'am' : 'pm';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return ` ${h12}${mi ? ':' + String(mi).padStart(2,'0') : ''}${ap}`;
  };

  const badge = t => {
    if (!t.due_on) return '';
    if (t.due_on <  today) {
      const d = Math.round((new Date(today) - new Date(t.due_on)) / 86400000);
      return `<span class="tbadge late">${d}d late${hhmm(t)}</span>`;
    }
    if (t.due_on === today) return `<span class="tbadge today">Today${hhmm(t)}</span>`;
    return `<span class="tbadge">${new Date(t.due_on + 'T12:00:00Z')
      .toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'})}${hhmm(t)}</span>`;
  };

  /* A recurring chore closed by the DATE rather than by a person — its next
     occurrence came due while it was still open. It sits in Done with a red
     badge instead of a tick, so a missed week is visible and "Clear done"
     sweeps it like anything else. */
  const item = t => `
    <li class="todo${t.completed_at ? ' done' : ''}" data-id="${t.id}">
      <span class="grip" data-grip aria-hidden="true">⋮⋮</span>
      <button class="tick" data-tick="${t.id}" aria-label="Done">${t.completed_at ? (t.missed_at ? '✕' : '✓') : ''}</button>
      <span class="tt">${esc(t.title)}${t.assignee_id === null
        ? ' <span class="tbadge shared">Shared</span>' : ''}${t.missed_at
        ? ' <span class="tbadge late">Missed</span>' : badge(t)}
        ${t.repeat_freq ? '<span class="tbadge rep">repeats</span>' : ''}</span>
      <button class="tx" data-del="${t.id}" aria-label="Remove">×</button>
    </li>`;

  $('#bento').innerHTML = `
    <div class="col">
      <section class="card">
        <div class="pchips">${chips}</div>
        <form id="tadd" class="tadd">
          <input id="tin" placeholder="Something that needs doing…" autocomplete="off">
          <button>Add</button>
        </form>
        ${open.length
          ? `<ul class="todos" id="tlist">${open.map(item).join('')}</ul>
             <p class="hint">Hold the ⋮⋮ handle to drag. Order is the priority.</p>`
          : `<p class="hint" style="padding:18px 2px">Nothing on this list.</p>`}
        ${done.length
          ? `<div class="tdone"><b>Done</b>
               <button class="link" id="tclear">Clear done</button></div>
             <ul class="todos">${done.map(item).join('')}</ul>` : ''}
      </section>
    </div>`;

  $$('[data-who]').forEach(b => b.onclick = () => {
    state.todoWho = b.dataset.who === 'house' ? 'house' : b.dataset.who;
    render();
  });
  $('#tadd').onsubmit = e => {
    e.preventDefault();
    const v = $('#tin').value.trim(); if (!v) return;
    $('#tin').value = ''; TODO.add(v);
  };
  $$('[data-tick]').forEach(b => b.onclick = () => TODO.toggle(b.dataset.tick));
  $$('[data-del]').forEach(b => b.onclick = () => TODO.remove(b.dataset.del));
  if ($('#tclear')) $('#tclear').onclick = () => TODO.clearDone();
  if ($('#tlist')) bindDrag($('#tlist'));
}

/* Drag, on a phone.
 *
 * HTML5 drag-and-drop does not work by touch on iOS in any way worth
 * shipping — it fights text selection and gives no control over the ghost.
 * Pointer Events do, and the same code serves a mouse on the desktop.
 *
 * The handle is the only draggable part (`touch-action:none` on the grip,
 * `pan-y` on the row) so the list still scrolls normally under a thumb. A
 * 250ms hold starts the drag, which is what stops an ordinary tap-scroll
 * from picking a row up by accident. */
function bindDrag(list){
  let timer = null, drag = null;

  const rowsNow = () => [...list.querySelectorAll('.todo')];

  const start = (row, ev) => {
    const rect = row.getBoundingClientRect();
    const ghost = row.cloneNode(true);
    ghost.className = 'todo ghost';
    Object.assign(ghost.style, {
      position:'fixed', left:rect.left+'px', top:rect.top+'px',
      width:rect.width+'px', pointerEvents:'none', zIndex:'999'
    });
    document.body.appendChild(ghost);
    row.classList.add('lifted');
    drag = { row, ghost, dy: ev.clientY - rect.top, id: row.dataset.id };
    if (navigator.vibrate) navigator.vibrate(8);
  };

  const move = ev => {
    if (!drag) return;
    ev.preventDefault();
    drag.ghost.style.top = (ev.clientY - drag.dy) + 'px';
    /* Insert before the first row whose midpoint is below the pointer. */
    const others = rowsNow().filter(r => r !== drag.row);
    let before = null;
    for (const r of others) {
      const b = r.getBoundingClientRect();
      if (ev.clientY < b.top + b.height / 2) { before = r; break; }
    }
    if (before) list.insertBefore(drag.row, before);
    else list.appendChild(drag.row);
  };

  const end = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!drag) return;
    const d = drag; drag = null;
    d.ghost.remove(); d.row.classList.remove('lifted');
    const after = [...list.querySelectorAll('.todo')].map(r => r.dataset.id);
    const at = after.indexOf(d.id);
    await TODO.move(d.id, at + 1 < after.length ? after[at + 1] : null);
  };

  list.querySelectorAll('[data-grip]').forEach(g => {
    g.addEventListener('contextmenu', e => e.preventDefault());
    g.addEventListener('pointerdown', ev => {
      const row = ev.target.closest('.todo');
      ev.target.setPointerCapture?.(ev.pointerId);
      timer = setTimeout(() => start(row, ev), 250);
    });
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
  });
}


/* ==========================================================================
 * MEALS
 *
 * Recipes and the dinner countdown are one feature, and the object both
 * need is the MEAL. "Monday, tacos, ready by 5:55" is what pushes
 * ingredients onto the shopping list and what anchors the countdown, so it
 * is said once, here.
 *
 * WHERE RECIPES COME FROM
 *   A link, or a paste. A Pinterest pin is a pointer to a blog, and the
 *   recipe-import function follows that pointer itself — the pin's own
 *   structured data names the source — then reads the blog's recipe. So a
 *   pin link pasted straight from Pinterest's Share sheet is enough. Family
 *   recipes get pasted as text. Both land on the same confirm screen, and
 *   NOTHING is saved until somebody looks at it and taps.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *   A pantry. Knowing what is in the cupboard requires logging the can of
 *   beans you used, and nobody does, so it rots and then lies. What works is
 *   a have/need tap at plan time with sane defaults — staples default to
 *   "have", things bought lately default to "have?", the rest to "need".
 * ======================================================================== */
const MEAL = {
  async load(){
    if (state.demo) { state.recipes = []; state.meals = []; return; }
    const from = new Date(); from.setDate(from.getDate() - 7);
    const [r, m] = await Promise.all([
      state.db.from('recipes').select('*, recipe_ingredients(*), recipe_steps(*)')
        .eq('household_id', CONFIG.HOUSEHOLD_ID).is('deleted_at', null).order('name'),
      state.db.from('meal_plan').select('*, recipes(name, servings, cook_minutes, image_url)')
        .eq('household_id', CONFIG.HOUSEHOLD_ID).is('deleted_at', null)
        .gte('plan_date', ymd(from)).order('plan_date')
    ]);
    state.recipes = (r.data || []).map(x => ({
      ...x,
      recipe_ingredients: (x.recipe_ingredients || []).sort((a,b) => a.sort_order - b.sort_order),
      recipe_steps: (x.recipe_steps || []).sort((a,b) => b.minutes_before_cook - a.minutes_before_cook)
    }));
    state.meals = m.data || [];
    await MEAL.repairIngredients();
  },

  /* Rows saved by the old ingredient parser: ". black pepper" (a unit's full
     stop left on the name), "⅔ c. olive oil" (a mixed fraction half-read),
     "bag" with unit "gallon". The parser is JavaScript, so there is no SQL
     path to fix them — this re-runs parseIngredient on `original` for any
     row that shows the damage and writes back only what changed. Once per
     session; a clean table costs one pass and zero writes. New saves go
     through the fixed parser on the confirm screen, so this is for history. */
  _repaired: false,
  async repairIngredients(){
    if (MEAL._repaired || state.demo) return;
    MEAL._repaired = true;
    const damaged = /^[^a-z0-9]|[½⅓⅔¼¾⅛⅜⅝⅞]|^(?:tsp|tbsp?|c|cups?|oz|lbs?|g|kg|ml|l|pt|qt|gal(?:lon)?s?|pkg)\b\.?/i;
    let fixed = 0;
    for (const r of state.recipes) {
      for (const i of r.recipe_ingredients || []) {
        if (!i.original) continue;
        const bad = damaged.test(i.name || '') || (i.unit && /^(?:gallon|quart|pint)s?$/i.test(i.unit) && /\b(?:bag|jar|container)s?\b/i.test(i.name || ''));
        if (!bad) continue;
        /* catalog: [] on purpose — the household's memory of ". black
           pepper" is the damage, not the truth. */
        const p = parseIngredient(i.original, { catalog: [] });
        const patch = { name: p.name, qty: p.qty, unit: p.unit, note: p.note };
        const same = Object.keys(patch).every(k => (patch[k] ?? null) === (i[k] ?? null));
        if (same || !p.name) continue;
        const { error } = await state.db.from('recipe_ingredients').update(patch).eq('id', i.id);
        if (error) { console.warn('ingredient repair failed', i.id, error); continue; }
        const oldName = i.name;
        Object.assign(i, patch); fixed++;

        /* The category lives in shopping_catalog, keyed by name, and the
           damaged name taught it garbage (". black pepper" → produce, pick
           yourself). Teach the clean name, forget the damaged one. Only a
           name that shows the damage is dropped — never a row a person typed. */
        const clean = state.shopCatalog.find(c => c.name.toLowerCase() === p.name.toLowerCase());
        if (!clean) {
          await state.db.from('shopping_catalog').insert({
            household_id: CONFIG.HOUSEHOLD_ID, name: p.name, category: p.category,
            pick_yourself: !!p.pickYourself
          }).then(() => {}, () => {});
        } else if (clean.category === 'other' && p.category !== 'other') {
          await state.db.from('shopping_catalog').update({ category: p.category, pick_yourself: !!p.pickYourself })
            .eq('id', clean.id).then(() => {}, () => {});
        }
        if (oldName && damaged.test(oldName) && oldName.toLowerCase() !== p.name.toLowerCase()) {
          await state.db.from('shopping_catalog').delete()
            .eq('household_id', CONFIG.HOUSEHOLD_ID).eq('name', oldName).then(() => {}, () => {});
        }
      }
    }
    if (fixed) { console.info(`repaired ${fixed} recipe ingredient rows`); await SHOP.load(); }
  },

  /* ---- import: URL or paste, through the edge function ---------------- */
  async fetchDraft(input){
    const isUrl = /^https?:\/\/\S+$/i.test(input.trim());
    const body  = isUrl ? { url: input.trim() } : { text: input };
    const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/recipe-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 'Authorization': `Bearer ${CONFIG.SUPABASE_ANON}`, 'apikey': CONFIG.SUPABASE_ANON },
      body: JSON.stringify(body)
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.message || j.error || `import failed (${res.status})`);
    return j;
  },

  /* Turn a draft's ingredient strings into rows, through the same parser
     the shopping list uses so names line up with the catalog. */
  draftToRecipe(d){
    const ings = (d.ingredients || []).map((line, i) => {
      const p = parseIngredient(line, { catalog: state.shopCatalog });
      return { name: p.name, original: p.original, qty: p.qty, unit: p.unit,
               note: p.note, optional: p.optional, sort_order: i, category: p.category };
    });
    return {
      name: d.name || '', servings: d.servings ?? null,
      cook_minutes: d.cook_minutes ?? d.total_minutes ?? 30,
      prep_note: d.prep_minutes ? `Prep about ${d.prep_minutes} min` : null,
      instructions: d.instructions || [], image_url: d.image || null,
      source_url: d.source_url || null, source: d.method || 'manual',
      ingredients: ings, steps: []
    };
  },

  async saveRecipe(rec, existingId = null){
    const row = {
      household_id: CONFIG.HOUSEHOLD_ID, name: rec.name.trim(), servings: rec.servings || null,
      cook_minutes: rec.cook_minutes ?? 30, prep_note: rec.prep_note || null,
      instructions: rec.instructions || [], image_url: rec.image_url || null,
      source_url: rec.source_url || null, source: rec.source || 'manual',
      created_by: state.me?.id || null, updated_at: new Date().toISOString()
    };
    let id = existingId;
    if (id) {
      const { error } = await state.db.from('recipes').update(row).eq('id', id);
      if (error) throw error;
      await state.db.from('recipe_ingredients').delete().eq('recipe_id', id);
      await state.db.from('recipe_steps').delete().eq('recipe_id', id);
    } else {
      const { data, error } = await state.db.from('recipes').insert(row).select('id').single();
      if (error) throw error;
      id = data.id;
    }
    const ings = (rec.ingredients || []).filter(i => i.name).map((i, k) => ({
      recipe_id: id, name: i.name, original: i.original || i.name, qty: i.qty ?? null,
      unit: i.unit || null, note: i.note || null, optional: !!i.optional, sort_order: k
    }));
    if (ings.length) { const { error } = await state.db.from('recipe_ingredients').insert(ings); if (error) throw error; }
    const steps = (rec.steps || []).filter(s => s.label && s.minutes_before_cook >= 0).map((s, k) => ({
      recipe_id: id, label: s.label, minutes_before_cook: +s.minutes_before_cook, sort_order: k
    }));
    if (steps.length) { const { error } = await state.db.from('recipe_steps').insert(steps); if (error) throw error; }
    /* Teach the catalog anything new, same guard as the shopping list. */
    for (const i of ings) {
      if (state.shopCatalog.find(c => c.name.toLowerCase() === i.name.toLowerCase())) continue;
      const src = (rec.ingredients || []).find(x => x.name === i.name);
      await state.db.from('shopping_catalog').insert({
        household_id: CONFIG.HOUSEHOLD_ID, name: i.name, category: src?.category || 'other'
      }).then(() => {}, () => {});
    }
    await SHOP.load(); await MEAL.load();
    return id;
  },

  async deleteRecipe(id){
    await state.db.from('recipes').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    await MEAL.load(); render();
  },

  /* ---- planning --------------------------------------------------------- */
  /* Who cooks when nobody says: the household default (Jess), then whoever
     is planning. The planner used to be the cook automatically, which put
     the thaw alert on the person at a desk instead of the person in the
     kitchen. materialize_meal_reminders applies the same fallback. */
  defaultCook(){
    return state.household?.default_cook_id || state.me?.id || null;
  },

  async plan(date, recipeId, opts = {}){
    const row = {
      household_id: CONFIG.HOUSEHOLD_ID, plan_date: date, slot: 'dinner',
      recipe_id: recipeId || null, freeform: recipeId ? null : (opts.freeform || 'Dinner'),
      servings: opts.servings ?? (state.household?.default_servings ?? 4),
      ready_by: opts.ready_by || null,
      cook_id: opts.cook_id !== undefined ? opts.cook_id : MEAL.defaultCook(),
      created_by: state.me?.id || null
    };
    /* One dinner per day is a PARTIAL unique index (deleted_at is null), and
       ON CONFLICT cannot infer a partial index without its predicate — so
       an upsert on those columns is refused by Postgres. Find, then update
       or insert. */
    const existing = state.meals.find(m => m.plan_date === date && m.slot === 'dinner' && !m.deleted_at);
    let data, error;
    if (existing) {
      ({ data, error } = await state.db.from('meal_plan').update(row).eq('id', existing.id).select('id').single());
    } else {
      ({ data, error } = await state.db.from('meal_plan').insert(row).select('id').single());
    }
    if (error) { console.error(error); toast('Could not plan that'); return null; }
    await MEAL.load(); render();
    return data.id;
  },

  /* Change the cook on a planned meal. The meal_resync trigger rebuilds the
     countdown for the new person, so nothing else needs doing here. */
  async setCook(id, memberId){
    const { error } = await state.db.from('meal_plan')
      .update({ cook_id: memberId || null }).eq('id', id);
    if (error) { console.error(error); toast('Could not change the cook'); return; }
    await MEAL.load();
  },

  async unplan(id){
    /* Un-bought items that came from this meal come off the list with it. */
    await state.db.from('shopping_items').delete().eq('meal_id', id).eq('got', false);
    await state.db.from('meal_plan').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    await SHOP.load(); await MEAL.load(); render();
  },

  async setMealDone(id, done){
    await state.db.from('meal_plan').update({
      done_at: done ? new Date().toISOString() : null, done_by: done ? (state.me?.id || null) : null
    }).eq('id', id);
    await MEAL.load(); render();
  },

  /* ---- have / need ------------------------------------------------------ */
  /* Default for one ingredient: staple → have; bought in the last N days →
     have (with the date shown); otherwise need. A hint, never a truth. */
  defaultHave(name){
    const cat = state.shopCatalog.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (cat?.staple) return { have: true, why: 'staple' };
    const recent = state.shopItems
      .filter(i => i.got && i.name.toLowerCase() === name.toLowerCase() && i.got_at)
      .sort((a,b) => new Date(b.got_at) - new Date(a.got_at))[0];
    if (recent) {
      const days = (Date.now() - new Date(recent.got_at)) / 86400000;
      const window = ['produce','meat','dairy','bakery','eggs'].includes(cat?.category) ? 7 : 45;
      if (days <= window) return { have: true, why: `bought ${Math.round(days)}d ago` };
    }
    return { have: false, why: null };
  },

  async scaledIngredients(mealId){
    const { data, error } = await state.db.rpc('meal_ingredients', { p_meal: mealId });
    if (error) { console.warn(error); return []; }
    return data || [];
  },

  /* The Need-to-buy list is for SHOPPING, and nobody buys "¼ tsp black
     pepper" — you buy black pepper. A spoon-sized unit, or a measured unit
     scaled to less than one, is dropped from the list quantity; countable
     and purchasable units (lb, oz, can, box, bag, bunch, a cup or more) are
     kept. The recipe's own amount still shows on the have/need row. */
  shopQty(i){
    if (i.qty == null) return null;
    const u = String(i.unit || '').toLowerCase();
    if (/^(?:tsp|teaspoons?|tbsp|tablespoons?|pinch(?:es)?|dash(?:es)?|sprinkle|splash|drizzle)$/.test(u)) return null;
    const measured = /^(?:cups?|oz|ounces?|fl\s*oz|lbs?|pounds?|g|grams?|kg|ml|l|liters?|litres?|pints?|quarts?|gallons?|sticks?)$/.test(u);
    if (measured && i.qty < 1) return null;
    return `${fmtQty(i.qty)}${u ? ' ' + u : ''}`;
  },

  async pushToList(mealId, need, dish = 'dinner'){
    /* need: [{name, qty, unit, category}] — dedupe on NAME alone. The list
       key elsewhere is store|name; a recipe push with a preferred store vs
       an existing row with none would otherwise make two rows for one thing.
       Every row says which dinner wanted it, so Jess knows why milk is on
       the list. */
    const live = new Map(state.shopItems.filter(i => !i.got && !i.cleared_at)
      .map(i => [i.name.toLowerCase(), i]));
    const rows = [];
    const why = `for ${dish}`;
    for (const n of need) {
      const key = n.name.toLowerCase();
      const cat = state.shopCatalog.find(c => c.name.toLowerCase() === key);
      const qtyText = MEAL.shopQty(n);
      if (live.has(key)) {
        /* Already on the list: fold the quantity into the note rather than
           make a second row. */
        const ex = live.get(key);
        if (ex.note && ex.note.includes(why)) continue;
        const note = [ex.note, qtyText ? `+${qtyText} ${why}` : why].filter(Boolean).join('; ');
        await state.db.from('shopping_items').update({ note }).eq('id', ex.id);
        continue;
      }
      rows.push({
        household_id: CONFIG.HOUSEHOLD_ID, store_id: cat?.store_id ?? null,
        name: n.name, qty: qtyText, category: cat?.category || n.category || 'other',
        note: [n.note, why].filter(Boolean).join('; '),
        pick_yourself: !!n.pickYourself, online_ok: !!n.onlineOk,
        added_by: state.me?.id || null, source: 'recipe', meal_id: mealId
      });
    }
    if (rows.length) {
      const { error } = await state.db.from('shopping_items').insert(rows);
      if (error) { console.error(error); toast('Could not add to the list'); return; }
    }
    await SHOP.load();
    toast(`${rows.length} added to the list`);
  },

  async setStaple(name, staple){
    await state.db.from('shopping_catalog').update({ staple })
      .eq('household_id', CONFIG.HOUSEHOLD_ID).eq('name', name);
    await SHOP.load();
  }
};

/* 1.5 → "1½", 0.25 → "¼", 2 → "2", 0.33 → "⅓" */
function fmtQty(q){
  if (q == null) return '';
  const whole = Math.floor(q), frac = q - whole;
  const F = [[0.125,'⅛'],[0.25,'¼'],[1/3,'⅓'],[0.375,'⅜'],[0.5,'½'],[0.625,'⅝'],[2/3,'⅔'],[0.75,'¾'],[0.875,'⅞']];
  const near = F.find(([v]) => Math.abs(frac - v) < 0.03);
  if (frac < 0.03) return String(whole);
  if (near) return (whole ? whole : '') + near[1];
  return String(Math.round(q * 100) / 100);
}

/* ---- the generic sheet ------------------------------------------------- */
const msheet = $('#msheet');
function openMSheet(title, html, bind){
  $('#msheet-title').textContent = title;
  $('#msheet-body').innerHTML = html;
  msheet.classList.add('on');
  if (bind) bind($('#msheet-body'));
}
function closeMSheet(){ msheet.classList.remove('on'); $('#msheet-body').innerHTML = ''; }
if (msheet) msheet.querySelector('[data-mclose]').onclick = closeMSheet;

/* ---- rendering ---------------------------------------------------------- */
function renderMeals(){
  $('#qa').classList.add('hide');
  const today = ymd(new Date());
  if (!state.mealWeek) { const d = new Date(); d.setDate(d.getDate() - d.getDay()); state.mealWeek = ymd(d); }
  const start = new Date(state.mealWeek + 'T12:00:00');
  const days = [...Array(7)].map((_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return ymd(d); });

  const mealOn = d => state.meals.find(m => m.plan_date === d && m.slot === 'dinner');
  const dayRow = d => {
    const m = mealOn(d);
    const lbl = new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
    const title = m ? (m.recipes?.name || m.freeform) : '';
    return `<div class="mday${d === today ? ' today' : ''}${m?.done_at ? ' mdone' : ''}" data-day="${d}">
      <span class="mdate">${lbl}</span>
      ${m ? `<button class="mname" data-meal="${m.id}">${esc(title)}${m.ready_by ? `<small> · ${clock12(m.ready_by)}</small>` : ''}</button>
             <button class="tick" data-mealtick="${m.id}" aria-label="Done">${m.done_at ? '✓' : ''}</button>`
          : `<button class="mplan" data-plan="${d}">+ plan</button>`}
    </div>`;
  };

  const card = r => `<button class="rcard" data-recipe="${r.id}">
      ${r.image_url ? `<img src="${esc(r.image_url)}" alt="" loading="lazy">` : '<span class="rimg"></span>'}
      <span class="rname">${esc(r.name)}</span>
      <span class="rmeta">${r.servings ? `serves ${r.servings} · ` : ''}${r.cook_minutes} min${r.recipe_steps?.length ? ' · countdown' : ''}</span>
    </button>`;

  $('#bento').innerHTML = `
    <div class="col">
      <section class="card">
        <div class="ch"><span>This week</span>
          <span><button class="link" data-wk="-7">‹</button> <button class="link" data-wk="0">today</button> <button class="link" data-wk="7">›</button></span></div>
        ${days.map(dayRow).join('')}
      </section>
      <section class="card">
        <div class="ch"><span>Recipes</span><b>${state.recipes.length}</b></div>
        <form id="radd" class="tadd">
          <input id="rin" placeholder="Paste a recipe link, or type a name…" autocomplete="off">
          <button>Add</button>
        </form>
        <p class="hint">Pinterest: Share → <b>Copy link</b>, paste it here. Any recipe site works too. Family recipes: type the name, then paste the ingredients.</p>
        ${state.recipes.length ? `<div class="rgrid">${state.recipes.map(card).join('')}</div>` : ''}
      </section>
    </div>`;

  $$('[data-wk]').forEach(b => b.onclick = () => {
    if (b.dataset.wk === '0') { state.mealWeek = null; }
    else { const d = new Date(state.mealWeek + 'T12:00:00'); d.setDate(d.getDate() + (+b.dataset.wk)); state.mealWeek = ymd(d); }
    render();
  });
  $$('[data-plan]').forEach(b => b.onclick = () => openPlanSheet(b.dataset.plan));
  $$('[data-meal]').forEach(b => b.onclick = () => openMealSheet(b.dataset.meal));
  $$('[data-mealtick]').forEach(b => b.onclick = () => {
    const m = state.meals.find(x => x.id === b.dataset.mealtick); MEAL.setMealDone(m.id, !m.done_at);
  });
  $$('[data-recipe]').forEach(b => b.onclick = () => openRecipeSheet(b.dataset.recipe));
  $('#radd').onsubmit = async e => {
    e.preventDefault();
    const v = $('#rin').value.trim(); if (!v) return;
    $('#rin').value = '';
    await startImport(v);
  };
}

const clock12 = t => { const [h, m] = String(t).split(':').map(Number);
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2,'0') : ''}${h < 12 ? 'am' : 'pm'}`; };

/* A link → fetch a draft. A name → an empty draft to fill in. Either way,
   the confirm screen. */
async function startImport(input){
  const isUrl = /^https?:\/\/\S+$/i.test(input);
  if (isUrl) {
    toast('Reading the recipe…');
    try {
      const d = await MEAL.fetchDraft(input);
      openConfirmSheet(MEAL.draftToRecipe(d), d.method);
    } catch (err) {
      openConfirmSheet({ name: '', servings: null, cook_minutes: 30, instructions: [], ingredients: [],
                         steps: [], source_url: input, source: 'manual' }, 'none', String(err.message || err));
    }
  } else {
    openConfirmSheet({ name: input, servings: null, cook_minutes: 30, instructions: [],
                       ingredients: [], steps: [], source: 'manual' }, 'manual');
  }
}

/* The confirm screen. Nothing is saved until Save is tapped. */
function openConfirmSheet(rec, method, errMsg = null, existingId = null){
  const ingText = rec.ingredients.map(i => i.original || i.name).join('\n');
  const insText = (rec.instructions || []).join('\n');
  const stepRows = (rec.steps || []).map(s => `${s.label} | ${s.minutes_before_cook}`).join('\n');
  const how = { jsonld: 'Read from the page', microdata: 'Read from the page', heading: 'Read from the page (best guess)',
                paste: 'From your paste', manual: '', none: "Couldn't read the ingredients from this page — paste them below." }[method] || '';
  const html = `
    ${errMsg ? `<p class="warn">${esc(errMsg)}</p>` : ''}
    ${how ? `<p class="hint">${esc(how)}</p>` : ''}
    <div class="f"><label>Name</label><input id="c-name" value="${esc(rec.name || '')}"></div>
    <div class="frow">
      <div class="f"><label>Serves</label><input id="c-serv" type="number" min="1" max="100" value="${rec.servings ?? ''}" placeholder="—"></div>
      <div class="f"><label>Cook time (min)</label><input id="c-cook" type="number" min="0" value="${rec.cook_minutes ?? 30}"></div>
    </div>
    <div class="f"><label>Ingredients — one per line</label>
      <textarea id="c-ing" rows="8" placeholder="one ingredient per line">${esc(ingText)}</textarea></div>
    <div class="f"><label>Directions — one step per line</label>
      <textarea id="c-ins" rows="6" placeholder="one step per line">${esc(insText)}</textarea></div>
    <!-- Prep-ahead is the exception, not the rule. A snack has nothing to
         thaw. So this is folded away unless the recipe already has steps or
         someone opens it, and the example text was replaced: a grey
         "Take the beef out to thaw" on a cookie recipe read as real data. -->
    <details class="f" id="c-cd" ${stepRows ? 'open' : ''}>
      <summary>Prep ahead <small>(optional — thaw, marinate, preheat)</small></summary>
      <textarea id="c-steps" rows="3" placeholder="what to do  |  minutes before cooking starts">${esc(stepRows)}</textarea>
      <p class="hint">One per line, as <b>what | minutes</b>. Leave empty if nothing needs doing ahead.</p>
    </details>
    ${rec.source_url ? `<p class="hint">Source: <a href="${esc(rec.source_url)}" target="_blank" rel="noopener">${esc(rec.source_url.replace(/^https?:\/\//,'').slice(0,50))}</a></p>` : ''}
    <div class="actions">
      ${existingId ? `<button type="button" class="danger" id="c-del">Delete</button>` : ''}
      <button type="button" id="c-save" class="primary">Save recipe</button>
    </div>`;
  openMSheet(existingId ? 'Edit recipe' : 'New recipe', html, body => {
    body.querySelector('#c-save').onclick = async () => {
      const lines = splitIngredientBlock(body.querySelector('#c-ing').value);
      const ings  = lines.map((l, i) => { const p = parseIngredient(l, { catalog: state.shopCatalog });
        return { ...p, sort_order: i }; });
      const steps = body.querySelector('#c-steps').value.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
        const [label, mins] = l.split('|').map(x => x.trim());
        return { label, minutes_before_cook: parseInt(mins, 10) || 0 };
      }).filter(s => s.label);
      const out = {
        name: body.querySelector('#c-name').value, servings: +body.querySelector('#c-serv').value || null,
        cook_minutes: +body.querySelector('#c-cook').value || 30,
        instructions: body.querySelector('#c-ins').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean),
        image_url: rec.image_url, source_url: rec.source_url, source: rec.source,
        prep_note: rec.prep_note, ingredients: ings, steps
      };
      if (!out.name.trim()) { toast('Give it a name'); return; }
      try { await MEAL.saveRecipe(out, existingId); closeMSheet(); render(); toast('Saved'); }
      catch (e) { console.error(e); toast(e.message?.includes('recipes_source_url_uniq') ? 'That link is already saved' : 'Could not save'); }
    };
    const del = body.querySelector('#c-del');
    if (del) del.onclick = () => { if (confirm('Delete this recipe?')) { MEAL.deleteRecipe(existingId); closeMSheet(); } };
  });
}

/* A recipe, readable. This is the cookbook page: the directions live here. */
function openRecipeSheet(id){
  const r = state.recipes.find(x => x.id === id); if (!r) return;
  const html = `
    ${r.image_url ? `<img class="rhero" src="${esc(r.image_url)}" alt="">` : ''}
    <p class="rmeta">${r.servings ? `Serves ${r.servings} · ` : ''}${r.cook_minutes} min${r.prep_note ? ` · ${esc(r.prep_note)}` : ''}</p>
    <h3>Ingredients</h3>
    <ul class="ring">${r.recipe_ingredients.map(i => `<li>${esc(i.original || i.name)}${i.optional ? ' <small>(optional)</small>' : ''}</li>`).join('')}</ul>
    ${r.instructions?.length ? `<h3>Directions</h3><ol class="rins">${r.instructions.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
    ${r.recipe_steps?.length ? `<h3>Countdown</h3><ul class="ring">${r.recipe_steps.map(s => `<li>${esc(s.label)} <small>— ${s.minutes_before_cook} min before cooking</small></li>`).join('')}</ul>` : ''}
    ${r.source_url ? `<p class="hint"><a href="${esc(r.source_url)}" target="_blank" rel="noopener">View original</a></p>` : ''}
    <div class="actions">
      <button type="button" id="r-edit">Edit</button>
      <button type="button" id="r-plan" class="primary">Plan it</button>
    </div>`;
  openMSheet(r.name, html, body => {
    body.querySelector('#r-edit').onclick = () => openConfirmSheet({
      name: r.name, servings: r.servings, cook_minutes: r.cook_minutes, prep_note: r.prep_note,
      instructions: r.instructions || [], image_url: r.image_url, source_url: r.source_url, source: r.source,
      ingredients: r.recipe_ingredients, steps: r.recipe_steps
    }, r.source, null, r.id);
    body.querySelector('#r-plan').onclick = () => openPlanSheet(ymd(new Date()), r.id);
  });
}

/* Pick a recipe (or type "pizza night"), a day, how many, and when it needs
   to be on the table. That is the whole form. */
/* One chip per person; the pressed one cooks. Shared by the plan sheet and
   the meal sheet so the two never disagree about what a cook picker is. */
function cookChips(selectedId){
  return `<div class="chips" data-cooks>${state.members.map(m =>
    `<button type="button" class="chip" data-cook="${m.id}" aria-pressed="${selectedId === m.id}">
       <span class="dot" style="background:${m.color}"></span>${esc(m.name)}</button>`).join('')}</div>`;
}
function bindCookChips(body, onPick){
  body.querySelectorAll('[data-cook]').forEach(c => c.onclick = () => {
    body.querySelectorAll('[data-cook]').forEach(x => x.setAttribute('aria-pressed', 'false'));
    c.setAttribute('aria-pressed', 'true');
    if (onPick) onPick(c.dataset.cook);
  });
}
const pickedCook = body => body.querySelector('[data-cook][aria-pressed="true"]')?.dataset.cook || null;

/* How many to plan for. A batch recipe is made as a batch: a 16-serving
   tray of Fire Crackers planned "for 4" is a quarter tray of a snack, and a
   quarter teaspoon of pepper on the shopping list. When the recipe serves
   at least twice the household default, its own number wins. */
function defaultServings(recipe){
  const house = state.household?.default_servings ?? 4;
  if (recipe?.servings && recipe.servings >= 2 * house) return recipe.servings;
  return house;
}

function openPlanSheet(date, recipeId = null){
  const opts = state.recipes.map(r => `<option value="${r.id}"${r.id === recipeId ? ' selected' : ''}>${esc(r.name)}</option>`).join('');
  const html = `
    <div class="f"><label>Day</label><input id="p-date" type="date" value="${date}"></div>
    <div class="f"><label>What</label>
      <select id="p-recipe"><option value="">— something else —</option>${opts}</select>
      <input id="p-free" placeholder="e.g. pizza night, leftovers" style="margin-top:6px${recipeId ? ';display:none' : ''}"></div>
    <div class="frow">
      <div class="f"><label>For how many</label><input id="p-serv" type="number" min="1" value="${defaultServings(state.recipes.find(r => r.id === recipeId))}"></div>
      <div class="f"><label>On the table by</label><input id="p-ready" type="time" value="${state.household?.default_dinner_at?.slice(0,5) ?? '18:00'}"></div>
    </div>
    <div class="f"><label>Cook</label>${cookChips(MEAL.defaultCook())}</div>
    <p class="hint">The countdown — thaw, preheat, start cooking — goes to the cook. Set the time and it works backwards from it.</p>
    <div class="actions"><button type="button" id="p-go" class="primary">Plan dinner</button></div>`;
  openMSheet('Plan dinner', html, body => {
    const sel = body.querySelector('#p-recipe'), free = body.querySelector('#p-free');
    sel.onchange = () => {
      free.style.display = sel.value ? 'none' : '';
      body.querySelector('#p-serv').value = defaultServings(state.recipes.find(r => r.id === sel.value));
    };
    bindCookChips(body);
    body.querySelector('#p-go').onclick = async () => {
      const rid = sel.value || null;
      const id = await MEAL.plan(body.querySelector('#p-date').value, rid, {
        freeform: free.value.trim() || 'Dinner',
        servings: +body.querySelector('#p-serv').value || null,
        ready_by: body.querySelector('#p-ready').value || null,
        cook_id: pickedCook(body)
      });
      closeMSheet();
      if (id && rid) openMealSheet(id);          // straight to have/need
    };
  });
}

/* The meal: have/need, push to list, the countdown as it will fire. */
async function openMealSheet(id){
  const m = state.meals.find(x => x.id === id); if (!m) return;
  const r = state.recipes.find(x => x.id === m.recipe_id);
  const scaled = r ? await MEAL.scaledIngredients(id) : [];
  const factor = scaled[0]?.factor ?? 1;
  const { data: rem } = state.demo ? { data: [] } : await state.db.from('reminders')
    .select('label, fire_at, sent_at').eq('meal_id', id).order('fire_at');

  const rows = scaled.map((i, k) => {
    const d = MEAL.defaultHave(i.name);
    /* Name first, amount after in a muted span, so the names line up and read
       first — the amount is what the recipe uses, not what you buy. */
    const qty = i.qty != null ? ` <span class="hnqty">· ${fmtQty(i.qty)}${i.unit ? ' ' + i.unit : ''}${i.note ? `, ${esc(i.note)}` : ''}</span>` : (i.note ? ` <span class="hnqty">· ${esc(i.note)}</span>` : '');
    return `<label class="hn"><input type="checkbox" data-need="${k}" ${d.have ? '' : 'checked'}>
      <span class="hnname">${esc(i.name)}${qty}${i.optional ? ' <small>(optional)</small>' : ''}</span>
      <span class="hnwhy">${d.why ? esc(d.why) : ''}</span>
      <button type="button" class="staple${d.why === 'staple' ? ' on' : ''}" data-staple="${esc(i.name)}" title="We always have this">★</button>
    </label>`;
  }).join('');

  const when = x => new Date(x).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
  /* The cook as the server resolves it: the meal's, else the house default,
     else the planner. Shown so "who's got dinner" has an answer on the card. */
  const cookId = m.cook_id || MEAL.defaultCook() || m.created_by || null;
  const cook = state.members.find(x => x.id === cookId);
  const html = `
    <p class="rmeta">${new Date(m.plan_date + 'T12:00:00').toLocaleDateString('en-US',{weekday:'long', month:'short', day:'numeric'})}
      ${m.ready_by ? ` · on the table by ${clock12(m.ready_by)}` : ''}${m.servings ? ` · for ${m.servings}` : ''}
      ${factor !== 1 ? ` · <b>×${fmtQty(factor)}</b>` : ''}${cook ? ` · ${esc(cook.name)} cooks` : ''}</p>
    ${r ? `<h3>Need to buy <small>— tick what you don't have</small></h3><div class="hnlist">${rows}</div>
           <div class="actions"><button type="button" id="m-push" class="primary">Add checked to shopping list</button></div>` : ''}
    ${r ? `<h3>Cook <small>— the countdown goes to them</small></h3>${cookChips(cookId)}` : ''}
    ${rem?.length ? `<h3>Countdown</h3><ul class="ring">${rem.map(x => `<li${x.sent_at ? ' class="sent"' : ''}>${when(x.fire_at)} — ${esc(x.label || 'Start cooking')}</li>`).join('')}</ul>` : ''}
    ${r?.instructions?.length ? `<h3>Directions</h3><ol class="rins">${r.instructions.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
    <div class="actions">
      <button type="button" class="danger" id="m-unplan">Un-plan</button>
      ${r ? `<button type="button" id="m-recipe">Recipe</button>` : ''}
    </div>`;
  openMSheet(r?.name || m.freeform || 'Dinner', html, body => {
    const push = body.querySelector('#m-push');
    if (push) push.onclick = async () => {
      const need = [...body.querySelectorAll('[data-need]:checked')].map(cb => {
        const i = scaled[+cb.dataset.need];
        const ing = r.recipe_ingredients.find(x => x.name === i.name);
        const cat = state.shopCatalog.find(c => c.name.toLowerCase() === i.name.toLowerCase());
        /* recipe_ingredients has no category or pick columns; the catalog
           (by name) is the memory, and the parser is the fallback. */
        const fresh = cat ? null : parseIngredient(ing?.original || i.name, { catalog: [] });
        const pick = cat ? !!cat.pick_yourself : !!fresh?.pickYourself;
        return { name: i.name, qty: i.qty, unit: i.unit, note: i.note,
                 category: cat?.category || fresh?.category,
                 pickYourself: pick, onlineOk: !pick };
      });
      await MEAL.pushToList(id, need, r?.name || m.freeform || 'dinner'); closeMSheet(); render();
    };
    body.querySelectorAll('[data-staple]').forEach(b => b.onclick = async () => {
      const on = !b.classList.contains('on'); b.classList.toggle('on', on);
      await MEAL.setStaple(b.dataset.staple, on);
      const cb = b.closest('.hn').querySelector('input'); if (on) cb.checked = false;
    });
    body.querySelector('#m-unplan').onclick = () => { if (confirm('Un-plan this dinner? Un-bought items come off the list too.')) { MEAL.unplan(id); closeMSheet(); } };
    const rb = body.querySelector('#m-recipe'); if (rb) rb.onclick = () => openRecipeSheet(r.id);
    /* Changing the cook moves the countdown (trigger); reopen so it shows. */
    bindCookChips(body, async memberId => {
      await MEAL.setCook(id, memberId);
      toast(`Cook: ${state.members.find(x => x.id === memberId)?.name || '—'}`);
      openMealSheet(id);
    });
  });
}

/* ?import=<url> — the iOS share-sheet path. A one-action Shortcut ("Open
   URL: https://…/index.html?import=[Shortcut Input]") shows up in every
   share sheet, which is the same feeling as a native share target on a
   platform that does not offer one. */
function checkImportParam(){
  const u = new URL(location.href);
  const imp = u.searchParams.get('import');
  if (!imp) return;
  history.replaceState(null, '', location.pathname);      // don't re-import on reload
  state.module = 'meals';
  $$('#tabbar button').forEach(x => x.setAttribute('aria-current', String(x.dataset.mod === 'meals')));
  MEAL.load().then(() => { render(); startImport(imp); });
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
  if (state.module === 'todos')    await TODO.load();
  if (state.module === 'meals')    { await SHOP.load(); await MEAL.load(); }
  if (state.module === 'calendar') await EV.loadDone();
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

/* A PASTED SCHEDULE. The quick-add box is a single line and would flatten
   the newlines, so the paste itself is read: twenty dated lines under a
   header become one confirm sheet (openSeasonSheet), never twenty typed
   events. A pasted grocery list with no dates goes straight to the shopping
   list through SHOP.add, which already splits on newlines. Anything else
   pastes normally. */
qaIn.addEventListener('paste', e => {
  const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
  if (splitSeasonLines(text).length < 3) return;
  const opts = { members: state.members.map(m => ({ name: m.name, aliases: m.aliases || [] })),
                 now: new Date(), me: state.me?.name };
  if (looksLikeSeason(text, opts)) {
    e.preventDefault();
    openSeasonSheet(parseSeason(text, opts));
    return;
  }
  const probe = parseShopping(text, { stores: state.stores, catalog: state.shopCatalog });
  const known = probe.items.filter(i => i.category !== 'other').length;
  if (probe.items.length >= 3 && known * 2 >= probe.items.length) {
    e.preventDefault();
    SHOP.add(text).then(() => { toast(`Added to the shopping list`); });
  }
});

/* One confirm, many rows. Header: title, who, roles. Then every line with a
   tick — lines that could not be dated are shown unticked and greyed with
   their raw text, never guessed. Rows are one-off events (a schedule is
   irregular; that is why it was pasted), cast from the header, and no
   rides question follows: the header answered it once for all of them. */
function openSeasonSheet(season){
  const roleWord = { going: '', driving: 'drives', dropoff: 'takes', pickup: 'picks up', helping: 'helps', optional: 'maybe' };
  const who = (season.people || []).map(p =>
    `<span class="chip" aria-pressed="true" style="pointer-events:none">${esc(p.name)}${roleWord[p.role] ? ` · ${roleWord[p.role]}` : ''}</span>`).join(' ');
  const when = r => r.allDay ? 'All day'
    : `${clockLabel(r.start)}${r.end ? `–${clockLabel(r.end)}` : ''}`;
  const rows = season.rows.map((r, i) => r.ok
    ? `<label class="hn"><input type="checkbox" data-row="${i}" checked>
         <span class="hnname"><b>${esc(dayLabel(r.date))}</b> ${esc(when(r))}<br>${esc(r.title)}${r.location ? ` <small>@ ${esc(r.location)}</small>` : ''}${r.people?.length && r.people !== season.people ? ` <small>${esc(r.people.map(p => p.name).join(', '))}</small>` : ''}</span></label>`
    : `<label class="hn" style="opacity:.55"><input type="checkbox" data-row="${i}" disabled>
         <span class="hnname">${esc(r.raw)}<br><small>couldn't read a date — add it by hand</small></span></label>`).join('');
  const okCount = season.rows.filter(r => r.ok).length;
  const html = `
    <div class="f"><label>What</label><input id="s-title" value="${esc(season.title || '')}" placeholder="e.g. Orchestra rehearsals"></div>
    ${who ? `<div class="f"><label>Who</label><div class="chips">${who}</div></div>` : `<p class="hint">Nobody named — put "Addie, Jess driving" on the first line to set the cast for every row.</p>`}
    <div class="hnlist">${rows}</div>
    <div class="actions"><button type="button" id="s-go" class="primary">Add ${okCount}</button></div>`;
  openMSheet('Add a schedule', html, body => {
    const recount = () => {
      const n = body.querySelectorAll('[data-row]:checked').length;
      body.querySelector('#s-go').textContent = `Add ${n}`;
      body.querySelector('#s-go').disabled = n === 0;
    };
    body.querySelectorAll('[data-row]').forEach(cb => cb.onchange = recount);
    body.querySelector('#s-go').onclick = async () => {
      const title = body.querySelector('#s-title').value.trim();
      const picked = [...body.querySelectorAll('[data-row]:checked')].map(cb => season.rows[+cb.dataset.row]);
      body.querySelector('#s-go').disabled = true;
      let added = 0, failed = 0;
      for (const r of picked) {
        /* If the header title was edited on the sheet, rows that carried it
           down follow the edit; rows with their own words keep them. */
        const t = (season.title && r.title.startsWith(season.title) && title)
          ? title + r.title.slice(season.title.length) : (r.title || title || 'Untitled');
        const p = { title: t, allDay: r.allDay, date: r.date, start: r.start, end: r.end,
                    member: (r.people.find(x => x.role === 'going') || r.people[0])?.name ?? null,
                    people: r.people, leadMinutes: state.me?.default_lead_minutes ?? 30,
                    repeat: null, matched: [] };
        try { await DB.saveEvent({ ...parsedToEvent(p), source: 'season', location: r.location || null }); added++; }
        catch (err) { console.error(err); failed++; }
      }
      closeMSheet(); clearQA(); render();
      const skipped = season.rows.length - added;
      toast(`Added ${added}${skipped ? ` · skipped ${skipped}` : ''}${failed ? ` · ${failed} failed` : ''}`);
    };
  });
}

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

  /* The read-only .ics feed for grandparents and sitters. The token lives on
     the household row (migration 021) so the app can show the link; before
     that row has one, the row stays hidden rather than showing a dead URL. */
  const feedRow = $('#set-feed-row');
  const token = state.household?.feed_token;
  feedRow.hidden = !(token && !state.demo);
  if (!feedRow.hidden) {
    const url = `${CONFIG.SUPABASE_URL}/functions/v1/ics-feed?h=${CONFIG.HOUSEHOLD_ID}&t=${token}`;
    $('#set-feed').value = url;
    $('#set-feed-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(url); toast('Link copied'); }
      catch { $('#set-feed').select(); toast('Select the link and copy it'); }
    };
  }
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
  if (Notification.permission === 'denied') return;

  /* Permission granted is NOT the same as registered.
     This used to `return` right here, and that was the whole bug: permission
     is remembered by the browser forever, but the subscription lives in a
     database row that can go missing — the subscribe() call failed the first
     time, the server pruned the endpoint after a 410, the row was never
     written because the upsert lost the network. In every one of those cases
     the browser says "granted", the old code returned happy, and the device
     was silently unreachable with no way back: the banner never showed again,
     so the user could never retry.

     push_subscriptions has zero rows for this household. This is very likely
     why. Re-sync on every launch instead of trusting the permission flag. */
  if (Notification.permission === 'granted') {
    if (await syncPush()) return;
    /* Fall through to the banner. Something is wrong that a tap might fix. */
  }

  b.innerHTML = `<b>Reminders are off.</b> Turn them on to get alerts before events.
                 <button id="push-on" style="margin-left:6px;border:0;background:transparent;
                 font-weight:700;text-decoration:underline;color:inherit">Turn on</button>`;
  b.classList.remove('hide');
  $('#push-on').onclick = enablePush;   // must be inside a user gesture — iOS requires it
}

/* Make the database agree with what this browser actually has.
   Returns true only if this device is genuinely registered and recorded.

   Reuses the existing subscription when there is one, and creates one when
   permission is already granted but the subscription has gone. That second
   case needs no user gesture — the gesture was for requestPermission(), and
   that has already happened. */
async function syncPush(){
  if (state.demo || !CONFIG.VAPID_PUBLIC || !state.me) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64(CONFIG.VAPID_PUBLIC)
      });
    }
    const j = sub.toJSON();
    /* onConflict endpoint, so re-running this is free — and it re-points the
       device at whoever is signed in as "me" now, which is what you want on a
       personal phone. On a shared tablet the last person to open it owns the
       alerts; that is a real limitation, not an oversight. */
    const { error } = await state.db.from('push_subscriptions').upsert({
      household_id: CONFIG.HOUSEHOLD_ID, member_id: state.me.id,
      endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth,
      user_agent: navigator.userAgent
    }, { onConflict: 'endpoint' });
    if (error) { console.warn('push upsert failed', error); return false; }
    return true;
  } catch (err) {
    console.warn('push sync failed', err);
    return false;
  }
}

async function enablePush(){
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Reminders stay off'); return; }
    if (state.demo || !CONFIG.VAPID_PUBLIC) {
      $('#banner').classList.add('hide'); toast('Reminders on (demo)'); return;
    }
    if (await syncPush()) {
      $('#banner').classList.add('hide');
      toast('Reminders on');
    } else {
      /* Leave the banner up. Saying "on" when the row did not land is how a
         device ends up believing it is registered when nothing can reach it. */
      toast('Could not turn on reminders — try again');
    }
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
  if (document.visibilityState === 'visible' && state.module === 'todos' && !state.demo) {
    TODO.load().then(render);
  }
  if (document.visibilityState === 'visible' && state.module === 'meals' && !state.demo) {
    MEAL.load().then(render);
  }
  if (!document.hidden) checkRollover();
});
window.addEventListener('focus', checkRollover);
setInterval(checkRollover, 60_000);

boot();
