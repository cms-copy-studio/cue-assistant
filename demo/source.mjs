// A GitHub Pages demo has no Chrome permissions and only ships invented data.
const main = '天下雜誌', city = '未來城市';
const dates = Array.from({length:10},(_,i)=>'2027-03-'+String(i+1).padStart(2,'0'));
const examples = [
  {id:'DEMO-A',name:'綠色街區讀本',topic:'城市生活、智慧城市',start:dates[0],end:dates[8],
    originalBudget:65000,budget:138000,hardCap:null,sites:[main,city],siteMinimums:{[main]:105000},
    requiredPlacements:[],facebook:{[main]:1},pv:'上線後追蹤 4,000 PV',notes:'示範權益已列在各站最低曝光與粉專欄，可改條件後重新試排。'},
  {id:'DEMO-B',name:'海岸走讀工作坊',topic:'在地旅行',start:dates[2],end:dates[5],
    originalBudget:28000,budget:62500,hardCap:66000,sites:['微笑台灣'],siteMinimums:{'微笑台灣':35000},
    requiredPlacements:[],facebook:{},pv:'上線後追蹤 1,200 PV',notes:''},
  {id:'DEMO-C',name:'河岸策展邀請',topic:'文化',start:dates[0],end:dates[1],
    originalBudget:18000,budget:40000,hardCap:null,sites:[city],siteMinimums:{[city]:220000},
    requiredPlacements:[],facebook:{[city]:2},pv:'',notes:''}
];
const placements = [
  [main,'全網 Text A','Text',35000,210,'文字'],[main,'首頁 Rectangle A','Rectangle',10000,350,'300×250'],
  [main,'MB 文章頁 TOP','TOP',12000,440,'300×250'],[city,'城市全網 Text A','Text',16000,245,'文字'],
  [city,'城市 Rectangle B','Rectangle',8000,360,'300×250'],['微笑台灣','旅行全網 Text B','Text',14000,235,'文字'],
  ['微笑台灣','旅行 Rectangle A','Rectangle',7000,420,'300×250'],['微笑台灣','MB 文章頁 BOTTOM','BOTTOM',9000,445,'300×250']
];
const web=placements.flatMap(([site,placement,format,recommended,cpm,size],j)=>dates.map((date,i)=>({
  site,placement,format,recommended,cpm,size,date,
  remaining:j===0&&i===0?42000:j===0&&i===1?70000:(i+j)%13===5?null:(i+j)%9===4?0:recommended*(1+((i+j)%3))
})));
const social=[main,city].flatMap((page,j)=>dates.flatMap((date,i)=>['12:00','16:00'].map((slot,k)=>({
  page,date,slot,unitPrice:j?12000:18500,remaining:j===1&&i<2?null:(i+k)%4===0?0:1
}))));
export async function connect({onChange}) {
  let current=examples[0];
  let prefs={};
  const identity=async id=>{ if(id!==current.id) throw Error('已切換示範訂單，請重新查詢。'); };
  return {demo:true,scenarios:examples.map(e=>({id:e.id,label:e.name})),
    chooseScenario(id) {const next=examples.find(e=>e.id===id);if(next){current=next;onChange();}},
    async read(){return {order:structuredClone(current),identity:current.id};},
    assertIdentity:identity,
    async inventory(id,order){
      await identity(id);
      const within=row=>row.date>=order.start&&row.date<=order.end;
      const outside=order.start<dates[0]||order.end>dates.at(-1);
      return structuredClone({web:web.filter(row=>within(row)&&order.sites.includes(row.site)),
        social:social.filter(row=>within(row)&&order.facebook[row.page]>0),queriedAt:new Date().toISOString(),
        warnings:outside?['模擬庫存僅涵蓋 2027/03/01 至 03/10，其餘日期未知。']:[]});
    },
    async loadPrefs(){return structuredClone(prefs);}, async savePrefs(value){prefs=structuredClone(value);}
  };
}
