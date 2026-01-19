process.env.TZ = process.env.TZ || "Asia/Shanghai";

const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const childProcess = require("child_process");
const { createStorage } = require("./lib/storage");
const { createWeChatClient } = require("./lib/wechat");
const { registerApiRoutes } = require("./routes/api");
const { registerInternalRoutes } = require("./routes/internal");
const { registerToolsRoutes } = require("./routes/tools");

const app = express();

app.get("/health", (req, res) => res.status(200).send("ok"));

app.use(express.json({ limit: "2mb" }));

const isProd = process.env.NODE_ENV === "production";
const shouldLogHttp = !isProd || process.env.LOG_HTTP === "true";
const shouldLogHttpBodies = process.env.LOG_HTTP_BODIES === "true";

const sanitizeForLog = (value, depth = 0) => {
  const maxDepth = 6;
  if (depth > maxDepth) return "[max_depth]";
  if (value == null) return value;
  if (typeof value === "string") {
    const s = value;
    if (s.startsWith("eyJ") && s.split(".").length >= 3) return `[redacted_jwt len=${s.length}]`;
    if (s.startsWith("100_") && s.length > 20) return `[redacted_wechat_token len=${s.length}]`;
    if (s.length > 2000) return s.slice(0, 2000) + "...[truncated]";
    return s;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeForLog(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    const entries = Object.entries(value).slice(0, 200);
    for (const [k, v] of entries) {
      const key = String(k).toLowerCase();
      if (
        key.includes("token") ||
        key.includes("secret") ||
        key.includes("password") ||
        key.includes("authorization") ||
        key.includes("session") ||
        key.includes("sessionkey") ||
        key === "access_token" ||
        key === "accesstoken"
      ) {
        const sv = v == null ? "" : String(v);
        out[k] = sv ? `[redacted len=${sv.length}]` : "[redacted]";
      } else {
        out[k] = sanitizeForLog(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
};

const logSubscribers = new Set();
const logBuffer = [];
const maxLogBuffer = 800;
const maxLogSubscribers = 20;

const nowChinaIso = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}.${ms}+08:00`;
};

const stringifyLogArg = (v) => {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v == null) return "";
  try {
    return JSON.stringify(v);
  } catch (_) {
    return String(v);
  }
};

const pushLogEntry = (level, args) => {
  let entry = null;
  if (args && args.length === 1 && typeof args[0] === "string") {
    const raw = args[0];
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          entry = { ...parsed, ts: nowChinaIso(), level };
        }
      } catch (_) {}
    }
  }
  if (!entry) {
    const line = args.map(stringifyLogArg).filter(Boolean).join(" ");
    entry = { ts: nowChinaIso(), level, line };
  }
  logBuffer.push(entry);
  while (logBuffer.length > maxLogBuffer) logBuffer.shift();
  for (const fn of [...logSubscribers]) {
    try {
      fn(entry);
    } catch (_) {
      logSubscribers.delete(fn);
    }
  }
};

const wrapConsole = (level) => {
  const orig = console[level];
  console[level] = (...args) => {
    try {
      pushLogEntry(level, args);
    } catch (_) {}
    return orig.apply(console, args);
  };
};

wrapConsole("log");
wrapConsole("error");

const shouldTranslateErrorForPath = (p) => typeof p === "string" && (p.startsWith("/api/") || p.startsWith("/internal/"));

const translateErrorBody = (p, body) => {
  if (!shouldTranslateErrorForPath(p)) return body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  if (body.ok !== false) return body;
  if (typeof body.error !== "string") return body;

  const hasChinese = /[\u4e00-\u9fff]/.test(body.error);
  if (hasChinese) return body;

  const code = body.code != null ? String(body.code) : "";
  const error = body.error;

  const zhByCode = {
    SCENE_NOT_FOUND: "邀请不存在或已失效",
    SCENE_EXPIRED: "邀请已过期",
    SELF_BIND_NOT_ALLOWED: "不能绑定自己",
  };

  const zhByError = {
    unauthorized: "未授权",
    "missing token": "缺少登录凭证",
    "invalid token": "登录凭证无效",
    "missing code": "缺少 code",
    "missing sceneId": "缺少 sceneId",
    "scene not found": "邀请不存在或已失效",
    "scene expired": "邀请已过期",
    "missing inviter": "缺少邀请人信息",
    "invalid env_version": "env_version 参数不合法",
    "invalid channel": "channel 参数不合法",
    "missing openid": "获取用户身份失败",
    "jscode2session failed": "登录失败",
    "self bind not allowed": "不能绑定自己",
    "missing id": "缺少 id",
    "not found": "未找到记录",
    "missing toUser": "缺少 toUser",
    "missing content": "缺少 content",
    "content too long": "内容过长",
    "missing avatarUrl": "缺少 avatarUrl",
    "avatarUrl too long": "头像地址过长",
    "invalid avatarUrl": "头像地址不合法",
    "missing fields": "缺少需要更新的字段",
    "invalid age": "年龄不合法",
    "invalid gender": "性别不合法",
    "invalid familyName": "姓氏不合法",
    "send failed": "发送失败",
    "server error": "服务器错误",
  };

  let zh = "";
  if (code && zhByCode[code]) zh = zhByCode[code];
  if (!zh && zhByError[error]) zh = zhByError[error];
  if (!zh && /^missing env:\s*/.test(error)) zh = "服务器配置缺失";

  if (zh) return { ...body, error: zh };
  return { ...body, error: "请求失败", errorEn: error };
};

if (shouldLogHttp) {
  app.use((req, res, next) => {
    const p = typeof req.path === "string" ? req.path : "";
    const shouldLogPath =
      Boolean(p) && !p.startsWith("/health") && !p.startsWith("/__dev_files/") && !p.startsWith("/__db_files/");
    if (!shouldLogPath) return next();

    const reqId = crypto.randomBytes(6).toString("hex");
    const startedAt = Date.now();
    const oldJson = res.json.bind(res);
    const oldSend = res.send.bind(res);
    const xRealIp = (req.headers["x-real-ip"] || "").toString();
    const xff = (req.headers["x-forwarded-for"] || "").toString();
    const forwardedProto = (req.headers["x-forwarded-proto"] || "").toString();
    const ua = (req.headers["user-agent"] || "").toString();
    const referer = (req.headers.referer || "").toString();
    const origin = (req.headers.origin || "").toString();
    const host = (req.headers.host || "").toString();

    const resMeta = () => {
      const ct = res.getHeader("content-type");
      const cl = res.getHeader("content-length");
      const loc = res.getHeader("location");
      return {
        status: res.statusCode,
        contentType: ct != null ? String(ct) : "",
        contentLength: cl != null ? String(cl) : "",
        location: loc != null ? String(loc) : "",
      };
    };

    const reqBodyPayload = () => {
      const b = req.body;
      if (b == null) return undefined;
      if (!shouldLogHttpBodies) return b && typeof b === "object" ? Object.keys(b) : typeof b;
      return sanitizeForLog(b);
    };

    const logBase = () => ({
      tag: "http",
      reqId,
      method: req.method,
      path: req.originalUrl || req.path,
      status: res.statusCode,
      ms: Date.now() - startedAt,
      ip: (xRealIp || req.ip || "").toString(),
      userId: req.user && req.user.openid ? String(req.user.openid) : "",
      req: {
        host,
        origin,
        referer,
        ua,
        xRealIp,
        xff,
        proto: forwardedProto || (req.secure ? "https" : "http"),
      },
      res: resMeta(),
      reqBody: reqBodyPayload(),
    });

    res.json = (body) => {
      const outBody = translateErrorBody(p, body);
      let payload = null;
      try {
        const base = logBase();
        payload = shouldLogHttpBodies ? sanitizeForLog(outBody) : outBody && typeof outBody === "object" ? Object.keys(outBody) : typeof outBody;
        res.__imfineLogged = true;
      } catch (_) {}
      const r = oldJson(outBody);
      try {
        const base = logBase();
        console.log(JSON.stringify({ ...base, kind: "json", body: payload }, null, 2));
      } catch (_) {}
      return r;
    };

    res.send = (body) => {
      if (res.__imfineLogged) return oldSend(body);
      let payload = null;
      try {
        const t = typeof body;
        payload = t;
        if (shouldLogHttpBodies) {
          if (Buffer.isBuffer(body)) payload = "[buffer]";
          else if (t === "string") {
            const s = body;
            if (p.startsWith("/tools")) payload = `[html len=${s.length}]`;
            else {
              const trimmed = s.trimStart();
              if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                try {
                  payload = sanitizeForLog(JSON.parse(s));
                } catch (_) {
                  payload = s.length > 2000 ? s.slice(0, 2000) + "...[truncated]" : s;
                }
              } else {
                payload = s.length > 500 ? s.slice(0, 500) + "...[truncated]" : s;
              }
            }
          } else payload = sanitizeForLog(body);
        }
      } catch (_) {}
      const r = oldSend(body);
      try {
        const base = logBase();
        console.log(JSON.stringify({ ...base, kind: "send", body: payload }, null, 2));
      } catch (_) {}
      return r;
    };

    return next();
  });
}

app.use((req, res, next) => {
  const oldJson = res.json.bind(res);
  res.json = (body) => oldJson(translateErrorBody(req.path, body));
  return next();
});

const asyncHandler =
  (fn) =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const requireEnv = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
};

const getEnv = (name) => (process.env[name] ? String(process.env[name]) : "");

const toolsCookieName = "imfine_tools_session";
const toolsPassword = process.env.TOOLS_PASSWORD ? String(process.env.TOOLS_PASSWORD) : "hujiaqih";

const b64urlEncode = (buf) =>
  Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const b64urlDecode = (s) => {
  const t = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = t.length % 4 === 0 ? "" : "=".repeat(4 - (t.length % 4));
  return Buffer.from(t + pad, "base64");
};

const parseCookies = (cookieHeader) => {
  const out = {};
  const raw = String(cookieHeader || "");
  if (!raw) return out;
  const parts = raw.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    if (!k) continue;
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch (_) {
      out[k] = v;
    }
  }
  return out;
};

const signToolsSession = ({ expMs }, secret) => {
  const payload = { exp: expMs };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest();
  const sigB64 = b64urlEncode(sig);
  return `${payloadB64}.${sigB64}`;
};

const verifyToolsSession = (token, secret) => {
  const t = String(token || "");
  const idx = t.lastIndexOf(".");
  if (idx <= 0) return { ok: false };
  const payloadB64 = t.slice(0, idx);
  const sigB64 = t.slice(idx + 1);
  let expectedSig = null;
  let gotSig = null;
  try {
    expectedSig = crypto.createHmac("sha256", secret).update(payloadB64).digest();
    gotSig = b64urlDecode(sigB64);
  } catch (_) {
    return { ok: false };
  }
  if (!gotSig || gotSig.length !== expectedSig.length) return { ok: false };
  try {
    if (!crypto.timingSafeEqual(gotSig, expectedSig)) return { ok: false };
  } catch (_) {
    return { ok: false };
  }
  try {
    const payloadRaw = b64urlDecode(payloadB64).toString("utf8");
    const payload = payloadRaw ? JSON.parse(payloadRaw) : null;
    const exp = payload && payload.exp != null ? Number(payload.exp) : 0;
    if (!Number.isFinite(exp) || exp <= Date.now()) return { ok: false };
    return { ok: true };
  } catch (_) {
    return { ok: false };
  }
};

const isInternalAuthed = (req) => {
  const expected = getEnv("INTERNAL_JOB_TOKEN");
  if (!expected) return false;
  const token = (req.headers["x-internal-token"] || "").toString();
  if (token && token === expected) return true;
  const toolsSessionHeader = (req.headers["x-tools-session"] || "").toString();
  if (toolsSessionHeader) {
    const r = verifyToolsSession(toolsSessionHeader, expected);
    if (r.ok) return true;
  }
  const cookies = parseCookies(req.headers.cookie || "");
  const session = cookies[toolsCookieName];
  if (session) {
    const r = verifyToolsSession(session, expected);
    if (r.ok) return true;
  }
  return false;
};

const requireInternalAuth = (req, res) => {
  if (isInternalAuthed(req)) return true;
  res.status(401).json({ ok: false, error: "unauthorized" });
  return false;
};

const randomId = (prefix = "") => `${prefix}${crypto.randomBytes(8).toString("hex")}`;

const getShanghaiParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    dateKey: `${map.year}-${map.month}-${map.day}`,
    timeText: `${map.hour}:${map.minute}`,
  };
};

const storage = createStorage({ requireEnv, getEnv });
storage.registerDevFilesRoutes(app);

const getDb = storage.getDb;
const uploadToCos = storage.uploadToCos;

const requireAuth = asyncHandler(async (req, res, next) => {
  const h = (req.headers.authorization || "").toString();
  const token = h.startsWith("Bearer ") ? h.slice("Bearer ".length).trim() : "";
  if (!token) return res.status(401).json({ ok: false, error: "missing token" });
  try {
    const secret = requireEnv("API_JWT_SECRET");
    const payload = jwt.verify(token, secret);
    if (!payload || !payload.openid) return res.status(401).json({ ok: false, error: "invalid token" });
    req.user = { openid: payload.openid };
    return next();
  } catch (_) {
    return res.status(401).json({ ok: false, error: "invalid token" });
  }
});

registerApiRoutes(app, {
  asyncHandler,
  requireAuth,
  getDb,
  getShanghaiParts,
  randomId,
  createWeChatClient,
  uploadToCos,
  getEnv,
  requireEnv,
});

registerInternalRoutes(app, {
  asyncHandler,
  requireInternalAuth,
  getDb,
  createWeChatClient,
  getShanghaiParts,
  logSubscribers,
  logBuffer,
  maxLogSubscribers,
  getEnv,
  nowIso: nowChinaIso,
});

registerToolsRoutes(app, {
  asyncHandler,
  isProd,
  requireEnv,
  requireInternalAuth,
  toolsPassword,
  toolsCookieName,
  signToolsSession,
  nowIso: nowChinaIso,
});

app.use((err, req, res, next) => {
  const message = err && err.message ? String(err.message) : "server error";
  if (req.path && (req.path.startsWith("/api/") || req.path.startsWith("/internal/"))) {
    return res.status(500).json({ ok: false, error: message });
  }
  return res.status(500).type("text/plain").send(message);
});

const requestedPort = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;
const basePort = Number.isFinite(requestedPort) ? requestedPort : 3000;

const listen = (port) =>
  new Promise((resolve, reject) => {
    const server = app.listen(port, "0.0.0.0", () => resolve(server));
    server.once("error", reject);
  });

const start = async () => {
  try {
    const server = await listen(basePort);
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : basePort;
    console.log("listening on", actualPort);
  } catch (err) {
    if (!isProd && err && err.code === "EADDRINUSE") {
      const server = await listen(basePort + 1);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : basePort + 1;
      console.log("listening on", actualPort);
      return;
    }
    console.error(err);
    process.exitCode = 1;
  }
};

const enableSelfGuard = process.env.SELF_GUARD === "1";
const isChild = process.argv.includes("--child");

if (enableSelfGuard && !isChild) {
  const script = process.argv[1];
  const args = process.argv.slice(2);
  let stopping = false;
  let child = null;
  let crashCount = 0;

  const spawnChild = () => {
    const startedAt = Date.now();
    child = childProcess.spawn(process.execPath, [script, "--child", ...args], {
      env: { ...process.env, SELF_GUARD_CHILD: "1" },
      stdio: "inherit",
    });
    child.once("exit", (code) => {
      child = null;
      if (stopping) return process.exit(Number.isFinite(code) ? code : 0);
      const aliveMs = Date.now() - startedAt;
      crashCount = aliveMs < 5000 ? crashCount + 1 : 0;
      const delay = Math.min(30_000, 300 * Math.pow(2, Math.min(10, crashCount)));
      setTimeout(spawnChild, delay);
    });
  };

  const stop = (signal) => {
    stopping = true;
    try {
      if (child && child.pid) child.kill(signal);
    } catch (_) {}
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  spawnChild();
} else {
  start();
}
