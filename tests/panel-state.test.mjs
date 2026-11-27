import test from "node:test";
import assert from "node:assert/strict";
import { DraftSession, parseOrder } from "../extension/panel-model.mjs";

const fake = id => ({
  identity: "tab:demo:" + id,
  order: {
    id, name: "模擬文章 " + id, start: "2030-06-03", end: "2030-06-12",
    originalBudget: 43000, budget: 86000, hardCap: null, topic: "測試",
    sites: ["天下雜誌"], siteMinimums: {天下雜誌: 35000},
    requiredPlacements: ["天下雜誌/Text A"], facebook: {天下雜誌: 1}, pv: "每篇 800", notes: ""
  }
});

test("手改後查詢採用側欄條件；單欄還原保留其他修改", () => {
  const session = new DraftSession();
  session.load(session.revision, fake("A"));
  const before = session.beginQuery();
  assert.deepEqual(before.errors, {});
  session.edit("budget", "75,500");
  session.edit("facebook", "未來城市 = 2");
  assert.equal(session.publish(before, {ok:true}, {}), false);
  const changed = session.beginQuery();
  assert.equal(changed.order.budget, 75500);
  assert.equal(changed.order.originalBudget, 43000);
  assert.deepEqual(changed.order.facebook, {未來城市: 2});
  assert.equal(session.publish(changed, {ok:true}, {}), true);
  session.edit("budget", session.base.budget);
  assert.equal(session.result, null);
  const restored = session.beginQuery().order;
  assert.equal(restored.budget, 86000);
  assert.deepEqual(restored.facebook, {未來城市: 2});
});

test("切換訂單同步清空狀態，拒絕晚到的讀單與查庫存結果", () => {
  const session = new DraftSession();
  const loadA = session.clear();
  session.load(loadA, fake("A"));
  session.edit("notes", "只屬於 A");
  const queryA = session.beginQuery();
  const loadB = session.clear();
  assert.equal(session.identity, null);
  assert.equal(session.original, null);
  assert.deepEqual(session.raw, {});
  assert.equal(session.result, null);
  assert.equal(session.load(loadA, fake("A")), false);
  assert.equal(session.load(loadB, fake("B")), true);
  assert.equal(session.publish(queryA, {ok:true}, {}), false);
  assert.equal(session.raw.notes, "");
  assert.equal(session.original.id, "B");
});

test("同一單快速重查，舊查詢不得覆蓋新結果；重讀原單恢復原值", () => {
  const session = new DraftSession();
  session.load(session.revision, fake("B"));
  session.edit("start", "2030-06-05");
  const earlier = session.beginQuery();
  const later = session.beginQuery();
  assert.equal(session.publish(later, {totalValue:18}, {}), true);
  assert.equal(session.publish(earlier, {totalValue:7}, {}), false);
  assert.equal(session.result.plan.totalValue, 18);
  session.load(session.clear(), fake("B"));
  assert.equal(session.result, null);
  assert.equal(session.raw.start, "2030-06-03");
});

test("站別、數字與 Facebook 欄位分別解析；不接受破碎數量、重複規則和反向走期", () => {
  const session = new DraftSession();
  session.load(session.revision, fake("C"));
  Object.assign(session.raw, {
    sites: "天下官網、CSR", siteMinimums: "天下官網 = 200,000\nCSR：12000",
    facebook: "2", requiredPlacements:"天下官網／Text A", budget:"21,000.50"
  });
  const {order,errors} = parseOrder(session.raw, session.original);
  assert.deepEqual(errors, {});
  assert.deepEqual(order.sites, ["天下雜誌", "CSR"]);
  assert.deepEqual(order.requiredPlacements, ["天下雜誌/Text A"]);
  assert.deepEqual(order.facebook, {天下雜誌:2});
  assert.deepEqual(order.siteMinimums, {天下雜誌:200000, CSR:12000});
  assert.equal(order.budget, 21000.5);
  assert.equal(order.hardCap, null);
  Object.assign(session.raw, {end:"2030-06-02", budget:"21,2", facebook:"CSR:2\nCSR:3", siteMinimums:"微笑台灣 = 105"});
  const rejected = parseOrder(session.raw, session.original).errors;
  assert.deepEqual(Object.keys(rejected).sort(), ["budget","end","facebook","siteMinimums"]);
});

test("空白站別但明定 Facebook 的純社群需求仍可查，無身份的一律拒絕", () => {
  const session = new DraftSession();
  assert.throws(() => session.load(session.revision, {order:{name:"模擬"}}), /編號/);
  session.load(session.revision, fake("D"));
  Object.assign(session.raw, {sites:"", siteMinimums:"", requiredPlacements:"", facebook:"天下雜誌 = 1"});
  assert.deepEqual(session.beginQuery().errors, {});
  session.edit("facebook", "");
  assert.ok(session.beginQuery().errors.sites);
});
