const crypto = require("crypto");

const registerToolsRoutes = (
  app,
  { asyncHandler, isProd, requireEnv, requireInternalAuth, toolsPassword, toolsCookieName, signToolsSession, nowIso }
) => {
  app.get("/internal/authStatus", (req, res) => {
    if (!requireInternalAuth(req, res)) return;
    return res.json({ ok: true });
  });

  app.post(
    "/tools/auth",
    asyncHandler(async (req, res) => {
      const passwordRaw = req.body && req.body.password ? String(req.body.password) : "";
      const password = passwordRaw
        .normalize("NFKC")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .trim();
      const allowCaseInsensitive = !process.env.TOOLS_PASSWORD;
      const passwordLower = allowCaseInsensitive ? password.toLowerCase() : "";
      const got = Buffer.from(password, "utf8");
      const gotLower = allowCaseInsensitive ? Buffer.from(passwordLower, "utf8") : null;
      const expectedTexts = [String(toolsPassword || "")].filter(Boolean);
      const expectedUnique = [...new Set(expectedTexts)];
      const same = expectedUnique.some((t) => {
        const expected = Buffer.from(t, "utf8");
        if (expected.length !== got.length) return false;
        try {
          return crypto.timingSafeEqual(expected, got);
        } catch (_) {
          return false;
        }
      }) || (allowCaseInsensitive && expectedUnique.some((t) => {
        const expectedLowerText = String(t).toLowerCase();
        const expectedLower = Buffer.from(expectedLowerText, "utf8");
        if (!gotLower || expectedLower.length !== gotLower.length) return false;
        try {
          return crypto.timingSafeEqual(expectedLower, gotLower);
        } catch (_) {
          return false;
        }
      }));
      try {
        const ip = (req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || req.ip || "").toString();
        const xRealIp = (req.headers["x-real-ip"] || "").toString();
        const xff = (req.headers["x-forwarded-for"] || "").toString();
        console.log(JSON.stringify({ tag: "tools_auth", ip, xRealIp, xff, ok: same, len: got.length }, null, 2));
      } catch (_) {}
      if (!same) {
        await new Promise((r) => setTimeout(r, 200));
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }

      const secret = requireEnv("INTERNAL_JOB_TOKEN");
      const expMs = Date.now() + 12 * 60 * 60 * 1000;
      const session = signToolsSession({ expMs }, secret);

      const forwardedProto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim().toLowerCase();
      const shouldSecure = isProd && (req.secure || forwardedProto === "https");

      const pieces = [
        `${toolsCookieName}=${encodeURIComponent(session)}`,
        "Path=/internal",
        "HttpOnly",
        "SameSite=Strict",
        `Max-Age=${12 * 60 * 60}`,
      ];
      if (shouldSecure) pieces.push("Secure");
      res.setHeader("Set-Cookie", pieces.join("; "));
      res.setHeader("X-Imfine-Origin", `node-${process.pid}`);
      return res.json({ ok: true, session });
    })
  );

  app.post("/tools/logout", (req, res) => {
    const forwardedProto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim().toLowerCase();
    const shouldSecure = isProd && (req.secure || forwardedProto === "https");
    const pieces = [
      `${toolsCookieName}=`,
      "Path=/internal",
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=0",
    ];
    if (shouldSecure) pieces.push("Secure");
    res.setHeader("Set-Cookie", pieces.join("; "));
    return res.json({ ok: true });
  });

  app.get("/tools", (req, res) => {
    res
      .status(200)
      .setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
      .setHeader("Pragma", "no-cache")
      .setHeader("Expires", "0")
      .setHeader("Surrogate-Control", "no-store")
      .type("text/html; charset=utf-8")
      .send(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>imfine tools</title>
    <style>
      :root { color-scheme: light; }
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"; margin: 20px; color: #111; background: #fff; }
      h1 { margin: 0 0 12px; font-size: 18px; }
      h2 { margin: 20px 0 10px; font-size: 15px; }
      .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      input, select, button, textarea { font: inherit; }
      input[type="text"] { padding: 8px 10px; border: 1px solid #ddd; border-radius: 8px; min-width: 320px; }
      input.small { min-width: 120px; width: 120px; }
      button { padding: 8px 10px; border: 1px solid #ddd; border-radius: 8px; background: #fafafa; cursor: pointer; }
      button:disabled { opacity: .6; cursor: not-allowed; }
      .card { border: 1px solid #eee; border-radius: 12px; padding: 12px; background: #fff; }
      .muted { color: #666; font-size: 12px; }
      .grid { display: grid; gap: 12px; }
      .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border-bottom: 1px solid #eee; text-align: left; padding: 8px; vertical-align: top; }
      th { font-size: 12px; color: #666; font-weight: 600; }
      td { font-size: 13px; }
      a { color: #0b57d0; text-decoration: none; }
      a:hover { text-decoration: underline; }
      pre { background: #0b1020; color: #eaefff; padding: 10px; border-radius: 10px; overflow: auto; }
      .cols { display: grid; grid-template-columns: 240px 1fr; gap: 12px; }
      .list { border: 1px solid #eee; border-radius: 10px; overflow: auto; max-height: 320px; }
      .list button { width: 100%; border: 0; border-bottom: 1px solid #f2f2f2; border-radius: 0; background: #fff; text-align: left; padding: 10px; }
      .list button:hover { background: #fafafa; }
      .list button.active { background: #f3f7ff; }
      .error { color: #b42318; }
    </style>
  </head>
  <body>
    <h1>imfine 工具</h1>
    <div class="muted">build: ${nowIso ? nowIso() : new Date().toISOString()}</div>
    <div class="card grid">
      <div class="row">
        <div style="min-width:110px">工具密码</div>
        <input
          id="toolsPassword"
          name="tools_password"
          type="password"
          placeholder="输入密码（不会保存）"
          autocomplete="new-password"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          inputmode="latin"
        />
        <label class="muted" style="display:flex;align-items:center;gap:6px">
          <input id="toolsShowPw" type="checkbox" />
          显示
        </label>
        <button id="toolsLogin">登录</button>
        <button id="toolsLogout">退出</button>
        <span id="authHint" class="muted"></span>
      </div>
      <div class="muted">提示：只有登录成功才会请求 /internal/* 数据。</div>
    </div>

    <h2>系统</h2>
    <div class="card grid">
      <div class="row">
        <button id="serverRuntime">检测运行环境</button>
        <button id="serverRestart">重启服务</button>
        <span id="serverRestartStatus" class="muted"></span>
      </div>
      <pre id="serverRuntimeOut" class="mono" style="max-height:240px"></pre>
      <div id="serverRuntimeHint" class="muted"></div>
    </div>

    <h2>公众号素材</h2>
    <div class="card grid">
      <div class="row">
        <select id="matType">
          <option value="image">image</option>
          <option value="video">video</option>
          <option value="voice">voice</option>
          <option value="news">news</option>
        </select>
        <input id="matOffset" class="small" type="number" value="0" min="0" />
        <input id="matCount" class="small" type="number" value="20" min="1" max="20" />
        <button id="matLoad">加载</button>
        <span id="matStatus" class="muted"></span>
      </div>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>mediaId</th>
              <th>name</th>
              <th>url</th>
              <th>updateTime</th>
            </tr>
          </thead>
          <tbody id="matBody"></tbody>
        </table>
      </div>
    </div>

    <h2>数据库</h2>
    <div class="card grid">
      <div class="row">
        <button id="dbLoad">加载集合</button>
        <span id="dbStatus" class="muted"></span>
      </div>
      <div class="cols">
        <div class="list" id="dbList"></div>
        <div class="grid">
          <div class="row">
            <div class="muted" style="min-width:60px">collection</div>
            <div id="dbSelected" class="mono"></div>
          </div>
          <div class="row">
            <div class="muted" style="min-width:60px">limit</div>
            <input id="dbLimit" class="small" type="number" min="1" max="50" value="20" />
            <div class="muted" style="min-width:30px">q</div>
            <input id="dbQuery" type="text" placeholder='{"_id":"..."}' />
            <button id="dbFind">查询</button>
            <span id="dbFindStatus" class="muted"></span>
          </div>
          <pre id="dbOut" class="mono"></pre>
        </div>
      </div>
    </div>

    <h2>守护关系</h2>
    <div class="card grid">
      <div class="row">
        <div class="muted" style="min-width:70px">搜索</div>
        <input id="guardianQ" type="text" placeholder="模糊匹配 openid / name / scene（也用于小程序邀请关系）" />
        <div class="muted" style="min-width:40px">limit</div>
        <input id="guardianLimit" class="small" type="number" min="1" max="200" value="50" />
        <button id="guardianLoad">加载</button>
        <span id="guardianStatus" class="muted"></span>
      </div>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>elderOpenid</th>
              <th>guardianMpOpenid</th>
              <th>scene</th>
              <th>updatedAt</th>
              <th>createdAt</th>
              <th>op</th>
            </tr>
          </thead>
          <tbody id="guardianBody"></tbody>
        </table>
      </div>
      <div class="card grid">
        <div class="row">
          <div style="min-width:90px">发送模板测试</div>
          <select id="guardianTestKind" class="small">
            <option value="guardian" selected>守护者消息</option>
            <option value="elder">被守护者消息</option>
          </select>
          <input id="guardianToUser" type="text" placeholder="接收者公众号 openid" />
          <input id="guardianTestElderName" class="small" type="text" placeholder="被守护者姓名(可选)" />
          <input id="guardianTestDateKey" class="small mono" type="text" placeholder="dateKey(可选,YYYY-MM-DD)" />
          <button id="guardianSend">发送</button>
          <span id="guardianSendStatus" class="muted"></span>
        </div>
        <textarea
          id="guardianRemark"
          rows="3"
          placeholder="remark（可选，不填会自动生成）"
          style="padding:8px 10px;border:1px solid #ddd;border-radius:10px"
        ></textarea>
      </div>

      <div class="card">
        <div class="row" style="margin-bottom:8px">
          <div class="muted" style="min-width:140px">小程序邀请关系</div>
          <button id="miniGuardianLoad">加载</button>
          <span id="miniGuardianStatus" class="muted"></span>
        </div>
        <div class="row" style="margin-bottom:8px">
          <div class="muted" style="min-width:140px">按 relationId 解除</div>
          <input id="miniGuardianUnbindId" type="text" placeholder="例如：inviterOpenid__inviteeOpenid" />
          <button id="miniGuardianUnbind">解除</button>
        </div>
        <table>
          <thead>
            <tr>
              <th>relationId</th>
              <th>inviterOpenid</th>
              <th>inviteeOpenid</th>
              <th>inviterName</th>
              <th>inviteeName</th>
              <th>sceneId</th>
              <th>acceptedAt</th>
              <th>op</th>
            </tr>
          </thead>
          <tbody id="miniGuardianBody"></tbody>
        </table>
      </div>
    </div>

    <h2>实时日志</h2>
    <div class="card grid">
      <div class="row">
        <button id="logStart">开始</button>
        <button id="logStop" disabled>停止</button>
        <button id="logClear">清空</button>
        <input id="logFilter" type="text" placeholder="过滤关键字（可选）" />
        <span id="logStatus" class="muted"></span>
      </div>
      <pre id="logBox" class="mono" style="max-height:420px"></pre>
      <div class="muted">NDJSON 流：/internal/logStream</div>
    </div>

    <script>
      const $ = (id) => document.getElementById(id);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let toolsSession = "";
      try {
        toolsSession = sessionStorage.getItem("imfine_tools_session") || "";
      } catch (_) {}

      const fetchJson = async (url, options) => {
        const inputHeaders = (options && options.headers) ? options.headers : {};
        const headers = Array.isArray(inputHeaders) ? inputHeaders.slice() : { ...inputHeaders };
        if (toolsSession && typeof url === "string" && url.startsWith("/internal/")) {
          if (Array.isArray(headers)) headers.push(["x-tools-session", toolsSession]);
          else headers["x-tools-session"] = toolsSession;
        }
        const res = await fetch(url, { credentials: "same-origin", ...options, headers });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) {}
        if (!res.ok) {
          const msg = (data && data.error) ? data.error : (text || (res.status + ""));
          throw new Error(msg);
        }
        return data;
      };

      const fmtTs = (ts) => {
        const pad2 = (n) => String(n).padStart(2, "0");
        const pad3 = (n) => String(n).padStart(3, "0");
        const formatShanghaiFromUtcMs = (utcMs) => {
          const d = new Date(Number(utcMs) + 8 * 60 * 60 * 1000);
          return (
            d.getUTCFullYear() +
            "-" +
            pad2(d.getUTCMonth() + 1) +
            "-" +
            pad2(d.getUTCDate()) +
            " " +
            pad2(d.getUTCHours()) +
            ":" +
            pad2(d.getUTCMinutes()) +
            ":" +
            pad2(d.getUTCSeconds()) +
            "." +
            pad3(d.getUTCMilliseconds())
          );
        };

        const s = ts == null ? "" : String(ts);
        const mShanghai =
          /^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}:[0-9]{2}:[0-9]{2})([.][0-9]+)?[+]08:00$/.exec(s) ||
          /^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}:[0-9]{2}:[0-9]{2})([.][0-9]+)?[+]0800$/.exec(s);
        if (mShanghai) return mShanghai[1] + " " + mShanghai[2] + (mShanghai[3] || "");

        const m =
          /^([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2}):([0-9]{2})([.]([0-9]{1,3}))?(Z|([+-])([0-9]{2}):?([0-9]{2}))$/.exec(
            s
          );
        if (m) {
          const year = Number(m[1]);
          const month = Number(m[2]);
          const day = Number(m[3]);
          const hour = Number(m[4]);
          const minute = Number(m[5]);
          const second = Number(m[6]);
          const ms = m[8] ? Number(String(m[8]).padEnd(3, "0")) : 0;
          let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, ms);
          if (m[9] !== "Z") {
            const sign = m[10] === "-" ? -1 : 1;
            const offH = Number(m[11]);
            const offM = Number(m[12]);
            const offsetMs = sign * (offH * 60 + offM) * 60 * 1000;
            utcMs -= offsetMs;
          }
          return formatShanghaiFromUtcMs(utcMs);
        }

        const n = Number(s);
        if (Number.isFinite(n) && s.trim() && /^[0-9]{10,}$/.test(s.trim())) return formatShanghaiFromUtcMs(n);
        return s || "";
      };

      const checkAuth = async () => {
        try {
          await fetchJson("/internal/authStatus");
          $("authHint").textContent = "已登录";
          $("authHint").classList.remove("error");
        } catch (e) {
          $("authHint").textContent = "未登录";
          $("authHint").classList.add("error");
        }
      };

      const renderRuntime = (runtime) => {
        if (!runtime) {
          $("serverRuntimeOut").textContent = "";
          $("serverRuntimeHint").textContent = "";
          return;
        }
        $("serverRuntimeOut").textContent = JSON.stringify(runtime, null, 2);
        const hint = runtime && runtime.restart && runtime.restart.hint ? String(runtime.restart.hint) : "";
        $("serverRuntimeHint").textContent = hint;
      };

      $("serverRuntime").onclick = async () => {
        $("serverRestartStatus").textContent = "检测中...";
        $("serverRestartStatus").classList.remove("error");
        try {
          const j = await fetchJson("/internal/runtimeInfo");
          renderRuntime(j && j.runtime ? j.runtime : null);
          $("serverRestartStatus").textContent = "ok";
        } catch (e) {
          $("serverRestartStatus").textContent = "检测失败：" + (e && e.message ? e.message : "unknown");
          $("serverRestartStatus").classList.add("error");
        }
      };

      $("serverRestart").onclick = async () => {
        $("serverRestartStatus").textContent = "请求中...";
        $("serverRestartStatus").classList.remove("error");
        try {
          let runtime = null;
          try {
            const j = await fetchJson("/internal/runtimeInfo");
            runtime = j && j.runtime ? j.runtime : null;
            renderRuntime(runtime);
          } catch (_) {}

          const likelyOk = runtime && runtime.restart && runtime.restart.likelyOk === true;
          const hint = runtime && runtime.restart && runtime.restart.hint ? String(runtime.restart.hint) : "";
          const msg = likelyOk
            ? ("确认重启服务？（当前连接会断开）" + (hint ? ("\\n" + hint) : ""))
            : ("未检测到明确的进程守护，点击后可能直接停服。\\n仍要继续吗？" + (hint ? ("\\n" + hint) : ""));
          const ok = confirm(msg);
          if (!ok) {
            $("serverRestartStatus").textContent = "";
            return;
          }
          const r = await fetchJson("/internal/restartServer", { method: "POST" });
          renderRuntime(r && r.runtime ? r.runtime : runtime);
          $("serverRestartStatus").textContent = "已触发重启（页面可能会断开）";
        } catch (e) {
          $("serverRestartStatus").textContent = "失败：" + (e && e.message ? e.message : "unknown");
          $("serverRestartStatus").classList.add("error");
        }
      };

      $("toolsLogin").onclick = async () => {
        $("authHint").textContent = "登录中...";
        $("authHint").classList.remove("error");
        try {
          const raw = $("toolsPassword").value || "";
          const normalized = String(raw)
            .normalize("NFKC")
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            .trim();
          const asciiOnly = /^[\x20-\x7E]*$/.test(normalized);
          const j = await fetchJson("/tools/auth", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: normalized }),
          });
          toolsSession = (j && j.session) ? String(j.session) : "";
          try {
            if (toolsSession) sessionStorage.setItem("imfine_tools_session", toolsSession);
          } catch (_) {}
          $("toolsPassword").value = "";
          await checkAuth();
        } catch (e) {
          const msg = e && e.message ? String(e.message) : "unknown";
          const raw = $("toolsPassword").value || "";
          const normalized = String(raw)
            .normalize("NFKC")
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            .trim();
          const asciiOnly = /^[\x20-\x7E]*$/.test(normalized);
          $("authHint").textContent =
            msg === "unauthorized"
              ? "登录失败：密码错误（len=" +
                String(raw).length +
                "→" +
                normalized.length +
                "；ascii=" +
                (asciiOnly ? "1" : "0") +
                "）"
              : "登录失败：" + msg;
          $("authHint").classList.add("error");
        }
      };

      $("toolsLogout").onclick = async () => {
        toolsSession = "";
        try { sessionStorage.removeItem("imfine_tools_session"); } catch (_) {}
        try {
          await fetchJson("/tools/logout", { method: "POST" });
        } catch (_) {}
        await checkAuth();
      };

      $("matLoad").onclick = async () => {
        $("matStatus").textContent = "加载中...";
        $("matStatus").classList.remove("error");
        try {
          const type = $("matType").value;
          const offset = $("matOffset").value || "0";
          const count = $("matCount").value || "20";
          const j = await fetchJson(
            "/internal/listMpMaterials?type=" +
              encodeURIComponent(type) +
              "&offset=" +
              encodeURIComponent(offset) +
              "&count=" +
              encodeURIComponent(count)
          );

          $("matBody").innerHTML = "";
          for (const it of (j.items || [])) {
            const tr = document.createElement("tr");
            tr.innerHTML = "<td class='mono'></td><td></td><td class='mono'></td><td class='mono'></td>";
            tr.children[0].textContent = it.mediaId || "";
            tr.children[1].textContent = it.name || "";
            const a = document.createElement("a");
            a.href = it.url || "#";
            a.target = "_blank";
            a.textContent = it.url || "";
            tr.children[2].appendChild(a);
            tr.children[3].textContent = it.updateTime ? String(it.updateTime) : "";
            $("matBody").appendChild(tr);
          }

          $("matStatus").textContent = "ok";
        } catch (e) {
          $("matStatus").textContent = "失败：" + (e && e.message ? e.message : "unknown");
          $("matStatus").classList.add("error");
        }
      };

      let selectedCollection = "";
      const setSelectedCollection = (name) => {
        selectedCollection = name || "";
        $("dbSelected").textContent = selectedCollection;
        for (const btn of $("dbList").querySelectorAll("button")) {
          btn.classList.toggle("active", btn.dataset.name === selectedCollection);
        }
      };

      $("dbLoad").onclick = async () => {
        $("dbStatus").textContent = "加载中...";
        $("dbStatus").classList.remove("error");
        try {
          const j = await fetchJson("/internal/dbCollections");
          $("dbList").innerHTML = "";
          for (const c of (j.collections || [])) {
            const btn = document.createElement("button");
            btn.dataset.name = c.name || "";
            btn.textContent = (c.name || "") + (c.count != null ? (" (" + c.count + ")") : "");
            btn.onclick = () => setSelectedCollection(btn.dataset.name);
            $("dbList").appendChild(btn);
          }
          if ((j.collections || []).length && !selectedCollection) setSelectedCollection(j.collections[0].name || "");
          $("dbStatus").textContent = "ok";
        } catch (e) {
          $("dbStatus").textContent = "失败：" + (e && e.message ? e.message : "unknown");
          $("dbStatus").classList.add("error");
        }
      };

      $("dbFind").onclick = async () => {
        $("dbFindStatus").textContent = "查询中...";
        $("dbFindStatus").classList.remove("error");
        try {
          if (!selectedCollection) throw new Error("请选择 collection");
          const qs = new URLSearchParams();
          qs.set("collection", selectedCollection);
          qs.set("limit", $("dbLimit").value || "20");
          const q = $("dbQuery").value || "";
          if (q.trim()) qs.set("q", q);
          const j = await fetchJson("/internal/dbFind?" + qs.toString());
          $("dbOut").textContent = JSON.stringify(j, null, 2);
          $("dbFindStatus").textContent = "ok";
        } catch (e) {
          $("dbFindStatus").textContent = "失败：" + (e && e.message ? e.message : "unknown");
          $("dbFindStatus").classList.add("error");
        }
      };

      const loadGuardianLinks = async () => {
        $("guardianStatus").textContent = "加载中...";
        $("guardianStatus").classList.remove("error");
        try {
          const qs = new URLSearchParams();
          const q = ($("guardianQ").value || "").trim();
          const limit = $("guardianLimit").value || "50";
          if (q) qs.set("q", q);
          qs.set("limit", limit);
          const j = await fetchJson("/internal/listGuardianLinks?" + qs.toString());

          $("guardianBody").innerHTML = "";
          for (const it of (j.items || [])) {
            const tr = document.createElement("tr");
            tr.style.cursor = "pointer";
            tr.innerHTML = "<td class='mono'></td><td class='mono'></td><td class='mono'></td><td class='mono'></td><td class='mono'></td><td></td>";
            tr.children[0].textContent = it.elderOpenid || "";
            tr.children[1].textContent = it.guardianMpOpenid || "";
            tr.children[2].textContent = it.scene || "";
            tr.children[3].textContent = fmtTs(it.updatedAt);
            tr.children[4].textContent = fmtTs(it.createdAt);
            const btn = document.createElement("button");
            btn.textContent = "解除";
            btn.onclick = async (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              const ok = confirm("确认解除这条绑定关系？");
              if (!ok) return;
              $("guardianStatus").textContent = "解除中...";
              $("guardianStatus").classList.remove("error");
              try {
                await fetchJson("/internal/unbindGuardianLink", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ id: it.id || "" }),
                });
                tr.remove();
                const left = $("guardianBody").querySelectorAll("tr").length;
                $("guardianStatus").textContent = "ok (" + String(left) + ")";
              } catch (e) {
                $("guardianStatus").textContent = "解除失败：" + (e && e.message ? e.message : "unknown");
                $("guardianStatus").classList.add("error");
              }
            };
            tr.children[5].appendChild(btn);
            tr.onclick = () => {
              $("guardianTestKind").value = "guardian";
              $("guardianToUser").value = it.guardianMpOpenid || "";
              if (!$("guardianRemark").value.trim()) $("guardianRemark").value = "";
            };
            $("guardianBody").appendChild(tr);
          }

          $("guardianStatus").textContent = "ok (" + String(j.count || (j.items || []).length || 0) + ")";
        } catch (e) {
          $("guardianStatus").textContent = "失败：" + (e && e.message ? e.message : "unknown");
          $("guardianStatus").classList.add("error");
        }
      };

      const loadMiniGuardianLinks = async () => {
        $("miniGuardianStatus").textContent = "加载中...";
        $("miniGuardianStatus").classList.remove("error");
        try {
          const qs = new URLSearchParams();
          const q = ($("guardianQ").value || "").trim();
          const limit = $("guardianLimit").value || "50";
          if (q) qs.set("q", q);
          qs.set("limit", limit);
          const j = await fetchJson("/internal/listMiniGuardianLinks?" + qs.toString());

          $("miniGuardianBody").innerHTML = "";
          for (const it of (j.items || [])) {
            const tr = document.createElement("tr");
            tr.innerHTML =
              "<td class='mono'></td><td class='mono'></td><td class='mono'></td><td></td><td></td><td class='mono'></td><td class='mono'></td><td></td>";
            tr.children[0].textContent = it.id || "";
            tr.children[1].textContent = it.inviterOpenid || "";
            tr.children[2].textContent = it.inviteeOpenid || "";
            tr.children[3].textContent = it.inviterName || "";
            tr.children[4].textContent = it.inviteeName || "";
            tr.children[5].textContent = it.sceneId || "";
            tr.children[6].textContent = fmtTs(it.acceptedAt);
            const btn = document.createElement("button");
            btn.textContent = "解除";
            btn.onclick = async (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              const ok = confirm("确认解除这条小程序邀请关系？");
              if (!ok) return;
              $("miniGuardianStatus").textContent = "解除中...";
              $("miniGuardianStatus").classList.remove("error");
              try {
                await fetchJson("/internal/unbindMiniGuardianLink", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ id: it.id || "" }),
                });
                tr.remove();
                const left = $("miniGuardianBody").querySelectorAll("tr").length;
                $("miniGuardianStatus").textContent = "ok (" + String(left) + ")";
              } catch (e) {
                $("miniGuardianStatus").textContent = "解除失败：" + (e && e.message ? e.message : "unknown");
                $("miniGuardianStatus").classList.add("error");
              }
            };
            tr.children[7].appendChild(btn);
            $("miniGuardianBody").appendChild(tr);
          }

          $("miniGuardianStatus").textContent = "ok (" + String(j.count || (j.items || []).length || 0) + ")";
        } catch (e) {
          $("miniGuardianStatus").textContent = "失败：" + (e && e.message ? e.message : "unknown");
          $("miniGuardianStatus").classList.add("error");
        }
      };

      $("guardianLoad").onclick = async () => {
        await loadGuardianLinks();
        await loadMiniGuardianLinks();
      };

      $("guardianSend").onclick = async () => {
        $("guardianSendStatus").textContent = "发送中...";
        $("guardianSendStatus").classList.remove("error");
        try {
          const kind = ($("guardianTestKind").value || "guardian").trim();
          const toUser = ($("guardianToUser").value || "").trim();
          const elderName = ($("guardianTestElderName").value || "").trim();
          const dateKey = ($("guardianTestDateKey").value || "").trim();
          const remark = ($("guardianRemark").value || "").trim();
          const j = await fetchJson("/internal/sendTestGuardianText", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind, toUser, elderName, dateKey, remark }),
          });
          $("guardianSendStatus").textContent = j && j.ok ? "ok" : "ok";
        } catch (e) {
          $("guardianSendStatus").textContent = "失败：" + (e && e.message ? e.message : "unknown");
          $("guardianSendStatus").classList.add("error");
        }
      };

      $("miniGuardianLoad").onclick = loadMiniGuardianLinks;

      $("miniGuardianUnbind").onclick = async () => {
        $("miniGuardianStatus").textContent = "解除中...";
        $("miniGuardianStatus").classList.remove("error");
        try {
          const id = ($("miniGuardianUnbindId").value || "").trim();
          if (!id) throw new Error("请输入 relationId");
          const ok = confirm("确认解除这条小程序邀请关系？");
          if (!ok) {
            $("miniGuardianStatus").textContent = "";
            return;
          }
          await fetchJson("/internal/unbindMiniGuardianLink", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id }),
          });
          $("miniGuardianStatus").textContent = "ok";
          $("miniGuardianUnbindId").value = "";
        } catch (e) {
          $("miniGuardianStatus").textContent = "解除失败：" + (e && e.message ? e.message : "unknown");
          $("miniGuardianStatus").classList.add("error");
        }
      };

      let logShouldRun = false;
      let logAbort = null;
      let logReader = null;
      let logBufferText = "";
      let logEntries = [];
      let logReconnectTimer = null;
      let logReconnectAttempt = 0;

      const scheduleReconnect = () => {
        clearTimeout(logReconnectTimer);
        const ms = Math.min(30_000, 500 * Math.pow(2, logReconnectAttempt++));
        logReconnectTimer = setTimeout(() => startLogs(), ms);
        $("logStatus").textContent = "重连中，等待 " + ms + "ms";
      };

      const parseLines = (chunk) => {
        logBufferText += chunk;
        const lines = logBufferText.split("\\n");
        logBufferText = lines.pop() || "";
        return lines;
      };

      const renderLogEntry = (e) => {
        const f = ($("logFilter").value || "").trim();
        let payloadText = "";
        if (e && typeof e === "object" && e.line != null) {
          payloadText = String(e.line || "");
        } else {
          try {
            payloadText = JSON.stringify(e, null, 2);
          } catch (_) {
            payloadText = String(e || "");
          }
        }
        if (payloadText.length > 12_000) payloadText = payloadText.slice(0, 12_000) + "...[truncated]";
        const text = "[" + fmtTs(e.ts) + "] " + (e.level || "") + " " + payloadText;
        if (f && !text.includes(f)) return;
        const line = document.createElement("div");
        line.textContent = text;
        $("logBox").appendChild(line);
        $("logBox").scrollTop = $("logBox").scrollHeight;
      };

      const startLogs = async () => {
        if (logAbort) return;
        logShouldRun = true;
        $("logStatus").textContent = "连接中...";
        $("logStart").disabled = true;
        $("logStop").disabled = false;
        logAbort = new AbortController();
        const logUrl = "/internal/logStream?n=200";
        const startedAttempt = logReconnectAttempt;

        try {
          const headers = toolsSession ? { "x-tools-session": toolsSession } : {};
          const res = await fetch(logUrl, { credentials: "same-origin", signal: logAbort.signal, headers });
          if (!res.ok) {
            const t = await res.text();
            throw new Error(t || (res.status + ""));
          }

          logReconnectAttempt = 0;
          $("logStatus").textContent = "已连接";
          logReader = res.body.getReader();
          const decoder = new TextDecoder("utf-8");

          while (true) {
            const { done, value } = await logReader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            for (const line of parseLines(chunk)) {
              if (!line.trim()) continue;
              let j = null;
              try { j = JSON.parse(line); } catch (_) { j = { ts: nowIso ? nowIso() : new Date().toISOString(), level: "raw", line }; }
              logEntries.push(j);
              if (logEntries.length > 2000) logEntries.shift();
              renderLogEntry(j);
            }
          }

          if (logShouldRun) scheduleReconnect();
        } catch (e) {
          const isAbort = e && (e.name === "AbortError" || (e.message || "").includes("aborted"));
          if (isAbort) {
            $("logStatus").textContent = "已停止";
          } else {
            const msg = e && e.message ? e.message : "network error";
            $("logStatus").textContent = "断开：" + msg;
            if (logShouldRun && startedAttempt === 0) await sleep(200);
            if (logShouldRun) scheduleReconnect();
          }
        } finally {
          try { if (logReader) logReader.releaseLock(); } catch (_) {}
          logReader = null;
          logAbort = null;
          $("logStart").disabled = false;
          $("logStop").disabled = true;
        }
      };

      const stopLogs = () => {
        logShouldRun = false;
        clearTimeout(logReconnectTimer);
        logReconnectTimer = null;
        logReconnectAttempt = 0;
        try { if (logAbort) logAbort.abort(); } catch (_) {}
        $("logStatus").textContent = "已停止";
        $("logStart").disabled = false;
        $("logStop").disabled = true;
      };

      const clearLogs = () => {
        $("logBox").innerHTML = "";
        logEntries = [];
      };

      $("logStart").onclick = startLogs;
      $("logStop").onclick = stopLogs;
      $("logClear").onclick = clearLogs;
      $("logFilter").addEventListener("input", () => {
        $("logBox").innerHTML = "";
        for (const e of logEntries) renderLogEntry(e);
      });

      const init = () => {
        $("toolsShowPw").addEventListener("change", () => {
          $("toolsPassword").type = $("toolsShowPw").checked ? "text" : "password";
        });
        checkAuth();
      };
      init();
    </script>
  </body>
</html>`);
  });
};

module.exports = { registerToolsRoutes };
