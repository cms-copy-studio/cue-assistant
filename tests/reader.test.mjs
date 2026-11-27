import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const program = readFileSync(new URL("../extension/reader.js",import.meta.url),"utf8");
function reader(globals={}) {
  const module={exports:{}};
  runInNewContext(program,{module,setTimeout,clearTimeout,...globals});
  return module.exports;
}
const {orderFromRows,exposureRemaining,gridDates,socialStock,catalogPage}=reader();
const example=[
  ["訂單編號","101","訂單名稱","模擬活動"],
  ["預算","NT$ 85,000","檔期","2032/12/30 ~ 2033/01/03"],
  ["可曝光網站","天下官網 / CSR"],
  ["指定版位","天下官網/模擬 Text、CSR/模擬 Rectangle"],
  ["指定社群工具","Facebook、Instagram"],
  ["宣傳廣告類型","模擬圖文"],
  ["KPI","文章 PV 3000"],
  ["其他說明","天下官網至少 20 萬次曝光。天下與未來城市各一篇 FB。"]
];
test("order detail attributes are identified by labels and bound to the URL id",()=>{
  const got=orderFromRows(example,"/orders/101/");
  assert.equal(got.identity,"101");
  assert.equal(got.order.budget,null);
  assert.equal(got.order.originalBudget,85000);
  assert.equal(got.order.end,"2033-01-03");
  assert.equal(got.order.facebook["未來城市"],1);
  assert.equal(got.order.facebook["天下雜誌"],1);
  assert.equal(got.order.siteMinimums["天下雜誌"],200000);
  assert.equal(got.order.pv,"文章 PV 3000");
  assert.match(got.order.notes,/宣傳廣告類型：模擬圖文/u);
  assert.ok(got.warnings.some(w=>w.includes("以外")));
  assert.equal(got.order.requiredPlacements.join("、"),"天下雜誌/模擬 Text、CSR/模擬 Rectangle");
  assert.throws(()=>orderFromRows(example,"/orders/202"));
  const pvOnly=orderFromRows([["訂單編號","101"],["KPI","天下官網至少 3000 次 PV"]],"/orders/101");
  assert.equal(Object.keys(pvOnly.order.siteMinimums).length,0);
  assert.throws(()=>orderFromRows([],"/orders/101"));
});
test("exact exposure is the labeled numerator; zero, missing and a color range differ",()=>{
  assert.equal(exposureRemaining("剩餘：0/50,500"),0);
  assert.equal(exposureRemaining("剩餘：17,500/50,500"),17500);
  for(const text of ["20%～49%","剩餘：12%","剩餘：12/90%","剩餘：12/90–100","剩餘：剩餘量未知","剩餘：51,500/50,500","預訂量：21000/36000"]) assert.equal(exposureRemaining(text),null);
  assert.equal(socialStock("1"),1);
  assert.equal(socialStock("0"),0);
  assert.equal(socialStock("-"),null);
});
test("visible date range and every calendar heading must describe the same dates",()=>{
  const range="2032\n12/30 → 2033\n1/02";
  assert.equal(Array.from(gridDates(range,["30 四","31 五","1 六","2 日"])).join(","),"2032-12-30,2032-12-31,2033-01-01,2033-01-02");
  assert.equal(gridDates(range,["29","30","31","1"]),null);
  assert.equal(gridDates("12/30 至 1/02",["30","31","1","2"]),null);
});
test("rates use the named recommended amount and CPM, independent of column order",()=>{
  const table={
    querySelectorAll(q){
      if(q==="thead th")return ["CPM","狀態","建議單次預訂曝光量","版位名稱","曝光網站"].map(innerText=>({innerText}));
      return [["190","上架","35,000","測試 Text","天下官網"],["3","下架","2","示範","天下官網"]].map(row=>({cells:row.map(innerText=>({innerText}))}));
    }
  };
  const rows=catalogPage(table,false,new Set(["天下雜誌"]));
  assert.equal(rows.length,1);
  assert.equal(rows[0].recommended,35000);
  assert.equal(rows[0].cpm,190);
});
test("successive live-shaped cell popups return A→B→A; a missing popup is unknown",async()=>{
  let tooltipVisible=false,amount=null,reference;
  const makeRect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height});
  const overlay={
    isConnected:true,closest:()=>null,getClientRects:()=>[{}],
    getBoundingClientRect:()=>makeRect(reference.x-120,120,280,116),
    querySelector:()=>({innerText:"剩餘："+amount+"/50500"})
  };
  const doc={
    body:{},documentElement:{},querySelector(selector) {
      if(selector==="#tooltip")return overlay;
      if(selector==="#tooltip .header")return {innerText:"剩餘："+amount+"/50500"};
      return {querySelector:()=>({click(){tooltipVisible=false;}})};
    }
  };
  function cell(x,value){
    const c={x,isConnected:true,getBoundingClientRect:()=>makeRect(x,230,40,39),scrollIntoView(){},dispatchEvent(){}};
    c.firstElementChild={
      getBoundingClientRect:c.getBoundingClientRect,
      dispatchEvent(e){
        if(e.type==="mouseout" || e.type==="mouseleave")tooltipVisible=false;
        if(e.type==="click" && value!==null){reference=c;amount=value;tooltipVisible=true;}
      }
    };
    return c;
  }
  class Observer {observe(){} disconnect(){}}
  class Mouse {constructor(type){this.type=type;}}
  const dom=reader({document:doc,window:{},getComputedStyle:()=>({display:"block",visibility:tooltipVisible?"visible":"hidden"}),MouseEvent:Mouse,MutationObserver:Observer});
  const a=cell(340,0),b=cell(380,17500),missing=cell(420,null),state={};
  assert.equal(await dom.readCell(a,state),0);
  assert.equal(await dom.readCell(b,state),17500);
  assert.equal(await dom.readCell(a,state),0);
  assert.equal(await dom.readCell(missing,state),null);
  const stale=cell(380,1);
  stale.firstElementChild.dispatchEvent=e=>{
    if(e.type==="click"){reference=a;amount=17500;tooltipVisible=true;}
  };
  assert.equal(await dom.readCell(stale,state),null);
});
function loadingOrder() {
  let rows=[], notify=()=>{};
  const location={pathname:"/orders/101/"};
  class Observer {
    constructor(fn){this.callback=fn;}
    observe(){notify=this.callback;}
    disconnect(){notify=()=>{};}
  }
  const document={documentElement:{},querySelectorAll:()=>rows};
  const api=reader({document,location,MutationObserver:Observer});
  return {
    read:timeout=>api.readOrderWhenReady(timeout),
    render(pairs,path=location.pathname) {
      location.pathname=path;
      rows=pairs.map(row=>({cells:row.map((innerText,i)=>({
        innerText, matches:()=>i%2===0,
        nextElementSibling:{innerText:row[i+1],matches:()=>true}
      }))}));
      notify();
    }
  };
}
test("readOrder waits through an empty shell, old order and id-only intermediate render",async()=>{
  const screen=loadingOrder();
  const pending=screen.read(100);
  screen.render([["訂單編號","999","訂單名稱","示意舊單"]]);
  screen.render([["訂單編號","101"]]);
  screen.render([["訂單編號","101","訂單名稱","載入完成"]]);
  const result=await pending;
  assert.equal(result.identity,"101");
  assert.equal(result.order.name,"載入完成");
  assert.equal(result.order.originalBudget,null);
});
test("navigation during readiness or before delivery rejects the original read",async()=>{
  const screen=loadingOrder();
  const pending=screen.read(100);
  screen.render([["訂單編號","202","訂單名稱","另一張"]],"/orders/202");
  await assert.rejects(pending,/切換訂單/);
  const first=loadingOrder(),race=first.read(100);
  first.render([["訂單編號","101","訂單名稱","第一張"]]);
  first.render([["訂單編號","303","訂單名稱","第三張"]],"/orders/303");
  await assert.rejects(race,/切換訂單/);
});
test("a shell with no matching read-only fields ends with a bounded retry instruction",async()=>{
  const screen=loadingOrder();
  screen.render([["訂單編號","101"]]);
  await assert.rejects(screen.read(15),/逾時.*重新讀取原單/);
});
