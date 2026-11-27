import { defaultPrefs, planCue } from "./planner.mjs";
import { connect } from "./source.mjs";
import { DraftSession, fields } from "./panel-model.mjs";

const byId = id => document.getElementById(id);
const model = new DraftSession();
const controls = new Map();
const number = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 });
const fmt = value => Number.isFinite(value) ? number.format(value) : "未知";
const money = value => Number.isFinite(value) ? "NT$" + fmt(value) : "未知";
const signed = value => Number.isFinite(value) ? (value < 0 ? "−" : value > 0 ? "+" : "") + money(Math.abs(value)) : "未知";
const time = value => {
  const date = new Date(value);
  return value && !Number.isNaN(date.valueOf())
    ? new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", dateStyle: "short", timeStyle: "medium", hour12: false }).format(date) + "（台北）"
    : "未知";
};
let source;
let prefs = structuredClone(defaultPrefs);
let querying = false;
let prefsReady = false;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function makeList(parent, title, lines) {
  if (!lines.length) return;
  const box = el("section", null, "alert");
  box.append(el("strong", title));
  const list = el("ul");
  for (const text of lines) list.append(el("li", text));
  box.append(list);
  parent.append(box);
}

function createFields() {
  for (const field of fields) {
    const wrap = el("div", null, "field");
    const top = el("div", null, "field-top");
    const label = el("label", field.label);
    label.htmlFor = "field-" + field.key;
    if (field.required) label.append(el("span", " *", "required"));
    const actions = el("span", null, "field-actions");
    const modified = el("span", "已修改", "modified");
    const restore = el("button", "還原", "restore");
    restore.type = "button";
    restore.setAttribute("aria-label", "還原" + field.label);
    restore.onclick = () => {
      input.value = model.base[field.key];
      editField(field);
      input.focus();
    };
    actions.append(modified, restore);
    actions.hidden = true;
    top.append(label, actions);
    const multiline = ["textArea", "counts", "list"].includes(field.type);
    const input = el(multiline ? "textarea" : "input");
    input.id = label.htmlFor;
    if (multiline) input.rows = field.type === "list" ? 1 : 2;
    else input.type = field.type === "date" ? "date" : "text";
    if (field.type === "money") input.inputMode = "decimal";
    if (field.required) input.required = true;
    wrap.append(top, input);
    const error = el("span", "", "error");
    error.id = field.key + "-error";
    const description = [error.id];
    if (field.hint) {
      const hint = el("small", field.hint, "hint");
      hint.id = field.key + "-hint";
      description.push(hint.id);
      wrap.append(hint);
    }
    input.setAttribute("aria-describedby", description.join(" "));
    input.addEventListener("input", () => editField(field));
    wrap.append(error);
    byId(field.group).append(wrap);
    controls.set(field.key, { wrap, actions, input, error });
  }
}

function syncButtons() {
  byId("order-fields").disabled = !model.original;
  byId("query").disabled = !model.original || querying || !prefsReady;
  byId("query").textContent = querying ? "正在查詢逐日庫存…" : "查庫存並產生 Cue";
  byId("copy").disabled = !model.result?.plan.ok;
  byId("copy").textContent = "複製 Cue";
}

function cancelQuery() {
  if (querying) source?.cancelInventory?.();
  querying = false;
}

function editField(field) {
  const { wrap, input, actions, error } = controls.get(field.key);
  if (!model.edit(field.key, input.value)) return;
  cancelQuery();
  const changed = model.raw[field.key] !== model.base[field.key];
  wrap.classList.toggle("changed", changed);
  actions.hidden = !changed;
  input.removeAttribute("aria-invalid");
  error.textContent = "";
  const count = fields.filter(item => model.raw[item.key] !== model.base[item.key]).length;
  byId("dirty-count").textContent = count ? count + " 欄已修改" : "";
  if (["notes", "pv", "siteMinimums", "facebook", "requiredPlacements", "sites"].includes(field.key)) byId("review").checked = false;
  showReview();
  showEmpty("條件已更新。重新查詢後會顯示本次的配置。");
  byId("status").textContent = "查詢將採用側欄內的條件。";
}

function showReview() {
  const hasNotes = Boolean(model.raw.notes?.trim() || model.original?.notes || model.warnings.length);
  byId("review-wrap").hidden = !model.original || !hasNotes;
}

function showEmpty(message) {
  byId("result-tag").textContent = querying ? "查詢中" : "待查庫存";
  byId("result-body").replaceChildren(el("p", message, "empty"));
  syncButtons();
}

async function reload() {
  const revision = model.clear();
  cancelQuery();
  byId("review").checked = false;
  byId("dirty-count").textContent = "";
  byId("identity").textContent = "讀取中";
  byId("status").textContent = "正在讀取目前訂單…";
  byId("read-warnings").replaceChildren();
  byId("read-warnings").hidden = true;
  for (const { input, wrap, error, actions } of controls.values()) {
    input.value = ""; input.removeAttribute("aria-invalid");
    wrap.classList.remove("changed"); actions.hidden = true; error.textContent = "";
  }
  showReview();
  showEmpty("核對訂單條件後，查詢庫存以查看逐日配置及預算差額。");
  if (!source) return;
  try {
    const response = await source.read();
    if (!model.load(revision, response)) return;
    for (const [key, control] of controls) control.input.value = model.raw[key];
    byId("identity").textContent = model.original.id;
    byId("status").textContent = model.original.name ? "已讀取「" + model.original.name + "」。" : "已讀取訂單，請補填缺少的欄位。";
    if (model.warnings.length) {
      const list = el("ul");
      for (const warning of model.warnings) list.append(el("li", warning));
      byId("read-warnings").append(el("strong", "原單待核對"), list);
      byId("read-warnings").hidden = false;
    }
    showReview();
    syncButtons();
  } catch (error) {
    if (revision !== model.revision) return;
    byId("identity").textContent = "未讀取";
    byId("status").textContent = error.message || "讀取失敗，請在訂單分頁重新讀取。";
  }
}

function validate(ticket) {
  let first;
  for (const [key, control] of controls) {
    const message = ticket.errors[key];
    control.error.textContent = message || "";
    control.input.toggleAttribute("aria-invalid", Boolean(message));
    if (message) {
      control.input.setAttribute("aria-invalid", "true");
      if (control.input.closest("details")) control.input.closest("details").open = true;
      first ??= control.input;
    }
  }
  if (first) {
    byId("status").textContent = "請補正標示的訂單條件。";
    first.focus();
    return false;
  }
  if (!byId("review-wrap").hidden && !byId("review").checked) {
    byId("more-box").open = true;
    byId("status").textContent = "請核對備註與必交權益，並勾選核對欄。";
    byId("review").focus();
    return false;
  }
  return true;
}

async function query() {
  const ticket = model.beginQuery();
  showEmpty("核對條件中。");
  if (!validate(ticket)) return;
  querying = true;
  byId("status").textContent = "正在查詢本次走期的網站及社群庫存…";
  showEmpty("正在查詢逐日庫存。");
  try {
    const inventory = await source.inventory(ticket.identity, structuredClone(ticket.order));
    if (ticket.revision !== model.revision) return;
    const plan = await planCue(ticket.order, inventory, structuredClone(prefs));
    if (!model.publish(ticket, plan, inventory)) return;
    renderResult();
    byId("status").textContent = plan.ok ? "試排完成。請在原訂版系統核對並正式訂版。" : "這次試排有未滿足的條件，請查看原因。";
    byId("result-title").focus();
  } catch (error) {
    if (ticket.revision !== model.revision) return;
    model.result = null;
    byId("status").textContent = error.message || "讀取庫存失敗。";
    showEmpty("本次未取得可核對的 Cue。請檢查訂單及庫存後重新查詢。");
  } finally {
    if (ticket.revision === model.revision) { querying = false; syncButtons(); if (!model.result) byId("result-tag").textContent = "待查庫存"; }
  }
}

function description(entries, className = "detail-list") {
  const list = el("dl", null, className);
  for (const [label, value] of entries) {
    const cell = el("div");
    if (className === "metrics") {
      cell.append(el("dt", label), el("dd", value));
      list.append(cell);
    } else list.append(el("dt", label), el("dd", value));
  }
  return list;
}

function section(parent, title) {
  const node = el("section", null, "result-section");
  node.append(el("h3", title));
  parent.append(node);
  return node;
}

function table(parent, labels, data) {
  const wrap = el("div", null, "table-wrap");
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", labels.join("、"));
  const grid = el("table");
  const head = grid.createTHead().insertRow();
  for (const label of labels) { const cell = el("th", label); cell.scope = "col"; head.append(cell); }
  const rows = grid.createTBody();
  for (const values of data) {
    const row = rows.insertRow();
    for (const item of values) row.append(el("td", item));
  }
  wrap.append(grid); parent.append(wrap);
}

function placementGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const id = JSON.stringify([row.site, row.placement]);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  return groups.values();
}

const unknownWeb = row => !Number.isFinite(row.remaining) || !Number.isFinite(row.recommended) || !Number.isFinite(row.cpm);
const unknownSocial = row => !Number.isFinite(row.remaining) || !Number.isFinite(row.unitPrice);

function inventoryAudit(parent, inventory) {
  const social = inventory.social || [];
  const web = inventory.web || [];
  const total = social.length + web.length;
  const unknown = web.filter(unknownWeb).length + social.filter(unknownSocial).length;
  const box = el("details", null, "audit");
  box.append(el("summary", "查詢明細 · " + fmt(total) + " 格（含 " + fmt(unknown) + " 格資料未知）"));
  parent.append(box);
  if (!total) { box.append(el("p", "沒有可列出的逐日庫存明細。", "note")); return; }
  const list = el("div");
  const nav = el("div", null, "pager");
  const prev = el("button", "上一頁"), next = el("button", "下一頁"), label = el("span");
  nav.append(prev, label, next); box.append(list, nav);
  let offset = 0;
  const step = 20;
  function show() {
    list.replaceChildren();
    for (let i = offset; i < Math.min(total, offset + step); i++) {
      const row = i < web.length ? web[i] : social[i - web.length];
      const text = i < web.length
        ? [row.date, row.site, row.placement, "剩餘 " + fmt(row.remaining) + " 次", "推薦 " + fmt(row.recommended), "CPM " + money(row.cpm)]
        : [row.date, row.page, row.slot, "剩餘 " + fmt(row.remaining) + " 次", "每篇 " + money(row.unitPrice)];
      list.append(el("div", text.join(" · "), "audit-row"));
    }
    label.textContent = (offset + 1) + "–" + Math.min(total, offset + step) + " / " + fmt(total);
    prev.disabled = !offset; next.disabled = offset + step >= total;
  }
  prev.onclick = () => { offset -= step; show(); };
  next.onclick = () => { offset += step; show(); };
  box.addEventListener("toggle", () => { if (box.open) show(); });
}

function renderResult() {
  const { order, plan, inventory } = model.result;
  const body = byId("result-body");
  body.replaceChildren();
  byId("result-tag").textContent = plan.ok ? "可複製草案" : "條件未滿足";
  body.append(description([
    ["整單價值", money(plan.totalValue)], ["與總預算差額", signed(plan.delta)],
    ["網站總曝光", fmt(plan.totalImpressions) + " 次"], ["網站版位", fmt(plan.placementCount) + " 個"]
  ], "metrics"));
  body.append(description([["本案總預算", money(order.budget)],["預訂類型", "一般"],["文章 PV（上線後追蹤）", order.pv || "未指定"], ["庫存查詢時間", time(plan.queriedAt || inventory.queriedAt)]]));
  makeList(body, "未滿足條件", plan.issues || []);
  makeList(body, "試排提醒", [...new Set([...(inventory.warnings || []), ...(plan.warnings || [])])]);
  const subtotals = section(body, "各站曝光小計");
  const sites = [...new Set([...order.sites, ...Object.keys(plan.subtotals), ...Object.keys(order.siteMinimums)])];
  if (sites.length) table(subtotals, ["網站", "擬訂曝光", "本站最低曝光"], sites.map(site => [site, fmt(plan.subtotals[site] || 0), order.siteMinimums[site] == null ? "—" : fmt(order.siteMinimums[site])]));
  else subtotals.append(el("p", "無網站曝光需求。", "note"));
  const placements = section(body, "逐日版位配置");
  if (!plan.web.length) placements.append(el("p", "沒有已選網站版位。", "note"));
  for (const group of placementGroups(plan.web)) {
    const box = el("details");
    const first = group[0];
    box.append(el("summary", first.site + " ／ " + first.placement + " · " + fmt(group.length) + " 天"));
    box.append(description([["總曝光", fmt(group.reduce((sum,r) => sum+r.quantity,0)) + " 次"],["版位價值", money(group.reduce((sum,r) => sum+r.value,0))]]));
    table(box, ["日期","推薦／日","擬訂曝光","倍數","查詢時剩餘","試排後餘量","價值","入選理由"], group.map(r => [
      r.date,fmt(r.recommended),fmt(r.quantity),fmt(r.quantity/r.recommended)+"×",fmt(r.remaining),fmt(r.remaining-r.quantity),money(r.value),r.reason
    ]));
    placements.append(box);
  }
  const fb = section(body, "Facebook 時段");
  if (plan.social.length) table(fb, ["粉專","日期／時段","擬訂篇數","查詢時剩餘次數","試排後剩餘次數","價值","入選理由"], plan.social.map(r=>[r.page,r.date+" "+r.slot,fmt(r.quantity),fmt(r.remaining),fmt(r.remaining-r.quantity),money(r.value),r.reason]));
  else fb.append(el("p", Object.values(order.facebook).some(n=>n>0) ? "沒有符合需求的已選時段。" : "本單無 Facebook 需求。", "note"));
  inventoryAudit(body, inventory);
  syncButtons();
}

function cueText(result) {
  const { order, plan, inventory } = result;
  const lines = [
    (source.demo ? "【模擬資料】" : "") + order.name + "｜Cue 草案",
    "訂單編號 " + order.id + "　預訂類型 一般",
    "走期 " + order.start + " ～ " + order.end,
    "查詢時間 " + time(plan.queriedAt || inventory.queriedAt),
    "原始預算 " + money(order.originalBudget) + "　本案總預算 " + money(order.budget) + (order.hardCap != null ? "　硬上限 " + money(order.hardCap) : ""),
    "整單價值 " + money(plan.totalValue) + "　與總預算差額 " + signed(plan.delta),
    "網站版位 " + fmt(plan.placementCount) + " 個　總曝光 " + fmt(plan.totalImpressions) + " 次",
    "文章 PV（上線後追蹤） " + (order.pv || "未指定"), "", "各站曝光小計"
  ];
  for (const site of new Set([...order.sites, ...Object.keys(plan.subtotals)])) lines.push(site + "　" + fmt(plan.subtotals[site] || 0) + " 次" + (order.siteMinimums[site] != null ? "　最低 " + fmt(order.siteMinimums[site]) + " 次" : ""));
  lines.push("", "逐日網站配置", ["網站","版位","日期","推薦量","擬訂量","倍數","查詢時剩餘","試排後餘量","CPM","價值","入選理由"].join("｜"));
  for (const r of plan.web) lines.push([r.site,r.placement,r.date,fmt(r.recommended),fmt(r.quantity),fmt(r.quantity/r.recommended)+"×",fmt(r.remaining),fmt(r.remaining-r.quantity),money(r.cpm),money(r.value),r.reason].join("｜"));
  lines.push("", "Facebook 時段");
  if (!plan.social.length) lines.push("無");
  for (const r of plan.social) lines.push([r.page,r.date,r.slot,fmt(r.quantity)+" 篇","查詢時剩 "+fmt(r.remaining)+" 次","試排後剩 "+fmt(r.remaining-r.quantity)+" 次",money(r.value),r.reason].join("｜"));
  const warnings = [...new Set([...(inventory.warnings || []), ...(plan.warnings || [])])];
  if (warnings.length) lines.push("", "核對提醒", ...warnings);
  return lines.join("\n");
}

async function copyCue() {
  const current = model.result;
  if (!current?.plan.ok) return;
  const revision = model.revision;
  try {
    if (await source.assertIdentity(model.identity) === false) throw new Error("訂單已切換。");
  } catch {
    if (model.revision === revision) await reload();
    return;
  }
  if (model.revision !== revision || current !== model.result) return;
  const text = cueText(current);
  try {
    await navigator.clipboard.writeText(text);
    if (revision === model.revision) {
      byId("status").textContent = "已複製本單的 Cue 草案。";
      byId("copy").textContent = "已複製 Cue";
    }
  } catch {
    if (revision !== model.revision) return;
    byId("result-body").querySelector(".copy-fallback")?.remove();
    const fallback = el("textarea", null, "copy-fallback");
    fallback.readOnly = true; fallback.rows = 6; fallback.setAttribute("aria-label", "可手動複製的 Cue");
    fallback.value = text;
    byId("result-body").prepend(fallback); fallback.focus(); fallback.select();
    byId("status").textContent = "請按 Ctrl+C 或 ⌘C 複製已選取的 Cue。";
  }
}

function renderPrefs() {
  byId("pref-order").value = prefs.placementOrder.join("、");
  byId("pref-days").value = prefs.preferredDays;
  byId("pref-monday").checked = prefs.avoidMonday;
  byId("pref-shared").checked = prefs.sharedCreative;
}

async function savePrefs(next) {
  byId("save-prefs").disabled = byId("reset-prefs").disabled = true;
  try {
    await source.savePrefs(next);
    prefs = structuredClone(next);
    renderPrefs();
    if (model.original) {
      model.invalidate(); cancelQuery();
      showEmpty("排序偏好已更新，請重新查詢。");
    }
    byId("prefs-status").textContent = "已儲存目前的排序偏好。";
  } catch (error) { byId("prefs-status").textContent = error.message || "儲存偏好失敗。"; }
  finally { byId("save-prefs").disabled = byId("reset-prefs").disabled = false; }
}

async function init() {
  createFields();
  byId("reload").onclick = reload;
  byId("query").onclick = query;
  byId("copy").onclick = copyCue;
  byId("review").onchange = () => {
    if (model.result || querying) {
      model.invalidate(); cancelQuery(); showEmpty("權益核對狀態已更新，請重新查詢。");
    }
  };
  byId("prefs-form").onsubmit = event => {
    event.preventDefault();
    const placementOrder = [...new Set(byId("pref-order").value.split(/[\n、，,；;]/u).map(s=>s.trim()).filter(Boolean))];
    const preferredDays = Number(byId("pref-days").value);
    if (placementOrder.length === 0 || placementOrder.length > 40 || placementOrder.some(name => name.length > 120) || !Number.isSafeInteger(preferredDays) || preferredDays < 1 || preferredDays > 366) {
      byId("prefs-status").textContent = "請填 1 至 40 個版位（每項最多 120 字）及 1 至 366 天。"; return;
    }
    void savePrefs({placementOrder, preferredDays, avoidMonday: byId("pref-monday").checked, sharedCreative: byId("pref-shared").checked});
  };
  byId("reset-prefs").onclick = () => savePrefs(defaultPrefs);
  source = await connect({onChange: reload});
  if (source.demo) {
    byId("demo-nav").hidden = false;
    byId("mode").textContent = "模擬試排";
    byId("prefs-note").textContent = "展示區使用模擬案例，設定與正式擴充功能分開。";
    for (const scenario of source.scenarios || []) byId("scenario").add(new Option(scenario.label,scenario.id));
    byId("scenario").onchange = () => source.chooseScenario(byId("scenario").value);
  }
  try { prefs = { ...structuredClone(defaultPrefs), ...(await source.loadPrefs()) }; }
  catch { byId("prefs-status").textContent = "無法讀取偏好，已套用團隊預設。"; }
  prefsReady = true;
  renderPrefs();
  await reload();
}

init().catch(error => {
  byId("identity").textContent = "未連線";
  byId("status").textContent = error.message || "無法啟動側欄，請重新開啟。";
});
