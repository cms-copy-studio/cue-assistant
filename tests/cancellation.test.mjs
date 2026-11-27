import test from "node:test";
import assert from "node:assert/strict";
import {connect} from "../extension/source.mjs";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

async function mockChrome(t, send) {
  let active = "901";
  const cancelled = [];
  const listeners = {};
  const event = key => ({addListener: listener => { listeners[key] = listener; }});
  const previousChrome = globalThis.chrome, previousWindow = globalThis.window;
  globalThis.window = {addEventListener() {}};
  globalThis.chrome = {
    windows:{async getCurrent() {return {id:1};}},
    tabs:{
      onActivated:event("activated"), onRemoved:event("removed"), onUpdated:event("updated"),
      async query() {return [{id:109,url:"https://ad-pro.cwg.tw/orders/" + active}];},
      sendMessage(id,msg) {return send(msg,active);}
    },
    runtime:{async sendMessage(message) {if (message.action === "cancelCueQuery") cancelled.push(message.token);}}
  };
  t.after(() => {
    if (previousChrome) globalThis.chrome = previousChrome; else delete globalThis.chrome;
    if (previousWindow) globalThis.window = previousWindow; else delete globalThis.window;
  });
  const source = await connect({onChange() {}});
  return {source, cancelled, switchOrder(id) {
    active = id;
    listeners.updated(109,{url:"https://ad-pro.cwg.tw/orders/" + active});
  }};
}

const orderReply = id => ({identity:id,order:{id}});
const stock = (id, value) => ({identity:id,inventory:{queriedAt:value,web:[],social:[]}});

test("先發起的慢讀單不得在後完成時取消新一輪查詢", async t => {
  const started = deferred(), release = deferred();
  let firstRead = true;
  const orders = [];
  const {source} = await mockChrome(t,async (msg,id) => {
    if (msg.action === "readOrder") {
      if (firstRead) {
        firstRead = false;
        started.resolve();
        await release.promise;
      }
      return orderReply(id);
    }
    orders.push(msg.order.budget);
    return stock(id, String(msg.order.budget));
  });
  const slow = source.inventory("901",{id:"901",budget:25});
  const superseded = assert.rejects(slow,/切換|取消/);
  await started.promise;
  const fresh = await source.inventory("901",{id:"901",budget:35});
  release.resolve();
  await superseded;
  assert.equal(fresh.queriedAt,"35");
  assert.deepEqual(orders,[35]);
});

test("已送出的跨目錄查詢在欄位變更時取消，晚到的結果作廢", async t => {
  const querying = deferred(), reply = deferred();
  let token;
  const {source,cancelled} = await mockChrome(t, async (msg,id) => {
    if (msg.action === "readOrder") return orderReply(id);
    token = msg.token;
    querying.resolve();
    return reply.promise;
  });
  const running = source.inventory("901",{id:"901"});
  const superseded = assert.rejects(running,/切換|取消/);
  await querying.promise;
  source.cancelInventory();
  assert.deepEqual(cancelled,[token]);
  reply.resolve(stock("901","old"));
  await superseded;
});

test("切換同分頁的訂單後，先前庫存及舊稿複製身分檢查均失效", async t => {
  const querying = deferred(), reply = deferred();
  const {source,switchOrder} = await mockChrome(t, async (msg,id) => {
    if (msg.action === "readOrder") return orderReply(id);
    querying.resolve();
    return reply.promise;
  });
  const running = source.inventory("901",{id:"901"});
  const stale = assert.rejects(running,/切換|取消/);
  await querying.promise;
  switchOrder("902");
  reply.resolve(stock("901","old"));
  await stale;
  await assert.rejects(source.assertIdentity("901"),/切換/);
  assert.equal((await source.read()).identity,"902");
});
