// Content script. The only clicks are on the inventory and price screens opened for this query.
(() => {
  "use strict";
  const origin = "https://ad-pro.cwg.tw";
  const clean = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const normalizedSite = value => {
    const name = clean(value);
    return /^(天下|天下官網|天下雜誌官網|天下主站)$/.test(name) ? "天下雜誌" : name;
  };
  const fields = {
    id: ["訂單編號", "訂單序號"], name: ["訂單名稱", "專案名稱", "案名"],
    originalBudget: ["預算", "宣傳預算", "宣傳項目預算"], budget: ["本案排 Cue 的總預算", "排 Cue 總預算", "Cue 總預算"],
    hardCap: ["硬上限", "價值硬上限"], range: ["檔期", "走期"], sites: ["可曝光網站", "曝光網站", "可曝光頻道"],
    facebook: ["指定社群工具", "社群需求"], advertising: ["宣傳廣告類型"], pv: ["KPI", "約定 KPI"], notes: ["其他說明", "備註"],
    topic: ["稿件主題", "主題"], required: ["指定版位", "客戶指定版位"]
  };
  const dayMs = 86400000;
  const textOf = el => el?.innerText ?? el?.textContent ?? "";
  function number(value) {
    const token = clean(value).replace(/^(?:NT\$|\$)\s*/iu, "").replace(/\s*(?:元|次)$/, "");
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(token)) return null;
    const result = Number(token.replaceAll(",", ""));
    return Number.isFinite(result) && result <= Number.MAX_SAFE_INTEGER ? result : null;
  }
  function iso(y, m, d) {
    const stamp = Date.UTC(+y, +m - 1, +d);
    if (!Number.isFinite(stamp)) return null;
    const day = new Date(stamp);
    if (day.getUTCFullYear() !== +y || day.getUTCMonth() + 1 !== +m || day.getUTCDate() !== +d) return null;
    return day.toISOString().slice(0, 10);
  }
  function dates(value) {
    return Array.from(clean(value).matchAll(/\b(20\d{2})\s*(?:[-/.年]\s*|\s+)(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?!\d)/gu), m => iso(...m.slice(1))).filter(Boolean);
  }
  function splitNames(value) {
    return [...new Set(String(value || "").split(/\s*[/／、，,;；\n]\s*/u).map(clean).filter(Boolean))];
  }
  // Read exact label/value cell pairs. A row can contain several labels.
  function valuesFromRows(rows) {
    const values = Object.create(null);
    for (const row of rows) {
      for (let i = 0; i < row.length - 1; i += 2) {
        const label = clean(row[i]).replace(/[:*]+$/g, "");
        for (const [field, labels] of Object.entries(fields)) {
          if (labels.includes(label) && values[field] === undefined) values[field] = row[i + 1].trim();
        }
      }
    }
    return values;
  }
  const pageAliases = { CW:"天下雜誌", CSR:"CSR", FC:"未來城市", ST:"微笑台灣", CHEERS:"Cheers", "銀天下":"銀天下" };
  function socialName(name) {
    const value = clean(name);
    const prefix = /^([^_()（）]+)_FB/i.exec(value)?.[1].trim().toUpperCase();
    // An unmapped backend prefix matches only the same explicit page name in the draft.
    if (prefix) return pageAliases[prefix] || prefix;
    return ["天下雜誌","天下官網","天下","未來城市","微笑台灣","CSR","換日線"].find(site => value.includes(site)) || null;
  }
  const zhNumbers = {一:1,二:2,兩:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
  const qty = token => zhNumbers[token] ?? Number(token);
  function parseRights(info) {
    const warnings = [];
    const sites = splitNames(info.sites).map(normalizedSite);
    const notes = info.notes || "";
    const pv = info.pv || "";
    const siteMinimums = {};
    const facebook = {};
    const minimum = /(天下(?:雜誌)?(?:官網)?|CSR|未來城市|微笑台灣|換日線)\s*(?:網站|Banner)?\s*(曝光(?:量)?)?\s*(?:至少|保證|最低)\s*(曝光(?:量)?)?\s*([\d,.]+)\s*(萬)?\s*(次)?\s*(?:網站|Banner)?\s*(曝光)?/giu;
    for (const match of (pv + "\n" + notes).matchAll(minimum)) {
      if (!match[2] && !match[3] && !match[7]) {
        const suffix=match.input.slice(match.index+match[0].length);
        if (!match[6] || /^\s*(?:PV|瀏覽|閱讀|點擊|收聽|觀看)/iu.test(suffix)) continue;
      }
      const n = number(match[4]);
      if (n !== null) {
        const site = normalizedSite(match[1]);
        siteMinimums[site] = Math.max(siteMinimums[site] || 0, n * (match[5] ? 10000 : 1));
      }
    }
    const social = info.facebook || "";
    const relevant = [social, ...notes.split(/[。；;\n]/u).filter(s => /facebook|FB|粉專/i.test(s))].join("\n");
    const exclusion=/(?:禁止|不得|不需要?|無需|不用|不要|免上|不排|不安排|無)\s*(?:上|安排|使用)?\s*(?:facebook|FB|粉專)|(?:facebook|FB|粉專)\s*(?:不排|不用|無需|不需要?|禁止|免排)/iu;
    if (exclusion.test(relevant)) {
      warnings.push("原單含社群排除條件，請核對指定粉專後確認篇數。");
    } else if (/facebook|FB|粉專/i.test(relevant)) {
      const names = "(天下(?:雜誌)?(?:官網)?|未來城市|微笑台灣|CSR|換日線)";
      const lead = new RegExp(names + "\\s*(?:(?:Facebook|FB|粉專|轉貼|發文|貼文|貼文數|發|貼|文|粉絲頁|各|[:：])\\s*)*([0-9一二兩三四五六七八九十]+)\\s*(?:篇|則|次)", "giu");
      for (const match of relevant.matchAll(lead)) facebook[normalizedSite(match[1])] = qty(match[2]);
      const shared = new RegExp(names + "\\s*(?:與|和|及|、)\\s*" + names + "\\s*(?:(?:Facebook|FB|粉專|貼文)\\s*)*各\\s*([0-9一二兩三四五六七八九十]+)\\s*(?:篇|則|次)", "giu");
      for (const match of relevant.matchAll(shared)) for (const site of match.slice(1,3)) facebook[normalizedSite(site)] = qty(match[3]);
      if (!Object.keys(facebook).length) {
        const listed = [...new Set(Array.from(relevant.matchAll(new RegExp(names, "giu")), m => normalizedSite(m[0])))];
        const count = relevant.match(/([0-9一二兩三四五六七八九十]+)\s*(?:篇|則|次)/u);
        const explicitFacebook=/facebook|FB|粉專/i.test(social) || /安排|需求|貼文|粉專|轉貼/.test(relevant);
        if (explicitFacebook && listed.length <= 1 && (!listed.length || count)) {
          facebook[listed[0] || "天下雜誌"] = count ? qty(count[1]) : 1;
          if (!count) warnings.push("原單有 Facebook 需求，篇數先帶 1，請核對原始權益。");
        } else warnings.push("原單提及 Facebook，請確認各粉專與篇數後填入。");
      }
    }
    if (/(?:Instagram|\bIG\b|限動|LINE|電子報|每日報|Podcast)/iu.test(social)) warnings.push("原單另列 Facebook 以外的社群工具，請人工核對這些權益。");
    if (notes || pv) warnings.push("請對照 KPI 與其他說明，確認指定網站、曝光門檻、社群篇數與特殊權益。");
    return {sites:[...new Set(sites)],siteMinimums,facebook,warnings};
  }
  function orderFromRows(rows, path, requireFields=false) {
    const pathId = /^\/orders\/(\d+)\/?$/.exec(path)?.[1];
    if (!pathId) throw Error("請先開啟一張訂單的明細頁。");
    const info = valuesFromRows(rows);
    if (clean(info.id) !== pathId) throw Error("頁面與訂單編號尚未一致，請稍候再讀取。");
    if (requireFields && !Object.keys(info).some(key=>key!=="id")) throw Error("訂單欄位仍在載入。");
    const range = dates(info.range);
    const rights = parseRights(info);
    const order = {
      id:pathId, name: info.name || "", start:range[0] || "", end:range[1] || "",
      originalBudget:number(info.originalBudget), budget:number(info.budget), hardCap:number(info.hardCap),
      sites:rights.sites, siteMinimums:rights.siteMinimums, requiredPlacements:[...new Set(String(info.required || "").split(/[、，,；;\n]/u)
        .map(value=>clean(value).replace(/^([^/／]+)\s*[/／]\s*/u,(_whole,site)=>normalizedSite(site)+"/")).filter(Boolean))],
      facebook:rights.facebook, topic:info.topic || "", pv:info.pv || "",
      notes:[info.notes, info.advertising && "宣傳廣告類型：" + info.advertising,
        info.facebook && "指定社群工具：" + info.facebook].filter(Boolean).join("\n")
    };
    return {identity:pathId,order,warnings:rights.warnings};
  }
  function readOrder(requireFields = false) {
    // Existing cue tables also contain dates. Only actual backend title/value pairs are order attributes.
    const rows=Array.from(document.querySelectorAll("tr"), row => {
      const pairs=[];
      for (const cell of row.cells) {
        if (cell.matches("td.title,th.title") && cell.nextElementSibling?.matches("td:not(.title)")) {
          pairs.push(textOf(cell),textOf(cell.nextElementSibling));
        }
      }
      return pairs;
    });
    return orderFromRows(rows,location.pathname,requireFields);
  }
  async function readOrderWhenReady(timeout=8000) {
    const expectedPath=location.pathname;
    const expectedId=/^\/orders\/(\d+)\/?$/.exec(expectedPath)?.[1];
    if (!expectedId) throw Error("請先開啟一張訂單的明細頁。");
    const changed="等待期間已切換訂單，請重新讀取。";
    const ready=await waitFor(()=>{
      if (location.pathname!==expectedPath) return {changed:true};
      // The order screen first renders a shell and can briefly show the previous order's cells.
      try {return readOrder(true);} catch {return null;}
    },timeout);
    if (ready?.changed || location.pathname!==expectedPath) throw Error(changed);
    if (!ready) throw Error("等待訂單明細逾時：請確認已登入、訂單編號與欄位已顯示，再按「重新讀取原單」。");
    const fresh=readOrder(true);
    if (fresh.identity!==expectedId || location.pathname!==expectedPath) throw Error(changed);
    return fresh;
  }
  // Only remaining/total from a labeled detail is accepted for exposure.
  function exposureRemaining(value) {
    const m = clean(value).match(/^剩餘(?:曝光量)?\s*:\s*([\d,]+)\s*\/\s*([\d,]+)$/u);
    if (!m) return null;
    const left = number(m[1]), total = number(m[2]);
    return Number.isSafeInteger(left) && Number.isSafeInteger(total) && left <= total ? left : null;
  }
  function gridDates(range, columns) {
    const bounds = dates(range);
    if (bounds.length !== 2 || !columns.length) return null;
    const start = Date.parse(bounds[0]), end = Date.parse(bounds[1]);
    if ((end - start) / dayMs !== columns.length - 1) return null;
    const days = [];
    for (let i=0;i<columns.length;i++) {
      const d = new Date(start+i*dayMs);
      const match = clean(columns[i]).match(/^(?:(?:\d{4}[/-])?\d{1,2}[/-])?(\d{1,2})(?:\s|[（(日一二三四五六週星期]|$)/u);
      if (!match || +match[1] !== d.getUTCDate()) return null;
      days.push(d.toISOString().slice(0,10));
    }
    return days;
  }
  function visible(el) {
    if (!el?.isConnected || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility === "visible" && !el.closest('[hidden],[aria-hidden="true"]');
  }
  // Background tabs can throttle intervals. Observe Vue's mutations directly.
  function waitFor(read, timeout=5000) {
    return new Promise(resolve => {
      let timer, done = false;
      const observer = new MutationObserver(check);
      function finish(value) {
        if (done) return;
        done = true; observer.disconnect(); clearTimeout(timer); resolve(value);
      }
      function check() {
        try { const value = read(); if (value !== null && value !== undefined && value !== false) finish(value); }
        catch { finish(null); }
      }
      observer.observe(document.documentElement, {subtree:true,childList:true,characterData:true,attributes:true});
      timer = setTimeout(() => finish(null), timeout);
      check();
    });
  }
  function tableWith(label) {
    return Array.from(document.querySelectorAll("table")).find(t =>
      Array.from(t.querySelectorAll("thead th"), h=>clean(textOf(h))).includes(label) && visible(t));
  }
  function catalogPage(table, isSocial, sites) {
    const headers=Array.from(table.querySelectorAll("thead th"),h=>clean(textOf(h)).replace(/\s/g,""));
    const field = name => headers.indexOf(name);
    const indexes = isSocial ? [field("社群工具名稱"),field("社群類型"),field("單次發送價格"),field("狀態")]
      : [field("版位名稱"),field("曝光網站"),field("建議單次預訂曝光量"),field("CPM"),field("狀態")];
    if (indexes.includes(-1)) throw Error("版位目錄表頭已變更，請核對後台。");
    const rows=[];
    for (const tr of table.querySelectorAll("tbody tr")) {
      if (tr.cells.length < headers.length) continue;
      const cells=indexes.map(i=>clean(textOf(tr.cells[i])));
      const status=cells.pop();
      if (/停用|關閉|下架|未啟用|未上架|到期|失效|草稿|禁用/.test(status)) continue;
      const [name,siteOrType,amount,cpm]=cells;
      if (!name) continue;
      if (isSocial) {
        if (/^(?:facebook|fb)$/i.test(siteOrType)) rows.push({name,unitPrice:number(amount)});
      } else {
        const site=normalizedSite(siteOrType);
        if (sites.has(site)) rows.push({site,placement:name,recommended:number(amount),cpm:number(cpm)});
      }
    }
    return rows;
  }
  const nextTokens = /^(?:下一頁|下頁|next(?: page)?|[›»❯])$/iu;
  function nextCatalogPage() {
    const controls=document.querySelectorAll(".pagination button,.pagination a,.pagination li,[aria-label*=分頁] button,[aria-label*=pagination i] button,.paginate-buttons,button[aria-label],a[rel=next]");
    const matches = Array.from(controls).filter(el => {
      if (!visible(el) || el.disabled || el.closest('[disabled],[aria-disabled="true"],.disabled,.is-disabled')) return false;
      if (el.matches('li') && el.querySelector("a,button")) return false;
      return [el.getAttribute("aria-label"),el.getAttribute("title"),textOf(el)].some(v => nextTokens.test(clean(v))) ||
        el.getAttribute("rel")==="next" || el.matches(".next,.next-page,.btn-next") ||
        Boolean(el.closest(".page-item.next"));
    });
    return matches.find(el=>el.tagName!=="A" || !el.getAttribute("href") || el.getAttribute("href").startsWith("#") ||
      new URL(el.href).pathname===location.pathname);
  }
  async function readCatalog(order,isSocial) {
    const wanted = isSocial ? "社群工具名稱" : "版位名稱";
    const key = isSocial?"socialRates":"rates";
    const sites=new Set(order.sites || []);
    const result=new Map(), warnings=[];
    let table=await waitFor(()=>{
      const current=tableWith(wanted);
      return current && [...current.querySelectorAll("tbody tr")].some(row=>row.cells.length>2) && current;
    });
    if (!table) return {[key]:[],warnings:["未能讀取後台單價目錄。"]};
    const visited = new Set();
    while (table) {
      const signature=clean(textOf(table.tBodies[0]));
      if (visited.has(signature)) { warnings.push("目錄換頁後重複，部分版位費率未知。"); break; }
      visited.add(signature);
      // Infinite scroll appends to the same table; keep each distinct catalog entry only once.
      for (const entry of catalogPage(table,isSocial,sites)) result.set(JSON.stringify(entry),entry);
      const next=nextCatalogPage();
      if (next) next.click();
      else {
        // The current catalog appends rows in #page-content on reaching the bottom.
        const scroll=document.querySelector("#page-content");
        if (!scroll || scroll.scrollHeight <= scroll.clientHeight) break;
        scroll.scrollTop=scroll.scrollHeight;
        scroll.dispatchEvent(new Event("scroll"));
      }
      table=await waitFor(()=>{
        const t=tableWith(wanted);
        const body=t?.tBodies[0];
        return body?.rows.length && body.rows[0].cells.length>2 && clean(textOf(body))!==signature && t;
      });
      if (!table && next) warnings.push("目錄換頁未完成，部分版位費率未知。");
    }
    return {[key]:[...result.values()],warnings};
  }
  const stockTable = () => document.querySelector("#stock-container table.home-info");
  function currentDates() {
    const table=stockTable();
    const headings=table && Array.from(table.querySelectorAll("thead th.date"), h=>textOf(h.querySelector(".date-number") || h));
    const left=document.querySelector(".left-button"), right=document.querySelector(".right-button");
    if (!headings?.length || !left || !right) return null;
    for (let scope=left.parentElement;scope && scope!==document.body;scope=scope.parentElement) {
      if (!scope.contains(right)) continue;
      const datePair=Array.from(scope.querySelectorAll("p"), p=>textOf(p)).filter(v=> dates(v).length===1);
      const range=gridDates(datePair.join(" "),headings) || gridDates(textOf(scope),headings);
      if (range) return range;
    }
    return null;
  }
  async function shiftGrid(direction, before) {
    const control=document.querySelector(direction>0?".right-button":".left-button");
    if (!control || control.disabled || !visible(control)) return null;
    const oldBody=stockTable()?.tBodies[0];
    if (!oldBody) return null;
    let rowsRefreshed=false;
    const observer=new MutationObserver(changes=>{
      if (changes.some(change=>{
        const el=change.target.nodeType===Node.ELEMENT_NODE?change.target:change.target.parentElement;
        return change.type==="childList" || Boolean(el?.closest("td.stock-block"));
      })) rowsRefreshed=true;
    });
    observer.observe(oldBody,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["class"]});
    try {
      control.click();
      const expected=new Date(Date.parse(before[0])+direction*before.length*dayMs).toISOString().slice(0,10);
      return await waitFor(()=>{
        const days=currentDates();
        const newBody=stockTable()?.tBodies[0];
        return days?.[0]===expected && newBody && getRows().length && (oldBody!==newBody || rowsRefreshed) && days;
      });
    } finally { observer.disconnect(); }
  }
  function getRows() {
    return Array.from(stockTable()?.querySelectorAll("tbody tr")||[]).filter(tr=>tr.cells.length>2 && tr.cells[2].matches("td.stock-block"));
  }
  function rateIndex(entries,key) {
    const index=new Map();
    for (const value of entries||[]) {
      const id=key(value), previous=index.get(id);
      if (!index.has(id)) index.set(id,value);
      else if (JSON.stringify(previous)!==JSON.stringify(value)) index.set(id,null);
    }
    return index;
  }
  function socialStock(value) {
    const stripped=clean(value);
    if (!/^\d+$/.test(stripped)) return null;
    const n=Number(stripped);
    return Number.isSafeInteger(n) ? n : null;
  }
  function floatingTip() {
    const tip=document.querySelector("#tooltip");
    return visible(tip) && tip || null;
  }
  function tooltipAt(tip,cell) {
    const t=tip.getBoundingClientRect(), c=cell.getBoundingClientRect();
    // Adjacent date cells are much narrower than the popup. Mere overlap would accept a stale neighbour.
    const x=c.left+c.width/2;
    const centered=Math.abs(t.left+t.width/2-x)<=Math.min(18,c.width/2);
    const clipped=(t.left<=12 || t.right>=window.innerWidth-12) && x>=t.left && x<=t.right;
    return (centered || clipped) &&
      (Math.abs(t.bottom-c.top)<=24 || Math.abs(c.bottom-t.top)<=24);
  }
  function mouse(el,kind,relatedTarget=null) {
    const box=el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent(kind,{bubbles:kind!=="mouseenter" && kind!=="mouseleave",
      cancelable:true,view:window,relatedTarget,clientX:box.left+box.width/2,clientY:box.top+box.height/2}));
  }
  function dismissTip(cell) {
    if (cell?.isConnected) {
      const target=cell.firstElementChild || cell;
      mouse(target,"mouseout",document.body); mouse(target,"mouseleave",document.body);
      if (target!==cell) mouse(cell,"mouseleave",document.body);
    }
    if (floatingTip()) {
      const neutral=stockTable()?.querySelector("thead th");
      if (neutral) {
        mouse(neutral,"mousedown"); mouse(neutral,"mouseup"); neutral.click();
      }
    }
  }
  async function readCell(cell,state) {
    const target=cell.firstElementChild || cell;
    // Color and a value left by the preceding cell are both insufficient evidence.
    dismissTip(state.previous);
    if (floatingTip() && !await waitFor(()=>!floatingTip(),450)) return null;
    if (!cell.isConnected) return null;
    cell.scrollIntoView({block:"nearest",inline:"nearest"});
    mouse(target,"mouseover"); mouse(target,"mouseenter");
    if (target!==cell) mouse(cell,"mouseenter");
    mouse(target,"click");
    state.previous=cell;
    const result=await waitFor(()=>{
      const tooltip=floatingTip();
      if (!tooltip || !tooltipAt(tooltip,cell) || !cell.isConnected) return false;
      const header=tooltip.querySelector(".tooltip-container .header, .header");
      const value=exposureRemaining(textOf(header));
      if (value===null) return false;
      return {value};
    },1200);
    if (!result) return null;
    // Let Vue flush a newly opened popover, then recheck the current reference and amount.
    await Promise.resolve();
    const current=floatingTip();
    return current && tooltipAt(current,cell) && exposureRemaining(textOf(current.querySelector(".header")))===result.value
      ? result.value : null;
  }
  function inventoryTab(label) {
    return [...document.querySelectorAll(".tabs-container .tab")].find(el=>clean(textOf(el))===label);
  }
  async function chooseMode(isSocial) {
    const label=isSocial?"社群工具":"網站版位";
    const tab=await waitFor(()=>inventoryTab(label));
    if (!tab) return false;
    if (!tab.classList.contains("active")) tab.click();
    return waitFor(()=>{
      const title=clean(textOf(stockTable()?.querySelector("thead th")));
      const ok=isSocial ? /社群類型/.test(title) : /曝光網站|曝光頻道/.test(title);
      return inventoryTab(label)?.classList.contains("active") && ok && currentDates() && getRows().length>0;
    });
  }
  async function departmentMatches(isSocial) {
    const labels=Array.from(document.querySelectorAll("label")).filter(el=>clean(textOf(el))==="可用部門" && visible(el));
    if (!labels.length) return isSocial;
    const panel=labels[0].parentElement;
    const select=panel.querySelector(".select.single");
    const selected=()=>clean(textOf(select?.querySelector(".selected-option")));
    if (selected()==="整合傳播部") return true;
    if (!select || !visible(select)) return false;
    // This filter lives only on the disposable, read-only inventory page.
    const before=stockTable()?.tBodies[0];
    select.click();
    const option=await waitFor(()=>[...panel.querySelectorAll('[role="option"],.option,.select-option,li')]
      .find(el=>clean(textOf(el))==="整合傳播部" && visible(el)));
    if (!option) return false;
    let changed=false;
    const observer=new MutationObserver(()=>{changed=true;});
    if (before) observer.observe(before,{subtree:true,childList:true,characterData:true});
    try {
      option.click();
      return Boolean(await waitFor(()=>selected()==="整合傳播部" && getRows().length && (before!==stockTable()?.tBodies[0] || changed)));
    } finally {observer.disconnect();}
  }
  function markMissing(order,entries,warnings) {
    const unseen=order.sites.filter(site=>!entries.some(v=>v.site===site));
    if (unseen.length) warnings.push("未讀到這些站別的庫存列："+unseen.join("、")+"。");
    const fbMissing=Object.keys(order.facebook||{}).filter(page=>order.facebook[page]>0 && !entries.some(v=>v.page===page));
    if (fbMissing.length) warnings.push("未讀到這些粉專的庫存列："+fbMissing.join("、")+"。");
  }
  async function collectGrid(order,isSocial,catalog,result) {
    const rowsOut=isSocial?result.social:result.web;
    if (isSocial ? !Object.values(order.facebook || {}).some(n=>n>0) : !order.sites?.length) return;
    if (!await chooseMode(isSocial)) {
      result.warnings.push((isSocial?"社群":"網站")+"庫存表或日期未能核對，庫存未知。");
      return;
    }
    if (!await departmentMatches(isSocial)) {
      result.warnings.push("無法核對整合傳播部篩選，"+(isSocial?"社群":"網站")+"庫存未知。");
      return;
    }
    const sites=new Set(order.sites);
    const label=isSocial?"Facebook":"網站";
    let shown=currentDates();
    while (shown && (shown.at(-1)<order.start || shown[0]>order.start)) {
      const dir=shown.at(-1)<order.start?1:-1;
      shown=await shiftGrid(dir,shown);
    }
    const state={previous:null};
    let last=null;
    while (shown) {
      const table=stockTable();
      for (const tr of getRows()) {
        const [group,name]=Array.from(tr.cells).slice(0,2).map(c=>clean(textOf(c)));
        const site=normalizedSite(group);
        const page=isSocial?normalizedSite(socialName(name)||""):"";
        if (isSocial ? !/^Facebook$/i.test(group) || !order.facebook[page] : !sites.has(site)) continue;
        const rate=catalog.get(isSocial?name:site+"\n"+name);
        for (let i=0;i<shown.length;i++) {
          const date=shown[i],cell=tr.cells[i+2];
          if (date<order.start || date>order.end) continue;
          if (stockTable()!==table || !tr.isConnected || currentDates()?.[0]!==shown[0]) {
            throw Error("庫存表在查詢中切換，請重新查詢。");
          }
          const validCell=cell?.matches("td.stock-block") && tr.cells.length===shown.length+2;
          if (isSocial) {
            rowsOut.push({page,slot:name,date,remaining:validCell?socialStock(textOf(cell)):null,unitPrice:rate?.unitPrice??null});
          } else {
            const remaining=validCell && cell.firstElementChild && !/^[-–—]$/.test(clean(textOf(cell)))
              ? await readCell(cell,state) : null;
            rowsOut.push({site,placement:name,date,remaining,recommended:rate?.recommended??null,cpm:rate?.cpm??null});
          }
        }
      }
      dismissTip(state.previous);
      last=shown.at(-1);
      if (last>=order.end) break;
      shown=await shiftGrid(1,shown);
    }
    if (!last || last<order.end) result.warnings.push(label+"日期頁未能完整載入，缺少日期庫存未知。");
  }
  async function readGrid(message) {
    const {order,rates,socialRates,identity}=message;
    if (!identity || (order?.id!==undefined && identity!==order.id) || !order || dates(order.start)[0]!==order.start || dates(order.end)[0]!==order.end || !order.start || !order.end || order.start>order.end) {
      throw Error("訂單編號或查詢日期無法核對。");
    }
    const result={web:[],social:[],queriedAt:null,warnings:[]};
    await collectGrid(order,false,rateIndex(rates,v=>v.site+"\n"+v.placement),result);
    await collectGrid(order,true,rateIndex(socialRates,v=>v.name),result);
    markMissing(order,[...result.web,...result.social],result.warnings);
    const missing=result.web.filter(v=>v.remaining===null).length+result.social.filter(v=>v.remaining===null).length;
    if (missing) result.warnings.push("有 "+missing+" 格未取得精確剩餘量，已列為未知。");
    if (result.web.some(v=>v.recommended===null || v.cpm===null) || result.social.some(v=>v.unitPrice===null)) {
      result.warnings.push("有版位缺後台推薦量或價格，無法納入計價。");
    }
    result.queriedAt=new Date().toISOString();
    return {identity,inventory:result};
  }
  async function handle(message) {
    if (location.origin!==origin) throw Error("僅支援公司訂版網站。");
    const path=location.pathname.replace(/\/$/u,"") || "/";
    switch (message.action) {
      case "readOrder": return readOrderWhenReady();
      case "inventory": {
        const before=readOrder().identity;
        if (before!==message.identity || before!==message.order?.id) throw Error("訂單已切換，請重讀原單。");
        const answer=await chrome.runtime.sendMessage({action:"queryBookingInventory",identity:before,order:message.order,token:message.token});
        if (readOrder().identity!==before) throw Error("訂單已切換，已捨棄這次查詢。");
        return answer;
      }
      case "readRates":
        if (path!=="/slots") break;
        return readCatalog(message.order,false);
      case "readSocialRates":
        if (path!=="/sns-slots") break;
        return readCatalog(message.order,true);
      case "readGrid":
        if (path!=="/") break;
        return readGrid(message);
      default: break;
    }
    throw Error("後台頁面與查詢項目不符。");
  }
  if (typeof chrome!=="undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message,sender,respond)=>{
      if (sender.id!==chrome.runtime.id || !["readOrder","inventory","readRates","readSocialRates","readGrid"].includes(message?.action)) return;
      handle(message).then(respond).catch(error=>respond({error:error.message || "後台資料未能讀取。"}));
      return true;
    });
  }
  // Pure functions for offline, synthetic regression fixtures.
  if (typeof module!=="undefined" && module.exports) module.exports={
    orderFromRows,readOrderWhenReady,exposureRemaining,gridDates,socialStock,catalogPage,readCell,number,normalizedSite
  };
})();
