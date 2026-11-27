// Run with Playwright available to Node and a Chromium test browser installed.
// Optional overrides: PLAYWRIGHT_MODULE (absolute module path), CHROME_BINARY.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const demo = new URL("../docs/demo/", import.meta.url);
const assets = new Set(["index.html","panel.css","panel-model.mjs","panel.mjs","planner.mjs","source.mjs"]);
const server = createServer(async (request,response) => {
  const name = new URL(request.url, "http://localhost").pathname.slice(1) || "index.html";
  if (!assets.has(name)) { response.writeHead(404).end(); return; }
  const type = name.endsWith(".html") ? "text/html" : name.endsWith(".css") ? "text/css" : "text/javascript";
  try {
    response.writeHead(200, {"content-type":type + "; charset=utf-8"}).end(await readFile(new URL(name, demo)));
  } catch { response.writeHead(500).end(); }
});
await new Promise((resolve,reject) => server.once("error",reject).listen(0,"127.0.0.1",resolve));
let browser;
try {
  browser = await chromium.launch({
    headless:true,
    executablePath:process.env.CHROME_BINARY,
    args:["--disable-background-networking","--disable-default-apps","--no-first-run"]
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  const context = await browser.newContext({viewport:{width:365,height:800},permissions:["clipboard-read","clipboard-write"]});
  await context.route("**/*",route => route.request().url().startsWith(origin+"/") ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const waitText = (id, value) => page.waitForFunction(([id,value])=>document.getElementById(id)?.textContent.includes(value), [id,value]);
  const assertFits = async () => assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth+1),"側欄不應出現整頁橫向捲動");
  await page.goto(origin);
  await waitText("identity","DEMO-A");
  await assertFits();
  const query = page.getByRole("button",{name:"查庫存並產生 Cue",exact:true});
  const copy = page.locator("#copy");
  await query.click();
  await waitText("status","請核對備註與必交權益");
  assert.equal(await copy.isEnabled(),false);
  await page.locator("#review").check();
  await query.click();
  await waitText("result-tag","可複製草案");
  await assertFits();
  await page.locator(".audit summary").click();
  await page.getByText(/剩餘 42,000 次/).first().waitFor();
  await copy.click();
  await waitText("status","已複製本單");
  const text = await page.evaluate(()=>navigator.clipboard.readText());
  for (const content of ["【模擬資料】","DEMO-A","原始預算 NT$65,000","本案總預算 NT$138,000","各站曝光小計","Facebook 時段","推薦量","入選理由"]) {
    assert.ok(text.includes(content),content);
  }
  const budget = page.locator("#field-budget");
  await budget.fill("123456");
  assert.equal(await copy.isEnabled(),false);
  await waitText("dirty-count","1 欄已修改");
  await query.click();
  await waitText("result-tag","可複製草案");
  assert.match(await page.locator("#result-body").innerText(),/NT\$123,456/);
  await page.getByRole("button",{name:"還原本案排 Cue 的總預算（元）",exact:true}).click();
  assert.equal(await budget.inputValue(),"138000");
  assert.equal(await copy.isEnabled(),false);
  const scenarios = page.locator("#scenario");
  await scenarios.selectOption("DEMO-B");
  await waitText("identity","DEMO-B");
  assert.equal(await budget.inputValue(),"62500");
  assert.equal(await page.locator("#review-wrap").isVisible(),false);
  await query.click();
  await waitText("result-tag","可複製草案");
  assert.doesNotMatch(await page.locator("#result-body").innerText(),/綠色街區|138,000/);
  await page.locator(".preferences summary").click();
  await page.locator("#pref-days").fill("4");
  await page.locator("#pref-monday").uncheck();
  await page.getByRole("button",{name:"儲存偏好"}).click();
  await waitText("prefs-status","已儲存");
  assert.equal(await copy.isEnabled(),false);
  assert.equal(await page.locator("#pref-days").inputValue(),"4");
  await page.getByRole("button",{name:"恢復團隊預設"}).click();
  await page.waitForFunction(()=>document.getElementById("pref-days").value==="7");
  assert.equal(await page.locator("#pref-monday").isChecked(),true);
  await scenarios.selectOption("DEMO-C");
  await waitText("identity","DEMO-C");
  await query.click();
  await waitText("result-tag","條件未滿足");
  assert.equal(await copy.isEnabled(),false);
  assert.match(await page.locator("#result-body").innerText(),/未知|已知/);
  await scenarios.selectOption("DEMO-A");
  await waitText("identity","DEMO-A");
  assert.equal(await page.locator("#review").isChecked(),false);
  assert.equal(await copy.isEnabled(),false);
  await assertFits();
  assert.deepEqual(errors,[]);
  console.log("Chrome 展示測試通過：備註確認、逐日精確數量、剪貼簿、改單、單欄還原、切單、偏好、庫存不足與窄側欄。");
} finally {
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
