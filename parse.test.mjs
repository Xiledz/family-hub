import {parseQuickAdd, describe as dsc} from './parse.js';
const NOW = new Date(2026,7,19,10,0,0);            // Wed Aug 19 2026, 10:00
const M = ['Erich','Lisa','Noah','Mia'];
const P = s => parseQuickAdd(s,{members:M, now:NOW, defaultLead:30});
let pass=0, fail=0;
const t=(label,got,want)=>{
  const g=JSON.stringify(got), w=JSON.stringify(want);
  if(g===w){pass++;} else {fail++; console.log(`FAIL ${label}\n  got  ${g}\n  want ${w}`);}
};
const core = r => ({title:r.title,date:r.date,start:r.start,end:r.end,allDay:r.allDay,member:r.member,lead:r.leadMinutes});

t('weekday+time+person', core(P('Soccer practice Thursday 5:30 Noah')),
  {title:'Soccer practice',date:'2026-08-20',start:'17:30',end:null,allDay:false,member:'Noah',lead:30});
t('tomorrow am', core(P('Dentist tomorrow 9am Mia')),
  {title:'Dentist',date:'2026-08-20',start:'09:00',end:null,allDay:false,member:'Mia',lead:30});
t('all day sat', core(P('Church picnic Saturday all day everyone')),
  {title:'Church picnic',date:'2026-08-22',start:null,end:null,allDay:true,member:null,lead:30});
t('month name + noon', core(P('Payroll deadline Aug 21 noon')),
  {title:'Payroll deadline',date:'2026-08-21',start:'12:00',end:null,allDay:false,member:null,lead:30});
t('lead phrase', core(P('Date night Friday 7pm remind 1 hour before')),
  {title:'Date night',date:'2026-08-21',start:'19:00',end:null,allDay:false,member:null,lead:60});
t('lead no verb', core(P('Quarterly review 8/28 9am Erich 2 hrs before')),
  {title:'Quarterly review',date:'2026-08-28',start:'09:00',end:null,allDay:false,member:'Erich',lead:120});
t('range', core(P('Parent teacher conf Wednesday 3:30-4:30 Lisa')),
  {title:'Parent teacher conf',date:'2026-08-26',start:'15:30',end:'16:30',allDay:false,member:'Lisa',lead:30});
t('duration', core(P('Team standup tomorrow 8:30am for 30 minutes Erich')),
  {title:'Team standup',date:'2026-08-20',start:'08:30',end:'09:00',allDay:false,member:'Erich',lead:30});
t('today implicit', core(P("Dinner at Grandma's 6pm everyone")),
  {title:"Dinner at Grandma's",date:'2026-08-19',start:'18:00',end:null,allDay:false,member:null,lead:30});
t('next week', core(P('Physical next Thursday 10:15am Noah')),
  {title:'Physical',date:'2026-08-27',start:'10:15',end:null,allDay:false,member:'Noah',lead:30});
t('bare colon pm heuristic', core(P('Piano lesson Wednesday 4:00 Mia')),
  {title:'Piano lesson',date:'2026-08-26',start:'16:00',end:null,allDay:false,member:'Mia',lead:30});
t('slash date + day lead', core(P('Anniversary 8/30 all day remind 2 days before')),
  {title:'Anniversary',date:'2026-08-30',start:null,end:null,allDay:true,member:null,lead:2880});
t('no reminder', core(P('Trash out tonight Erich no reminder')),
  {title:'Trash out',date:'2026-08-19',start:'19:00',end:null,allDay:false,member:'Erich',lead:null});
t('in N days', core(P('Oil change in 3 days Erich 9am')),
  {title:'Oil change',date:'2026-08-22',start:'09:00',end:null,allDay:false,member:'Erich',lead:30});
t('possessive name', core(P("Lisa's book club Tuesday 7pm")),
  {title:'book club',date:'2026-08-25',start:'19:00',end:null,allDay:false,member:'Lisa',lead:30});
t('title only', core(P('Fix the gutters')),
  {title:'Fix the gutters',date:'2026-08-19',start:null,end:null,allDay:true,member:null,lead:30});
t('past-year rollover', core(P('Taxes due Apr 15')),
  {title:'Taxes due',date:'2027-04-15',start:null,end:null,allDay:true,member:null,lead:30});

// warnings
t('recurrence flagged', P('Soccer every Tuesday 5:30 Noah').warnings.length>0, true);
t('past time flagged', P('Lunch 9am Erich').warnings.some(w=>/already passed/.test(w)), true);
t('no title flagged', P('tomorrow 5pm').title, 'Untitled');

// describe()
t('describe', dsc(P('Soccer practice Thursday 5:30 Noah remind 1 hour before')),
  {day:'Thursday, Aug 20', time:'5:30 PM', who:'Noah', lead:'alert 1h before'});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
