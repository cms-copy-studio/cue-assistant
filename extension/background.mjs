const ORIGIN = 'https://ad-pro.cwg.tw';
const jobs = new Map();
// A panel sends cancellations directly. The corresponding query travels via the
// order's content script and can reach this worker after its cancellation.
const cancelledTokens = new Map();
const cancelLifetime = 2 * 60 * 1000;
const cancellationKey = (windowId, token) => windowId + '/' + token;

function rememberCancellation(windowId, token) {
  const now = Date.now();
  for (const [key, at] of cancelledTokens) {
    if (at > now - cancelLifetime) break;
    cancelledTokens.delete(key);
  }
  const key = cancellationKey(windowId, token);
  cancelledTokens.delete(key);
  cancelledTokens.set(key, now);
  if (cancelledTokens.size > 256) cancelledTokens.delete(cancelledTokens.keys().next().value);
}


function orderNumber(url) {
  try {
    const u = new URL(url);
    return u.origin === ORIGIN && u.pathname.match(/^\/orders\/(\d+)\/?$/)?.[1];
  } catch { return null; }
}

chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(() => {});
// Keep preferences private to extension pages; content scripts only read the booking UI.
chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}).catch(() => {});

async function releaseTab(job, id) {
  const url = job.tabs.get(id);
  job.tabs.delete(id);
  if (!url) return;
  try {
    const tab = await chrome.tabs.get(id);
    if (!tab.active && (tab.url === url || tab.pendingUrl === url)) await chrome.tabs.remove(id);
  } catch { /* The user may have already closed the helper. */ }
}

function cancel(job) {
  if (job.cancelled) return;
  job.cancelled = true;
  for (const id of job.tabs.keys()) void releaseTab(job,id);
}

async function assertOrigin(job) {
  if (job.cancelled) throw Error('訂單已切換或查詢已取消。');
  const [active] = await chrome.tabs.query({windowId:job.windowId, active:true});
  if (active?.id !== job.tabId || orderNumber(active.url) !== job.identity) {
    cancel(job);
    throw Error('訂單分頁已變更，請重新查詢。');
  }
}

async function openHelper(job, path) {
  await assertOrigin(job);
  const url = ORIGIN + path;
  const tab = await chrome.tabs.create({url,active:false,windowId:job.windowId});
  job.tabs.set(tab.id,url);
  if (job.cancelled) {
    await releaseTab(job,tab.id);
    throw Error('查詢已取消。');
  }
  return tab.id;
}

const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
async function request(job, path, message) {
  const id = await openHelper(job,path);
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await assertOrigin(job);
      const tab = await chrome.tabs.get(id);
      if (tab.status === 'complete') {
        if (tab.url !== ORIGIN + path) throw Error('後台查詢頁需要登入或已離開指定頁面。');
        let reply;
        try { reply = await chrome.tabs.sendMessage(id,message,{frameId:0}); }
        catch (error) {
          if (!/Receiving end does not exist|Could not establish connection/i.test(error.message)) throw error;
          await delay(180);
          continue;
        }
        if (!reply || reply.error) throw Error(reply?.error || '無法從指定頁讀取資料。');
        await assertOrigin(job);
        return reply;
      }
      await delay(180);
    }
    throw Error('後台頁面未完成載入，請確認登入狀態後重試。');
  } finally { await releaseTab(job,id); }
}

async function query(message,sender) {
  if (sender.frameId !== 0 || !sender.tab || orderNumber(sender.url) !== message.identity ||
      message.order?.id !== message.identity || typeof message.token !== 'string' || !message.token) {
    throw Error('查詢來源與訂單編號不符。');
  }
  const cancelledAt = cancelledTokens.get(cancellationKey(sender.tab.windowId, message.token));
  if (cancelledAt != null && Date.now() - cancelledAt <= cancelLifetime) throw Error('本次查詢已取消。');
  const old = jobs.get(sender.tab.id);
  if (old) cancel(old);
  const job = {identity:message.identity,windowId:sender.tab.windowId,tabId:sender.tab.id,
    token:message.token,tabs:new Map(),cancelled:false};
  jobs.set(job.tabId,job);
  // Temporary tabs receive only the selectors for this query, never the order's notes or budget.
  const {id,start,end,sites,facebook} = message.order;
  const order = {id,start,end,sites,facebook};
  // API activity also lets Chrome keep the short-lived worker available during longer grid scans.
  const watchdog = setInterval(()=>{assertOrigin(job).catch(()=>cancel(job));},20000);
  try {
    const [website,social] = await Promise.all([
      sites?.length ? request(job,'/slots',{action:'readRates',order}) : {rates:[],warnings:[]},
      Object.values(facebook || {}).some(n=>n>0) ? request(job,'/sns-slots',{action:'readSocialRates',order}) : {socialRates:[],warnings:[]}
    ]);
    const response = await request(job,'/',{action:'readGrid',identity:job.identity,order,
      rates:website.rates,socialRates:social.socialRates});
    if (!response.inventory || response.identity !== job.identity) throw Error('庫存回覆與訂單不符。');
    response.inventory.warnings = [...(website.warnings||[]),...(social.warnings||[]),...(response.inventory.warnings||[])];
    return response;
  } finally {
    clearInterval(watchdog);
    cancel(job);
    if (jobs.get(job.tabId) === job) jobs.delete(job.tabId);
  }
}

chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if (sender.id !== chrome.runtime.id) return;
  if (message?.action === 'cancelCueQuery' && sender.url === chrome.runtime.getURL('panel.html')) {
    if (!Number.isInteger(message.windowId) || typeof message.token !== 'string' || !message.token || message.token.length > 120) {
      reply({error:'無法核對要取消的查詢。'});
      return;
    }
    rememberCancellation(message.windowId, message.token);
    for (const job of jobs.values()) {
      if (job.windowId === message.windowId && job.token === message.token) cancel(job);
    }
    reply({ok:true});
    return;
  }
  if (message?.action !== 'queryBookingInventory') return;
  query(message,sender).then(reply,error=>reply({error:error.message || '後台查詢中斷。'}));
  return true;
});

chrome.tabs.onActivated.addListener(({tabId,windowId})=>{
  for (const job of jobs.values()) if (job.windowId === windowId && job.tabId !== tabId) cancel(job);
});
chrome.tabs.onRemoved.addListener(tabId=>{ const job=jobs.get(tabId); if (job) cancel(job); });
chrome.tabs.onUpdated.addListener((tabId,change)=>{
  const job=jobs.get(tabId);
  if (job && (change.status === 'loading' || (change.url && orderNumber(change.url) !== job.identity))) cancel(job);
});
