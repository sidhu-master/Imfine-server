const crypto = require("crypto");
const { XMLParser } = require("fast-xml-parser");

const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");

const nowIso = (date = new Date()) => {
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

const logInfo = (data) => {
  try {
    console.log(JSON.stringify({ ts: nowIso(), ...data }));
  } catch (_) {
    console.log(String(data));
  }
};

const logError = (data) => {
  try {
    console.error(JSON.stringify({ ts: nowIso(), ...data }));
  } catch (_) {
    console.error(String(data));
  }
};

const verifyWeChatSignature = ({ token, signature, timestamp, nonce }) => {
  const sig = String(signature || "");
  const t = String(timestamp || "");
  const n = String(nonce || "");
  if (!token || !sig || !t || !n) return false;
  const arr = [token, t, n].sort();
  return sha1(arr.join("")) === sig;
};

const parseWeChatXml = (xmlText) => {
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: false,
  });
  const parsed = parser.parse(xmlText || "");
  if (!parsed || typeof parsed !== "object") return null;
  const xml = parsed.xml || parsed;
  if (!xml || typeof xml !== "object") return null;
  return xml;
};

const handleMpCallback = async ({ method, query, body, deps, meta }) => {
  const token = process.env.MP_CALLBACK_TOKEN || "";
  const reqId = crypto.randomBytes(8).toString("hex");
  const signature = (query.signature || query.msg_signature || "").toString();
  const timestamp = (query.timestamp || "").toString();
  const nonce = (query.nonce || "").toString();
  const echostr = (query.echostr || "").toString();
  const mpMiniOpenidSignSecret = process.env.MP_MINI_OPENID_SIGN_SECRET || process.env.API_JWT_SECRET || "";

  if (!verifyWeChatSignature({ token, signature, timestamp, nonce })) {
    logInfo({
      tag: "mpCallback",
      reqId,
      method,
      ok: false,
      reason: "invalid_signature",
      ip: (meta && meta.ip) || "",
      ua: (meta && meta.ua) || "",
      queryKeys: query ? Object.keys(query) : [],
    });
    return { statusCode: method === "GET" ? 200 : 401, body: "invalid signature" };
  }

  if (method === "GET") {
    logInfo({
      tag: "mpCallback",
      reqId,
      method,
      ok: true,
      action: "handshake",
      ip: (meta && meta.ip) || "",
      ua: (meta && meta.ua) || "",
    });
    return { statusCode: 200, body: echostr };
  }

  try {
    const msg = parseWeChatXml(body || "");
    if (!msg) {
      logInfo({
        tag: "mpCallback",
        reqId,
        method,
        ok: true,
        action: "parsed_empty",
        ip: (meta && meta.ip) || "",
        ua: (meta && meta.ua) || "",
      });
      return { statusCode: 200, body: "success" };
    }

    const msgType = (msg.MsgType || "").toString().toLowerCase();
    const event = (msg.Event || "").toString().toLowerCase();
    const fromUser = (msg.FromUserName || "").toString();
    const eventKey = (msg.EventKey || "").toString();
    const ticket = (msg.Ticket || "").toString();
    const content = (msg.Content || "").toString();

    if (!fromUser) {
      logInfo({
        tag: "mpCallback",
        reqId,
        method,
        ok: true,
        action: "missing_from_user",
        msgType,
        event,
      });
      return { statusCode: 200, body: "success" };
    }

    if (event === "subscribe" || event === "scan") {
      const rawScene = eventKey.startsWith("qrscene_") ? eventKey.slice("qrscene_".length) : eventKey;
      const scene = rawScene || "";
      logInfo({
        tag: "mpCallback",
        reqId,
        method,
        ok: true,
        action: "event_received",
        msgType,
        event,
        fromUser,
        eventKey,
        scene,
        hasTicket: Boolean(ticket),
        ip: (meta && meta.ip) || "",
        ua: (meta && meta.ua) || "",
      });
      if (scene.startsWith("wy_b_") && deps && deps.db && deps.wx) {
        const db = deps.db;
        const bindScenes = db.collection("wy_guardian_bind_scenes");

        const bindScene = await bindScenes.findOne({ _id: scene });
        if (bindScene && bindScene.elderOpenid) {
          const now = new Date();
          const elderOpenid = String(bindScene.elderOpenid || "");
          console.log("[wx_unionid] mp_bind_scene_loaded", { reqId, scene, elderOpenid, fromUser });

          const same = await deps.wx.isSameUserByElderAndMpOpenid({
            elderOpenid,
            mpOpenid: fromUser,
            now,
          });
          console.log("[wx_unionid] same_user_check", {
            reqId,
            scene,
            elderOpenid,
            fromUser,
            ok: Boolean(same && same.ok),
            same: Boolean(same && same.ok && same.same),
            reason: same && same.ok && same.reason ? String(same.reason) : "",
            userOpenid: same && same.ok && same.userOpenid ? String(same.userOpenid) : "",
            error: same && !same.ok && same.error ? String(same.error) : "",
          });
          if (same && same.ok && same.same) {
            logInfo({
              tag: "mpCallback",
              reqId,
              method,
              ok: true,
              action: "same_user_skip_send",
              fromUser,
              scene,
              elderOpenid,
              reason: same && same.reason ? String(same.reason) : "",
            });
            return { statusCode: 200, body: "success" };
          }

          const alreadyUsed = Boolean(bindScene.usedAt);
          const alreadySentCard = Boolean(bindScene.sendCardOk);
          const bound = Boolean(await deps.db.collection("wy_guardian_relations").findOne({ sceneType: "mp_bind", scene }));
          const shouldSendCard = !bound;

          await bindScenes.updateOne(
            { _id: scene },
            {
              $set: {
                ...(alreadyUsed ? {} : { usedAt: now }),
                lastGuardianMpOpenid: fromUser,
              },
            }
          );

          logInfo({
            tag: "mpCallback",
            reqId,
            method,
            ok: true,
            action: "bind_scene_resolved",
            fromUser,
            scene,
            elderOpenid: bindScene.elderOpenid,
            alreadyUsed,
            alreadySentCard,
            bound,
            shouldSendCard,
          });

          if (!shouldSendCard) return { statusCode: 200, body: "success" };

          const title = process.env.MP_BIND_MINIPROGRAM_CARD_TITLE || "点击进入小程序完成绑定";
          const inviterId = bindScene && bindScene.inviterId != null ? String(bindScene.inviterId) : "";
          const inviterNameRaw = bindScene && bindScene.inviterName != null ? String(bindScene.inviterName) : "";
          const inviterName = inviterNameRaw.slice(0, 20);
          const params = [];
          if (inviterId) params.push(`inviterId=${encodeURIComponent(inviterId)}`);
          if (inviterName) params.push(`inviterName=${encodeURIComponent(inviterName)}`);
          params.push(`bindScene=${encodeURIComponent(scene)}`);
          if (mpMiniOpenidSignSecret) {
            const mpTs = Date.now();
            const mpSig = crypto
              .createHmac("sha256", mpMiniOpenidSignSecret)
              .update(`${fromUser}.${scene}.${mpTs}`)
              .digest("hex");
            params.push(`mpOpenid=${encodeURIComponent(fromUser)}`);
            params.push(`mpTs=${encodeURIComponent(String(mpTs))}`);
            params.push(`mpSig=${encodeURIComponent(mpSig)}`);
          }
          const pagepath = `pages/acceptInvite/index${params.length ? `?${params.join("&")}` : ""}`;

          const r = await deps.wx.sendMpMiniProgramPage({
            toUser: fromUser,
            title,
            appid: process.env.MINIAPP_APPID || "",
            pagepath,
          });

          if (!r.ok) {
            logError({
              tag: "mpCallback",
              reqId,
              method,
              ok: false,
              action: "send_miniprogrampage_failed",
              fromUser,
              scene,
              error: r.error || "send failed",
            });
            await bindScenes.updateOne(
              { _id: scene },
              {
                $set: {
                  sendCardAt: now,
                  sendCardOk: false,
                  sendCardMode: "text_fallback",
                  sendCardErr: r.error || "send failed",
                  sendCardToMpOpenid: fromUser,
                },
              }
            );
            await deps.wx.sendMpText({
              toUser: fromUser,
              content: "请打开小程序完成绑定（如未自动跳转，请在小程序内重新操作）。",
            });
          } else {
            logInfo({
              tag: "mpCallback",
              reqId,
              method,
              ok: true,
              action: "send_miniprogrampage_ok",
              fromUser,
              scene,
            });
            await bindScenes.updateOne(
              { _id: scene },
              {
                $set: {
                  sendCardAt: now,
                  sendCardOk: true,
                  sendCardMode: "miniprogrampage",
                  sendCardErr: "",
                  sendCardToMpOpenid: fromUser,
                },
              }
            );
          }
        } else {
          logInfo({
            tag: "mpCallback",
            reqId,
            method,
            ok: true,
            action: "bind_scene_not_found_or_missing_elder",
            fromUser,
            scene,
          });
        }
      } else if (scene) {
        logInfo({
          tag: "mpCallback",
          reqId,
          method,
          ok: true,
          action: "scene_ignored",
          fromUser,
          scene,
          hasDeps: Boolean(deps && deps.db && deps.wx),
        });
      }
    } else if (msgType === "text") {
      logInfo({
        tag: "mpCallback",
        reqId,
        method,
        ok: true,
        action: "text_received",
        fromUser,
        contentPreview: content.slice(0, 200),
      });
    }
  } catch (err) {
    logError({
      tag: "mpCallback",
      reqId,
      method,
      ok: false,
      action: "exception",
      error: err && err.stack ? String(err.stack) : String(err),
    });
  }

  return { statusCode: 200, body: "success" };
};

module.exports = { handleMpCallback };
