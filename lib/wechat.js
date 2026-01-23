const fetchJson = async (url, options) => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12_000);
  try {
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {
        data = null;
      }
      return { ok: res.ok, status: res.status, data, text };
    } catch (e) {
      const cause = e && typeof e === "object" ? e.cause : null;
      const payload = {
        message: e && e.message ? String(e.message) : "fetch failed",
        name: e && e.name ? String(e.name) : "",
        cause: cause && typeof cause === "object"
          ? {
              code: cause.code != null ? String(cause.code) : "",
              errno: cause.errno != null ? String(cause.errno) : "",
              syscall: cause.syscall != null ? String(cause.syscall) : "",
              address: cause.address != null ? String(cause.address) : "",
              port: cause.port != null ? String(cause.port) : "",
            }
          : null,
      };
      return { ok: false, status: 0, data: null, text: JSON.stringify(payload) };
    }
  } finally {
    clearTimeout(t);
  }
};

const fetchBuffer = async (url, options) => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12_000);
  try {
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      const ab = await res.arrayBuffer();
      return { ok: res.ok, status: res.status, buffer: Buffer.from(ab) };
    } catch (e) {
      const cause = e && typeof e === "object" ? e.cause : null;
      const payload = {
        message: e && e.message ? String(e.message) : "fetch failed",
        name: e && e.name ? String(e.name) : "",
        cause: cause && typeof cause === "object"
          ? {
              code: cause.code != null ? String(cause.code) : "",
              errno: cause.errno != null ? String(cause.errno) : "",
              syscall: cause.syscall != null ? String(cause.syscall) : "",
              address: cause.address != null ? String(cause.address) : "",
              port: cause.port != null ? String(cause.port) : "",
            }
          : null,
      };
      return { ok: false, status: 0, buffer: Buffer.from([]), text: JSON.stringify(payload) };
    }
  } finally {
    clearTimeout(t);
  }
};

const createWeChatClient = ({ db, getEnv }) => {
  const kv = db.collection("wy_kv");

  const getCachedToken = async (key) => {
    const now = Date.now();
    const doc = await kv.findOne({ _id: key });
    if (!doc || !doc.value || !doc.expireAt || doc.expireAt - 120_000 <= now) return null;
    return doc.value;
  };

  const setCachedToken = async (key, value, expiresInSeconds) => {
    const now = Date.now();
    const expireAt = now + Math.max(0, (Number(expiresInSeconds) || 0) - 120) * 1000;
    await kv.updateOne(
      { _id: key },
      { $set: { value, expireAt, updatedAt: new Date() } },
      { upsert: true }
    );
  };

  const getAccessToken = async (kind) => {
    const key = kind === "mp" ? "mp_access_token" : "mini_access_token";
    const cached = await getCachedToken(key);
    if (cached) return { ok: true, accessToken: cached };

    const appid = kind === "mp" ? getEnv("MP_APPID") : getEnv("MINIAPP_APPID");
    const secret = kind === "mp" ? getEnv("MP_SECRET") : getEnv("MINIAPP_SECRET");
    if (!appid || !secret) return { ok: false, error: `missing wechat appid/secret for ${kind}` };
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(
      appid
    )}&secret=${encodeURIComponent(secret)}`;
    const r = await fetchJson(url);
    if (!r.ok || !r.data || r.data.errcode) {
      return { ok: false, error: r.data ? JSON.stringify(r.data) : r.text || "token fetch failed" };
    }

    await setCachedToken(key, r.data.access_token, r.data.expires_in);
    return { ok: true, accessToken: r.data.access_token };
  };

  const jscode2session = async ({ code }) => {
    const appid = getEnv("MINIAPP_APPID");
    const secret = getEnv("MINIAPP_SECRET");
    if (!appid || !secret) return { ok: false, error: "missing miniapp appid/secret" };
    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(
      appid
    )}&secret=${encodeURIComponent(secret)}&js_code=${encodeURIComponent(
      code
    )}&grant_type=authorization_code`;
    const r = await fetchJson(url);
    if (!r.ok || !r.data || r.data.errcode) {
      return { ok: false, error: r.data ? JSON.stringify(r.data) : r.text || "jscode2session failed" };
    }
    return { ok: true, openid: r.data.openid, sessionKey: r.data.session_key };
  };

  const createMpQr = async ({ scene, expireSeconds }) => {
    const t = await getAccessToken("mp");
    if (!t.ok) return t;
    const url = `https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=${encodeURIComponent(t.accessToken)}`;
    const payload = expireSeconds
      ? {
          expire_seconds: expireSeconds,
          action_name: "QR_STR_SCENE",
          action_info: { scene: { scene_str: scene } },
        }
      : { action_name: "QR_LIMIT_STR_SCENE", action_info: { scene: { scene_str: scene } } };

    const r = await fetchJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok || !r.data || r.data.errcode) {
      return { ok: false, error: r.data ? JSON.stringify(r.data) : r.text || "qrcode create failed" };
    }
    const ticket = r.data.ticket;
    if (!ticket) return { ok: false, error: "missing ticket" };

    const img = await fetchBuffer(
      `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(ticket)}`
    );
    if (!img.ok) return { ok: false, error: `qrcode download failed: ${img.status}` };
    return { ok: true, ticket, buffer: img.buffer };
  };

  const createWxaCodeUnlimit = async ({ sceneId, page, envVersion }) => {
    const t = await getAccessToken("mini");
    if (!t.ok) return t;
    const url = `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(
      t.accessToken
    )}`;
    const r = await fetchBuffer(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scene: sceneId,
        page: page || undefined,
        env_version: envVersion || undefined,
      }),
    });
    if (!r.ok) return { ok: false, error: `wxacode fetch failed: ${r.status}` };

    const maybeJson = r.buffer.toString("utf8");
    if (maybeJson.startsWith("{")) {
      try {
        const data = JSON.parse(maybeJson);
        if (data && data.errcode) return { ok: false, error: JSON.stringify(data) };
      } catch (_) {}
    }
    return { ok: true, buffer: r.buffer };
  };

  const createWxaShortLink = async ({ pageUrl }) => {
    const t = await getAccessToken("mini");
    if (!t.ok) return t;
    const url = `https://api.weixin.qq.com/wxa/genwxashortlink?access_token=${encodeURIComponent(t.accessToken)}`;
    const r = await fetchJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page_url: pageUrl }),
    });
    if (!r.ok || !r.data || r.data.errcode) {
      return { ok: false, error: r.data ? JSON.stringify(r.data) : r.text || "shortlink create failed" };
    }
    const link = r.data.link || "";
    if (!link) return { ok: false, error: "missing short link" };
    return { ok: true, link };
  };

  const sendMpText = async ({ toUser, content }) => {
    const t = await getAccessToken("mp");
    if (!t.ok) return t;
    const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(t.accessToken)}`;
    const r = await fetchJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ touser: toUser, msgtype: "text", text: { content } }),
    });
    if (!r.ok || !r.data || r.data.errcode) {
      return { ok: false, error: r.data ? JSON.stringify(r.data) : r.text || "send text failed" };
    }
    return { ok: true };
  };

  const sendMpMiniProgramPage = async ({ toUser, title, appid, pagepath }) => {
    const t = await getAccessToken("mp");
    if (!t.ok) return t;
    const thumbMediaId = "xJa5uiBR3ShYNhagMMh7jRFZVAQQPrG6S4jXkmFFWkijr9bWpPAl1PGQp-72m7_l";
    const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(t.accessToken)}`;
    const r = await fetchJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        touser: toUser,
        msgtype: "miniprogrampage",
        miniprogrampage: { title, appid, pagepath, thumb_media_id: thumbMediaId },
      }),
    });
    if (!r.ok || !r.data || r.data.errcode) {
      return { ok: false, error: r.data ? JSON.stringify(r.data) : r.text || "send miniprogrampage failed" };
    }
    return { ok: true };
  };

  const listMpMaterials = async ({ type, offset, count }) => {
    const t = await getAccessToken("mp");
    if (!t.ok) return t;
    const materialType = String(type || "image");
    if (!["image", "video", "voice", "news"].includes(materialType)) {
      return { ok: false, error: "invalid type" };
    }
    const materialOffset = Math.max(0, Number.parseInt(String(offset || "0"), 10) || 0);
    const materialCountRaw = Number.parseInt(String(count || "20"), 10) || 20;
    const materialCount = Math.min(20, Math.max(1, materialCountRaw));

    const url = `https://api.weixin.qq.com/cgi-bin/material/batchget_material?access_token=${encodeURIComponent(
      t.accessToken
    )}`;
    const r = await fetchJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: materialType, offset: materialOffset, count: materialCount }),
    });
    if (!r.ok || !r.data || r.data.errcode) {
      return { ok: false, error: r.data ? JSON.stringify(r.data) : r.text || "list materials failed" };
    }

    const items = Array.isArray(r.data.item) ? r.data.item : [];
    const normalizedItems = items.map((it) => ({
      mediaId: it.media_id || "",
      name: it.name || "",
      url: it.url || "",
      updateTime: it.update_time || 0,
    }));

    return {
      ok: true,
      type: materialType,
      offset: materialOffset,
      count: materialCount,
      totalCount: r.data.total_count || 0,
      itemCount: r.data.item_count || 0,
      items: normalizedItems,
    };
  };

  const getMpUserInfo = async ({ openid, lang }) => {
    const t = await getAccessToken("mp");
    if (!t.ok) return t;
    const id = String(openid || "").trim();
    if (!id) return { ok: false, error: "missing openid" };
    const language = String(lang || "zh_CN").trim() || "zh_CN";
    const url = `https://api.weixin.qq.com/cgi-bin/user/info?access_token=${encodeURIComponent(
      t.accessToken
    )}&openid=${encodeURIComponent(id)}&lang=${encodeURIComponent(language)}`;
    const r = await fetchJson(url);
    if (!r.ok || !r.data || r.data.errcode) {
      return { ok: false, error: r.data ? JSON.stringify(r.data) : r.text || "get user info failed" };
    }
    return { ok: true, user: r.data };
  };

  const sendMpTemplate = async ({ toUser, templateId, data, miniProgram }) => {
    const t = await getAccessToken("mp");
    if (!t.ok) return t;
    const url = `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${encodeURIComponent(
      t.accessToken
    )}`;
    const payload = {
      touser: toUser,
      template_id: templateId,
      data,
      miniprogram: miniProgram || undefined,
    };
    const r = await fetchJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok || !r.data || r.data.errcode) {
      return { ok: false, error: r.data ? JSON.stringify(r.data) : r.text || "send template failed" };
    }
    return { ok: true };
  };

  return {
    getAccessToken,
    jscode2session,
    createMpQr,
    createWxaCodeUnlimit,
    createWxaShortLink,
    sendMpText,
    sendMpMiniProgramPage,
    listMpMaterials,
    getMpUserInfo,
    sendMpTemplate,
  };
};

module.exports = { createWeChatClient };
