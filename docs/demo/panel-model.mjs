export const fields = [
  { key: "name", label: "案名", group: "base", required: true },
  { key: "start", label: "走期起日", type: "date", group: "dates", required: true },
  { key: "end", label: "走期迄日", type: "date", group: "dates", required: true },
  { key: "originalBudget", label: "訂單原始預算（元）", type: "money", group: "money" },
  { key: "budget", label: "本案排 Cue 的總預算（元）", type: "money", group: "money", required: true },
  { key: "hardCap", label: "硬上限（元）", type: "money", group: "more", hint: "有明定上限時才填寫。" },
  { key: "topic", label: "稿件主題", group: "base" },
  { key: "sites", label: "可曝光網站", type: "list", group: "rights", hint: "多個網站以頓號或換行分隔。" },
  { key: "siteMinimums", label: "各站最低曝光（次）", type: "counts", group: "rights", hint: "每行一站，例如「天下雜誌 = 200000」。" },
  { key: "requiredPlacements", label: "客戶指定版位", type: "list", group: "rights", hint: "每行一項，可填「網站/版位全名」；指定網站圖片權益可填「天下雜誌/Banner」。" },
  { key: "facebook", label: "Facebook 粉專與篇數", type: "counts", group: "rights", hint: "每行填「粉專 = 篇數」。僅填篇數會排天下粉專，無需求可留白。" },
  { key: "pv", label: "文章 PV 與追蹤口徑", group: "more", type: "textArea", hint: "上線後追蹤，獨立於網站版位曝光。" },
  { key: "notes", label: "訂單備註與其他權益", type: "textArea", group: "more" }
];

const canonicalSite = name => ["天下", "天下官網", "天下雜誌官網", "天下主站"].includes(name) ? "天下雜誌" : name;
const splitList = value => [...new Set(value.split(/[\n、，,；;]/u).map(item => item.trim()).filter(Boolean))];
const integerToken = /^(?:\d+|\d{1,3}(?:,\d{3})+)$/;
const moneyToken = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/;

function counts(text, facebook) {
  const entries = new Map();
  const input = text.trim();
  if (facebook && integerToken.test(input)) text = "天下雜誌 = " + input;
  for (const row of text.split(/[\n；;、]/u).map(item => item.trim()).filter(Boolean)) {
    const match = row.match(/^(.+?)\s*[=＝：:]\s*(.+)$/u);
    if (!match || !integerToken.test(match[2].trim())) throw new Error("每行須填名稱與整數，例如「天下雜誌 = 1」。");
    const name = canonicalSite(match[1].trim());
    const number = Number(match[2].replaceAll(",", ""));
    if (!name || !Number.isSafeInteger(number)) throw new Error("請核對名稱及數量。");
    if (entries.has(name)) throw new Error("同一名稱只需填一行。");
    entries.set(name, number);
  }
  return Object.fromEntries(entries);
}

function rawField(field, value) {
  if (value == null) return "";
  if (field.type === "list" && Array.isArray(value)) return value.join("、");
  if (field.type === "counts" && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).map(([name, number]) => name + " = " + number).join("\n");
  }
  return String(value);
}

function parseField(field, raw) {
  const value = raw.trim();
  if (field.required && !value) throw new Error("請補填此欄。");
  if (field.type === "date") {
    const date = new Date(value + "T00:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
      throw new Error("請填有效的年月日。");
    }
  }
  if (field.type === "money") {
    if (!value) return null;
    const number = Number(value.replaceAll(",", ""));
    if (!moneyToken.test(value) || number > Number.MAX_SAFE_INTEGER / 100) throw new Error("請填非負金額，最多兩位小數。");
    return number;
  }
  if (field.type === "counts") return counts(value, field.key === "facebook");
  if (field.type === "list") {
    const result = splitList(value);
    const normalize = field.key === "sites" ? canonicalSite : name => {
      const parts = name.split(/[/／]/);
      return parts.length > 1 ? [canonicalSite(parts[0].trim()), ...parts.slice(1).map(p => p.trim())].join("/") : name;
    };
    return [...new Set(result.map(normalize))];
  }
  return value;
}

export function parseOrder(raw, original) {
  const order = { ...original };
  const errors = {};
  for (const field of fields) {
    try { order[field.key] = parseField(field, raw[field.key] ?? ""); }
    catch (error) { errors[field.key] = error.message; }
  }
  if (!errors.start && !errors.end && order.start > order.end) errors.end = "迄日應在起日當天或之後。";
  if (!order.sites?.length && !Object.values(order.facebook || {}).some(count => count > 0)) errors.sites = "請填可曝光網站或 Facebook 權益。";
  const missing = Object.entries(order.siteMinimums || {}).filter(([site, count]) => count > 0 && !order.sites?.includes(site));
  if (!errors.siteMinimums && missing.length) errors.siteMinimums = "請先將「" + missing[0][0] + "」加入可曝光網站。";
  return { order, errors };
}

// The tab adapter may finish after a field edit, an order switch, or a later
// query. Each operation owns its revision until the next mutation.
export class DraftSession {
  constructor() { this.revision = 0; this.clear(); }

  clear() {
    this.invalidate();
    this.identity = null;
    this.original = null;
    this.base = {};
    this.raw = {};
    this.warnings = [];
    return this.revision;
  }

  load(revision, response) {
    if (revision !== this.revision) return false;
    if (!response?.identity || !response.order?.id) throw new Error("目前頁面缺少可核對的訂單編號。");
    this.identity = response.identity;
    this.original = structuredClone(response.order);
    this.base = Object.fromEntries(fields.map(field => [field.key, rawField(field, this.original[field.key])]));
    this.raw = { ...this.base };
    this.warnings = Array.isArray(response.warnings) ? response.warnings.map(String) : [];
    return true;
  }

  invalidate() {
    this.result = null;
    return ++this.revision;
  }

  edit(key, raw) {
    if (!Object.hasOwn(this.base, key) || this.raw[key] === raw) return false;
    this.raw[key] = raw;
    this.invalidate();
    return true;
  }

  beginQuery() {
    if (!this.original) throw new Error("請先讀取訂單。");
    const { order, errors } = parseOrder(this.raw, this.original);
    const revision = this.invalidate();
    return { identity: this.identity, revision, order, errors };
  }

  publish(ticket, plan, inventory) {
    if (this.identity !== ticket.identity || this.revision !== ticket.revision) return false;
    this.result = { order: ticket.order, plan, inventory };
    return true;
  }
}
