/* ===========================================================================
 * THE BOX YOU ARE TYPING IN SURVIVES THE ADD
 *
 * Erich: "when typing things in for the shopping list and we hit enter, I
 * wish the cursor would stay in the box." Every list tab rebuilt all of
 * #bento — add form included — after each add, so the input node was
 * destroyed and focus died with it (and the iOS keyboard dropped).
 *
 * The rule now: a live form is created once per tab (frame()) and never
 * replaced; only the slots around it are re-rendered. This suite runs the
 * REAL app.js under jsdom against a mock database and proves, for every
 * add box, that after a submit:
 *   - the very same input node is still in the document (identity, not id)
 *   - document.activeElement is that node
 *   - its value is empty
 *   - the new row is on screen — immediately (optimistic), and still after
 *     the database round-trip and the full re-render that follows.
 *
 * What jsdom cannot prove: that Safari keeps the on-screen keyboard open.
 * It will, as long as the focused node is never removed and nothing calls
 * blur() — both of which this suite does check. Erich checks the keyboard
 * on his phone.
 *
 * Needs jsdom (npm install). Without it the suite reports 0/0 and says so.
 * ========================================================================= */
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
let JSDOM;
try { ({ JSDOM } = await import('jsdom')); }
catch { console.log('jsdom not installed — run: npm install\n\n0 passed, 0 failed'); process.exit(0); }

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) pass++; else { fail++; console.log(`FAIL  ${label}${detail ? '\n      ' + detail : ''}`); } };

/* ---- a database that remembers inserts, so load() after add() sees them --- */
const HH = '00000000-0000-0000-0000-000000000001';
const MEMBERS = [
  { household_id: HH, id: 'm1', name: 'Erich', color: '#2f6f5e', role: 'owner', default_lead_minutes: 30, sort_order: 1, aliases: ['dad'] },
  { household_id: HH, id: 'm2', name: 'Jess',  color: '#b4553c', role: 'adult', default_lead_minutes: 30, sort_order: 2, aliases: ['mom'] },
  { household_id: HH, id: 'm4', name: 'Bryce', color: '#37588f', role: 'child', default_lead_minutes: 15, sort_order: 4, aliases: [] }
];
const tables = { members: MEMBERS, households: [{ id: HH, name: 'Family Hub', passcode: 'KELLEY', timezone: 'America/Chicago' }],
  shopping_items: [], todos: [], recipes: [], stores: [], shopping_catalog: [], store_aisles: [], shopping_categories: [],
  events: [], event_exceptions: [], member_absences: [], meal_plan: [], event_done: [] };
let seq = 0;
const log = [];
function from(table){
  const st = { filters: [] };
  const rows = () => (tables[table] || []).filter(r => st.filters.every(f => f(r)));
  const chain = {
    select(){ return chain; }, order(){ return chain; }, limit(){ return chain; }, or(){ return chain; }, gte(){ return chain; }, not(){ return chain; },
    eq(k, v){ st.filters.push(r => r[k] === v); return chain; },
    is(k, v){ st.filters.push(r => (r[k] ?? null) === v); return chain; },
    insert(r){ log.push(['insert', table]); const list = [].concat(r).map(x => ({ id: `${table}-${++seq}`, created_at: new Date().toISOString(), ...x }));
      (tables[table] ||= []).push(...list); st.ins = list; return chain; },
    upsert(r){ log.push(['upsert', table]); return chain; }, update(p){ log.push(['update', table]); st.upd = p; return chain; }, delete(){ st.del = true; return chain; },
    single(){ return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
    maybeSingle(){ return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
    then(res){ if (st.del) { tables[table] = (tables[table] || []).filter(r => !st.filters.every(f => f(r))); }
               if (st.upd) { for (const r of rows()) Object.assign(r, st.upd); }
               res({ data: st.ins ?? rows(), error: null, count: rows().length }); }
  };
  return chain;
}
const db = { from, rpc: () => Promise.resolve({ data: null, error: null }),
  channel(){ const c = { on(){ return c; }, subscribe(){ return c; } }; return c; } };

/* ---- the real app.js, with only the network swapped out ------------------ */
const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const imp = "const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');";
if (!src.includes(imp)) { console.log('app.js no longer imports supabase where this test expects'); process.exit(1); }
const tmp = new URL('./_focus_app.mjs', import.meta.url);
writeFileSync(tmp, src.replace(imp, 'const createClient = () => globalThis.__db;'));

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://xiledz.github.io/family-hub/index.html', pretendToBeVisual: true });
const w = dom.window;
for (const k of ['window', 'document', 'localStorage', 'location', 'history', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'Request', 'URL', 'URLSearchParams', 'getComputedStyle', 'confirm'])
  try { globalThis[k] = w[k] ?? globalThis[k]; } catch {}
w.matchMedia = globalThis.matchMedia = () => ({ matches: false, addEventListener(){}, addListener(){} });
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'jsdom', clipboard: {} }, configurable: true });
globalThis.__db = db;
globalThis.setInterval = () => 0;
w.localStorage.setItem('fh.code', 'KELLEY');
w.localStorage.setItem('fh.me', 'm2');
w.HTMLElement.prototype.scrollIntoView = () => {};

try {
  await import(tmp.href);
  await tick(100);
  const $ = s => w.document.querySelector(s);
  const $$ = s => [...w.document.querySelectorAll(s)];
  ok('app entered as Jess', !$('#app').classList.contains('hide') && $('#me').textContent.includes('Jess'));

  const goTab = async mod => { $(`#tabbar [data-mod="${mod}"]`).click(); await tick(60); };
  /* Type into a box the way a person does: focus, value, Enter (= submit). */
  const typeEnter = (inp, text) => {
    inp.focus(); inp.value = text;
    inp.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    inp.form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  };
  let blurs = 0;
  w.document.addEventListener('blur', () => blurs++, true);

  const prove = async (label, formSel, inputSel, text, rowSel, rowText, waitMs = 80) => {
    const inp = $(inputSel);
    ok(`${label}: box exists`, !!inp);
    if (!inp) return;
    const before = blurs;
    typeEnter(inp, text);
    /* Same task as the submit: the optimistic row is already there. */
    ok(`${label}: row appears at once (optimistic)`, $$(rowSel).some(r => r.textContent.includes(rowText)),
       $$(rowSel).map(r => r.textContent.trim()).join(' | ').slice(0, 200));
    ok(`${label}: box is empty`, inp.value === '');
    ok(`${label}: same node still focused before the network answers`, w.document.activeElement === inp && inp.isConnected);
    await tick(waitMs);                                   // insert → load → full re-render
    ok(`${label}: SAME input node still in the document after re-render`, inp.isConnected && $(inputSel) === inp);
    ok(`${label}: activeElement is still that node`, w.document.activeElement === inp,
       `active = ${w.document.activeElement?.tagName}#${w.document.activeElement?.id}`);
    ok(`${label}: no blur fired on it`, blurs === before);
    ok(`${label}: row is on screen after the round-trip`, $$(rowSel).some(r => r.textContent.includes(rowText) && !r.classList.contains('pending')),
       $$(rowSel).map(r => r.textContent.trim() + (r.classList.contains('pending') ? '(pending)' : '')).join(' | ').slice(0, 200));
    ok(`${label}: form node itself survived`, $(formSel)?.contains(inp));
  };

  /* --- shopping: three adds in a row, no waiting between them ------------- */
  await goTab('shopping');
  await prove('shopping', '#shop-add', '#shop-in', 'milk', '.shop-row', 'milk');
  {
    const inp = $('#shop-in');
    typeEnter(inp, 'eggs'); typeEnter(inp, 'butter sticks');
    ok('shopping: two more typed without waiting — both on screen at once', ['eggs', 'butter sticks'].every(t => $$('.shop-row').some(r => r.textContent.includes(t))));
    await tick(120);
    ok('shopping: all three saved and shown', ['milk', 'eggs', 'butter sticks'].every(t => $$('.shop-row:not(.pending)').some(r => r.textContent.includes(t))));
    ok('shopping: still the same focused node after three adds', w.document.activeElement === inp && $('#shop-in') === inp);
    ok('shopping: three inserts hit the database', log.filter(l => l[0] === 'insert' && l[1] === 'shopping_items').length === 3);
  }
  /* A tick re-renders the list; the box must survive that too. */
  {
    const inp = $('#shop-in'); inp.focus();
    $$('[data-tick]')[0].click(); await tick(50);
    ok('shopping: box survives a tick re-render', $('#shop-in') === inp && w.document.activeElement === inp);
    ok('shopping: the tick landed', $$('.shop-row.got').length === 1);
  }
  /* A failed insert takes the optimistic row back and says so. */
  {
    const realInsert = from; const inp = $('#shop-in');
    globalThis.__db.from = t => { const c = realInsert(t); if (t === 'shopping_items') c.insert = () => { c.then = res => res({ data: null, error: { message: 'down' } }); return c; }; return c; };
    typeEnter(inp, 'bread');
    ok('shopping: failed add shows the row first', $$('.shop-row.pending').some(r => r.textContent.includes('bread')));
    await tick(80);
    ok('shopping: failed add is taken back', !$$('.shop-row').some(r => r.textContent.includes('bread')));
    ok('shopping: failed add says so', $('#toast').textContent.includes('Could not save'));
    ok('shopping: box still alive and focused after a failure', $('#shop-in') === inp && w.document.activeElement === inp);
    globalThis.__db.from = realInsert;
  }

  /* --- todos --------------------------------------------------------------- */
  await goTab('todos');
  await prove('todos', '#tadd', '#tin', 'clean the garage', '.todo', 'Clean the garage');
  ok('todos: the row is a real one (tick present)', $$('.todo:not(.pending) [data-tick]').length === 1);

  /* --- meals: a typed name opens the confirm sheet; the box must survive --- */
  await goTab('meals');
  {
    const inp = $('#rin');
    ok('meals: box exists', !!inp);
    typeEnter(inp, 'Grandma\'s chili');
    await tick(80);
    ok('meals: same input node still in the document', inp.isConnected && $('#rin') === inp);
    ok('meals: box is empty', inp.value === '');
    ok('meals: confirm sheet opened for the typed name', $('#msheet').classList.contains('on') && $('#msheet-body').textContent.length > 0);
  }

  /* --- calendar quick-add: Enter previews, the node is static HTML -------- */
  await goTab('calendar');
  {
    const inp = $('#qa-input');
    typeEnter(inp, 'Dentist Thursday 3pm Bryce');
    await tick(30);
    ok('quick-add: preview rendered', $('#qa-prev').textContent.includes('Dentist'));
    ok('quick-add: same node, still focused after Enter', $('#qa-input') === inp && w.document.activeElement === inp);
    const okBtn = $('#qa-ok'); ok('quick-add: add button offered', !!okBtn && !okBtn.disabled);
    okBtn?.click(); await tick(80);
    ok('quick-add: event saved', (tables.events || []).some(e => e.title === 'Dentist'));
    ok('quick-add: box cleared and still in the document', inp.isConnected && inp.value === '' && $('#qa-input') === inp);
  }

  /* --- switching tabs rebuilds the frame; coming back gives a fresh box ---- */
  await goTab('shopping');
  ok('shopping: frame rebuilt after leaving and returning', !!$('#shop-in') && $('#bento').dataset.frame === 'shopping');
} finally {
  try { unlinkSync(tmp); } catch {}
}
function tick(ms){ return new Promise(r => setTimeout(r, ms)); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
