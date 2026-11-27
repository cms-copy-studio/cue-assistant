import {test} from 'node:test';
import assert from 'node:assert/strict';

const origin = 'https://ad-pro.cwg.tw';
const extensionId = 'mock';
const extensionUrl = 'chrome-extension://mock/';
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise,resolve};
};

async function setup(t, grids) {
  const previous = globalThis.chrome;
  const helpers = new Map();
  const opened = [];
  let listener;
  const newTab = (order,win) => ({id:100+win,windowId:win,url:origin+'/orders/'+order});
  const windows = new Map([[1,newTab('601',1)],[2,newTab('602',2)]]);
  const ignoreListeners = {addListener() {}};
  globalThis.chrome = {
    sidePanel:{async setPanelBehavior(){}}, storage:{local:{async setAccessLevel(){}}},
    runtime:{id:extensionId,getURL:path=>extensionUrl+path,onMessage:{addListener:fn=>{listener=fn;}}},
    tabs:{
      onActivated:ignoreListeners,onRemoved:ignoreListeners,onUpdated:ignoreListeners,
      async query({windowId}) {return [windows.get(windowId)];},
      async create(options) {
        const tab={...options,id:200+opened.length,status:'complete'};
        helpers.set(tab.id,tab); opened.push(tab); return tab;
      },
      async get(id) {return helpers.get(id);},
      async remove(id) {helpers.delete(id);},
      async sendMessage(id,message) {
        assert.equal(message.action,'readGrid');
        return grids(helpers.get(id).windowId,message);
      }
    }
  };
  t.after(()=>{if (previous) globalThis.chrome=previous; else delete globalThis.chrome;});
  await import('../extension/background.mjs?worker-test='+encodeURIComponent(t.name));
  const panel = {id:extensionId,url:extensionUrl+'panel.html'};
  return {
    opened, helpers,
    cancel(windowId,token) {
      return new Promise(resolve=>listener({action:'cancelCueQuery',windowId,token},panel,resolve));
    },
    query(windowId,token) {
      const tab=windows.get(windowId), identity=tab.url.split('/').pop();
      const sender={id:extensionId,tab,frameId:0,url:tab.url};
      const order={id:identity,start:'2030-01-01',end:'2030-01-01',sites:[],facebook:{}};
      const message={action:'queryBookingInventory',identity,token,order};
      return new Promise(resolve=>listener(message,sender,resolve));
    }
  };
}

const success = identity => ({identity,inventory:{web:[],social:[],warnings:[]}});

test('取消先到 worker，舊查詢較晚進入也不得開啟背景分頁，另一視窗仍可使用',async t=>{
  const worker=await setup(t,async (_window,msg)=>success(msg.identity));
  await worker.cancel(1,'same-test-token');
  assert.match((await worker.query(1,'same-test-token')).error,/取消/);
  assert.equal(worker.opened.length,0);
  assert.equal((await worker.query(2,'same-test-token')).identity,'602');
  assert.deepEqual(worker.opened.map(t=>t.windowId),[2]);
  assert.equal(worker.helpers.size,0);
});

test('兩個視窗正在逐格查詢時，取消其中一個只回收該視窗的查詢分頁',async t=>{
  const waiting=[,deferred(),deferred()];
  const finish=[,deferred(),deferred()];
  const worker=await setup(t,async (windowId,msg)=>{
    waiting[windowId].resolve();
    await finish[windowId].promise;
    return success(msg.identity);
  });
  const a=worker.query(1,'shared-test-token'), b=worker.query(2,'shared-test-token');
  await Promise.all([waiting[1].promise,waiting[2].promise]);
  await worker.cancel(1,'shared-test-token');
  finish[1].resolve();
  assert.match((await a).error,/取消/);
  assert.deepEqual([...worker.helpers.values()].map(tab=>tab.windowId),[2]);
  finish[2].resolve();
  assert.equal((await b).identity,'602');
  assert.equal(worker.helpers.size,0);
});
