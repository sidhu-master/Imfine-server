const jwt = require("jsonwebtoken");

const registerApiRoutes = (
  app,
  { asyncHandler, requireAuth, getDb, getShanghaiParts, randomId, createWeChatClient, uploadToCos, getEnv, requireEnv }
) => {
  const getPublicBaseUrlFromReq = (req) => {
    const forwardedProto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim().toLowerCase();
    const proto = forwardedProto || (req.secure ? "https" : "http");
    const forwardedHost = (req.headers["x-forwarded-host"] || "").toString().split(",")[0].trim();
    const host = forwardedHost || (req.headers.host || "").toString().split(",")[0].trim();
    if (!host) return "";
    if (proto !== "http" && proto !== "https") return "";
    return `${proto}://${host}`;
  };

  const rewriteLocalhostFileUrl = (url, req) => {
    const u = url == null ? "" : String(url);
    if (!u) return "";
    const base = getPublicBaseUrlFromReq(req);
    if (!base) return u;
    const m = /^(https?:\/\/)(localhost|127\.0\.0\.1)(:\d+)?(\/__db_files\/.+)$/.exec(u);
    if (!m) return u;
    const path = m[4] || "";
    if (!path) return u;
    return `${base}${path}`;
  };

  const normalizeGender = (raw) => {
    const s = String(raw == null ? "" : raw).trim().toLowerCase();
    if (!s) return "";
    if (["0", "unknown", "u"].includes(s)) return "unknown";
    if (["m", "male", "man", "boy", "男", "1"].includes(s)) return "male";
    if (["f", "female", "woman", "girl", "女", "2"].includes(s)) return "female";
    return "";
  };

  const extractUnionid = (data) => {
    if (!data || typeof data !== "object") return "";
    const v =
      data.unionid != null
        ? data.unionid
        : data.unionId != null
          ? data.unionId
          : data.union_id != null
            ? data.union_id
            : "";
    return v != null ? String(v) : "";
  };

  const extractOpenid = (data) => {
    if (!data || typeof data !== "object") return "";
    const v =
      data.openid != null
        ? data.openid
        : data.openId != null
          ? data.openId
          : data.open_id != null
            ? data.open_id
            : "";
    return v != null ? String(v) : "";
  };

  const updateUserUnionid = async (db, openid, unionid) => {
    const now = new Date();
    await db.collection("wy_users").updateOne(
      { _id: openid },
      {
        $set: { openid, unionid, unionidUpdatedAt: now, updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );
  };

  const normalizeBase64Image = (raw) => {
    const s = raw == null ? "" : String(raw).trim();
    if (!s) return { base64: "", contentTypeHint: "" };
    const m = s.match(/^data:([^;]+);base64,(.*)$/i);
    if (m) return { base64: (m[2] || "").trim(), contentTypeHint: (m[1] || "").trim().toLowerCase() };
    return { base64: s, contentTypeHint: "" };
  };

  const sniffImageType = (buf, contentTypeHint) => {
    const hint = contentTypeHint ? String(contentTypeHint).toLowerCase() : "";
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from([]);
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", contentType: "image/jpeg" };
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: "png", contentType: "image/png" };
    if (hint === "image/jpeg" || hint === "image/jpg") return { ext: "jpg", contentType: "image/jpeg" };
    if (hint === "image/png") return { ext: "png", contentType: "image/png" };
    if (hint === "image/webp") return { ext: "webp", contentType: "image/webp" };
    return { ext: "png", contentType: "image/png" };
  };

  app.post(
    "/api/wxLogin",
    asyncHandler(async (req, res) => {
      const code = req.body && req.body.code ? String(req.body.code) : "";
      if (!code) return res.status(400).json({ ok: false, error: "missing code" });
      const encryptedData =
        req.body && req.body.encryptedData != null
          ? String(req.body.encryptedData)
          : req.body && req.body.encrypted_data != null
            ? String(req.body.encrypted_data)
            : "";
      const iv =
        req.body && req.body.iv != null
          ? String(req.body.iv)
          : req.body && req.body.iv_b64 != null
            ? String(req.body.iv_b64)
            : "";

      const mockOpenid = getEnv("WX_LOGIN_MOCK_OPENID");
      if (mockOpenid) {
        const secret = requireEnv("API_JWT_SECRET");
        const token = jwt.sign({ openid: mockOpenid }, secret, { algorithm: "HS256", expiresIn: "30d" });
        return res.json({ ok: true, openid: mockOpenid, token });
      }

      const parseWxError = (raw) => {
        const text = raw == null ? "" : String(raw);
        if (!text) return null;
        try {
          const obj = JSON.parse(text);
          if (obj && typeof obj === "object") return obj;
        } catch (e) {}
        return null;
      };

      const db = await getDb();
      const wx = createWeChatClient({ db, getEnv });
      const r = await wx.jscode2session({ code });
      if (!r.ok) {
        const wxErr = parseWxError(r.error);
        const errcode = wxErr && wxErr.errcode != null ? Number(wxErr.errcode) : null;
        const isClientError = errcode === 40029 || errcode === 40163;
        const status = isClientError ? 400 : 502;
        const errorText = isClientError ? r.error : "微信接口不可达";
        return res.status(status).json({
          ok: false,
          error: errorText,
          ...(isClientError ? {} : { errorEn: r.error }),
          ...(errcode == null ? {} : { errcode }),
          ...(wxErr && wxErr.errmsg ? { errmsg: String(wxErr.errmsg) } : {}),
          ...(!isClientError && wxErr ? { detail: wxErr } : {}),
        });
      }

      console.log("[wx_unionid] jscode2session", {
        openid: r.openid || "",
        hasUnionid: !!(r.unionid || ""),
        hasEncryptedData: !!(encryptedData && iv),
      });
      let unionid = r.unionid || "";
      if (encryptedData && iv) {
        const decrypted = wx.decryptMiniData({ sessionKey: r.sessionKey, encryptedData, iv });
        if (!decrypted.ok) {
          console.log("[wx_unionid] decrypt_failed", { openid: r.openid || "" });
          return res.status(400).json({ ok: false, error: "decrypt failed" });
        }
        const payload = decrypted.data || {};
        const decryptedOpenid = extractOpenid(payload);
        if (decryptedOpenid && decryptedOpenid !== r.openid) {
          return res.status(400).json({ ok: false, error: "openid mismatch" });
        }
        const decryptedUnionid = extractUnionid(payload);
        if (!decryptedUnionid) {
          console.log("[wx_unionid] decrypt_missing_unionid", { openid: r.openid || "" });
          return res.status(400).json({ ok: false, error: "missing unionid" });
        }
        unionid = decryptedUnionid;
      }
      if (unionid) {
        await updateUserUnionid(db, r.openid, unionid);
        console.log("[wx_unionid] bound", { openid: r.openid, unionid });
      } else {
        console.log("[wx_unionid] missing_unionid", { openid: r.openid || "" });
      }

      const secret = requireEnv("API_JWT_SECRET");
      const token = jwt.sign({ openid: r.openid }, secret, { algorithm: "HS256", expiresIn: "30d" });
      return res.json({ ok: true, openid: r.openid, token });
    })
  );

  app.post(
    "/api/wxUnionid",
    requireAuth,
    asyncHandler(async (req, res) => {
      const code = req.body && req.body.code ? String(req.body.code) : "";
      if (!code) return res.status(400).json({ ok: false, error: "missing code" });
      const encryptedData =
        req.body && req.body.encryptedData != null
          ? String(req.body.encryptedData)
          : req.body && req.body.encrypted_data != null
            ? String(req.body.encrypted_data)
            : "";
      const iv =
        req.body && req.body.iv != null
          ? String(req.body.iv)
          : req.body && req.body.iv_b64 != null
            ? String(req.body.iv_b64)
            : "";
      if (!encryptedData || !iv) return res.status(400).json({ ok: false, error: "missing encrypted data" });

      const db = await getDb();
      const wx = createWeChatClient({ db, getEnv });
      const r = await wx.jscode2session({ code });
      if (!r.ok) return res.status(502).json({ ok: false, error: r.error || "jscode2session failed" });

      const openid = r.openid || "";
      if (!openid) return res.status(502).json({ ok: false, error: "missing openid" });
      const authOpenid = req.user && req.user.openid ? String(req.user.openid) : "";
      if (authOpenid && openid !== authOpenid) return res.status(400).json({ ok: false, error: "openid mismatch" });

      console.log("[wx_unionid] jscode2session", {
        openid,
        hasUnionid: !!(r.unionid || ""),
        hasEncryptedData: true,
      });
      let unionid = r.unionid || "";
      const decrypted = wx.decryptMiniData({ sessionKey: r.sessionKey, encryptedData, iv });
      if (!decrypted.ok) {
        console.log("[wx_unionid] decrypt_failed", { openid });
        return res.status(400).json({ ok: false, error: "decrypt failed" });
      }
      const payload = decrypted.data || {};
      const decryptedOpenid = extractOpenid(payload);
      if (decryptedOpenid && decryptedOpenid !== openid) {
        return res.status(400).json({ ok: false, error: "openid mismatch" });
      }
      const decryptedUnionid = extractUnionid(payload);
      if (!decryptedUnionid) {
        console.log("[wx_unionid] decrypt_missing_unionid", { openid });
        return res.status(400).json({ ok: false, error: "missing unionid" });
      }
      unionid = decryptedUnionid || unionid;
      if (!unionid) return res.status(502).json({ ok: false, error: "missing unionid" });

      await updateUserUnionid(db, openid, unionid);
      console.log("[wx_unionid] bound", { openid, unionid });
      return res.json({ ok: true, openid, unionid });
    })
  );

  app.get(
    "/api/userProfile",
    requireAuth,
    asyncHandler(async (req, res) => {
      const db = await getDb();
      const openid = req.user && req.user.openid ? String(req.user.openid) : "";
      if (!openid) return res.status(401).json({ ok: false, error: "invalid token" });
      const doc = await db.collection("wy_users").findOne({ _id: openid });
      const links = await db.collection("wy_guardian_relations").find({ elderOpenid: openid }).limit(200).toArray();
      const guardians = [...new Map(
        (links || [])
          .filter((d) => d && d.guardianOpenid)
          .map((d) => [
            String(d.guardianOpenid),
            {
              id: String(d.guardianOpenid),
              nickname: d.guardianName != null ? String(d.guardianName) : "",
              avatarUrl: d.guardianAvatarUrl != null ? String(d.guardianAvatarUrl) : "",
              acceptedAt: d.acceptedAt ? new Date(d.acceptedAt).getTime() : null,
            },
          ])
      ).values()].sort((a, b) => (b.acceptedAt || 0) - (a.acceptedAt || 0));
      const deadline = doc && doc.deadline ? String(doc.deadline) : "22:30";
      const graceMinutesRaw = doc && doc.graceMinutes != null ? Number(doc.graceMinutes) : NaN;
      const graceMinutes = Number.isFinite(graceMinutesRaw) ? graceMinutesRaw : 1440;

      return res.json({
        ok: true,
        userId: openid,
        profile: {
          familyName: doc && doc.familyName ? String(doc.familyName) : "",
          gender: doc && doc.gender ? String(doc.gender) : "",
          age: doc && doc.age != null ? doc.age : null,
          avatarUrl: doc && doc.avatarUrl ? String(doc.avatarUrl) : "",
        },
        rule: {
          deadline,
          graceMinutes,
        },
        guardians,
      });
    })
  );

  app.post(
    "/api/userAvatar",
    requireAuth,
    asyncHandler(async (req, res) => {
      const db = await getDb();
      const openid = req.user && req.user.openid ? String(req.user.openid) : "";
      if (!openid) return res.status(401).json({ ok: false, error: "invalid token" });

      const avatarUrlRaw = req.body && req.body.avatarUrl != null ? String(req.body.avatarUrl) : null;
      const avatarBase64Raw = req.body && req.body.avatarBase64 != null ? String(req.body.avatarBase64) : "";
      const avatarBase64Trimmed = avatarBase64Raw ? avatarBase64Raw.trim() : "";

      let avatarUrl = "";
      if (avatarBase64Trimmed) {
        const { base64, contentTypeHint } = normalizeBase64Image(avatarBase64Trimmed);
        if (!base64) return res.status(400).json({ ok: false, error: "missing avatar" });
        let buf = null;
        try {
          buf = Buffer.from(base64, "base64");
        } catch (e) {
          buf = null;
        }
        if (!buf || !buf.length) return res.status(400).json({ ok: false, error: "missing avatar" });
        if (buf.length > 3 * 1024 * 1024) return res.status(413).json({ ok: false, error: "avatar too large" });
        const { ext, contentType } = sniffImageType(buf, contentTypeHint);
        const key = `wy/user_avatars/${openid}_${randomId()}.${ext}`;
        avatarUrl = await uploadToCos({ key, buffer: buf, contentType });
      } else {
        if (avatarUrlRaw === null) return res.status(400).json({ ok: false, error: "missing avatar" });
        avatarUrl = avatarUrlRaw.trim();
        if (avatarUrl.length > 500) return res.status(400).json({ ok: false, error: "avatarUrl too long" });
        if (avatarUrl && !(avatarUrl.startsWith("http://") || avatarUrl.startsWith("https://"))) {
          return res.status(400).json({ ok: false, error: "invalid avatarUrl" });
        }
      }

      const now = new Date();
      await db.collection("wy_users").updateOne(
        { _id: openid },
        {
          $set: { openid, avatarUrl, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true }
      );

      return res.json({ ok: true, userId: openid, avatarUrl });
    })
  );

  app.post(
    "/api/userProfile",
    requireAuth,
    asyncHandler(async (req, res) => {
      const db = await getDb();
      const openid = req.user && req.user.openid ? String(req.user.openid) : "";
      if (!openid) return res.status(401).json({ ok: false, error: "invalid token" });

      const familyNameRaw = req.body && req.body.familyName != null ? String(req.body.familyName) : null;
      const genderRaw = req.body && req.body.gender != null ? req.body.gender : null;
      const ageRaw = req.body && req.body.age != null ? req.body.age : null;

      const set = { openid, updatedAt: new Date() };
      let hasAny = false;

      if (familyNameRaw !== null) {
        const familyName = familyNameRaw.trim();
        if (!familyName || familyName.length > 20) return res.status(400).json({ ok: false, error: "invalid familyName" });
        set.familyName = familyName;
        hasAny = true;
      }

      if (genderRaw !== null) {
        const g = normalizeGender(genderRaw);
        if (!g) return res.status(400).json({ ok: false, error: "invalid gender" });
        set.gender = g;
        hasAny = true;
      }

      if (ageRaw !== null) {
        const age = Number.parseInt(String(ageRaw), 10);
        if (!Number.isFinite(age) || age < 0 || age > 150) return res.status(400).json({ ok: false, error: "invalid age" });
        set.age = age;
        hasAny = true;
      }

      if (!hasAny) return res.status(400).json({ ok: false, error: "missing fields" });

      await db.collection("wy_users").updateOne(
        { _id: openid },
        {
          $set: set,
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      );

      const doc = await db.collection("wy_users").findOne({ _id: openid });
      const links = await db.collection("wy_guardian_relations").find({ elderOpenid: openid }).limit(200).toArray();
      const guardians = [...new Map(
        (links || [])
          .filter((d) => d && d.guardianOpenid)
          .map((d) => [
            String(d.guardianOpenid),
            {
              id: String(d.guardianOpenid),
              nickname: d.guardianName != null ? String(d.guardianName) : "",
              avatarUrl: d.guardianAvatarUrl != null ? String(d.guardianAvatarUrl) : "",
              acceptedAt: d.acceptedAt ? new Date(d.acceptedAt).getTime() : null,
            },
          ])
      ).values()].sort((a, b) => (b.acceptedAt || 0) - (a.acceptedAt || 0));
      return res.json({
        ok: true,
        userId: openid,
        profile: {
          familyName: doc && doc.familyName ? String(doc.familyName) : "",
          gender: doc && doc.gender ? String(doc.gender) : "",
          age: doc && doc.age != null ? doc.age : null,
          avatarUrl: doc && doc.avatarUrl ? String(doc.avatarUrl) : "",
        },
        guardians,
      });
    })
  );

  app.get(
    "/api/todayStatus",
    requireAuth,
    asyncHandler(async (req, res) => {
      const db = await getDb();
      const { dateKey } = getShanghaiParts();
      const id = `${req.user.openid}_${dateKey}`;
      const doc = await db.collection("wy_checkins").findOne({ _id: id });
      if (!doc) return res.json({ checkedIn: false, dateKey });
      return res.json({ checkedIn: true, dateKey, timeText: doc.timeText || "" });
    })
  );

  app.get(
    "/api/guardian/overview",
    requireAuth,
    asyncHandler(async (req, res) => {
      const db = await getDb();
      const openid = req.user && req.user.openid != null ? String(req.user.openid) : "";
      if (!openid) return res.status(401).json({ ok: false, error: "invalid token" });

      const links = await db.collection("wy_guardian_relations").find({ guardianOpenid: openid }).limit(200).toArray();
      const { dateKey } = getShanghaiParts();

      const isOpenidLike = (value) => {
        const s = String(value == null ? "" : value).trim();
        if (!s) return false;
        if (s.length < 20 || s.length > 64) return false;
        return /^o[0-9A-Za-z_-]+$/.test(s);
      };

      const inviterOpenids = [
        ...new Set(
          links
            .map((d) => {
              const elderOpenid = String(d && d.elderOpenid != null ? d.elderOpenid : "").trim();
              if (elderOpenid) return elderOpenid;
              const inviterId = String(d && d.inviterId != null ? d.inviterId : "").trim();
              return isOpenidLike(inviterId) ? inviterId : "";
            })
            .filter(Boolean)
        ),
      ];
      const checkinIds = inviterOpenids.map((id) => `${id}_${dateKey}`);
      const checkins = checkinIds.length ? await db.collection("wy_checkins").find({ _id: { $in: checkinIds } }).toArray() : [];
      const users = inviterOpenids.length ? await db.collection("wy_users").find({ _id: { $in: inviterOpenids } }).toArray() : [];

      const checkinMap = new Map(checkins.map((c) => [String(c && c._id != null ? c._id : ""), c]));
      const userMap = new Map(users.map((u) => [String(u && u._id != null ? u._id : ""), u]));

      const guardees = links.map((link, index) => {
        const elderOpenid = String(link && link.elderOpenid != null ? link.elderOpenid : "").trim();
        const inviterId = String(link && link.inviterId != null ? link.inviterId : "").trim();
        const inviterName = String(link && link.inviterName != null ? link.inviterName : "").trim();
        const resolvedOpenid = elderOpenid || (isOpenidLike(inviterId) ? inviterId : "");
        const user = resolvedOpenid ? userMap.get(resolvedOpenid) : null;
        const avatarUrl = user && user.avatarUrl != null ? String(user.avatarUrl) : "";
        const checkin = resolvedOpenid ? checkinMap.get(`${resolvedOpenid}_${dateKey}`) : null;
        const timeText = checkin && checkin.timeText != null ? String(checkin.timeText) : "";
        const checkedIn = Boolean(checkin);
        const status = checkedIn ? "ok" : "alert";
        const statusText = checkedIn ? (timeText ? `已报平安 ${timeText}` : "已报平安") : "今日尚未打卡";
        return {
          id: resolvedOpenid || inviterId || String(index),
          inviterId,
          inviterName,
          inviterOpenid: resolvedOpenid,
          avatarUrl,
          status,
          statusText,
          checkedIn,
          timeText,
        };
      });

      let safeCount = 0;
      let pendingCount = 0;
      for (const item of guardees) {
        const status = item && item.status ? String(item.status) : "";
        if (status === "alert") pendingCount += 1;
        else safeCount += 1;
      }

      return res.json({ ok: true, dateKey, guardees, safeCount, pendingCount });
    })
  );

  app.post(
    "/api/checkin",
    requireAuth,
    asyncHandler(async (req, res) => {
      const db = await getDb();
      const { dateKey, timeText } = getShanghaiParts();
      const now = new Date();
      const id = `${req.user.openid}_${dateKey}`;

      await db.collection("wy_checkins").updateOne(
        { _id: id },
        {
          $set: {
            openid: req.user.openid,
            dateKey,
            timeText,
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true }
      );

      return res.json({ checkedIn: true, dateKey, timeText });
    })
  );

  app.post(
    "/api/notifyGuardian/createInviteWxaCode",
    requireAuth,
    asyncHandler(async (req, res) => {
      const inviterId = req.body && req.body.inviterId ? String(req.body.inviterId) : "";
      const inviterName = req.body && req.body.inviterName ? String(req.body.inviterName) : "";
      if (!inviterId || !inviterName) return res.status(400).json({ ok: false, error: "missing inviter" });

      const pageRaw = req.body && req.body.page != null ? String(req.body.page) : "";
      const page = pageRaw ? pageRaw.trim() : "";
      if (!page) return res.status(400).json({ ok: false, error: "missing page" });
      if (page !== "pages/acceptInvite/index") return res.status(400).json({ ok: false, error: "invalid page" });

      const envVersionRaw = req.body && req.body.env_version != null ? String(req.body.env_version) : "";
      const envVersion = envVersionRaw ? envVersionRaw.trim() : "";
      if (envVersion && !["develop", "trial", "release"].includes(envVersion)) {
        return res.status(400).json({ ok: false, error: "invalid env_version" });
      }

      const db = await getDb();
      const wx = createWeChatClient({ db, getEnv });

      const sceneId = randomId("wy_i_");
      const now = new Date();
      await db.collection("wy_invite_scenes").updateOne(
        { _id: sceneId },
        {
          $set: {
            inviterId,
            inviterName,
            inviterOpenid: req.user.openid,
            createdAt: now,
            expireAt: Date.now() + 30 * 86400_000,
          },
        },
        { upsert: true }
      );

      const img = await wx.createWxaCodeUnlimit({ sceneId, page, envVersion: envVersion || undefined });
      if (!img.ok) return res.status(502).json({ ok: false, error: img.error });

      const key = `invite_wxacode/${sceneId}.png`;
      const imageUrlRaw = await uploadToCos({ key, buffer: img.buffer, contentType: "image/png" });
      const imageUrl = rewriteLocalhostFileUrl(imageUrlRaw, req);
      if (!imageUrl) throw new Error("imageUrl empty");

      return res.json({ ok: true, sceneId, imageUrl });
    })
  );

  app.post(
    "/api/notifyGuardian/createBindQr",
    requireAuth,
    asyncHandler(async (req, res) => {
      const inviterId = req.body && req.body.inviterId ? String(req.body.inviterId) : "";
      const inviterName = req.body && req.body.inviterName ? String(req.body.inviterName) : "";
      if (!inviterId || !inviterName) return res.status(400).json({ ok: false, error: "missing inviter" });

      const db = await getDb();
      const wx = createWeChatClient({ db, getEnv });

      const scene = randomId("wy_b_");
      const now = new Date();
      await db.collection("wy_guardian_bind_scenes").updateOne(
        { _id: scene },
        {
          $set: {
            elderOpenid: req.user.openid,
            inviterId,
            inviterName,
            createdAt: now,
            expireAt: Date.now() + 30 * 86400_000,
            usedAt: null,
            lastGuardianMpOpenid: "",
            sendCardAt: null,
            sendCardOk: false,
            sendCardMode: "",
            sendCardErr: "",
          },
        },
        { upsert: true }
      );

      const qr = await wx.createMpQr({ scene, expireSeconds: 30 * 86400 });
      if (!qr.ok) return res.status(502).json({ ok: false, error: qr.error });

      const key = `bind_mpqr/${scene}.png`;
      const imageUrlRaw = await uploadToCos({ key, buffer: qr.buffer, contentType: "image/png" });
      const imageUrl = rewriteLocalhostFileUrl(imageUrlRaw, req);
      if (!imageUrl) throw new Error("imageUrl empty");

      const cardParams = [
        `inviterId=${encodeURIComponent(inviterId)}`,
        `inviterName=${encodeURIComponent(inviterName)}`,
        `bindScene=${encodeURIComponent(scene)}`,
      ];
      const pageUrl = `pages/acceptInvite/index?${cardParams.join("&")}`;
      const shortLink = await wx.createWxaShortLink({ pageUrl });
      if (!shortLink.ok) return res.status(502).json({ ok: false, error: shortLink.error });
      const cardUrl = shortLink.link;
      console.log(JSON.stringify({ tag: "bind_mpqr", scene, inviterId, inviterName, cardUrl }));
      return res.json({ ok: true, scene, imageUrl, cardUrl });
    })
  );

  app.get(
    "/api/notifyGuardian/resolveInviteScene",
    asyncHandler(async (req, res) => {
      const sceneId = req.query && req.query.sceneId ? String(req.query.sceneId) : "";
      if (!sceneId) return res.status(400).json({ ok: false, error: "missing sceneId" });

      const db = await getDb();
      const doc = await db.collection("wy_invite_scenes").findOne({ _id: sceneId });
      if (!doc) return res.status(404).json({ ok: false, error: "scene not found" });
      const expireAt = doc.expireAt != null ? Number(doc.expireAt) : null;
      const isExpired = Number.isFinite(expireAt) ? expireAt <= Date.now() : false;
      return res.json({
        ok: true,
        sceneId,
        inviterId: doc.inviterId || "",
        inviterName: doc.inviterName || "",
        inviterOpenid: doc.inviterOpenid || "",
        expireAt: Number.isFinite(expireAt) ? expireAt : null,
        isExpired,
      });
    })
  );

  app.post(
    "/api/notifyGuardian/acceptInvite",
    asyncHandler(async (req, res) => {
      const code = req.body && req.body.code ? String(req.body.code) : "";
      if (!code) return res.status(400).json({ ok: false, error: "missing code" });

      const sceneIdRaw = req.body && req.body.sceneId != null ? String(req.body.sceneId) : "";
      const bindSceneRaw = req.body && req.body.bindScene != null ? String(req.body.bindScene) : "";
      const sceneRaw = req.body && req.body.scene != null ? String(req.body.scene) : "";

      let sceneId = sceneIdRaw ? sceneIdRaw.trim() : "";
      let bindScene = bindSceneRaw ? bindSceneRaw.trim() : "";
      const scene = sceneRaw ? sceneRaw.trim() : "";

      if (!sceneId && !bindScene && scene) {
        if (scene.startsWith("wy_b_")) bindScene = scene;
        else if (scene.startsWith("wy_i_")) sceneId = scene;
      }
      if (sceneId && !bindScene && sceneId.startsWith("wy_b_")) {
        bindScene = sceneId;
        sceneId = "";
      }
      if (bindScene && !sceneId && bindScene.startsWith("wy_i_")) {
        sceneId = bindScene;
        bindScene = "";
      }

      const inviterIdRaw = req.body && req.body.inviterId != null ? String(req.body.inviterId) : "";
      const inviterNameRaw = req.body && req.body.inviterName != null ? String(req.body.inviterName) : "";
      const inviterIdFallback = inviterIdRaw ? inviterIdRaw.trim() : "";
      const inviterNameFallback = inviterNameRaw ? inviterNameRaw.trim() : "";

      const inviterOpenidRaw = req.body && req.body.inviterOpenid != null ? String(req.body.inviterOpenid) : "";
      const inviterOpenidInput = inviterOpenidRaw ? inviterOpenidRaw.trim() : "";

      const inviteeNameRaw = req.body && req.body.inviteeName != null ? String(req.body.inviteeName) : "";
      const inviteeAvatarUrlRaw = req.body && req.body.inviteeAvatarUrl != null ? String(req.body.inviteeAvatarUrl) : "";
      const inviteeAvatarBase64Raw = req.body && req.body.inviteeAvatarBase64 != null ? String(req.body.inviteeAvatarBase64) : "";
      const inviteeName = inviteeNameRaw ? inviteeNameRaw.trim().slice(0, 50) : "";
      const inviteeAvatarUrlInput = inviteeAvatarUrlRaw ? inviteeAvatarUrlRaw.trim().slice(0, 500) : "";

      const channelRaw = req.body && req.body.channel != null ? String(req.body.channel) : "";
      const channel = channelRaw ? channelRaw.trim() : "";
      if (channel && channel !== "mini_landing") return res.status(400).json({ ok: false, error: "invalid channel" });

      const envVersionRaw = req.body && req.body.env_version != null ? String(req.body.env_version) : "";
      const envVersion = envVersionRaw ? envVersionRaw.trim() : "";
      if (envVersion && !["develop", "trial", "release"].includes(envVersion)) {
        return res.status(400).json({ ok: false, error: "invalid env_version" });
      }

      const db = await getDb();
      const wx = createWeChatClient({ db, getEnv });

      const mockOpenid = getEnv("WX_LOGIN_MOCK_OPENID");
      let inviteeOpenid = "";
      if (mockOpenid) {
        inviteeOpenid = String(mockOpenid);
      } else {
        const s = await wx.jscode2session({ code });
        if (!s.ok) return res.status(502).json({ ok: false, error: s.error || "jscode2session failed" });
        inviteeOpenid = s.openid || "";
      }
      if (!inviteeOpenid) return res.status(502).json({ ok: false, error: "missing openid" });

      let inviteeAvatarUrl = inviteeAvatarUrlInput;
      if (inviteeAvatarUrl) {
        if (!(inviteeAvatarUrl.startsWith("http://") || inviteeAvatarUrl.startsWith("https://"))) {
          return res.status(400).json({ ok: false, error: "invalid inviteeAvatarUrl" });
        }
      } else {
        const { base64, contentTypeHint } = normalizeBase64Image(inviteeAvatarBase64Raw);
        if (!base64) return res.status(400).json({ ok: false, error: "missing avatar" });
        let buf = null;
        try {
          buf = Buffer.from(base64, "base64");
        } catch (e) {
          buf = null;
        }
        if (!buf || !buf.length) return res.status(400).json({ ok: false, error: "missing avatar" });
        if (buf.length > 3 * 1024 * 1024) return res.status(413).json({ ok: false, error: "avatar too large" });
        const { ext, contentType } = sniffImageType(buf, contentTypeHint);
        const key = `wy/invitee_avatars/${inviteeOpenid}_${randomId()}.${ext}`;
        inviteeAvatarUrl = await uploadToCos({ key, buffer: buf, contentType });
      }

      let inviterId = inviterIdFallback;
      let inviterName = inviterNameFallback;
      let inviterOpenid = inviterOpenidInput;
      let resolvedSceneId = sceneId;
      let expireAt = null;
      let isExpired = false;
      let bindSceneDoc = null;

      const bindSceneId = bindScene && bindScene.startsWith("wy_b_") ? bindScene : "";
      if (bindSceneId) {
        const doc = await db.collection("wy_guardian_bind_scenes").findOne({ _id: bindSceneId });
        if (!doc) return res.status(404).json({ ok: false, error: "scene not found", code: "BIND_SCENE_NOT_FOUND" });
        bindSceneDoc = doc;
        inviterId = doc.inviterId || inviterId;
        inviterName = doc.inviterName || inviterName;
        inviterOpenid = doc.elderOpenid || "";
        resolvedSceneId = doc._id || bindSceneId;
        expireAt = doc.expireAt != null ? Number(doc.expireAt) : null;
        isExpired = Number.isFinite(expireAt) ? expireAt <= Date.now() : false;
        if (isExpired) {
          return res
            .status(400)
            .json({ ok: false, error: "scene expired", code: "SCENE_EXPIRED", expireAt: Number.isFinite(expireAt) ? expireAt : null });
        }
      } else if (sceneId) {
        const doc = await db.collection("wy_invite_scenes").findOne({ _id: sceneId });
        if (!doc) return res.status(404).json({ ok: false, error: "scene not found", code: "SCENE_NOT_FOUND" });
        inviterId = doc.inviterId || inviterId;
        inviterName = doc.inviterName || inviterName;
        inviterOpenid = doc.inviterOpenid || "";
        resolvedSceneId = doc._id || sceneId;
        expireAt = doc.expireAt != null ? Number(doc.expireAt) : null;
        isExpired = Number.isFinite(expireAt) ? expireAt <= Date.now() : false;
        if (isExpired) {
          return res
            .status(400)
            .json({ ok: false, error: "scene expired", code: "SCENE_EXPIRED", expireAt: Number.isFinite(expireAt) ? expireAt : null });
        }
      } else if (!inviterId || !inviterName) {
        return res.status(400).json({ ok: false, error: "missing inviter" });
      }

      const looksLikeOpenid = (s) => {
        const t = String(s || "").trim();
        if (!t) return false;
        if (t.length < 20 || t.length > 40) return false;
        return /^o[0-9a-zA-Z_-]+$/.test(t);
      };

      if (!inviterOpenid && inviterId && looksLikeOpenid(inviterId)) {
        inviterOpenid = inviterId;
      }

      if (inviterOpenid && inviterOpenid === inviteeOpenid) {
        return res.status(400).json({ ok: false, error: "self bind not allowed", code: "SELF_BIND_NOT_ALLOWED" });
      }
      if (!inviterOpenid && inviterId && inviterId === inviteeOpenid) {
        return res.status(400).json({ ok: false, error: "self bind not allowed", code: "SELF_BIND_NOT_ALLOWED" });
      }

      const mpOpenidRaw = req.body && req.body.mpOpenid != null ? String(req.body.mpOpenid) : "";
      const mpOpenid = mpOpenidRaw ? mpOpenidRaw.trim() : "";
      const now = new Date();

      const elderOpenid = inviterOpenid ? String(inviterOpenid) : "";
      if (!elderOpenid) {
        return res.status(400).json({ ok: false, error: "missing inviterOpenid", code: "MISSING_INVITER_OPENID" });
      }

      let inferredMpOpenid = "";
      if (!mpOpenid) {
        const bindScenes = db.collection("wy_guardian_bind_scenes");
        const recentBind = await bindScenes.findOne(
          { elderOpenid, lastGuardianMpOpenid: { $exists: true, $ne: "" } },
          { sort: { sendCardAt: -1, usedAt: -1, createdAt: -1 } }
        );
        inferredMpOpenid =
          recentBind && recentBind.lastGuardianMpOpenid != null ? String(recentBind.lastGuardianMpOpenid).trim() : "";
      }

      let verifiedInviteeMpOpenid = "";
      const candidateMpOpenid = mpOpenid || inferredMpOpenid;
      if (candidateMpOpenid) {
        const inviteeDoc = await db.collection("wy_users").findOne({ _id: inviteeOpenid }, { projection: { unionid: 1 } });
        const inviteeUnionid = inviteeDoc && inviteeDoc.unionid != null ? String(inviteeDoc.unionid) : "";
        if (inviteeUnionid) {
          try {
            const resolved = await wx.resolveUserByMpOpenid({ mpOpenid: candidateMpOpenid, now });
            const resolvedUnionid = resolved && resolved.ok && resolved.unionid ? String(resolved.unionid) : "";
            const resolvedUserOpenid = resolved && resolved.ok && resolved.userOpenid ? String(resolved.userOpenid) : "";
            if ((resolvedUnionid && resolvedUnionid === inviteeUnionid) || resolvedUserOpenid === inviteeOpenid) {
              verifiedInviteeMpOpenid = candidateMpOpenid;
            }
          } catch (_) {}
        }
      }

      const relationId = `${elderOpenid}__${inviteeOpenid}`;
      const relations = db.collection("wy_guardian_relations");
      const existing = await relations.findOne({ _id: relationId });

      const existingAcceptedAtRaw = existing && existing.acceptedAt != null ? existing.acceptedAt : null;
      const existingAcceptedAt = existingAcceptedAtRaw ? new Date(existingAcceptedAtRaw) : null;
      const acceptedAt = existingAcceptedAt && Number.isFinite(existingAcceptedAt.getTime()) ? existingAcceptedAt : now;

      const guardianNameExisting = existing && existing.guardianName != null ? String(existing.guardianName) : "";
      const guardianAvatarExisting = existing && existing.guardianAvatarUrl != null ? String(existing.guardianAvatarUrl) : "";
      const guardianName = inviteeName || guardianNameExisting;
      const guardianAvatarUrl = inviteeAvatarUrl || guardianAvatarExisting;

      const fallbackMpOpenid =
        bindSceneId && bindSceneDoc && bindSceneDoc.lastGuardianMpOpenid != null
          ? String(bindSceneDoc.lastGuardianMpOpenid).trim()
          : "";
      const finalCandidateMpOpenid = candidateMpOpenid || fallbackMpOpenid;
      const guardianMpOpenid = verifiedInviteeMpOpenid || finalCandidateMpOpenid;

      const set = {
        elderOpenid,
        guardianOpenid: inviteeOpenid,
        guardianName,
        guardianAvatarUrl,
        inviterId: inviterId || "",
        inviterName: inviterName || "",
        scene: resolvedSceneId || "",
        sceneType: bindSceneId ? "mp_bind" : sceneId ? "mini_invite" : "",
        channel: channel || "mini_landing",
        envVersion: envVersion || "",
        expireAt: Number.isFinite(expireAt) ? expireAt : null,
        acceptedAt,
        updatedAt: now,
      };
      if (guardianMpOpenid) {
        set.guardianMpOpenid = guardianMpOpenid;
      }
      if (verifiedInviteeMpOpenid) {
        set.guardianMpVerifiedAt = now;
      }

      await relations.updateOne(
        { _id: relationId },
        {
          $set: set,
          $setOnInsert: { createdAt: now },
        },
        { upsert: true }
      );

      const userSet = {
        openid: inviteeOpenid,
        nickname: guardianName || "",
        avatarUrl: guardianAvatarUrl || "",
        updatedAt: now,
      };
      if (verifiedInviteeMpOpenid) {
        userSet.mpOpenid = verifiedInviteeMpOpenid;
        userSet.mpOpenidUpdatedAt = now;
      }
      await db.collection("wy_users").updateOne(
        { _id: inviteeOpenid },
        {
          $set: userSet,
          $setOnInsert: { createdAt: now },
        },
        { upsert: true }
      );

      const acceptedAtMs = acceptedAt ? acceptedAt.getTime() : null;

      const jwt = require("jsonwebtoken");
      const secret = requireEnv("API_JWT_SECRET");
      const token = jwt.sign({ openid: inviteeOpenid }, secret, { algorithm: "HS256", expiresIn: "30d" });

      return res.json({
        ok: true,
        relationId,
        alreadyAccepted: Boolean(existing),
        acceptedAt: Number.isFinite(acceptedAtMs) ? acceptedAtMs : null,
        openid: inviteeOpenid,
        token,
      });
    })
  );

  app.post(
    "/api/notifyGuardian/removeGuardian",
    requireAuth,
    asyncHandler(async (req, res) => {
      const db = await getDb();
      const openid = req.user && req.user.openid ? String(req.user.openid) : "";
      if (!openid) return res.status(401).json({ ok: false, error: "invalid token" });

      const raw =
        req.body && (req.body.guardianOpenid || req.body.guardianId || req.body.inviteeOpenid || req.body.id) != null
          ? String(req.body.guardianOpenid || req.body.guardianId || req.body.inviteeOpenid || req.body.id)
          : "";
      const guardianOpenid = raw.trim();
      if (!guardianOpenid) return res.status(400).json({ ok: false, error: "missing guardianOpenid" });
      if (guardianOpenid === openid) return res.status(400).json({ ok: false, error: "invalid guardianOpenid" });

      const relations = db.collection("wy_guardian_relations");
      const del = await relations.deleteOne({ _id: `${openid}__${guardianOpenid}` });
      const removedCount = Number(del && del.deletedCount) || 0;

      return res.json({ ok: true, removedCount });
    })
  );

  app.post(
    "/api/notifyGuardian/setRule",
    requireAuth,
    asyncHandler(async (req, res) => {
      const deadline = req.body && req.body.deadline ? String(req.body.deadline) : "";
      const graceMinutes = req.body && req.body.graceMinutes != null ? Number(req.body.graceMinutes) : null;
      if (!deadline || !Number.isFinite(graceMinutes)) return res.status(400).json({ ok: false, error: "invalid rule" });

      const db = await getDb();
      const openid = req.user && req.user.openid ? String(req.user.openid) : "";
      if (!openid) return res.status(401).json({ ok: false, error: "invalid token" });

      await db.collection("wy_users").updateOne(
        { _id: openid },
        {
          $set: {
            deadline,
            graceMinutes,
            updatedAt: new Date(),
          },
          $setOnInsert: { openid, createdAt: new Date() },
        },
        { upsert: true }
      );
      return res.json({ ok: true });
    })
  );
};

module.exports = { registerApiRoutes };
