const assert = require("assert");
const test = require("node:test");

const {
  buildSystemContext,
  handleAiCompanionChat,
  normalizeInput,
  resolveUserKey,
} = require("../lib/aiCompanion");

const createFakeDb = () => {
  const stores = new Map();
  const getStore = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  return {
    collection(name) {
      const store = getStore(name);
      return {
        findOne: async (query) => store.get(String(query && query._id)) || null,
        updateOne: async (filter, update, options) => {
          const id = String(filter && filter._id);
          const existed = store.has(id);
          const oldDoc = existed ? store.get(id) : {};
          const setOnInsert = !existed && update && update.$setOnInsert ? update.$setOnInsert : {};
          const set = update && update.$set ? update.$set : {};
          store.set(id, { ...oldDoc, ...setOnInsert, ...set, _id: id });
          return { matchedCount: existed ? 1 : 0, modifiedCount: 1, upsertedId: options && options.upsert && !existed ? id : null };
        },
      };
    },
    dump(name) {
      return [...getStore(name).values()];
    },
  };
};

test("normalizeInput uses phone number as stable memory key", () => {
  const input = normalizeInput({
    conversation_id: "conv-1",
    phone_number: "+8613800000000",
    messages: [{ role: "user", content: "我今天很累" }],
  });
  assert.equal(input.phoneNumber, "13800000000");
  assert.equal(resolveUserKey(input), "phone:13800000000");
});

test("buildSystemContext carries Imfine persona and memory", () => {
  const context = buildSystemContext({ summary: "近期状态：疲惫\n偏好：喜欢直接一点" });
  assert.match(context, /无恙每日/);
  assert.match(context, /无恙陪伴员/);
  assert.match(context, /近期状态：疲惫/);
});

test("handleAiCompanionChat injects memory context and stores new memory", async () => {
  const db = createFakeDb();
  let upstreamBody = null;
  const fetchImpl = async (url, options) => {
    assert.equal(url, "http://127.0.0.1:3100/internal/company/ai/chat");
    assert.equal(options.headers["x-internal-token"], "internal-token");
    upstreamBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          conversation_id: "conv-1",
          reply: "我在。先喝口水，慢慢说最累的点。",
          model: { role: "planner", model_name: "doubao-seed-2.0-pro" },
        }),
    };
  };

  const result = await handleAiCompanionChat({
    body: {
      conversation_id: "conv-1",
      phone_number: "13800000000",
      messages: [{ role: "user", content: "我今天很累，我喜欢你直接一点" }],
    },
    getDb: async () => db,
    getEnv: (name) => (name === "INTERNAL_JOB_TOKEN" ? "internal-token" : ""),
    nowIso: () => "2026-05-17T12:00:00.000+08:00",
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.memory.user_key, "phone:13800000000");
  assert.match(upstreamBody.system_context, /无恙陪伴员/);
  assert.match(upstreamBody.system_context, /暂无稳定记忆/);

  const docs = db.dump("wy_ai_companion_memories");
  assert.equal(docs.length, 1);
  assert.match(docs[0].summary, /疲惫/);
  assert.match(docs[0].summary, /喜欢你直接一点/);
});

test("handleAiCompanionChat does not turn memory questions into preferences", async () => {
  const db = createFakeDb();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, conversation_id: "conv-2", reply: "记得，你喜欢直接一点。" }),
  });

  await handleAiCompanionChat({
    body: {
      conversation_id: "conv-2",
      phone_number: "13800000001",
      messages: [{ role: "user", content: "你记得我刚才说我喜欢怎样的回复吗？" }],
    },
    getDb: async () => db,
    getEnv: (name) => (name === "INTERNAL_JOB_TOKEN" ? "internal-token" : ""),
    nowIso: () => "2026-05-17T12:00:00.000+08:00",
    fetchImpl,
  });

  const docs = db.dump("wy_ai_companion_memories");
  assert.equal(docs.length, 1);
  assert.deepEqual(docs[0].profile.preferences || [], []);
});
