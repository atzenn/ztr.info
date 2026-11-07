// z-tracker — 7EN Labs affiliate tracking hub on ztr.info
// Endpoints: /g/<code>, /goto/?url=..., /b (beacon), /admin
// Storage: single SQLite-backed Durable Object (TrackerStore) — the Cloudflare
// API token has no KV permission (401 on KV), DO is the available durable
// store on the Workers Free plan (100k req/day, 0 dong). Config (platforms)
// lives in the DO, editable in /admin. No secrets in code.

const BOT_RE = /bot|crawl|spider|slurp|mediapartners|facebookexternalhit|facebookcatalog|zalo|embedly|pingdom|uptimerobot|headless|phantomjs|python-requests|curl\//i;

const DEFAULT_PLATFORMS = [
  { id: "shopee", name: "Shopee", affiliate_id: "REPLACE_ME", aff_param: "af_id", sub_key: "sub_id", sub_template: "{site}_{placement}_{click_id}" },
  { id: "lazada", name: "Lazada", affiliate_id: "REPLACE_ME", aff_param: "sub_aff_id", sub_key: "sub_id1", sub_template: "{site}_{click_id}" },
];

// ---------------- Durable Object (SQLite store) ----------------
export class TrackerStore {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS links (code TEXT PRIMARY KEY, destination TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS clicks (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, site TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '', placement TEXT NOT NULL DEFAULT '', dest TEXT NOT NULL DEFAULT '', referrer TEXT NOT NULL DEFAULT '', ua TEXT NOT NULL DEFAULT '', bot INTEGER NOT NULL DEFAULT 0)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS counters (day TEXT PRIMARY KEY, total INTEGER NOT NULL DEFAULT 0, bots INTEGER NOT NULL DEFAULT 0, shopee INTEGER NOT NULL DEFAULT 0, lazada INTEGER NOT NULL DEFAULT 0, beacon INTEGER NOT NULL DEFAULT 0)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_clicks_ts ON clicks (ts DESC)`);
    });
  }

  async fetch(req) {
    await this.ready;
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/do/link" && req.method === "GET") {
        const code = url.searchParams.get("code") || "";
        const row = this.sql.exec(`SELECT destination, title FROM links WHERE code = ?`, code).toArray()[0];
        if (!row) return json({ ok: false, error: "not found" }, 404);
        return json({ ok: true, destination: row.destination, title: row.title });
      }
      if (path === "/do/click" && req.method === "POST") {
        const click = await req.json();
        this._logClick(click);
        return json({ ok: true });
      }
      if (path === "/do/config" && req.method === "GET") {
        const row = this.sql.exec(`SELECT value FROM config WHERE key = 'platforms'`).toArray()[0];
        return json({ ok: true, platforms: row ? JSON.parse(row.value) : null });
      }
      if (path === "/do/config" && req.method === "POST") {
        const { platforms } = await req.json();
        this.sql.exec(`INSERT INTO config (key, value) VALUES ('platforms', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify(platforms));
        return json({ ok: true });
      }
      if (path === "/do/link" && req.method === "POST") {
        const { code, destination, title } = await req.json();
        const exists = this.sql.exec(`SELECT 1 FROM links WHERE code = ?`, code).toArray().length > 0;
        if (exists) return json({ ok: false, error: "code exists" }, 409);
        this.sql.exec(`INSERT INTO links (code, destination, title, created_at) VALUES (?, ?, ?, ?)`, code, destination, title || "", new Date().toISOString());
        return json({ ok: true, code });
      }
      if (path === "/do/link/delete" && req.method === "POST") {
        const { code } = await req.json();
        this.sql.exec(`DELETE FROM links WHERE code = ?`, code);
        return json({ ok: true });
      }
      if (path === "/do/stats" && req.method === "GET") {
        const days = (url.searchParams.get("days") || "").split(",").filter(Boolean);
        const counters = {};
        for (const d of days) {
          const r = this.sql.exec(`SELECT total, bots, shopee, lazada, beacon FROM counters WHERE day = ?`, d).toArray()[0];
          counters[d] = r || { total: 0, bots: 0, shopee: 0, lazada: 0, beacon: 0 };
        }
        const recent = this.sql.exec(`SELECT ts, kind, site, platform, placement, dest, bot FROM clicks ORDER BY ts DESC LIMIT 20`).toArray();
        const links = this.sql.exec(`SELECT code, destination, title FROM links ORDER BY created_at DESC LIMIT 100`).toArray();
        return json({ ok: true, counters, recent, links });
      }
      return json({ ok: false, error: "unknown op" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
  }

  _logClick(c) {
    const day = new Date(c.ts).toISOString().slice(0, 10);
    this.sql.exec(
      `INSERT INTO clicks (id, ts, kind, site, platform, placement, dest, referrer, ua, bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.click_id, c.ts, c.kind, c.site || "", c.platform || "", c.placement || "",
      (c.dest || "").slice(0, 500), (c.referrer || "").slice(0, 500), (c.ua || "").slice(0, 500), c.bot ? 1 : 0
    );
    const cols = ["total"];
    if (c.bot) cols.push("bots");
    if (c.platform === "shopee") cols.push("shopee");
    if (c.platform === "lazada") cols.push("lazada");
    if (c.kind === "beacon") cols.push("beacon");
    const sets = cols.map((col) => `${col} = ${col} + 1`).join(", ");
    // INSERT-then-UPDATE: the upsert form would leave a fresh day's row at 0
    // (ON CONFLICT never runs on insert), so seed the row first, then bump.
    this.sql.exec(`INSERT INTO counters (day, total, bots, shopee, lazada, beacon) VALUES (?, 0, 0, 0, 0, 0) ON CONFLICT(day) DO NOTHING`, day);
    this.sql.exec(`UPDATE counters SET ${sets} WHERE day = ?`, day);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

// ---------------- helpers (same behavior as the PHP tracker) ----------------
let configCache = null;
let configCacheAt = 0;

async function doCall(env, path, method = "GET", body = null) {
  const stub = env.STORE.get(env.STORE.idFromName("main"));
  const res = await stub.fetch(new Request("http://do" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : null,
  }));
  return res.json();
}

async function getPlatforms(env) {
  const now = Date.now();
  if (configCache && now - configCacheAt < 60000) return configCache;
  try {
    const r = await doCall(env, "/do/config");
    if (r.ok && Array.isArray(r.platforms) && r.platforms.length > 0) {
      configCache = r.platforms;
      configCacheAt = now;
      return r.platforms;
    }
  } catch (e) { /* fall through to defaults */ }
  configCache = DEFAULT_PLATFORMS;
  configCacheAt = now;
  return DEFAULT_PLATFORMS;
}

function platformById(platforms, id) {
  return platforms.find((p) => p.id === id) || null;
}

function clickId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function isBot(ua) {
  return BOT_RE.test(ua || "");
}

function allowedHost(host) {
  host = (host || "").toLowerCase().trim();
  if (host === "shope.ee") return true;
  const tlds = "(vn|com|sg|my|th|id|ph|tw|br|com\\.my|co\\.th|co\\.id)";
  if (new RegExp("(^|\\.)shopee\\." + tlds + "$").test(host)) return true;
  if (new RegExp("(^|\\.)lazada\\." + tlds + "$").test(host)) return true;
  return false;
}

function isShortDomain(host) {
  host = (host || "").toLowerCase();
  return host === "shope.ee" || /^s\.lazada\./.test(host);
}

function affPlatform(url) {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch (e) { return null; }
  const tlds = "(vn|com|sg|my|th|id|ph|tw|br|com\\.my|co\\.th|co\\.id)";
  if (new RegExp("(^|\\.)lazada\\." + tlds + "$").test(host)) return "lazada";
  if (host === "shope.ee" || new RegExp("(^|\\.)shopee\\." + tlds + "$").test(host)) return "shopee";
  return null;
}

// Add params to a URL only if the key is not already present; preserve #fragment.
function attachParams(url, params) {
  if (!params || params.length === 0) return url;
  let frag = "";
  const hashPos = url.indexOf("#");
  if (hashPos !== -1) { frag = url.slice(hashPos); url = url.slice(0, hashPos); }
  const qPos = url.indexOf("?");
  const existing = new Set();
  if (qPos !== -1) {
    for (const pair of url.slice(qPos + 1).split("&")) {
      const k = pair.split("=", 1)[0];
      if (k) existing.add(decodeURIComponent(k).toLowerCase());
    }
  }
  const add = [];
  for (const [k, v] of params) {
    if (!existing.has(k.toLowerCase())) add.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
  }
  if (add.length === 0) return url + frag;
  return url + (qPos === -1 ? "?" : "&") + add.join("&") + frag;
}

function renderSub(template, vars) {
  let out = (template || "{click_id}")
    .replaceAll("{click_id}", vars.click_id || "")
    .replaceAll("{site}", vars.site || "direct")
    .replaceAll("{placement}", vars.placement || "");
  out = out.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return out.slice(0, 200);
}

function siteCode(req, params) {
  const s = (params.get("s") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  if (s) return s;
  const ref = req.headers.get("Referer") || "";
  try {
    const host = new URL(ref).hostname.toLowerCase().replace(/^www\./, "");
    const first = host.split(".")[0];
    if (first && /^[a-z0-9][a-z0-9-]*$/.test(first)) return first;
  } catch (e) { /* ignore */ }
  return "direct";
}

function todayKey(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function clickRecord(req, fields) {
  const ua = (req.headers.get("User-Agent") || "").slice(0, 500);
  return {
    click_id: clickId(),
    ts: Date.now(),
    ua,
    bot: isBot(ua),
    referrer: (req.headers.get("Referer") || "").slice(0, 500),
    ...fields,
  };
}

function htmlPage(title, body) {
  return new Response(
    `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#1f2937;margin:0;padding:24px}main{max-width:720px;margin:0 auto}.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:22px;margin:0 0 16px}h1{font-size:22px;margin:0 0 8px}h2{font-size:17px;margin:0 0 10px}p{color:#667085;line-height:1.55}code{background:#eef2ff;padding:1px 6px;border-radius:6px}input,select{padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;width:100%;box-sizing:border-box;margin:4px 0 10px}button{background:#4f46e5;color:#fff;border:0;font-weight:700;padding:9px 18px;border-radius:10px;cursor:pointer}table{width:100%;border-collapse:collapse;font-size:13px}td,th{border-bottom:1px solid #eee;padding:6px 4px;text-align:left;vertical-align:top}label{font-size:13px;font-weight:600}</style></head><body><main>${body}</main></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function errPage(status, title, msg) {
  const r = htmlPage(title, `<div class="card"><h1>${title}</h1><p>${msg}</p><p><a href="/">Về trang chính ztr.info</a></p></div>`);
  return new Response(r.body, { status, headers: r.headers });
}

function isAuthed(req, env) {
  const pw = env.ADMIN_PASSWORD || "";
  if (!pw) return false;
  const url = new URL(req.url);
  const qpw = url.searchParams.get("pw");
  if (qpw && qpw === pw) return "set-cookie";
  const cookie = req.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)ztr_admin=([^;]+)/);
  if (m && decodeURIComponent(m[1]) === pw) return true;
  return false;
}

async function buildFinalUrl(env, req, dest, site, placement) {
  const platform = affPlatform(dest);
  const platforms = await getPlatforms(env);
  const cfg = platform ? platformById(platforms, platform) : null;
  const cid = clickId();
  const params = [];
  if (cfg) {
    if (cfg.affiliate_id && cfg.affiliate_id !== "REPLACE_ME" && cfg.aff_param) {
      params.push([cfg.aff_param, cfg.affiliate_id]);
    }
    if (cfg.sub_key) {
      params.push([cfg.sub_key, renderSub(cfg.sub_template, { click_id: cid, site, placement })]);
    }
  }
  return { finalUrl: attachParams(dest, params), platform, cid };
}

async function handleGoto(req, env, ctx, destUrl, label) {
  const url = new URL(req.url);
  if (!destUrl) {
    return errPage(400, "Thiếu link đích", "Hãy thêm link Shopee/Lazada sau <code>url=</code>, ví dụ: <code>/goto?url=https://shopee.vn/...</code>");
  }
  let dest = destUrl.trim();
  if (!/^https?:\/\//i.test(dest)) dest = "https://" + dest;
  let host = "";
  try { host = new URL(dest).hostname; } catch (e) {
    return errPage(400, "Link chưa hợp lệ", "Link đích không phải một URL hợp lệ.");
  }
  if (!allowedHost(host)) {
    return errPage(400, "Chỉ chấp nhận link Shopee hoặc Lazada", "Domain đích không nằm trong danh sách cho phép.");
  }
  // Resolve short links (shope.ee / s.lazada.*) to the full URL first, so the
  // affiliate tag is not lost when the platform redirects further.
  if (isShortDomain(host)) {
    try {
      const r = await fetch(dest, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(5000) });
      const resolved = r.url;
      if (resolved && resolved !== dest) {
        let rhost = "";
        try { rhost = new URL(resolved).hostname; } catch (e) { /* keep original */ }
        if (rhost && allowedHost(rhost)) dest = resolved;
      }
    } catch (e) { /* keep original on failure */ }
  }
  const site = siteCode(req, url.searchParams);
  const placement = label || "";
  const { finalUrl, platform, cid } = await buildFinalUrl(env, req, dest, site, placement);
  // Log the click durably before redirecting (a lost redirect loses commission).
  try {
    await doCall(env, "/do/click", "POST", clickRecord(req, { click_id: cid, kind: "goto", dest: finalUrl, platform: platform || "", site, placement }));
  } catch (e) { /* never block the redirect on a log failure */ }
  return Response.redirect(finalUrl, 302);
}

async function handleShort(req, env, ctx, code) {
  const url = new URL(req.url);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(code)) {
    return errPage(404, "Link không tồn tại", "Mã rút gọn không hợp lệ.");
  }
  const site = siteCode(req, url.searchParams);
  const label = (url.searchParams.get("ref") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  let res;
  try {
    res = await doCall(env, "/do/link?code=" + encodeURIComponent(code));
  } catch (e) {
    return errPage(500, "Lỗi hệ thống", "Không đọc được link, vui lòng thử lại sau.");
  }
  if (!res.ok || !res.destination) {
    return errPage(404, "Link không tồn tại", "Link này có thể đã bị xóa hoặc bạn đã dán thiếu một phần.");
  }
  const { finalUrl, platform, cid } = await buildFinalUrl(env, req, res.destination, site, label);
  try {
    await doCall(env, "/do/click", "POST", clickRecord(req, { click_id: cid, kind: "g", dest: finalUrl, platform: platform || "", site, placement: label }));
  } catch (e) { /* never block the redirect on a log failure */ }
  return Response.redirect(finalUrl, 302);
}

async function handleBeacon(req, env, ctx) {
  const url = new URL(req.url);
  const s = (url.searchParams.get("s") || "").slice(0, 100);
  const d = (url.searchParams.get("d") || "").slice(0, 500);
  const ua = (req.headers.get("User-Agent") || "").slice(0, 500);
  const rec = clickRecord(req, { kind: "beacon", dest: d, platform: affPlatform(d) || "", site: s || "direct", placement: "" });
  ctx.waitUntil(doCall(env, "/do/click", "POST", rec).catch(() => {}));
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Cache-Control": "no-store",
    },
  });
}

function adminLoginForm(msg) {
  return htmlPage("Đăng nhập admin — ztr.info", `<div class="card"><h1>Admin ztr.info</h1>${msg ? `<p>${msg}</p>` : ""}<form method="get" action="/admin"><label>Mật khẩu</label><input type="password" name="pw" required><button type="submit">Đăng nhập</button></form></div>`);
}

async function adminDashboard(env) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    days.push(todayKey(new Date(Date.now() - i * 86400000)));
  }
  let stats = { counters: {}, recent: [], links: [] };
  try {
    const r = await doCall(env, "/do/stats?days=" + days.join(","));
    if (r.ok) stats = r;
  } catch (e) { /* show empty dashboard */ }
  const platforms = await getPlatforms(env);
  const platRows = platforms.map((p, i) => `
    <tr>
      <td><input name="id" value="${p.id}" readonly style="background:#f3f4f6"></td>
      <td><input name="name" value="${p.name}"></td>
      <td><input name="affiliate_id" value="${p.affiliate_id || ""}" placeholder="REPLACE_ME"></td>
      <td><input name="aff_param" value="${p.aff_param || ""}"></td>
      <td><input name="sub_key" value="${p.sub_key || ""}"></td>
      <td><input name="sub_template" value="${p.sub_template || ""}"></td>
      <td><button type="button" onclick="delPlat(${i})">Xóa</button></td>
    </tr>`).join("");
  const clickRows = stats.recent.map((r) => `<tr><td>${new Date(r.ts).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}</td><td>${r.kind || ""}</td><td>${r.site || ""}</td><td>${r.platform || ""}</td><td>${r.bot ? "BOT" : ""}</td><td style="word-break:break-all">${(r.dest || "").slice(0, 120)}</td></tr>`).join("") || `<tr><td colspan="6">Chưa có click nào.</td></tr>`;
  const linkRows = stats.links.map((l) => `<tr><td><a href="/g/${l.code}" target="_blank">${l.code}</a></td><td>${l.title || ""}</td><td style="word-break:break-all">${(l.destination || "").slice(0, 100)}</td><td><button type="button" onclick="delLink('${l.code}')">Xóa</button></td></tr>`).join("") || `<tr><td colspan="4">Chưa có short link nào.</td></tr>`;
  const dayRows = days.map((d) => { const c = stats.counters[d] || {}; return `<tr><td>${d}</td><td>${c.total || 0}</td><td>${c.bots || 0}</td><td>${c.shopee || 0}</td><td>${c.lazada || 0}</td><td>${c.beacon || 0}</td></tr>`; }).join("");
  const warn = platforms.some((p) => !p.affiliate_id || p.affiliate_id === "REPLACE_ME")
    ? `<p><b>Cảnh báo:</b> có sàn chưa đặt affiliate_id thật — click vẫn redirect và ghi log, nhưng chưa gắn mã affiliate nên chưa sinh hoa hồng. Đặt affiliate_id ở mục Cài đặt bên dưới.</p>` : "";
  return htmlPage("Admin — ztr.info", `
    <div class="card"><h1>Admin ztr.info</h1><p>Hub tracking affiliate: redirect + click + sub_id cho Shopee/Lazada.</p>${warn}</div>
    <div class="card"><h2>Thống kê 7 ngày gần nhất</h2><table><tr><th>Ngày</th><th>Tổng click</th><th>Bot</th><th>Shopee</th><th>Lazada</th><th>Beacon</th></tr>${dayRows}</table></div>
    <div class="card"><h2>Click gần nhất (20)</h2><table><tr><th>Thời gian</th><th>Loại</th><th>Site</th><th>Sàn</th><th>Bot</th><th>Đích</th></tr>${clickRows}</table></div>
    <div class="card"><h2>Short link</h2><table><tr><th>Mã</th><th>Tiêu đề</th><th>Đích</th><th></th></tr>${linkRows}</table>
      <h2 style="margin-top:16px">Tạo short link mới</h2>
      <form id="newLink"><label>Mã (để trống = tự sinh)</label><input name="code"><label>Link đích (Shopee/Lazada)</label><input name="destination" required><label>Tiêu đề</label><input name="title"><button type="submit">Tạo link</button></form><p id="linkMsg"></p></div>
    <div class="card"><h2>Cài đặt affiliate</h2><p>Mỗi sàn một mục. <code>aff_param</code> là khóa mang affiliate_id; <code>sub_key</code> là khóa mang sub_id; mẫu sub_id hỗ trợ <code>{click_id}</code>, <code>{site}</code>, <code>{placement}</code>. Thêm sàn mới chỉ cần thêm một dòng, không sửa code.</p>
      <form id="platForm"><table><tr><th>ID</th><th>Tên sàn</th><th>affiliate_id</th><th>aff_param</th><th>sub_key</th><th>Mẫu sub_id</th><th></th></tr><tbody id="platBody">${platRows}</tbody></table>
      <p><button type="button" onclick="addPlat()">+ Thêm sàn</button> <button type="submit">Lưu cài đặt</button></p></form><p id="platMsg"></p></div>
    <script>
      async function postJSON(path, obj) {
        const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
        return r.json();
      }
      document.getElementById("newLink").addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const r = await postJSON("/admin/api/links", { code: f.get("code"), destination: f.get("destination"), title: f.get("title") });
        document.getElementById("linkMsg").textContent = r.ok ? ("Đã tạo: /g/" + r.code) : ("Lỗi: " + (r.error || "?"));
        if (r.ok) setTimeout(() => location.reload(), 800);
      });
      async function delLink(code) {
        if (!confirm("Xóa link " + code + "?")) return;
        await postJSON("/admin/api/links/delete", { code });
        location.reload();
      }
      function addPlat() {
        const tr = document.createElement("tr");
        tr.innerHTML = '<td><input name="id" placeholder="vd: tiktok"></td><td><input name="name" placeholder="Tên sàn"></td><td><input name="affiliate_id" placeholder="REPLACE_ME"></td><td><input name="aff_param" placeholder="vd: aff_id"></td><td><input name="sub_key" placeholder="vd: sub_id"></td><td><input name="sub_template" value="{site}_{click_id}"></td><td></td>';
        document.getElementById("platBody").appendChild(tr);
      }
      async function delPlat(i) {
        const rows = document.querySelectorAll("#platBody tr");
        if (rows.length <= 1) { alert("Phải giữ ít nhất 1 sàn."); return; }
        rows[i].remove();
      }
      document.getElementById("platForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const rows = document.querySelectorAll("#platBody tr");
        const platforms = [];
        for (const tr of rows) {
          const inp = tr.querySelectorAll("input");
          const vals = [...inp].map((x) => x.value.trim());
          if (!vals[0]) continue;
          platforms.push({ id: vals[0], name: vals[1] || vals[0], affiliate_id: vals[2] || "REPLACE_ME", aff_param: vals[3], sub_key: vals[4], sub_template: vals[5] || "{click_id}" });
        }
        const r = await postJSON("/admin/api/config", { platforms });
        document.getElementById("platMsg").textContent = r.ok ? "Đã lưu cài đặt." : ("Lỗi: " + (r.error || "?"));
      });
    </script>`);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
    }

    if (path === "/") {
      return htmlPage("ztr.info — 7EN Labs affiliate tracking", `<div class="card"><h1>ztr.info</h1><p>Hub tracking affiliate của 7EN Labs: redirect + đo click + sub_id cho Shopee và Lazada. Mọi link affiliate trên các site của đội đi qua đây.</p><p><a href="/admin">Trang quản trị</a></p></div>`);
    }

    if (path === "/goto" || path === "/goto/") {
      // url= is one query param (URL-encoded when the destination itself has
      // & in it); s=/ref= are separate params, never part of the destination.
      const dest = url.searchParams.get("url") || "";
      const label = (url.searchParams.get("ref") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
      return handleGoto(req, env, ctx, dest, label);
    }

    if (path.startsWith("/g/")) {
      const code = decodeURIComponent(path.slice(3).split("/")[0]);
      return handleShort(req, env, ctx, code);
    }

    if (path === "/b") {
      return handleBeacon(req, env, ctx);
    }

    if (path === "/admin" || path === "/admin/") {
      const auth = isAuthed(req, env);
      if (!auth) {
        if (!env.ADMIN_PASSWORD) return adminLoginForm("Chưa đặt mật khẩu admin (secret ADMIN_PASSWORD).");
        return adminLoginForm("");
      }
      const resp = await adminDashboard(env);
      if (auth === "set-cookie") {
        resp.headers.set("Set-Cookie", `ztr_admin=${encodeURIComponent(new URL(req.url).searchParams.get("pw"))}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`);
      }
      return resp;
    }

    if (path === "/admin/api/config" && req.method === "GET") {
      if (!isAuthed(req, env)) return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
      const platforms = await getPlatforms(env);
      return new Response(JSON.stringify({ ok: true, platforms }), { headers: { "Content-Type": "application/json" } });
    }

    if (path === "/admin/api/config" && req.method === "POST") {
      if (!isAuthed(req, env)) return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
      let body;
      try { body = await req.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: "invalid json" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      const platforms = Array.isArray(body.platforms) ? body.platforms : [];
      const clean = [];
      for (const p of platforms) {
        const id = String(p.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
        if (!id) continue;
        clean.push({
          id,
          name: String(p.name || id).slice(0, 64),
          affiliate_id: String(p.affiliate_id || "REPLACE_ME").slice(0, 200),
          aff_param: String(p.aff_param || "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40),
          sub_key: String(p.sub_key || "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40),
          sub_template: String(p.sub_template || "{click_id}").slice(0, 200),
        });
      }
      if (clean.length === 0) {
        return new Response(JSON.stringify({ ok: false, error: "need at least one platform" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      await doCall(env, "/do/config", "POST", { platforms: clean });
      configCache = clean;
      configCacheAt = Date.now();
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    if (path === "/admin/api/links" && req.method === "POST") {
      if (!isAuthed(req, env)) return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
      let body;
      try { body = await req.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: "invalid json" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      const dest = String(body.destination || "").trim();
      let host = "";
      try { host = new URL(/^https?:\/\//i.test(dest) ? dest : "https://" + dest).hostname; } catch (e) { /* invalid */ }
      if (!host || !allowedHost(host)) {
        return new Response(JSON.stringify({ ok: false, error: "only Shopee/Lazada links" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      let code = String(body.code || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
      if (!code) code = clickId().slice(0, 6);
      const r = await doCall(env, "/do/link", "POST", { code, destination: dest, title: String(body.title || "").slice(0, 200) });
      if (!r.ok) {
        return new Response(JSON.stringify({ ok: false, error: r.error || "?" }), { status: r.error === "code exists" ? 409 : 400, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true, code }), { headers: { "Content-Type": "application/json" } });
    }

    if (path === "/admin/api/links/delete" && req.method === "POST") {
      if (!isAuthed(req, env)) return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
      let body;
      try { body = await req.json(); } catch (e) { body = {}; }
      const code = String(body.code || "");
      if (code) await doCall(env, "/do/link/delete", "POST", { code });
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    return errPage(404, "Không tìm thấy", "Đường dẫn này không tồn tại trên ztr.info.");
  },
};
