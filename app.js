/* ============================================================================
 * Family Hub — application
 * No build step. Native ES modules, loaded straight from GitHub Pages.
 * ==========================================================================*/
import { CONFIG, isDemo } from './config.js';
import { parseQuickAdd, describe } from './parse.js';

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const pad = n => String(n).padStart(2,'0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const EVERYONE = '#9a7b2f';

const LEADS = [
  {v:null,  l:'None'},   {v:0,   l:'At time'}, {v:10,  l:'10 min'},
  {v:30,    l:'30 min'}, {v:60,  l:'1 hour'},  {v:120, l:'2 hours'},
  {v:1440,  l:'1 day'},  {v:2880,l:'2 days'}
];

const state = {
  db: null, demo: isDemo(),
  household: null, members: [], events: [], me: null,
  module: 'calendar', editing: null, parsed: null
};

/* ==========================================================================
 * DATA LAYER — one shape for demo and live so no UI code branches on it.
 * ========================================================================*/
const DEMO_MEMBERS = [
  {id:'m1', name:'Erich', color:'#2f6f5e', role:'owner', default_lead_minutes:30, sort_order:1},
  {id:'m2', name:'Jess',  color:'#b4553c', role:'adult', default_lead_minutes:30, sort_order:2},
  {id:'m3', name:'Addie', color:'#7d4a8c', role:'teen',  default_lead_minutes:15, sort_order:3},
  {id:'m4', name:'Bryce', color:'#37588f', role:'child', default_lead_minutes:15, sort_order:4}
];
function demoEvents(){
  const t = new Date(); const d = n => ymd(new Date(t.getFullYear(),t.getMonth(),t.getDate()+n));
  return [
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
    const { data } = await state.db.from('events')
      .select('*, reminders(lead_minutes)')
      .eq('household_id', CONFIG.HOUSEHOLD_ID).is('deleted_at', null)
      .or(`event_date.gte.${ymd(from)},starts_at.gte.${from.toISOString()}`);
    state.events = (data || []).map(e => ({...e, lead_minutes: e.reminders?.[0]?.lead_minutes ?? null}));
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
      created_by: state.me?.id || null, source: e.source || 'web'
    };
    const q = e.id
      ? state.db.from('events').update(row).eq('id', e.id).select().single()
      : state.db.from('events').insert(row).select().single();
    const { data, error } = await q;
    if (error) throw error;
    await DB.setReminder(data, e.lead_minutes);
    await DB.loadEvents();
  },

  /* fire_at is computed here, on write, so the dispatcher only ever runs one
     cheap indexed range scan per minute instead of scanning every event. */
  async setReminder(row, lead){
    if (state.demo) return;
    await state.db.from('reminders').delete().eq('event_id', row.id).is('sent_at', null);
    if (lead == null) return;
    const base = row.all_day
      ? new Date(`${row.event_date}T09:00:00`)          // all-day -> 9am local
      : new Date(row.starts_at);
    const fire = new Date(base.getTime() - lead*60000);
    await state.db.from('reminders').insert({
      household_id: CONFIG.HOUSEHOLD_ID, event_id: row.id,
      member_id: row.member_id, lead_minutes: lead,
      channel: CONFIG.SMS_ENABLED ? 'sms' : 'push',
      fire_at: fire.toISOString()
    });
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
const onDay  = d => state.events.filter(e => dateOf(e) === d).sort(sortEv);
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

  if (state.module !== 'calendar') return renderPlaceholder();

  $('#qa').classList.remove('hide');
  const today = ymd(now);
  const todays = onDay(today);

  // week strip: Sunday-anchored week containing today
  const wkStart = new Date(now); wkStart.setDate(now.getDate() - now.getDay());
  const week = [...Array(7)].map((_,i) => { const d = new Date(wkStart); d.setDate(wkStart.getDate()+i); return d; });

  const upcoming = state.events
    .filter(e => dateOf(e) > today).sort(sortEv).slice(0, 6);

  $('#bento').innerHTML = `
    <div class="col">
      <section class="card">
        <div class="ch"><span>Today</span><b>${todays.length ? todays.length + (todays.length===1?' event':' events') : 'Clear'}</b></div>
        <div class="tdate">${now.toLocaleDateString('en-US',{weekday:'long'})}</div>
        <h2 class="tbig">${now.toLocaleDateString('en-US',{month:'short', day:'numeric'})}</h2>
        ${todays.length ? todays.map(e => `
          <button class="trow" data-ev="${e.id}" style="--c:${colorOf(e.member_id)}">
            <span class="ttime">${timeOf(e)}</span>
            <span class="body"><span class="ttitle">${esc(e.title)}</span><span class="twho">${nameOf(e.member_id)}</span></span>
            ${e.lead_minutes != null ? `<span class="bell" title="Reminder ${leadLabel(e.lead_minutes)} before">&#9201;</span>` : ''}
          </button>`).join('')
        : `<div class="empty">Nothing on the calendar today.</div>`}
      </section>

      <section class="card">
        <div class="ch"><span>Who's busy</span><b>Next 30 days</b></div>
        ${state.members.map(m => `<div class="lane"><span class="dot" style="background:${m.color}"></span>
          <span class="nm">${m.name}</span>
          <span class="ct">${state.events.filter(e=>e.member_id===m.id && dateOf(e)>=today).length}</span></div>`).join('')}
        <div class="lane"><span class="dot" style="background:${EVERYONE}"></span>
          <span class="nm">Everyone</span>
          <span class="ct">${state.events.filter(e=>!e.member_id && dateOf(e)>=today).length}</span></div>
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
            <span class="body"><span class="upt">${esc(e.title)}</span><span class="upm">${timeOf(e)} · ${nameOf(e.member_id)}</span></span>
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

$$('#tabbar button').forEach(b => b.onclick = () => {
  state.module = b.dataset.mod;
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

function preview(){
  const text = qaIn.value.trim(); if (!text) return;
  const p = parseQuickAdd(text, {
    members: state.members.map(m => m.name),
    defaultLead: state.me?.default_lead_minutes ?? 30
  });
  state.parsed = p;
  const d = describe(p);
  const mem = state.members.find(m => m.name === p.member);
  $('#qa-prev').innerHTML = `
    <div class="qa-prev" style="--c:${mem?.color || EVERYONE}">
      <div class="pt">${esc(p.title)}</div>
      ${p.warnings.map(w => `<div class="warn">${esc(w)}</div>`).join('')}
      <div class="meta">
        <span class="mtag">${d.day}</span><span class="mtag">${d.time}</span>
        <span class="mtag">${d.who}</span><span class="mtag">&#9201; ${d.lead}</span>
      </div>
      <div class="acts">
        <button type="button" id="qa-edit">Edit</button>
        <button type="button" class="ok" id="qa-ok">Add it</button>
      </div>
    </div>`;
  $('#qa-ok').onclick = commitParsed;
  $('#qa-edit').onclick = () => { openSheet(parsedToEvent(p)); clearQA(); };
}

function parsedToEvent(p){
  const mem = state.members.find(m => m.name === p.member);
  return {
    id: null, title: p.title, notes: null,
    all_day: p.allDay, event_date: p.date,
    starts_at: p.allDay ? null : new Date(`${p.date}T${p.start}:00`).toISOString(),
    ends_at:   p.end ? new Date(`${p.date}T${p.end}:00`).toISOString() : null,
    member_id: mem?.id || null, lead_minutes: p.leadMinutes, source: 'web'
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
  $('#sheet-title').textContent = state.editing ? 'Edit event' : 'New event';
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
  const payload = {
    id: state.editing?.id || null,
    title: $('#ev-title').value.trim(),
    notes: $('#ev-notes').value.trim() || null,
    all_day: !time, event_date: date,
    starts_at: time ? new Date(`${date}T${time}:00`).toISOString() : null,
    ends_at: null,
    member_id: whoBtn?.dataset.w || null,
    lead_minutes: leadBtn && leadBtn.dataset.l !== '' ? +leadBtn.dataset.l : null,
    source: 'web'
  };
  if (!payload.title) return;
  try { await DB.saveEvent(payload); closeSheet(); render(); toast(state.editing ? 'Saved' : 'Added'); }
  catch (err) { console.error(err); toast('Could not save'); }
});

$('#ev-del').onclick = async () => {
  if (!state.editing) return;
  await DB.deleteEvent(state.editing.id);
  closeSheet(); render(); toast('Deleted');
};

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

boot();
