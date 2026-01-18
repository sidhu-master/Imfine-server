const express = require("express");
const { handleMpCallback } = require("../mpCallback");
const fs = require("fs");

const registerInternalRoutes = (
  app,
  {
    asyncHandler,
    requireInternalAuth,
    getDb,
    createWeChatClient,
    getShanghaiParts,
    logSubscribers,
    logBuffer,
    maxLogSubscribers,
    getEnv,
    nowIso,
  }
) => {
  const parseTimeTextToMinutes = (timeText) => {
    const s = String(timeText || "").trim();
    const m = /^(\d{2}):(\d{2})$/.exec(s);
    if (!m) return null;
    const hh = Number.parseInt(m[1], 10);
    const mm = Number.parseInt(m[2], 10);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return hh * 60 + mm;
  };

  const minutesToTimeText = (mins) => {
    const t = Number(mins);
    if (!Number.isFinite(t)) return "";
    const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.floor(t)));
    const hh = String(Math.floor(clamped / 60)).padStart(2, "0");
    const mm = String(clamped % 60).padStart(2, "0");
    return `${hh}:${mm}`;
  };

  const computeDueMinutes = ({ deadline, graceMinutes }) => {
    const base = parseTimeTextToMinutes(deadline);
    if (base == null) return null;
    const g = Number.isFinite(graceMinutes) ? Math.floor(graceMinutes) : 0;
    return Math.max(0, Math.min(23 * 60 + 59, base + g));
  };

  const shiftDateKey = (dateKey, deltaDays) => {
    const s = String(dateKey || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
    const base = new Date(`${s}T00:00:00+08:00`);
    if (!Number.isFinite(base.getTime())) return "";
    const next = new Date(base.getTime() + Number(deltaDays || 0) * 86400_000);
    return getShanghaiParts(next).dateKey;
  };

  const getElderDisplayName = (user, elderOpenid) => {
    if (user && user.familyName) return String(user.familyName).slice(0, 20);
    if (user && user.name) return String(user.name).slice(0, 20);
    const id = String(elderOpenid || "");
    if (!id) return "";
    return id.length <= 10 ? id : `${id.slice(0, 4)}...${id.slice(-4)}`;
  };

  const getElderMpOpenid = (user) => {
    const candidates = [
      user && user.elderMpOpenid != null ? user.elderMpOpenid : "",
      user && user.mpOpenid != null ? user.mpOpenid : "",
      user && user.mp_openid != null ? user.mp_openid : "",
    ]
      .map((v) => String(v || "").trim())
      .filter(Boolean);
    return candidates[0] || "";
  };

  const buildTemplateData = ({ elderName, dateKey, remark }) => {
    const nameValue = elderName ? `被守护者${elderName}` : "被守护者（未命名）";
    return {
      name: { value: nameValue },
      date: { value: String(dateKey || "") },
      remark: { value: String(remark || "") },
    };
  };

  const runGuardianNotifyJob = async ({ nowDateKey, nowTimeText, force, waitHours }) => {
    const db = await getDb();
    const wx = createWeChatClient({ db, getEnv });

    const logsCol = db.collection("wy_guardian_notify_logs");
    const linksCol = db.collection("wy_guardian_links");
    const usersCol = db.collection("wy_users");

    const now = new Date();
    const timeText = nowTimeText || getShanghaiParts().timeText;
    const nowMin = parseTimeTextToMinutes(timeText);
    if (nowMin == null) return { ok: false, error: "invalid nowTimeText" };

    const elderOpenids = await linksCol.distinct("elderOpenid", {});
    const elderResults = [];
    const guardianResults = [];
    const waitMs = Math.max(0, Number(waitHours) || 0) * 3600_000;
    const waitText = Number.isFinite(waitHours) ? `${Number(waitHours)}h` : "24h";

    for (const elderOpenidRaw of elderOpenids) {
      const elderOpenid = String(elderOpenidRaw || "");
      if (!elderOpenid) continue;

      const user = await usersCol.findOne({ _id: elderOpenid });
      const deadline = user && user.deadline ? String(user.deadline) : "22:30";
      const graceMinutes = user && user.graceMinutes != null ? Number(user.graceMinutes) : 0;
      const dueMin = computeDueMinutes({ deadline, graceMinutes });
      if (dueMin == null) {
        elderResults.push({ elderOpenid, dateKey: nowDateKey, skipped: true, reason: "invalid_rule" });
        guardianResults.push({ elderOpenid, dateKey: shiftDateKey(nowDateKey, -1), skipped: true, reason: "invalid_rule" });
        continue;
      }

      const dueText = minutesToTimeText(dueMin);
      const elderName = getElderDisplayName(user, elderOpenid);

      const shouldRunNow = Boolean(force) || nowMin >= dueMin;

      {
        const dateKey = String(nowDateKey || "").trim();
        if (!dateKey) {
          elderResults.push({ elderOpenid, dateKey, skipped: true, reason: "invalid_dateKey" });
        } else if (!shouldRunNow) {
          elderResults.push({ elderOpenid, dateKey, skipped: true, reason: "not_due", dueTimeText: dueText });
        } else {
          const logId = `${elderOpenid}__${dateKey}__elder`;
          let acquired = true;
          if (!force) {
            const lock = await logsCol.updateOne(
              { _id: logId },
              {
                $setOnInsert: {
                  elderOpenid,
                  dateKey,
                  kind: "elder",
                  deadline,
                  graceMinutes,
                  dueTimeText: dueText,
                  createdAt: now,
                  finalizedAt: null,
                },
                $set: { lastSeenAt: now },
              },
              { upsert: true }
            );
            acquired = Boolean(lock && lock.upsertedId);
          }

          if (!acquired) {
            elderResults.push({ elderOpenid, dateKey, skipped: true, reason: "already_logged" });
          } else {
            const checkin = await db.collection("wy_checkins").findOne({ _id: `${elderOpenid}_${dateKey}` });
            if (checkin) {
              await logsCol.updateOne(
                { _id: logId },
                {
                  $set: {
                    checkedIn: true,
                    checkinTimeText: checkin.timeText || "",
                    skippedAt: now,
                    finalizedAt: now,
                    forcedAt: force ? now : null,
                  },
                },
                { upsert: true }
              );
              elderResults.push({ elderOpenid, dateKey, skipped: true, reason: "checked_in" });
            } else {
              const toUser = getElderMpOpenid(user);
              if (!toUser) {
                await logsCol.updateOne(
                  { _id: logId },
                  {
                    $set: {
                      checkedIn: false,
                      elderName,
                      sentTo: [],
                      failed: [{ toUser: "", err: "missing elder mp openid" }],
                      finalizedAt: now,
                      forcedAt: force ? now : null,
                    },
                  },
                  { upsert: true }
                );
                elderResults.push({ elderOpenid, dateKey, sent: false, reason: "missing_elder_mp_openid" });
              } else {
                const templateId =
                  (process.env.MP_TEMPLATE_ID_MISSED_CHECKIN || "").trim() || "v_d28wOOjVrFVHBLHgIrHcy1fzMELqdnQ1p79MN6a_k";
                const miniAppid = process.env.MINIAPP_APPID || "";
                const pagepath = process.env.MINIAPP_PAGEPATH_MISSED || "pages/dailyHome/index";
                const remark = `今天截至 ${dueText} 未打卡，请尽快打卡。`;
                const r = await wx.sendMpTemplate({
                  toUser,
                  templateId,
                  data: buildTemplateData({ elderName, dateKey, remark }),
                  miniProgram: miniAppid ? { appid: miniAppid, pagepath } : undefined,
                });
                await logsCol.updateOne(
                  { _id: logId },
                  {
                    $set: {
                      checkedIn: false,
                      elderName,
                      sentTo: r.ok ? [toUser] : [],
                      failed: r.ok ? [] : [{ toUser, err: r.error || "template failed" }],
                      finalizedAt: now,
                      forcedAt: force ? now : null,
                    },
                  },
                  { upsert: true }
                );
                elderResults.push({ elderOpenid, dateKey, sent: r.ok, failed: !r.ok });
              }
            }
          }
        }
      }

      {
        const dateKey = shiftDateKey(nowDateKey, -1);
        if (!dateKey) {
          guardianResults.push({ elderOpenid, dateKey, skipped: true, reason: "invalid_dateKey" });
        } else if (!shouldRunNow) {
          guardianResults.push({ elderOpenid, dateKey, skipped: true, reason: "not_due", dueTimeText: dueText });
        } else {
          const logId = `${elderOpenid}__${dateKey}__guardian`;
          let acquired = true;
          if (!force) {
            const lock = await logsCol.updateOne(
              { _id: logId },
              {
                $setOnInsert: {
                  elderOpenid,
                  dateKey,
                  kind: "guardian",
                  deadline,
                  graceMinutes,
                  dueTimeText: dueText,
                  waitMs,
                  waitText,
                  createdAt: now,
                  finalizedAt: null,
                },
                $set: { lastSeenAt: now },
              },
              { upsert: true }
            );
            acquired = Boolean(lock && lock.upsertedId);
          }

          if (!acquired) {
            guardianResults.push({ elderOpenid, dateKey, skipped: true, reason: "already_logged" });
          } else {
            const checkin = await db.collection("wy_checkins").findOne({ _id: `${elderOpenid}_${dateKey}` });
            if (checkin) {
              await logsCol.updateOne(
                { _id: logId },
                {
                  $set: {
                    checkedIn: true,
                    checkinTimeText: checkin.timeText || "",
                    skippedAt: now,
                    finalizedAt: now,
                    forcedAt: force ? now : null,
                  },
                },
                { upsert: true }
              );
              guardianResults.push({ elderOpenid, dateKey, skipped: true, reason: "checked_in" });
            } else {
              const guardians = await linksCol.find({ elderOpenid }).project({ guardianMpOpenid: 1 }).toArray();
              const sentTo = [];
              const failed = [];
              const templateId =
                (process.env.MP_TEMPLATE_ID_MISSED_CHECKIN || "").trim() || "v_d28wOOjVrFVHBLHgIrHcy1fzMELqdnQ1p79MN6a_k";
              const miniAppid = process.env.MINIAPP_APPID || "";
              const pagepath = process.env.MINIAPP_PAGEPATH_MISSED || "pages/dailyHome/index";
              const remark = `${dateKey} 截至 ${dueText} 未打卡，已超过等待期 ${waitText}，请留意。`;

              for (const g of guardians) {
                const toUser = (g && g.guardianMpOpenid != null ? String(g.guardianMpOpenid) : "").trim();
                if (!toUser) continue;
                const r = await wx.sendMpTemplate({
                  toUser,
                  templateId,
                  data: buildTemplateData({ elderName, dateKey, remark }),
                  miniProgram: miniAppid ? { appid: miniAppid, pagepath } : undefined,
                });
                if (r.ok) sentTo.push(toUser);
                else failed.push({ toUser, err: r.error || "template failed" });
              }

              await logsCol.updateOne(
                { _id: logId },
                { $set: { checkedIn: false, elderName, sentTo, failed, finalizedAt: now, forcedAt: force ? now : null } },
                { upsert: true }
              );
              guardianResults.push({ elderOpenid, dateKey, sentToCount: sentTo.length, failedCount: failed.length });
            }
          }
        }
      }
    }

    return {
      ok: true,
      nowDateKey,
      timeText,
      waitHours,
      elder: { results: elderResults },
      guardian: { results: guardianResults },
    };
  };

  const shouldAutoRun = !["0", "false", "off"].includes(String(getEnv("GUARDIAN_NOTIFY_AUTO") || "").trim().toLowerCase());
  let autoRunning = false;
  let autoTimer = null;
  const startAutoRunner = () => {
    if (!shouldAutoRun) return;
    if (autoTimer) return;
    autoTimer = setInterval(async () => {
      if (autoRunning) return;
      autoRunning = true;
      try {
        const parts = getShanghaiParts();
        await runGuardianNotifyJob({ nowDateKey: parts.dateKey, nowTimeText: parts.timeText, force: false, waitHours: 24 });
      } catch (_) {
      } finally {
        autoRunning = false;
      }
    }, 30 * 60_000);
    if (autoTimer && typeof autoTimer.unref === "function") autoTimer.unref();
  };

  startAutoRunner();

  const getRuntimeInfo = () => {
    const pid = process.pid;
    const ppid = process.ppid;
    let parentComm = "";
    try {
      parentComm = fs.readFileSync(`/proc/${ppid}/comm`, "utf8").trim();
    } catch (_) {}

    let inDocker = false;
    try {
      inDocker = fs.existsSync("/.dockerenv");
    } catch (_) {}
    if (!inDocker) {
      try {
        const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
        inDocker = /docker|kubepods|containerd/i.test(cgroup);
      } catch (_) {}
    }

    const inPm2 = process.env.pm_id != null || process.env.PM2_HOME || process.env.PM2_VERSION;
    const inSystemd = Boolean(process.env.INVOCATION_ID || process.env.JOURNAL_STREAM) || parentComm === "systemd";
    const inKubernetes = Boolean(process.env.KUBERNETES_SERVICE_HOST) || (!inDocker ? false : (() => {
      try {
        const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
        return /kubepods/i.test(cgroup);
      } catch (_) {
        return false;
      }
    })());
    const inSelfGuard = process.env.SELF_GUARD === "1" && process.env.SELF_GUARD_CHILD === "1";

    let restartLikelyOk = false;
    let restartHint = "";
    if (inSelfGuard) {
      restartLikelyOk = true;
      restartHint = "SELF_GUARD 已开启（内置守护），退出进程会自动拉起。";
    } else if (inPm2) {
      restartLikelyOk = true;
      restartHint = "检测到 PM2，退出进程通常会自动拉起。";
    } else if (inSystemd) {
      restartLikelyOk = true;
      restartHint = "检测到 systemd，是否自动拉起取决于 service 配置（Restart=...）。";
    } else if (inDocker) {
      restartLikelyOk = true;
      restartHint = "检测到容器环境，是否自动拉起取决于 docker/k8s 的 restart policy。";
    } else {
      restartLikelyOk = false;
      restartHint = "未检测到常见守护，退出进程可能直接停服。";
    }

    return {
      pid,
      ppid,
      parentComm,
      node: { version: process.version, execPath: process.execPath, argv: process.argv },
      envFlags: {
        pm2: Boolean(inPm2),
        systemd: Boolean(inSystemd),
        dockerOrContainer: Boolean(inDocker),
        kubernetes: Boolean(inKubernetes),
        selfGuard: Boolean(inSelfGuard),
      },
      restart: { method: "process_exit", likelyOk: restartLikelyOk, hint: restartHint },
    };
  };

  app.post(
    "/internal/runGuardianNotifyJob",
    asyncHandler(async (req, res) => {
      if (!requireInternalAuth(req, res)) return;

      const nowDateKey = (req.body && req.body.dateKey ? String(req.body.dateKey) : "") || getShanghaiParts().dateKey;
      const nowTimeText = req.body && req.body.nowTimeText != null ? String(req.body.nowTimeText) : "";
      const force = Boolean(req.body && req.body.force);
      const r = await runGuardianNotifyJob({ nowDateKey, nowTimeText: nowTimeText.trim() || undefined, force, waitHours: 24 });
      if (!r.ok) return res.status(400).json({ ok: false, error: r.error || "job failed" });
      return res.json(r);
    })
  );

  app.get(
    "/internal/wxAuthCheck",
    asyncHandler(async (req, res) => {
      if (!requireInternalAuth(req, res)) return;

      const db = await getDb();
      const wx = createWeChatClient({ db, getEnv });

      const mp = await wx.getAccessToken("mp");
      const mini = await wx.getAccessToken("mini");

      return res.json({
        ok: true,
        mp: mp.ok ? { ok: true } : { ok: false, error: mp.error || "mp token failed" },
        mini: mini.ok ? { ok: true } : { ok: false, error: mini.error || "mini token failed" },
      });
    })
  );

  app.get(
    "/internal/wxTokens",
    asyncHandler(async (req, res) => {
      if (!requireInternalAuth(req, res)) return;

      const db = await getDb();
      const wx = createWeChatClient({ db, getEnv });

      const mp = await wx.getAccessToken("mp");
      const mini = await wx.getAccessToken("mini");
      if (!mp.ok) return res.status(502).json({ ok: false, error: mp.error || "mp token failed" });
      if (!mini.ok) return res.status(502).json({ ok: false, error: mini.error || "mini token failed" });

      const kv = db.collection("wy_kv");
      const mpDoc = await kv.findOne({ _id: "mp_access_token" });
      const miniDoc = await kv.findOne({ _id: "mini_access_token" });

      const mask = (s) => {
        const t = String(s || "");
        if (!t) return "";
        if (t.length <= 10) return `${t.slice(0, 2)}***${t.slice(-2)}`;
        return `${t.slice(0, 6)}***${t.slice(-6)}`;
      };

      const mpToken = mpDoc && mpDoc.value ? String(mpDoc.value) : mp.accessToken;
      const miniToken = miniDoc && miniDoc.value ? String(miniDoc.value) : mini.accessToken;

      return res.json({
        ok: true,
        mp: { token: mpToken, tokenMasked: mask(mpToken), expireAt: mpDoc && mpDoc.expireAt ? mpDoc.expireAt : null },
        mini: {
          token: miniToken,
          tokenMasked: mask(miniToken),
          expireAt: miniDoc && miniDoc.expireAt ? miniDoc.expireAt : null,
        },
      });
    })
  );

  app.get(
    "/internal/listMpMaterials",
    asyncHandler(async (req, res) => {
      if (!requireInternalAuth(req, res)) return;

      const type = (req.query && req.query.type ? String(req.query.type) : "") || "image";
      const offset = req.query && req.query.offset != null ? Number.parseInt(String(req.query.offset), 10) : 0;
      const count = req.query && req.query.count != null ? Number.parseInt(String(req.query.count), 10) : 20;

      const db = await getDb();
      const wx = createWeChatClient({ db, getEnv });
      const r = await wx.listMpMaterials({ type, offset, count });
      if (!r.ok) return res.status(502).json({ ok: false, error: r.error || "list materials failed" });

      return res.json({
        ok: true,
        type: r.type,
        offset: r.offset,
        count: r.count,
        totalCount: r.totalCount,
        itemCount: r.itemCount,
        items: r.items,
      });
    })
  );

  app.get(
    "/internal/dbCollections",
    asyncHandler(async (req, res) => {
      if (!requireInternalAuth(req, res)) return;

      const db = await getDb();

      if (!db || typeof db.listCollections !== "function") {
        return res.json({ ok: true, collections: [] });
      }

      const cols = await db.listCollections().toArray();
      const names = cols
        .map((c) => (c && c.name ? String(c.name) : ""))
        .filter(Boolean)
        .slice(0, 200);
      const collections = [];

      for (const name of names) {
        let count = null;
        try {
          count = await db.collection(name).estimatedDocumentCount();
        } catch (_) {}
        collections.push({ name, count });
      }

      return res.json({ ok: true, collections });
    })
  );

  app.get(
    "/internal/dbFind",
    asyncHandler(async (req, res) => {
      if (!requireInternalAuth(req, res)) return;

      const collection = req.query && req.query.collection ? String(req.query.collection) : "";
      if (!collection) return res.status(400).json({ ok: false, error: "missing collection" });

      const limitRaw = req.query && req.query.limit != null ? Number.parseInt(String(req.query.limit), 10) : 20;
      const limit = Math.min(50, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 20));

      const qRaw = req.query && req.query.q != null ? String(req.query.q) : "";
      let query = {};
      if (qRaw) {
        try {
          const parsed = JSON.parse(qRaw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return res.status(400).json({ ok: false, error: "invalid q" });
          }
          query = parsed;
        } catch (_) {
          return res.status(400).json({ ok: false, error: "invalid q" });
        }
      }

      const db = await getDb();
      const docs = await db.collection(collection).find(query).limit(limit).toArray();
      return res.json({ ok: true, collection, limit, query, docs });
    })
  );

  app.get("/internal/logStream", (req, res) => {
    if (!requireInternalAuth(req, res)) return;

    if (logSubscribers.size >= maxLogSubscribers) return res.status(429).json({ ok: false, error: "too_many_streams" });

    const nRaw = req.query && req.query.n != null ? Number.parseInt(String(req.query.n), 10) : 200;
    const n = Math.min(800, Math.max(0, Number.isFinite(nRaw) ? nRaw : 200));

    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    let paused = false;
    const writeLine = (line) => {
      if (paused) return;
      try {
        const ok = res.write(line);
        if (!ok) {
          paused = true;
          res.once("drain", () => {
            paused = false;
          });
        }
      } catch (_) {}
    };

    const initial = n ? logBuffer.slice(-n) : [];
    for (const e of initial) {
      writeLine(JSON.stringify(e) + "\n");
    }

    const onEntry = (e) => {
      try {
        if (res.writableEnded || res.destroyed) {
          logSubscribers.delete(onEntry);
          return;
        }
        writeLine(JSON.stringify(e) + "\n");
      } catch (_) {
        logSubscribers.delete(onEntry);
      }
    };

    logSubscribers.add(onEntry);

    const t = setInterval(() => {
      writeLine("\n");
    }, 10_000);

    res.on("error", () => {
      clearInterval(t);
      logSubscribers.delete(onEntry);
    });

    req.on("close", () => {
      clearInterval(t);
      logSubscribers.delete(onEntry);
    });
  });

  app.post(
    "/internal/miniJscode2session",
    asyncHandler(async (req, res) => {
      if (!requireInternalAuth(req, res)) return;

      const code = req.body && req.body.code ? String(req.body.code) : "";
      if (!code) return res.status(400).json({ ok: false, error: "missing code" });

      const db = await getDb();
      const wx = createWeChatClient({ db, getEnv });
      const r = await wx.jscode2session({ code });
      if (!r.ok) return res.status(502).json({ ok: false, error: r.error || "jscode2session failed" });
      return res.json({ ok: true, openid: r.openid || "" });
    })
  );

  app.post(
    "/internal/sendTestMpMiniProgramPage",
    asyncHandler(async (req, res) => {
      if (!requireInternalAuth(req, res)) return;

      const toUser = req.body && req.body.toUser ? String(req.body.toUser) : "";
      if (!toUser) return res.status(400).json({ ok: false, error: "missing toUser" });

      const scene = req.body && req.body.scene ? String(req.body.scene) : "";
      const inviterId = req.body && req.body.inviterId ? String(req.body.inviterId) : "";
      const inviterNameRaw = req.body && req.body.inviterName ? String(req.body.inviterName) : "";
      const inviterName = inviterNameRaw.slice(0, 20);
      const mpOpenid = req.body && req.body.mpOpenid ? String(req.body.mpOpenid) : "";
      const title =
        req.body && req.body.title ? String(req.body.title) : process.env.MP_BIND_MINIPROGRAM_CARD_TITLE || "测试小程序卡片";
      const appid = req.body && req.body.appid ? String(req.body.appid) : process.env.MINIAPP_APPID || "";
      const pagepath =
        req.body && req.body.pagepath
          ? String(req.body.pagepath)
          : (() => {
              const params = [];
              if (inviterId) params.push(`inviterId=${encodeURIComponent(inviterId)}`);
              if (inviterName) params.push(`inviterName=${encodeURIComponent(inviterName)}`);
              if (scene) params.push(`scene=${encodeURIComponent(scene)}`);
              const signSecret = process.env.MP_MINI_OPENID_SIGN_SECRET || process.env.API_JWT_SECRET || "";
              if (mpOpenid && signSecret) {
                const mpTs = Date.now();
                const ctx = scene || "";
                const mpSig = require("crypto").createHmac("sha256", signSecret).update(`${mpOpenid}.${ctx}.${mpTs}`).digest("hex");
                params.push(`mpOpenid=${encodeURIComponent(mpOpenid)}`);
                params.push(`mpTs=${encodeURIComponent(String(mpTs))}`);
                params.push(`mpSig=${encodeURIComponent(mpSig)}`);
              }
              return `pages/acceptInvite/index${params.length ? `?${params.join("&")}` : ""}`;
            })();

      const db = await getDb();
      const wx = createWeChatClient({ db, getEnv });
      const r = await wx.sendMpMiniProgramPage({ toUser, title, appid, pagepath });
      if (!r.ok) return res.status(502).json({ ok: false, error: r.error || "send failed" });
      return res.json({ ok: true });
    })
  );

  app.get(
    "/internal/listGuardianLinks",
    asyncHandler(async (req, res) => {
      if (!requireInternalAuth(req, res)) return;

      const qRaw = req.query && req.query.q != null ? String(req.query.q) : "";
      const q = qRaw.trim().toLowerCase();
      const limitRaw = req.query && req.query.limit != null ? Number.parseInt(String(req.query.limit), 10) : 50;
      const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50));

      const db = await getDb();
      const col = db.collection("wy_guardian_links");
      const docs = await col.find({}).limit(2000).toArray();
      const normalized = (docs || []).map((d) => ({
        id: d && d._id != null ? String(d._id) : "",
        elderOpenid: d && d.elderOpenid != null ? String(d.elderOpenid) : "",
        guardianMpOpenid: d && d.guardianMpOpenid != null ? String(d.guardianMpOpenid) : "",
        scene: d && d.scene != null ? String(d.scene) : "",
        ticket: d && d.ticket != null ? String(d.ticket) : "",
        createdAt: d && d.createdAt != null ? d.createdAt : null,
        updatedAt: d && d.updatedAt != null ? d.updatedAt : null,
      }));

      const filtered = q
        ? normalized.filter((it) => {
            const a = (it.elderOpenid || "").toLowerCase();
            const b = (it.guardianMpOpenid || "").toLowerCase();
            const c = (it.scene || "").toLowerCase();
            return a.includes(q) || b.includes(q) || c.includes(q);
          })
        : normalized;

      const items = filtered.slice(0, limit);
      return res.json({ ok: true, count: items.length, items });
    })
  );

  app.get(
    "/internal/listMiniGuardianLinks",
    asyncHandler(async (req, res) => {
      if (!requireInternalAuth(req, res)) return;

      const qRaw = req.query && req.query.q != null ? String(req.query.q) : "";
      const q = qRaw.trim().toLowerCase();
      const limitRaw = req.query && req.query.limit != null ? Number.parseInt(String(req.query.limit), 10) : 50;
      const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50));

      const db = await getDb();
      const col = db.collection("wy_guardian_mini_links");

      const docs = await col.find({}).limit(2000).toArray();
      const normalized = (docs || []).map((d) => ({
        id: d && d._id != null ? String(d._id) : "",
        inviterOpenid: d && d.inviterOpenid != null ? String(d.inviterOpenid) : "",
        inviteeOpenid: d && d.inviteeOpenid != null ? String(d.inviteeOpenid) : "",
        inviterId: d && d.inviterId != null ? String(d.inviterId) : "",
        inviterName: d && d.inviterName != null ? String(d.inviterName) : "",
        inviteeName: d && d.inviteeName != null ? String(d.inviteeName) : "",
        sceneId: d && d.sceneId != null ? String(d.sceneId) : "",
        channel: d && d.channel != null ? String(d.channel) : "",
        envVersion: d && d.envVersion != null ? String(d.envVersion) : "",
        acceptedAt: d && d.acceptedAt != null ? d.acceptedAt : null,
        createdAt: d && d.createdAt != null ? d.createdAt : null,
        updatedAt: d && d.updatedAt != null ? d.updatedAt : null,
      }));

      const filtered = q
        ? normalized.filter((it) => {
            const s = q;
            return (
              (it.id || "").toLowerCase().includes(s) ||
              (it.inviterOpenid || "").toLowerCase().includes(s) ||
              (it.inviteeOpenid || "").toLowerCase().includes(s) ||
              (it.inviterId || "").toLowerCase().includes(s) ||
              (it.inviterName || "").toLowerCase().includes(s) ||
              (it.inviteeName || "").toLowerCase().includes(s) ||
              (it.sceneId || "").toLowerCase().includes(s)
            );
          })
        : normalized;

      filtered.sort((a, b) => {
        const au = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const bu = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        if (bu !== au) return bu - au;
        const aa = a.acceptedAt ? new Date(a.acceptedAt).getTime() : 0;
        const ba = b.acceptedAt ? new Date(b.acceptedAt).getTime() : 0;
        if (ba !== aa) return ba - aa;
        const ac = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bc = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bc - ac;
      });

      const items = filtered.slice(0, limit);
      return res.json({ ok: true, count: items.length, items });
    })
  );

  app.post(
    "/internal/unbindMiniGuardianLink",
    asyncHandler(async (req, res) => {
      if (!requireInternalAuth(req, res)) return;

      const id = req.body && req.body.id != null ? String(req.body.id).trim() : "";
      if (!id) return res.status(400).json({ ok: false, error: "missing id" });

      const db = await getDb();
      const col = db.collection("wy_guardian_mini_links");
      const r = await col.deleteOne({ _id: id });
      if (!r || !r.deletedCount) return res.status(404).json({ ok: false, error: "not found" });
      return res.json({ ok: true, deletedCount: r.deletedCount });
    })
  );

  app.post(
    "/internal/unbindGuardianLink",
    asyncHandler(async (req, res) => {
      if (!requireInternalAuth(req, res)) return;

      const id = req.body && req.body.id != null ? String(req.body.id).trim() : "";
      if (!id) return res.status(400).json({ ok: false, error: "missing id" });

      const db = await getDb();
      const col = db.collection("wy_guardian_links");
      const r = await col.deleteOne({ _id: id });
      if (!r || !r.deletedCount) return res.status(404).json({ ok: false, error: "not found" });
      return res.json({ ok: true, deletedCount: r.deletedCount });
    })
  );

  app.post(
    "/internal/sendTestGuardianText",
    asyncHandler(async (req, res) => {
      if (!requireInternalAuth(req, res)) return;

      const toUser = req.body && req.body.toUser ? String(req.body.toUser).trim() : "";
      const kindRaw = req.body && req.body.kind != null ? String(req.body.kind) : "";
      const kind = kindRaw.trim() || "guardian";
      const elderNameRaw = req.body && req.body.elderName != null ? String(req.body.elderName) : "";
      const elderName = elderNameRaw.trim().slice(0, 20);
      const dateKeyRaw = req.body && req.body.dateKey != null ? String(req.body.dateKey) : "";
      const dateKeyInput = dateKeyRaw.trim();
      const dueTimeTextRaw = req.body && req.body.dueTimeText != null ? String(req.body.dueTimeText) : "";
      const dueTimeText = dueTimeTextRaw.trim() || "22:30";
      const waitHoursRaw = req.body && req.body.waitHours != null ? Number(req.body.waitHours) : 24;
      const waitHours = Number.isFinite(waitHoursRaw) ? waitHoursRaw : 24;
      const remarkRaw = req.body && req.body.remark != null ? String(req.body.remark) : "";
      const remarkInput = remarkRaw.trim();
      if (!toUser) return res.status(400).json({ ok: false, error: "missing toUser" });
      if (!["elder", "guardian"].includes(kind)) return res.status(400).json({ ok: false, error: "invalid kind" });
      if (remarkInput.length > 500) return res.status(400).json({ ok: false, error: "content too long" });

      const db = await getDb();
      const wx = createWeChatClient({ db, getEnv });
      const parts = getShanghaiParts();
      const dateKey =
        dateKeyInput ||
        (kind === "guardian" ? shiftDateKey(parts.dateKey, -1) : parts.dateKey);

      const templateId = (process.env.MP_TEMPLATE_ID_MISSED_CHECKIN || "").trim() || "v_d28wOOjVrFVHBLHgIrHcy1fzMELqdnQ1p79MN6a_k";
      const miniAppid = process.env.MINIAPP_APPID || "";
      const pagepath = process.env.MINIAPP_PAGEPATH_MISSED || "pages/dailyHome/index";

      const effectiveElderName = elderName || "测试";
      const waitText = Number.isFinite(waitHours) ? `${Number(waitHours)}h` : "24h";
      const remark =
        remarkInput ||
        (kind === "elder"
          ? `今天截至 ${dueTimeText} 未打卡，请尽快打卡。`
          : `${dateKey} 截至 ${dueTimeText} 未打卡，已超过等待期 ${waitText}，请留意。`);

      const r = await wx.sendMpTemplate({
        toUser,
        templateId,
        data: buildTemplateData({ elderName: effectiveElderName, dateKey, remark }),
        miniProgram: miniAppid ? { appid: miniAppid, pagepath } : undefined,
      });
      if (!r.ok) return res.status(502).json({ ok: false, error: r.error || "send failed" });
      return res.json({ ok: true, kind, toUser, dateKey });
    })
  );

  app.post(
    "/internal/restartServer",
    asyncHandler(async (req, res) => {
      if (!requireInternalAuth(req, res)) return;
      const runtime = getRuntimeInfo();
      res.json({ ok: true, runtime });
      setTimeout(() => {
        process.exit(0);
      }, 300);
    })
  );

  app.get(
    "/internal/runtimeInfo",
    asyncHandler(async (req, res) => {
      if (!requireInternalAuth(req, res)) return;
      return res.json({ ok: true, runtime: getRuntimeInfo() });
    })
  );

  app.get("/mp/callback", async (req, res) => {
    const r = await handleMpCallback({
      method: "GET",
      query: req.query,
      body: "",
      deps: null,
      meta: {
        ip: (req.headers["x-real-ip"] || req.ip || "").toString(),
        ua: (req.headers["user-agent"] || "").toString(),
      },
    });
    res.status(r.statusCode).type("text/plain").send(r.body);
  });

  app.post("/mp/callback", express.text({ type: "*/*" }), async (req, res) => {
    let db = null;
    let wx = null;
    try {
      db = await getDb();
      wx = createWeChatClient({ db, getEnv });
    } catch (_) {}

    const r = await handleMpCallback({
      method: "POST",
      query: req.query,
      body: req.body || "",
      deps: db && wx ? { db, wx } : null,
      meta: {
        ip: (req.headers["x-real-ip"] || req.ip || "").toString(),
        ua: (req.headers["user-agent"] || "").toString(),
      },
    });
    res.status(r.statusCode).type("text/plain").send(r.body);
  });
};

module.exports = { registerInternalRoutes };
