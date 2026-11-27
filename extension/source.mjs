const origin = 'https://ad-pro.cwg.tw';
const storedKey = 'personalPreferences';

function allowedPrefs(value = {}) {
  const result = {};
  if (Array.isArray(value.placementOrder)) {
    result.placementOrder = [...new Set(value.placementOrder.filter(x => typeof x === 'string').map(x => x.trim()).filter(x => x && x.length <= 120))].slice(0,40);
  }
  if (Number.isInteger(value.preferredDays) && value.preferredDays > 0 && value.preferredDays <= 366) {
    result.preferredDays = value.preferredDays;
  }
  for (const key of ['avoidMonday', 'sharedCreative']) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  return result;
}

export async function connect({onChange}) {
  const windowId = (await chrome.windows.getCurrent()).id;
  let tabId;
  let generation = 0;
  let liveQuery;
  const changed = '已切換分頁或訂單，請重新讀取。';

  function cancelInventory() {
    const token = liveQuery;
    liveQuery = undefined;
    if (token) chrome.runtime.sendMessage({action:'cancelCueQuery', token, windowId}).catch(() => {});
  }

  function invalidate() {
    generation++;
    cancelInventory();
    onChange();
  }

  chrome.tabs.onActivated.addListener(info => {
    if (info.windowId === windowId) { tabId = info.tabId; invalidate(); }
  });
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (id === tabId && (change.url || change.status === 'loading' || change.status === 'complete')) invalidate();
  });
  chrome.tabs.onRemoved.addListener(id => { if (id === tabId) invalidate(); });

  async function current() {
    const [tab] = await chrome.tabs.query({active:true,windowId});
    tabId = tab?.id;
    if (!tab?.url || new URL(tab.url).origin !== origin || !/^\/orders\/\d+\/?$/.test(new URL(tab.url).pathname)) {
      throw new Error('請在同一個 Chrome 視窗登入天下訂版系統，並開啟一張訂單的明細。');
    }
    return tab;
  }

  async function send(id, message) {
    let reply;
    try { reply = await chrome.tabs.sendMessage(id, message, {frameId:0}); }
    catch { throw new Error('無法讀取訂單。初次安裝或更新後，請重新整理訂單分頁。'); }
    if (!reply || reply.error) throw new Error(reply?.error || '後台沒有回傳可核對的資料。');
    return reply;
  }

  async function read() {
    const version = generation;
    const tab = await current();
    const reply = await send(tab.id, {action:'readOrder'});
    const again = await current();
    if (version !== generation || again.id !== tab.id || again.url !== tab.url || !reply.identity || !reply.order) throw new Error(changed);
    return reply;
  }

  async function assertIdentity(identity) {
    const reply = await read();
    if (reply.identity !== identity) throw new Error(changed);
  }

  async function inventory(identity, order) {
    // Publish this attempt before any async tab/identity lookup. A slower old
    // lookup can then neither start a scan nor cancel its replacement.
    cancelInventory();
    const token = crypto.randomUUID();
    const version = generation;
    liveQuery = token;
    const assertCurrent = () => {
      if (generation !== version || liveQuery !== token) throw new Error(changed);
    };
    try {
      const tab = await current();
      assertCurrent();
      await assertIdentity(identity);
      assertCurrent();
      const reply = await send(tab.id,{action:'inventory', identity, order, token});
      assertCurrent();
      await assertIdentity(identity);
      assertCurrent();
      if (reply.identity !== identity || !reply.inventory) throw new Error(changed);
      return reply.inventory;
    } finally { if (liveQuery === token) liveQuery = undefined; }
  }

  window.addEventListener('pagehide', cancelInventory, {once:true});
  return {demo:false, read, inventory, assertIdentity, cancelInventory,
    async loadPrefs() { return allowedPrefs((await chrome.storage.local.get(storedKey))[storedKey]); },
    async savePrefs(prefs) { await chrome.storage.local.set({[storedKey]: allowedPrefs(prefs)}); }
  };
}
