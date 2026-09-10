import { occurrenceDates, expand, describeRepeat, ymd, parseYmd } from './recur.js';
const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
let pass=0,fail=0;
const t=(l,g,w)=>{const G=JSON.stringify(g),W=JSON.stringify(w);
  if(G===W)pass++;else{fail++;console.log(`FAIL ${l}\n  got  ${G}\n  want ${W}`)}};

const S=(o)=>Object.assign({id:'e1',all_day:true,event_date:'2026-08-25'},o);

t('weekly Tue', occurrenceDates(S({repeat_freq:'weekly',repeat_interval:1}),'2026-08-24','2026-09-16'),
  ['2026-08-25','2026-09-01','2026-09-08','2026-09-15']);
t('Tue+Thu', occurrenceDates(S({repeat_freq:'weekly',repeat_interval:1,repeat_days:[2,4]}),'2026-08-24','2026-09-04'),
  ['2026-08-25','2026-08-27','2026-09-01','2026-09-03']);
t('biweekly', occurrenceDates(S({repeat_freq:'weekly',repeat_interval:2}),'2026-08-24','2026-10-01'),
  ['2026-08-25','2026-09-08','2026-09-22']);
t('until', occurrenceDates(S({repeat_freq:'weekly',repeat_interval:1,repeat_until:'2026-09-08'}),'2026-08-24','2026-09-30'),
  ['2026-08-25','2026-09-01','2026-09-08']);
t('daily x3', occurrenceDates(S({repeat_freq:'daily',repeat_interval:3}),'2026-08-25','2026-09-04'),
  ['2026-08-25','2026-08-28','2026-08-31','2026-09-03']);
t('monthly across year', occurrenceDates(S({event_date:'2026-11-25',repeat_freq:'monthly',repeat_interval:1}),'2026-11-01','2027-02-28'),
  ['2026-11-25','2026-12-25','2027-01-25','2027-02-25']);
t('one-off', occurrenceDates(S({}),'2026-08-01','2026-09-30'), ['2026-08-25']);
t('nothing before start', occurrenceDates(S({repeat_freq:'weekly'}),'2026-08-01','2026-08-24'), []);

// DST — US fall back 2026-11-01, spring forward 2027-03-14
const f = occurrenceDates(S({event_date:'2026-10-27',repeat_freq:'weekly',repeat_interval:1}),'2026-10-27','2026-11-18');
t('fall DST weekdays', f.map(d=>DOW[parseYmd(d).getDay()]), ['Tue','Tue','Tue','Tue']);
const sp = occurrenceDates(S({event_date:'2027-03-09',repeat_freq:'weekly',repeat_interval:1}),'2027-03-09','2027-03-31');
t('spring DST weekdays', sp.map(d=>DOW[parseYmd(d).getDay()]), ['Tue','Tue','Tue','Tue']);

// exceptions
const ser = S({id:'s1',repeat_freq:'weekly',repeat_interval:1,title:'Soccer'});
const skipped = expand([ser],[{event_id:'s1',occurrence_date:'2026-09-01',action:'skip'}],'2026-08-24','2026-09-16');
t('skip removes one', skipped.map(o=>o.occurrence_date),
  ['2026-08-25','2026-09-08','2026-09-15']);
const over = expand([ser],[{event_id:'s1',occurrence_date:'2026-09-08',action:'override',title:'Soccer (away)'}],'2026-09-01','2026-09-16');
t('override changes title', over.map(o=>o.title), ['Soccer','Soccer (away)','Soccer']);
t('override keeps count', over.length, 3);

t('describe weekly', describeRepeat({repeat_freq:'weekly',repeat_interval:1,repeat_days:[2],event_date:'2026-08-25'}).includes('Tue'), true);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
