const jwt = require("jsonwebtoken");

const registerApiRoutes = (
  app,
  { asyncHandler, requireAuth, getDb, getShanghaiParts, randomId, createWeChatClient, uploadToCos, getEnv, requireEnv }
) => {
  const normalizeGender = (raw) => {
    const s = String(raw == null ? "" : raw).trim().toLowerCase();
    if (!s) return "";
    if (["0", "unknown", "u"].includes(s)) return "unknown";
    if (["m", "male", "man", "boy", "男", "1"].includes(s)) return "male";
    if (["f", "female", "woman", "girl", "女", "2"].includes(s)) return "female";
    return "";
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

      const mockOpenid = getEnv("WX_LOGIN_MOCK_OPENID");
      if (mockOpenid) {
        const secret = requireEnv("API_JWT_SECRET");
        const token = jwt.sign({ openid: mockOpenid }, secret, { algorithm: "HS256", expiresIn: "30d" });
        return res.json({ ok: true, openid: mockOpenid, token });
      }

      const db = await getDb();
      const wx = createWeChatClient({ db, getEnv });
      const r = await wx.jscode2session({ code });
      if (!r.ok) return res.status(502).json({ ok: false, error: r.error });

      const secret = requireEnv("API_JWT_SECRET");
      const token = jwt.sign({ openid: r.openid }, secret, { algorithm: "HS256", expiresIn: "30d" });
      return res.json({ ok: true, openid: r.openid, token });
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
      const links = await db.collection("wy_guardian_mini_links").find({ inviterOpenid: openid }).limit(200).toArray();
      const guardians = [...new Map(
        (links || [])
          .filter((d) => d && d.inviteeOpenid)
          .map((d) => [
            String(d.inviteeOpenid),
            {
              id: String(d.inviteeOpenid),
              nickname: d.inviteeName != null ? String(d.inviteeName) : "",
              avatarUrl: d.inviteeAvatarUrl != null ? String(d.inviteeAvatarUrl) : "",
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
      const links = await db.collection("wy_guardian_mini_links").find({ inviterOpenid: openid }).limit(200).toArray();
      const guardians = [...new Map(
        (links || [])
          .filter((d) => d && d.inviteeOpenid)
          .map((d) => [
            String(d.inviteeOpenid),
            {
              id: String(d.inviteeOpenid),
              nickname: d.inviteeName != null ? String(d.inviteeName) : "",
              avatarUrl: d.inviteeAvatarUrl != null ? String(d.inviteeAvatarUrl) : "",
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

      const img = await wx.createWxaCodeUnlimit({ sceneId, envVersion: envVersion || undefined });
      if (!img.ok) return res.status(502).json({ ok: false, error: img.error });

      const key = `invite_wxacode/${sceneId}.png`;
      const imageUrl = await uploadToCos({ key, buffer: img.buffer, contentType: "image/png" });

      return res.json({ ok: true, sceneId, imageUrl });
    })
  );

  app.post(
    "/api/notifyGuardian/createInviteMpQr",
    requireAuth,
    asyncHandler(async (req, res) => {
      const inviterId = req.body && req.body.inviterId ? String(req.body.inviterId) : "";
      const inviterName = req.body && req.body.inviterName ? String(req.body.inviterName) : "";
      if (!inviterId || !inviterName) return res.status(400).json({ ok: false, error: "missing inviter" });

      const db = await getDb();
      const wx = createWeChatClient({ db, getEnv });

      const scene = randomId("wy_i_");
      const now = new Date();
      await db.collection("wy_invite_mp_scenes").updateOne(
        { _id: scene },
        { $set: { inviterId, inviterName, createdAt: now, expireAt: Date.now() + 30 * 86400_000 } },
        { upsert: true }
      );

      const qr = await wx.createMpQr({ scene, expireSeconds: 30 * 86400 });
      if (!qr.ok) return res.status(502).json({ ok: false, error: qr.error });

      const key = `invite_mpqr/${scene}.png`;
      const imageUrl = await uploadToCos({ key, buffer: qr.buffer, contentType: "image/png" });

      return res.json({ ok: true, scene, imageUrl });
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
      const imageUrl = await uploadToCos({ key, buffer: qr.buffer, contentType: "image/png" });

      return res.json({ ok: true, scene, imageUrl });
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
      const sceneId = sceneIdRaw ? sceneIdRaw.trim() : "";

      const bindSceneRaw =
        req.body && req.body.bindScene != null
          ? String(req.body.bindScene)
          : req.body && req.body.scene != null
            ? String(req.body.scene)
            : "";
      const bindScene = bindSceneRaw ? bindSceneRaw.trim() : "";

      const inviterIdRaw = req.body && req.body.inviterId != null ? String(req.body.inviterId) : "";
      const inviterNameRaw = req.body && req.body.inviterName != null ? String(req.body.inviterName) : "";
      const inviterIdFallback = inviterIdRaw ? inviterIdRaw.trim() : "";
      const inviterNameFallback = inviterNameRaw ? inviterNameRaw.trim() : "";

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
      let inviterOpenid = "";
      let resolvedSceneId = sceneId;
      let expireAt = null;
      let isExpired = false;

      const bindSceneId = bindScene && bindScene.startsWith("wy_b_") ? bindScene : "";
      if (bindSceneId) {
        const doc = await db.collection("wy_guardian_bind_scenes").findOne({ _id: bindSceneId });
        if (!doc) return res.status(404).json({ ok: false, error: "scene not found", code: "BIND_SCENE_NOT_FOUND" });
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

      if (inviterOpenid && inviterOpenid === inviteeOpenid) {
        return res.status(400).json({ ok: false, error: "self bind not allowed", code: "SELF_BIND_NOT_ALLOWED" });
      }
      if (!inviterOpenid && inviterId && inviterId === inviteeOpenid) {
        return res.status(400).json({ ok: false, error: "self bind not allowed", code: "SELF_BIND_NOT_ALLOWED" });
      }

      const mpOpenidRaw = req.body && req.body.mpOpenid != null ? String(req.body.mpOpenid) : "";
      const mpOpenid = mpOpenidRaw ? mpOpenidRaw.trim() : "";
      const mpTsRaw = req.body && req.body.mpTs != null ? String(req.body.mpTs) : "";
      const mpTs = mpTsRaw ? Number.parseInt(mpTsRaw, 10) : NaN;
      const mpSigRaw = req.body && req.body.mpSig != null ? String(req.body.mpSig) : "";
      const mpSig = mpSigRaw ? mpSigRaw.trim() : "";

      let verifiedInviteeMpOpenid = "";
      if (mpOpenid && mpSig && Number.isFinite(mpTs)) {
        const nowMs = Date.now();
        const ageMs = nowMs - mpTs;
        if (ageMs >= 0 && ageMs <= 15 * 60_000) {
          const crypto = require("crypto");
          const signSecret = getEnv("MP_MINI_OPENID_SIGN_SECRET") || requireEnv("API_JWT_SECRET");
          const sigCtx = bindSceneId || sceneId || "";
          const expected = crypto.createHmac("sha256", signSecret).update(`${mpOpenid}.${sigCtx}.${mpTs}`).digest("hex");
          try {
            const a = Buffer.from(expected, "utf8");
            const b = Buffer.from(mpSig, "utf8");
            if (a.length === b.length && crypto.timingSafeEqual(a, b)) verifiedInviteeMpOpenid = mpOpenid;
          } catch (_) {}
        }
      }

      const relationKey = inviterOpenid
        ? `${inviterOpenid}__${inviteeOpenid}`
        : inviterId
          ? `inviterId_${inviterId}__${inviteeOpenid}`
          : `${resolvedSceneId}__${inviteeOpenid}`;

      const links = db.collection("wy_guardian_mini_links");
      const existing = await links.findOne({ _id: relationKey });
      if (existing) {
        if (verifiedInviteeMpOpenid) {
          const now = new Date();
          await links.updateOne(
            { _id: relationKey },
            {
              $set: {
                inviteeMpOpenid: verifiedInviteeMpOpenid,
                inviteeMpVerifiedAt: now,
                updatedAt: now,
              },
            }
          );
        }
        const acceptedAt = existing.acceptedAt ? new Date(existing.acceptedAt).getTime() : null;
        const jwt = require("jsonwebtoken");
        const secret = requireEnv("API_JWT_SECRET");
        const token = jwt.sign({ openid: inviteeOpenid }, secret, { algorithm: "HS256", expiresIn: "30d" });
        return res.json({
          ok: true,
          relationId: relationKey,
          alreadyAccepted: true,
          acceptedAt: Number.isFinite(acceptedAt) ? acceptedAt : null,
          openid: inviteeOpenid,
          token,
        });
      }

      const now = new Date();
      const set = {
        inviterId,
        inviterName,
        inviterOpenid,
        inviteeOpenid,
        inviteeName,
        inviteeAvatarUrl,
        sceneId: resolvedSceneId || "",
        channel: channel || "mini_landing",
        envVersion: envVersion || "",
        expireAt: Number.isFinite(expireAt) ? expireAt : null,
        updatedAt: now,
        acceptedAt: now,
      };
      if (verifiedInviteeMpOpenid) {
        set.inviteeMpOpenid = verifiedInviteeMpOpenid;
        set.inviteeMpVerifiedAt = now;
      }
      await links.updateOne(
        { _id: relationKey },
        {
          $set: {
            ...set,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true }
      );

      const jwt = require("jsonwebtoken");
      const secret = requireEnv("API_JWT_SECRET");
      const token = jwt.sign({ openid: inviteeOpenid }, secret, { algorithm: "HS256", expiresIn: "30d" });

      return res.json({
        ok: true,
        relationId: relationKey,
        alreadyAccepted: false,
        acceptedAt: now.getTime(),
        openid: inviteeOpenid,
        token,
      });
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
