// CPM to cents, then divide by 1,000 impressions. All search arithmetic stays integral.
const MONEY_SCALE = 100000;
const DAY_MS = 86400000;
export const defaultPrefs = Object.freeze({
  placementOrder: Object.freeze(['Text', 'Rectangle', 'TOP', 'BOTTOM', 'Scroll Video']),
  preferredDays: 7,
  avoidMonday: true,
  sharedCreative: true
});

function number(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return NaN;
    value = Number(text.replaceAll(',', ''));
  }
  return Number.isFinite(value) && value >= 0 ? value : NaN;
}

function money(value) {
  const amount = number(value);
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents * 1000) && Math.abs(amount * 100 - cents) < 0.00001
    ? cents * 1000 : NaN;
}

function dateIndex(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value)
    ? date.getTime() / DAY_MS : NaN;
}

function siteName(name) {
  const trimmed = String(name || '').trim();
  return ['天下', '天下官網', '天下粉專'].includes(trimmed) ? '天下雜誌' : trimmed;
}

function parseRequirements(input, defaultSite, label, issues) {
  const counts = new Map();
  if (input == null) return counts;
  if (typeof input !== 'object' || Array.isArray(input)) {
    issues.push('請確認' + label + '的名稱與數量。');
    return counts;
  }
  for (const [key, raw] of Object.entries(input)) {
    const site = siteName(key) || defaultSite;
    const quantity = number(raw);
    if (!site || !Number.isSafeInteger(quantity) || counts.has(site)) {
      issues.push('請確認' + label + '「' + (key || '未指定') + '」的名稱與整數需求量。');
    } else if (quantity > 0) {
      counts.set(site, quantity);
    }
  }
  return counts;
}

function typeOf(row) {
  const name = [row.format, row.placement].filter(Boolean).join(' ');
  const types = [
    ['Scroll Video', /scroll\s*video/i], ['Text', /text|文字/i], ['Rectangle', /rectangle|方形/i],
    ['TOP', /(?:^|[^a-z])top(?:$|[^a-z])/i], ['BOTTOM', /(?:^|[^a-z])bottom(?:$|[^a-z])/i], ['Billboard', /billboard/i], ['Banner', /banner|圖片版位/i]
  ];
  return types.find(([,pattern])=>pattern.test(name))?.[0] || String(row.format || row.placement);
}

// A brief can promise a category ('天下雜誌/Banner') without naming a single product.
// Video inventory does not count towards an image right unless an actual placement is specified.
function categoryMatches(text, kind) {
  if (/^(?:banner|圖片版位|圖片|圖片廣告)$/i.test(text)) {
    return ['Rectangle','TOP','BOTTOM','Billboard','Banner'].includes(kind);
  }
  return /^(?:text|文字版位|rectangle|top|bottom|scroll\s*video|billboard)$/i.test(text)
    && (kind.toLowerCase() === text.toLowerCase() || (text === '文字版位' && kind === 'Text'));
}

function topicMatch(site, topic) {
  const rules = [
    [/CSR|永續天下|天下永續/, /環境|永續|淨零|ESG|氣候|循環/i],
    [/未來城市/, /城市|城鄉|智慧|交通|都會/],
    [/微笑台灣/, /旅遊|旅行|地方|文化|觀光/],
    [/換日線/, /國際|海外|跨國|移民/]
  ];
  return rules.some(([sitePattern, keywords]) => sitePattern.test(site) && keywords.test(topic));
}

function cleanInventory(rows, social, config) {
  const {order, sites, facebook, warnings} = config;
  const seen = new Map();
  let unknown = 0;
  for (const raw of Array.isArray(rows) ? rows : []) {
    if (!raw || typeof raw !== 'object') continue;
    const site = siteName(social ? raw.page : raw.site);
    if (!(social ? facebook : sites).has(site)) continue;
    const day = dateIndex(raw.date);
    if (!Number.isFinite(day)) { unknown++; continue; }
    if (raw.date < order.start || raw.date > order.end) continue;
    const name = String((social ? raw.slot : raw.placement) || '').trim();
    if (!name) { unknown++; continue; }
    const remaining = number(raw.remaining);
    const recommended = social ? 1 : number(raw.recommended);
    const price = money(social ? raw.unitPrice : raw.cpm);
    const stepCost = social ? price : price / 1000 * recommended;
    const valid = Number.isSafeInteger(remaining) && Number.isSafeInteger(recommended)
      && recommended > 0 && Number.isSafeInteger(stepCost);
    const key = JSON.stringify([site, name, raw.date]);
    const previous = seen.get(key);
    if (!valid || (previous && (previous.remaining !== remaining ||
        previous.recommended !== recommended || previous.stepCost !== stepCost))) {
      seen.set(key, null);
      continue;
    }
    if (seen.has(key)) continue;
    const row = social ? {...raw, page:site, slot:name, unitPrice:price / MONEY_SCALE}
      : {...raw, site, placement:name, cpm:price / MONEY_SCALE, recommended};
    seen.set(key, {row, site, name, day, remaining, recommended, stepCost,
      units:Math.floor(remaining / recommended)});
  }
  const cells = [];
  for (const cell of seen.values()) {
    if (!cell) unknown++;
    else if (cell.units > 0) cells.push(cell);
  }
  if (unknown) warnings.push((social ? 'Facebook' : '網站') + '有 ' + unknown +
    ' 格庫存、推薦量或價格未知／互相矛盾，已從試排排除。');
  return cells.sort((a,b) => a.day - b.day || a.site.localeCompare(b.site, 'zh-Hant') ||
    a.name.localeCompare(b.name, 'zh-Hant'));
}

function rowGroup(cells, keyFor) {
  const groups = new Map();
  for (const cell of cells) {
    const key = keyFor(cell);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cell);
  }
  return groups;
}

function distanceFromPreferredCount(count) {
  return Math.max(3 - count, count - 4, 0);
}

function compareFinal(a, b, budget) {
  return Math.abs(a.cost - budget) - Math.abs(b.cost - budget) ||
    distanceFromPreferredCount(a.places) - distanceFromPreferredCount(b.places) ||
    a.penalty - b.penalty || a.cost - b.cost;
}

// Keep distinct budgets, completed placements and site progress when the exact frontier is large.
// Small cases remain exhaustive; a discarded frontier is reported explicitly in the result.
function trim(states, search) {
  const entries = [...states.values()];
  if (entries.length <= search.width) return entries;
  search.limited = true;
  entries.sort((a,b) => a.cost - b.cost || b.progress - a.progress || a.penalty - b.penalty);
  const kept = new Set([entries[0], entries.at(-1)]);
  const spread = Math.floor(search.width / 4);
  for (let i = 1; i < spread; i++) kept.add(entries[Math.floor(i * (entries.length - 1) / spread)]);
  // Preserve inexpensive paths for future rights, and paths that already cover more of this site's quota.
  const buckets = new Map();
  for (const state of entries) {
    const key = [Math.min(state.places, 5), state.covered, state.used, Math.min(state.progress, 1)].join(',');
    const best = buckets.get(key);
    if (!best || state.progress > best.progress ||
        (state.progress === best.progress && state.cost < best.cost)) buckets.set(key, state);
  }
  for (const state of buckets.values()) if (kept.size < search.width) kept.add(state);
  entries.sort((a,b) => compareFinal(a, b, search.budget));
  for (const state of entries) {
    if (kept.size >= search.width) break;
    kept.add(state);
  }
  return [...kept];
}

function remember(table, state) {
  const key = [state.cost, state.places, state.covered, state.progress, state.used, state.last, state.run].join(',');
  const old = table.get(key);
  if (!old || state.penalty < old.penalty) table.set(key, state);
}

function choices(low, high, targets, search) {
  if (high < low) return [];
  if (high - low <= 18) return Array.from({length:high-low+1}, (_,i) => i+low);
  search.limited = true;
  const options = new Set([low, low+1, low+2, high-1, high]);
  for (const target of targets) {
    if (Number.isFinite(target)) {
      options.add(Math.max(low, Math.min(high, Math.floor(target))));
      options.add(Math.max(low, Math.min(high, Math.ceil(target))));
    }
  }
  for (let i=1; i<6; i++) options.add(low + Math.floor((high - low)*i/6));
  return [...options].sort((a,b) => a-b);
}

function finishGroup(states, search) {
  const merged = new Map();
  for (const s of states) remember(merged, {...s, used:false, last:0, run:0});
  return trim(merged, search);
}

function fitCap(state, cell, search) {
  if (!cell.stepCost) return cell.units;
  return Math.min(cell.units, Math.floor((search.cap - state.cost) / cell.stepCost));
}

function searchFacebook(states, cells, count, search) {
  let left = cells.reduce((sum,c) => sum+c.units, 0);
  for (const cell of cells) {
    left -= cell.units;
    const next = new Map();
    for (const s of states) {
      const needed = count-s.progress;
      const low = Math.max(0, needed-left);
      const high = Math.min(needed, fitCap(s,cell,search));
      for (const n of choices(low, high, [(search.budget-s.cost)/cell.stepCost], search)) {
        if (!n) { remember(next,s); continue; }
        remember(next,{...s, cost:s.cost+n*cell.stepCost, progress:s.progress+n,
          penalty:s.penalty+Math.max(0,n-1)*4,
          trace:{cell,n,social:true,previous:s.trace}});
      }
    }
    states = trim(next,search);
  }
  return finishGroup(states.filter(s=>s.progress===count).map(s=>({...s,progress:0})),search);
}

function ratePlacement(cell, prefs, topic) {
  const kind = typeOf(cell.row);
  const normalized = x => String(x).toLowerCase();
  const rank = prefs.placementOrder.findIndex(x=>[kind,cell.name,cell.site+'/'+cell.name]
    .map(normalized).includes(normalized(x)));
  const rankPenalty = rank < 0 ? prefs.placementOrder.length : rank;
  const imageCandidate = kind === 'Rectangle' || (['TOP','BOTTOM'].includes(kind) && /MB|行動|手機/i.test(cell.name));
  const size = String(cell.row.size || '').trim();
  const shared = imageCandidate && /(?:^|[^0-9])300\s*[×xX＊*]\s*250(?:$|[^0-9])/.test(size);
  const confirmSize = imageCandidate && !size;
  const theme = topicMatch(cell.site,topic);
  const days = kind === 'Text' ? prefs.preferredDays :
    Math.min(prefs.preferredDays, kind === 'Rectangle' ? 5 : 3);
  return {kind,theme,shared,confirmSize,days,penalty:rankPenalty*3 + (prefs.sharedCreative && !shared ? (confirmSize ? 1 : 2) : 0) +
    (theme ? 0 : 4)};
}

function searchWebsite(states, group, stage, search) {
  const {cells,required,rating} = group;
  for (let i=0; i<cells.length; i++) {
    const cell = cells[i];
    const lastCell = i===cells.length-1;
    stage.future -= cell.units * cell.recommended;
    const next = new Map();
    for (const s of states) {
      const missing = stage.minimum - s.progress;
      let low = Math.max(0,Math.ceil((missing - stage.future)/cell.recommended));
      if (lastCell && ((required && !s.used) || (s.covered & group.lastRights) !== group.lastRights)) {
        low = Math.max(1,low);
      }
      const high = fitCap(s,cell,search);
      const targets = [(search.budget-s.cost)/cell.stepCost, missing/cell.recommended];
      for (const n of choices(low,high,targets,search)) {
        if (!n) { remember(next,s); continue; }
        const contiguous = s.used && cell.day === s.last+1;
        const run = contiguous ? Math.min(s.run+1,rating.days+1) : 1;
        const monday = (cell.day + 4) % 7 === 1;
        // Starting another run incurs a cost; adjacent days up to the preferred length earn it back.
        const runPenalty = contiguous ? (run <= rating.days ? -1 : 1) : rating.days;
        const penalty = s.penalty + (s.used ? 0 : rating.penalty) + runPenalty +
          (s.used && !contiguous ? 3 : 0) + (n-1)*3 +
          (!contiguous && monday && search.avoidMonday ? 4 : 0);
        remember(next,{
          cost:s.cost+n*cell.stepCost, covered:s.covered | group.rights,
          progress:Math.min(stage.minimum,s.progress+n*cell.recommended),
          places:s.places+(s.used ? 0 : 1), used:true, last:cell.day, run, penalty,
          trace:{cell,n,rating,previous:s.trace}
        });
      }
    }
    states = trim(next,search);
  }
  return finishGroup(states.filter(s=>!required || s.used),search);
}

function preferences(input) {
  const days = number(input?.preferredDays);
  return {
    placementOrder:Array.isArray(input?.placementOrder) && input.placementOrder.length
      ? input.placementOrder : defaultPrefs.placementOrder,
    preferredDays:Number.isSafeInteger(days) && days > 0 ? days : defaultPrefs.preferredDays,
    avoidMonday:typeof input?.avoidMonday==='boolean' ? input.avoidMonday : defaultPrefs.avoidMonday,
    sharedCreative:typeof input?.sharedCreative==='boolean' ? input.sharedCreative : defaultPrefs.sharedCreative
  };
}

export function planCue(order = {}, inventory = {}, personalPrefs = defaultPrefs) {
  const issues = [];
  const warnings = Array.isArray(inventory.warnings) ? [...inventory.warnings] : [];
  const result = {ok:false,web:[],social:[],subtotals:{},totalImpressions:0,totalValue:0,
    delta:null,placementCount:0,issues,warnings,queriedAt:inventory.queriedAt || null,bookingType:'一般'};
  const budget = money(order.budget);
  const cap = order.hardCap == null || order.hardCap === '' ? Number.MAX_SAFE_INTEGER : money(order.hardCap);
  if (!Number.isFinite(budget)) issues.push('請確認本案排 Cue 的總預算。');
  if (!Number.isFinite(cap)) issues.push('請確認本案的預算硬上限。');
  if (!Number.isFinite(dateIndex(order.start)) || !Number.isFinite(dateIndex(order.end)) ||
      order.start>order.end) issues.push('請確認有效的走期起日與迄日。');
  const prefs = preferences(personalPrefs);
  const sites = new Set((Array.isArray(order.sites) ? order.sites : []).map(siteName).filter(Boolean));
  const minimums = parseRequirements(order.siteMinimums, '', '指定站別最低曝光', issues);
  const facebook = parseRequirements(order.facebook, '天下雜誌', 'Facebook 權益', issues);
  if (!sites.size && !facebook.size) issues.push('請填寫可曝光網站或 Facebook 粉專與篇數。');
  for (const site of minimums.keys()) if (!sites.has(site)) issues.push(site+' 未列入可曝光網站。');
  if (issues.length) return result;

  const config = {order,sites,facebook,warnings};
  const webCells = cleanInventory(inventory.web,false,config);
  const fbGroups = rowGroup(cleanInventory(inventory.social,true,config), c=>c.site);
  const webGroups = [...rowGroup(webCells,c=>JSON.stringify([c.site,c.name])).values()].map(cells=>({
    cells,site:cells[0].site,name:cells[0].name,required:false,rights:0n,lastRights:0n,
    rating:ratePlacement(cells[0],prefs,String(order.topic || '')+' '+String(order.name || ''))
  }));
  const requirements = Array.isArray(order.requiredPlacements) ? order.requiredPlacements : [];
  let allRights = 0n;
  for (const raw of new Set(requirements)) {
    const text = String(raw || '').trim();
    const slash = text.indexOf('/');
    const matches = webGroups.filter(g=>g.name===text || (slash>0 &&
      g.site===siteName(text.slice(0,slash)) && g.name===text.slice(slash+1).trim()));
    if (matches.length===1) matches[0].required = true;
    else if (matches.length>1) issues.push('指定版位「'+text+'」跨站同名，請加上站名/版位。');
    else {
      const label = slash < 0 ? text : text.slice(slash+1).trim();
      const category = webGroups.filter(g=>(slash<0 || g.site===siteName(text.slice(0,slash))) &&
        categoryMatches(label,g.rating.kind));
      if (category.length===1) category[0].required = true;
      else if (category.length>1) {
        const bit = allRights+1n;
        allRights |= bit;
        for (const g of category) g.rights |= bit;
      } else issues.push('指定版位「'+text+'」沒有已核實且至少達一倍推薦量的當期庫存。');
    }
  }
  for (const [site,need] of minimums) {
    const capacity = webCells.filter(c=>c.site===site).reduce((s,c)=>s+c.units*c.recommended,0);
    if (capacity<need) issues.push(site+'的已知可排曝光為 '+capacity.toLocaleString('en-US')+
      ' 次，低於該站門檻 '+need.toLocaleString('en-US')+' 次。');
  }
  for (const [page,need] of facebook) {
    const capacity = (fbGroups.get(page)||[]).reduce((s,c)=>s+c.units,0);
    if (capacity<need) issues.push(page+' Facebook 已知可排 '+capacity+' 次，權益需要 '+need+' 篇。');
  }
  if (!webCells.length && !facebook.size && !issues.length) issues.push('走期內沒有已確認且足一倍推薦量的可排網站庫存。');
  if (issues.length) return result;

  const cellCount = webCells.length + [...fbGroups.values()].reduce((sum,g)=>sum+g.length,0);
  const search = {budget,cap,limited:false,width:cellCount<=16 ? 1200 : cellCount<=100 ? 240 : 96,
    avoidMonday:prefs.avoidMonday};
  let states = [{cost:0,progress:0,places:0,covered:0n,used:false,last:0,run:0,penalty:0,trace:null}];
  for (const [page,need] of facebook) {
    states = searchFacebook(states,fbGroups.get(page),need,search);
  }
  const groupsBySite = rowGroup(webGroups,g=>g.site);
  for (const groups of groupsBySite.values()) {
    groups.sort((a,b)=>Number(b.required)-Number(a.required) || a.rating.penalty-b.rating.penalty ||
      a.name.localeCompare(b.name,'zh-Hant'));
  }
  let laterRights = 0n;
  for (const group of [...groupsBySite.values()].flat().reverse()) {
    group.lastRights = group.rights & ~laterRights;
    laterRights |= group.rights;
  }
  for (const [site,groups] of groupsBySite) {
    const stage = {minimum:minimums.get(site)||0,future:0};
    for (const group of groups) for (const cell of group.cells) stage.future += cell.units*cell.recommended;
    for (const group of groups) states=searchWebsite(states,group,stage,search);
    states=finishGroup(states.filter(s=>s.progress>=stage.minimum).map(s=>({...s,progress:0})),search);
  }
  if (search.limited) warnings.push('組合較多，本次保留多種金額與曝光進度試排，可能有更接近預算的組合。');
  const eligible = states.filter(s=>s.trace && s.covered===allRights);
  if (!eligible.length) {
    issues.push(search.limited ? '本次試算範圍內未找到同時符合權益、走期、庫存及金額限制的組合。' :
      '在已知庫存中，沒有同時符合權益、走期及金額限制的組合。');
    return result;
  }
  eligible.sort((a,b)=>compareFinal(a,b,budget));
  const best = eligible[0];
  result.ok=true;
  result.totalValue=best.cost/MONEY_SCALE;
  result.delta=(best.cost-budget)/MONEY_SCALE;
  result.placementCount=best.places;
  result.subtotals=Object.fromEntries([...sites].map(site=>[site,0]));
  for (let step=best.trace; step; step=step.previous) {
    const {cell,n,rating} = step;
    const value = cell.stepCost*n/MONEY_SCALE;
    if (step.social) {
      result.social.push({...cell.row,remaining:cell.remaining,quantity:n,value,
        reason:'指定粉專的當日可用時段，配合 '+facebook.get(cell.site)+' 篇權益。'});
      continue;
    }
    const quantity = n*cell.recommended;
    const reasons = ['當日推薦量 × '+n+'，配合整單價值目標'];
    if (minimums.has(cell.site)) reasons.push('計入'+cell.site+'曝光門檻');
    if (rating.theme) reasons.push('頻道與稿件主題相符');
    if (rating.shared && prefs.sharedCreative) reasons.push('可共用 300×250 素材');
    else if (rating.confirmSize && prefs.sharedCreative) reasons.push('共用素材候選，請核對 300×250 規格');
    result.web.push({...cell.row,remaining:cell.remaining,quantity,value,reason:reasons.join('；')+'。'});
    result.subtotals[cell.site]+=quantity;
    result.totalImpressions+=quantity;
  }
  const byDate = (a,b)=>a.date.localeCompare(b.date);
  result.web.reverse().sort(byDate);
  result.social.reverse().sort(byDate);
  if (distanceFromPreferredCount(best.places)) warnings.push('本次採 '+best.places+
    ' 個網站版位。按指定權益與已知庫存試排，選擇與總預算差額最小的保留方案；Facebook 另計。');
  if (result.web.some(row=>typeOf(row)==='Scroll Video')) warnings.push('採用 Scroll Video，請核對影音素材與過稿時間。');
  return result;
}
