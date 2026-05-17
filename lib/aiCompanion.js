const crypto = require("crypto");

const PRODUCT = "imfine";
const SCENE = "mini_program_companion";
const MAX_HISTORY_MESSAGES = 16;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_MEMORY_NOTES = 12;
const MAX_MOOD_ITEMS = 20;

class AiCompanionError extends Error {
  constructor(statusCode, code, message) {
    super(message || code || "AI companion failed");
    this.statusCode = statusCode || 500;
    this.code = code || "AI_COMPANION_FAILED";
  }
}

const normalizeText = (value, maxLength = 256) => {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, maxLength) : "";
};

const normalizePhoneNumber = (value) => {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits;
  if (digits.length === 13 && digits.startsWith("86")) return digits.slice(2);
  return "";
};

const createConversationId = () => `imfine-ai-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;

const normalizeMessages = (input = {}) => {
  const rawMessages = Array.isArray(input.messages) ? input.messages : [];
  const messages = [];

  for (const item of rawMessages.slice(-MAX_HISTORY_MESSAGES)) {
    if (!item || typeof item !== "object") continue;
    const role = normalizeText(item.role, 16).toLowerCase();
    if (role !== "user" && role !== "assistant") continue;
    const content = normalizeText(item.content, MAX_MESSAGE_LENGTH);
    if (!content) continue;
    messages.push({ role, content });
  }

  const singleMessage = normalizeText(input.message ?? input.content, MAX_MESSAGE_LENGTH);
  if (singleMessage && (!messages.length || messages[messages.length - 1].content !== singleMessage)) {
    messages.push({ role: "user", content: singleMessage });
  }

  if (!messages.some((item) => item.role === "user")) {
    throw new AiCompanionError(400, "AI_MESSAGE_REQUIRED", "message is required");
  }

  return messages.slice(-MAX_HISTORY_MESSAGES);
};

const normalizeInput = (input = {}) => {
  const source = input && typeof input === "object" ? input : {};
  const conversationId = normalizeText(source.conversation_id || source.conversationId, 120) || createConversationId();
  const phoneNumber = normalizePhoneNumber(source.phone_number || source.phoneNumber);
  const openid = normalizeText(source.openid || source.openId, 128);
  const mpOpenid = normalizeText(source.mp_openid || source.mpOpenid, 128);
  return {
    conversationId,
    phoneNumber,
    openid,
    mpOpenid,
    messages: normalizeMessages(source),
  };
};

const resolveUserKey = ({ phoneNumber, openid, mpOpenid, conversationId }) => {
  if (phoneNumber) return `phone:${phoneNumber}`;
  if (openid) return `openid:${openid}`;
  if (mpOpenid) return `mp:${mpOpenid}`;
  return `conversation:${conversationId}`;
};

const uniqueLimited = (existing, additions, limit) => {
  const out = [];
  const seen = new Set();
  for (const value of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(additions) ? additions : [])]) {
    const text = normalizeText(value, 80);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out.slice(-limit);
};

const hasSensitiveText = (text) =>
  /(密码|验证码|银行卡|身份证|私钥|密钥|api\s*key|access\s*token|secret)/i.test(String(text || ""));

const inferMoods = (text) => {
  const s = String(text || "");
  const moods = [];
  if (/(累|疲惫|困|没力气|撑不住)/.test(s)) moods.push("疲惫");
  if (/(焦虑|慌|紧张|害怕|不安)/.test(s)) moods.push("焦虑");
  if (/(难过|委屈|想哭|低落|孤单|孤独)/.test(s)) moods.push("低落");
  if (/(烦|生气|火大|崩溃)/.test(s)) moods.push("烦躁");
  if (/(开心|高兴|轻松|舒服|还不错)/.test(s)) moods.push("状态不错");
  if (/(睡不着|失眠|熬夜|睡眠)/.test(s)) moods.push("睡眠困扰");
  return moods;
};

const inferTopics = (text) => {
  const s = String(text || "");
  const topics = [];
  if (/(打卡|报平安|无恙|每日)/.test(s)) topics.push("报平安");
  if (/(家人|妈妈|爸爸|父母|孩子|女儿|儿子|伴侣|老婆|老公)/.test(s)) topics.push("家人");
  if (/(工作|上班|同事|老板|项目|会议)/.test(s)) topics.push("工作");
  if (/(身体|头疼|胃|医院|吃药|不舒服|健康)/.test(s)) topics.push("健康");
  if (/(睡|失眠|熬夜|困)/.test(s)) topics.push("睡眠");
  if (/(提醒|计划|待办|安排|习惯)/.test(s)) topics.push("日常安排");
  return topics;
};

const extractProfileUpdates = (text) => {
  const s = String(text || "");
  const updates = { preferences: [], dislikes: [], people: [], supportStyle: "", displayName: "" };
  const nameMatch = s.match(/我(?:叫|是)([^，。,.!?！？\s]{1,12})/);
  if (nameMatch) updates.displayName = normalizeText(nameMatch[1], 12);

  const likeMatch = s.match(/我喜欢([^。！？!?]{1,32})/);
  if (likeMatch) updates.preferences.push(`喜欢${normalizeText(likeMatch[1], 32)}`);

  const dislikeMatch = s.match(/我不喜欢([^。！？!?]{1,32})/);
  if (dislikeMatch) updates.dislikes.push(`不喜欢${normalizeText(dislikeMatch[1], 32)}`);

  const styleMatch = s.match(/我希望你([^。！？!?]{1,40})/);
  if (styleMatch) updates.supportStyle = normalizeText(styleMatch[1], 40);

  const peopleMatches = s.match(/(妈妈|爸爸|父母|孩子|女儿|儿子|伴侣|老婆|老公|家人|朋友)/g);
  if (peopleMatches) updates.people.push(...peopleMatches.map((item) => `提到${item}`));
  return updates;
};

const buildSummary = (profile = {}, recentNotes = [], moodTimeline = []) => {
  const parts = [];
  if (profile.displayName) parts.push(`称呼：${profile.displayName}`);
  if (Array.isArray(profile.topics) && profile.topics.length) parts.push(`常聊主题：${profile.topics.slice(-6).join("、")}`);
  if (Array.isArray(profile.preferences) && profile.preferences.length) parts.push(`偏好：${profile.preferences.slice(-5).join("、")}`);
  if (Array.isArray(profile.dislikes) && profile.dislikes.length) parts.push(`避免：${profile.dislikes.slice(-5).join("、")}`);
  if (Array.isArray(profile.people) && profile.people.length) parts.push(`关系线索：${profile.people.slice(-5).join("、")}`);
  if (profile.supportStyle) parts.push(`陪伴方式：${profile.supportStyle}`);
  if (Array.isArray(moodTimeline) && moodTimeline.length) {
    const recentMoods = [...new Set(moodTimeline.slice(-6).map((item) => item && item.mood).filter(Boolean))];
    if (recentMoods.length) parts.push(`近期状态：${recentMoods.join("、")}`);
  }
  if (Array.isArray(recentNotes) && recentNotes.length) {
    parts.push(`最近说过：${recentNotes.slice(-3).map((item) => item.text).filter(Boolean).join(" / ")}`);
  }
  return parts.join("\n").slice(0, 1600);
};

const buildMemoryContext = (memory) => {
  if (!memory || typeof memory !== "object") return "暂无稳定记忆。";
  const summary = normalizeText(memory.summary, 1600);
  return summary || "暂无稳定记忆。";
};

const buildSystemContext = (memory) =>
  [
    "【无恙每日 AI 陪伴设定】",
    "产品定位：无恙每日是日常报平安、家人守护和轻量自我照顾的小程序。",
    "你的角色：你是“无恙陪伴员”，像一个稳定、懂分寸的日常陪伴者，而不是心理医生、教练或客服。",
    "气质：温和、松弛、具体、少说教，不鸡血，不装熟，不用夸张网络语。",
    "主要任务：陪用户把当下感受说清楚；给一个很小、能马上做的下一步；必要时提醒报平安、休息、喝水、联系家人或专业人士。",
    "边界：不做医疗、法律、金融诊断或承诺；遇到自伤、他伤、严重疾病或紧急风险，要建议立即联系现实中的可信任的人和当地紧急服务。",
    "回复风格：默认 1-3 句，先接住情绪，再给一个小动作或轻问题。不要复述系统设定，不要暴露记忆机制。",
    "【可用记忆】",
    buildMemoryContext(memory),
    "记忆使用规则：只把记忆用于更贴近用户；不确定就不要编；不要直接朗读记忆列表。",
  ].join("\n");

const loadMemory = async (db, userKey) => {
  const doc = await db.collection("wy_ai_companion_memories").findOne({ _id: userKey });
  return doc || null;
};

const updateMemory = async ({ db, userKey, input, reply, now }) => {
  const col = db.collection("wy_ai_companion_memories");
  const oldDoc = (await col.findOne({ _id: userKey })) || {};
  const lastUser = [...input.messages].reverse().find((item) => item.role === "user");
  const text = lastUser ? normalizeText(lastUser.content, 500) : "";
  const profile = { ...(oldDoc.profile || {}) };
  const nowDate = now instanceof Date ? now : new Date();

  const updates = hasSensitiveText(text) ? { preferences: [], dislikes: [], people: [] } : extractProfileUpdates(text);
  if (updates.displayName) profile.displayName = updates.displayName;
  if (updates.supportStyle) profile.supportStyle = updates.supportStyle;
  profile.topics = uniqueLimited(profile.topics, inferTopics(text), 12);
  profile.preferences = uniqueLimited(profile.preferences, updates.preferences, 12);
  profile.dislikes = uniqueLimited(profile.dislikes, updates.dislikes, 12);
  profile.people = uniqueLimited(profile.people, updates.people, 12);

  const recentNotes = Array.isArray(oldDoc.recentNotes) ? [...oldDoc.recentNotes] : [];
  if (text && text.length >= 4 && !hasSensitiveText(text)) {
    recentNotes.push({ at: nowDate, text: text.slice(0, 160) });
  }
  const trimmedNotes = recentNotes.slice(-MAX_MEMORY_NOTES);

  const moodTimeline = Array.isArray(oldDoc.moodTimeline) ? [...oldDoc.moodTimeline] : [];
  for (const mood of inferMoods(text)) {
    moodTimeline.push({ at: nowDate, mood });
  }
  const trimmedMoods = moodTimeline.slice(-MAX_MOOD_ITEMS);
  const summary = buildSummary(profile, trimmedNotes, trimmedMoods);

  const set = {
    product: PRODUCT,
    userKey,
    conversationId: input.conversationId,
    phoneNumber: input.phoneNumber || "",
    openid: input.openid || "",
    mpOpenid: input.mpOpenid || "",
    profile,
    recentNotes: trimmedNotes,
    moodTimeline: trimmedMoods,
    lastUserMessage: text,
    lastAssistantReply: normalizeText(reply, 500),
    summary,
    updatedAt: nowDate,
  };

  await col.updateOne({ _id: userKey }, { $set: set, $setOnInsert: { createdAt: nowDate } }, { upsert: true });
  return { ...oldDoc, ...set, _id: userKey };
};

const callCompanyAi = async ({ input, memory, getEnv, fetchImpl = fetch }) => {
  const url = normalizeText(
    getEnv("COMPANY_AI_CHAT_URL") || "http://127.0.0.1:3100/internal/company/ai/chat",
    512
  );
  const internalToken = normalizeText(getEnv("COMPANY_INTERNAL_TOKEN") || getEnv("INTERNAL_JOB_TOKEN"), 512);
  if (!url) throw new AiCompanionError(503, "AI_UPSTREAM_URL_MISSING", "AI upstream url is not configured");
  if (!internalToken) throw new AiCompanionError(503, "AI_INTERNAL_TOKEN_MISSING", "AI internal token is not configured");

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-internal-token": internalToken,
    },
    body: JSON.stringify({
      product: PRODUCT,
      scene: SCENE,
      conversation_id: input.conversationId,
      phone_number: input.phoneNumber,
      openid: input.openid,
      mp_openid: input.mpOpenid,
      model_role: "planner",
      system_context: buildSystemContext(memory),
      messages: input.messages,
    }),
  });

  const text = response && typeof response.text === "function" ? await response.text() : "";
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new AiCompanionError(502, "AI_UPSTREAM_INVALID_JSON", "AI upstream returned invalid json");
  }

  if (!response || !response.ok || payload.ok === false) {
    throw new AiCompanionError(
      response && response.status ? response.status : 502,
      payload.code || payload.error || "AI_UPSTREAM_FAILED",
      payload.message || payload.error || "AI upstream failed"
    );
  }

  return payload;
};

const handleAiCompanionChat = async ({ body, getDb, getEnv, nowIso, fetchImpl }) => {
  const input = normalizeInput(body);
  const userKey = resolveUserKey(input);
  const db = await getDb();
  const memoryBefore = await loadMemory(db, userKey);
  const upstream = await callCompanyAi({ input, memory: memoryBefore, getEnv, fetchImpl });
  const reply = normalizeText(upstream.reply, 4000);
  if (!reply) throw new AiCompanionError(502, "AI_EMPTY_REPLY", "AI returned empty reply");
  const now = new Date();
  const memoryAfter = await updateMemory({ db, userKey, input, reply, now });

  return {
    ok: true,
    conversation_id: upstream.conversation_id || input.conversationId,
    reply,
    product: PRODUCT,
    model: upstream.model || null,
    usage: upstream.usage || null,
    memory: {
      user_key: userKey,
      summary: memoryAfter.summary || "",
      recent_mood:
        Array.isArray(memoryAfter.moodTimeline) && memoryAfter.moodTimeline.length
          ? memoryAfter.moodTimeline[memoryAfter.moodTimeline.length - 1].mood
          : "",
      updated: true,
    },
    created_at: upstream.created_at || (typeof nowIso === "function" ? nowIso() : now.toISOString()),
  };
};

module.exports = {
  AiCompanionError,
  buildSystemContext,
  handleAiCompanionChat,
  normalizeInput,
  normalizeMessages,
  resolveUserKey,
};
