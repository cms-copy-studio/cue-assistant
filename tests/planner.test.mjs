import test from 'node:test';
import assert from 'node:assert/strict';
import {planCue, defaultPrefs} from '../extension/planner.mjs';

const main = '天下雜誌';
const other = '未來城市';
const start = '2031-04-01';
const later = '2031-04-02';
const stamp = '2031-03-31T08:00:00.000Z';
const order = (changes={}) => ({
  id:'SYNTHETIC-A', name:'模擬展覽', start,end:'2031-05-31', originalBudget:55,
  budget:100,sites:[main,other],siteMinimums:{},requiredPlacements:[],facebook:{},
  pv:'另以文章上線後流量核對',topic:'藝文',notes:'',...changes
});
const web = (placement, changes={}) => ({
  site:main,placement,date:start,recommended:1000,remaining:1000,cpm:100,...changes
});
const fb = (page,slot,unitPrice,remaining=1) => ({page,slot,date:start,unitPrice,remaining});
const inventory = (web=[],social=[]) => ({web,social,queriedAt:stamp,warnings:[]});
const run = (edits,webRows,socialRows,prefs) => planCue(order(edits),inventory(webRows,socialRows),prefs);

test('每個日期只能使用推薦日量的整數倍，套用側欄最新的總預算',()=>{
  const rows=[web('Text',{recommended:35000,remaining:42000,cpm:1}),
    web('Text',{date:later,recommended:35000,remaining:70000,cpm:1})];
  const first=run({budget:105},rows);
  assert.deepEqual(first.web.map(r=>r.quantity),[35000,70000]);
  assert.equal(first.totalValue,105);
  assert.equal(first.placementCount,1);
  assert.equal(first.queriedAt,stamp);
  const edited=run({budget:35},rows);
  assert.equal(edited.totalImpressions,35000);
  assert.equal(edited.totalValue,35);
  assert.equal(edited.delta,0);
  assert.equal(rows[0].remaining,42000);
});

test('以含社群的金額比絕對差，允許正負；明列硬上限會改變方案',()=>{
  const rows=[web('A',{cpm:100}),web('B',{cpm:125})];
  assert.equal(run({budget:120},rows).delta,5);
  assert.equal(run({budget:108},rows).delta,-8);
  assert.equal(run({budget:120,hardCap:120},rows).delta,-20);
  const social=[fb(other,'AM',20),fb(other,'PM',110)];
  const result=run({budget:210,facebook:{[other]:1},sites:[main]},rows,social);
  assert.equal(result.totalValue,210);
  assert.equal(result.social[0].unitPrice,110);
  assert.equal(result.delta,0);
  assert.equal(result.social[0].page,other);
});

test('粉專與網站分開核對，同格可用次數不可超用，需求未指粉專時採天下',()=>{
  const areas=[fb(other,'午',20,1),fb(other,'晚',30,1),fb(main,'早',50,1)];
  const schedule=run({sites:[],facebook:{[other]:2,'':1}},[],areas);
  assert.equal(schedule.ok,true);
  assert.equal(schedule.placementCount,0);
  assert.equal(schedule.social.reduce((s,r)=>s+r.quantity,0),3);
  assert.equal(run({facebook:{[other]:3}},[],areas).ok,false);
});

test('未知、價格缺漏、色塊範圍、有衝突或不在檔期的格都不可使用',()=>{
  const rows=[web('A',{remaining:null}),web('B',{cpm:''}),web('C',{remaining:'30–40 萬'}),
    web('D',{remaining:4000}),web('D',{remaining:1000}),
    web('E',{date:'2031-03-31'}),web('E',{date:'2031-04-31'})];
  const fail=run({},rows,[fb(main,'午',0,0)]);
  assert.equal(fail.ok,false);
  assert.deepEqual(fail.web,[]);
  assert.ok(fail.warnings.some(x=>x.includes('未知')));
  const exactZero=run({budget:100},[web('A',{remaining:0}),web('B')]);
  assert.equal(exactZero.web[0].placement,'B');
});

test('相同快照有重複列時不會重複計算庫存',()=>{
  const result=run({budget:200},[web('重複'),web('重複')]);
  assert.equal(result.web.length,1);
  assert.equal(result.totalImpressions,1000);
});

test('指定天下的門檻只能由天下小計達標，文章 PV 不抵曝光',()=>{
  const rows=[web('X',{recommended:100000,remaining:100000,cpm:1}),
    web('Y',{site:other,recommended:200000,remaining:200000,cpm:1})];
  const fail=run({budget:300,siteMinimums:{天下官網:200000},pv:999999},rows);
  assert.equal(fail.ok,false);
  assert.match(fail.issues.join(''),/天下雜誌.*100,000.*200,000/);
  const pass=run({budget:300,siteMinimums:{天下官網:100000},pv:999999},rows);
  assert.equal(pass.subtotals[main],100000);
  assert.equal(pass.subtotals[other],200000);
  assert.equal(pass.totalImpressions,300000);
});

test('3 到 4 個版位優先，達成權益可用 5 個，同一版位拆日只計 1 個',()=>{
  const rows=['A','B','C','D','E'].map(name=>web(name,{cpm:10,remaining:5000}));
  const balanced=run({budget:40},rows);
  assert.ok([3,4].includes(balanced.placementCount));
  const more=run({budget:40,requiredPlacements:rows.map(r=>main+'/'+r.placement)},rows);
  assert.equal(more.ok,true);
  assert.equal(more.placementCount,5);
  assert.equal(more.delta,10);
  assert.ok(more.warnings.some(x=>x.includes('5 個')));
  const fewer=run({budget:30},[web('A',{cpm:10}),web('A',{date:'2031-04-04',cpm:20})]);
  assert.equal(fewer.placementCount,1);
  assert.ok(fewer.warnings.some(x=>x.includes('1 個')));
});

test('指定版位與上限優先，跨站同名需指定站別',()=>{
  const rows=[web('Rectangle'),web('Rectangle',{site:other,cpm:200})];
  assert.equal(run({budget:100,requiredPlacements:['未來城市/Rectangle']},rows).totalValue,200);
  assert.equal(run({budget:100,hardCap:100,requiredPlacements:['未來城市/Rectangle']},rows).ok,false);
  assert.equal(run({requiredPlacements:['Rectangle']},rows).ok,false);
});

test('偏好只在合格且價差相同的方案間排序；避開週一起始但可跨週一',()=>{
  const cells=[
    web('Text',{format:'Text',date:'2031-04-07'}), // Monday
    web('Text',{format:'Text',date:'2031-04-08'}),
    web('Rectangle',{format:'Rectangle',size:'300×250',date:'2031-04-08'})
  ];
  assert.equal(run({},cells).web[0].date,'2031-04-08');
  const prefs={...defaultPrefs,placementOrder:['Rectangle','Text'],preferredDays:1};
  assert.equal(run({},cells,[],prefs).web[0].placement,'Rectangle');
  const across=run({budget:200},[web('Text',{date:'2031-04-06'}),web('Text',{date:'2031-04-07'})]);
  assert.equal(across.web.length,2);
  assert.equal(across.web[1].date,'2031-04-07');
  assert.equal(run({requiredPlacements:['Text']},cells,[],prefs).web[0].placement,'Text');
});

test('文字同位且連續的走期優先於拆段',()=>{
  const rows=['2031-04-01','2031-04-04','2031-04-05'].map(date=>web('全網 Text 1',{date}));
  const answer=run({budget:200},rows);
  assert.deepEqual(answer.web.map(r=>r.date),['2031-04-04','2031-04-05']);
});

test('總預算不能以原單預算或歷史金額補入；有精確小數的 CPM 仍可正確算價',()=>{
  assert.equal(run({budget:null},[web('A')]).ok,false);
  assert.equal(run({budget:0,hardCap:'不適用'},[web('A')]).ok,false);
  const result=run({budget:3.68},[web('A',{cpm:2.45,recommended:1500,remaining:1500})]);
  assert.equal(result.totalValue,3.675);
  assert.equal(result.delta,-0.005);
});

test('素材規格和主題用於排序，Scroll Video 會附過稿提醒',()=>{
  const cells=[web('Rectangle 1',{format:'Rectangle',size:'728×90'}),web('Rectangle 2',{format:'Rectangle',size:'300x250'})];
  assert.equal(run({},cells).web[0].placement,'Rectangle 2');
  const candidate=run({},[web('Rectangle 1',{size:'728×90'}),web('Rectangle 2')]);
  assert.equal(candidate.web[0].placement,'Rectangle 2');
  assert.match(candidate.web[0].reason,/請核對 300×250/);
  const theme=run({topic:'城市交通'},[web('Text'),web('Text',{site:other})]);
  assert.equal(theme.web[0].site,other);
  assert.ok(run({},[web('Scroll Video')]).warnings.some(x=>x.includes('過稿')));
});

test('較大範圍試排可重現，可行方案仍逐日符合推薦倍數、硬上限與權益',()=>{
  const cells=[];
  for(let p=0;p<9;p++) for(let day=1;day<=22;day++) {
    cells.push(web('版位 '+p,{site:p<5?main:other,date:'2031-04-'+String(day).padStart(2,'0'),
      cpm:90+p,remaining:4500}));
  }
  const edits={budget:2480,hardCap:2480,siteMinimums:{[other]:6000},requiredPlacements:[main+'/版位 0']};
  const result=run(edits,cells);
  assert.equal(result.ok,true);
  assert.ok(result.totalValue<=2480);
  assert.ok(result.subtotals[other]>=6000);
  assert.ok(result.web.some(r=>r.placement==='版位 0'));
  assert.ok(result.web.every(r=>r.quantity%r.recommended===0 && r.quantity<=r.remaining));
  assert.ok(result.warnings.some(w=>w.includes('可能有更接近')));
  assert.deepEqual(run(edits,cells),result);
});

test('指定天下 Banner 可由任一天下圖片版位履行，文字、影音和其他站曝光都不能代替',()=>{
  const rows=[web('全網文字 1',{cpm:100}),web('文章頁 Rectangle 2',{cpm:45}),
    web('文章頁 Rectangle 3',{cpm:60}),web('文章頁 Scroll Video TOP',{cpm:100}),
    web('文章頁 TOP',{cpm:100,site:other})];
  const output=run({budget:60,requiredPlacements:['天下官網/Banner']}, rows);
  assert.equal(output.ok,true);
  assert.equal(output.web[0].placement,'文章頁 Rectangle 3');
  const fail=run({budget:100,requiredPlacements:['天下官網/Banner']},[rows[0],rows[3],rows[4]]);
  assert.equal(fail.ok,false);
  const both=run({budget:145,requiredPlacements:['天下官網/Banner','未來城市/Banner']}, rows);
  assert.equal(both.totalValue,145);
  assert.equal(both.placementCount,2);
});
