import { parseQuickAdd, describe } from './parse.js';
const NOW = new Date(2026, 7, 24, 14, 0);      // Monday 24 Aug 2026, 2pm
const M = ['Erich','Jess','Addie','Bryce'];
const P = t => parseQuickAdd(t, { members: M, now: NOW, defaultLead: 30 });

let pass=0, fail=0;
const eq=(label,got,want)=>{
  const g=JSON.stringify(got), w=JSON.stringify(want);
  if(g===w){pass++;} else {fail++;console.log(`FAIL ${label}\n  got  ${g}\n  want ${w}`);}
};
const R=p=>p.repeat&&{f:p.repeat.freq,i:p.repeat.interval,d:p.repeat.days,u:p.repeat.until};

// --- frequency forms
eq('every Tuesday',        R(P('Piano every Tuesday 4pm Addie')), {f:'weekly',i:1,d:[2],u:null});
eq('every other Tuesday',  R(P('Piano every other Tuesday 4pm')), {f:'weekly',i:2,d:[2],u:null});
eq('every Mon and Wed',    R(P('Soccer every Monday and Wednesday 5:30')), {f:'weekly',i:1,d:[1,3],u:null});
eq('every Mon, Wed, Fri',  R(P('Gym every Mon, Wed, Fri 6am')), {f:'weekly',i:1,d:[1,3,5],u:null});
eq('every weekday',        R(P('Bus every weekday 7:15 Bryce')), {f:'weekly',i:1,d:[1,2,3,4,5],u:null});
eq('every weekend',        R(P('Chores every weekend')), {f:'weekly',i:1,d:[0,6],u:null});
eq('every day',            R(P('Vitamins every day 8am')), {f:'daily',i:1,d:[],u:null});
eq('every other day',      R(P('Meds every other day 8am')), {f:'daily',i:2,d:[],u:null});
eq('every 3 weeks',        R(P('Haircut every 3 weeks')), {f:'weekly',i:3,d:[],u:null});
eq('every month',          R(P('Rent every month')), {f:'monthly',i:1,d:[],u:null});
eq('biweekly',             R(P('Payday biweekly')), {f:'weekly',i:2,d:[],u:null});
eq('no repeat',            R(P('Dentist Thursday 9am')), null);

// --- until
eq('until May 30',   R(P('Piano every Tuesday 4pm until May 30')).u, '2027-05-30');
eq('until 12/31',    R(P('Piano every Tuesday 4pm until 12/31')).u, '2026-12-31');

// --- the span-collision bug findFree exists to prevent
const collide = P('Piano every Tuesday 4pm until 12/31');
eq('4pm survives "until"', collide.start, '16:00');
eq('no bogus end time',    collide.end, null);

// --- first occurrence seeding
eq('every Tue -> next Tue', P('Piano every Tuesday 4pm').date, '2026-08-25');
eq('every Mon -> next Mon (not today)', P('Scouts every Monday 6pm').date, '2026-08-31');
eq('Mon+Wed -> earliest next', P('Soccer every Monday and Wednesday 5:30').date, '2026-08-26');

// --- title stays clean
eq('title clean 1', P('Piano every Tuesday 4pm Addie remind 30 min before').title, 'Piano');
eq('title clean 2', P('Soccer every Monday and Wednesday 5:30 Bryce').title, 'Soccer');
eq('title clean 3', P('Gym every Mon, Wed, Fri 6am').title, 'Gym');
eq('title clean 4', P('Piano every Tuesday 4pm until 12/31').title, 'Piano');

// --- other fields still work alongside recurrence
const full = P('Piano every Tuesday 4pm Addie remind 30 min before');
eq('member', full.member, 'Addie');
eq('lead',   full.leadMinutes, 30);
eq('start',  full.start, '16:00');
eq('allDay', full.allDay, false);

// --- no stale warning
eq('no "not supported" warning',
   P('Piano every Tuesday 4pm').warnings.filter(w=>/supported/i.test(w)).length, 0);

// --- describe()
eq('describe weekly',  describe(P('Piano every Tuesday 4pm')).repeat, 'every Tue');
eq('describe biweekly',describe(P('Piano every other Tuesday 4pm')).repeat, 'every other Tue');
eq('describe 2 days',  describe(P('Soccer every Monday and Wednesday 5:30')).repeat, 'every Mon, Wed');
eq('describe daily',   describe(P('Vitamins every day 8am')).repeat, 'every day');
eq('describe until',   describe(P('Piano every Tuesday 4pm until 12/31')).repeat, 'every Tue, until Dec 31');
eq('describe none',    describe(P('Dentist Thursday 9am')).repeat, null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
