const { MongoClient } = require("mongodb");
const COS = require("cos-nodejs-sdk-v5");

const createMemoryDb = () => {
  const collections = new Map();

  const matchQuery = (doc, query) => {
    if (!query || Object.keys(query).length === 0) return true;
    for (const [k, v] of Object.entries(query)) {
      if (doc[k] !== v) return false;
    }
    return true;
  };

  const getCollectionStore = (name) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };

  const collection = (name) => {
    const store = getCollectionStore(name);
    return {
      createIndex: async () => {},
      findOne: async (query) => {
        if (query && query._id != null) return store.get(String(query._id)) || null;
        for (const doc of store.values()) {
          if (matchQuery(doc, query)) return doc;
        }
        return null;
      },
      updateOne: async (filter, update, options) => {
        const id = filter && filter._id != null ? String(filter._id) : "";
        if (!id) throw new Error("memory db requires _id filter");
        const existed = store.has(id);
        const oldDoc = existed ? store.get(id) : null;
        const set = (update && update.$set) || {};
        const setOnInsert = !existed && update && update.$setOnInsert ? update.$setOnInsert : {};
        store.set(id, { ...(oldDoc || {}), ...setOnInsert, ...set, _id: id });
        if (options && options.upsert && !existed) return { upsertedId: id, matchedCount: 0, modifiedCount: 1 };
        return { upsertedId: null, matchedCount: existed ? 1 : 0, modifiedCount: 1 };
      },
      distinct: async (field, query) => {
        const s = new Set();
        for (const doc of store.values()) {
          if (!matchQuery(doc, query)) continue;
          if (doc[field] != null) s.add(doc[field]);
        }
        return [...s];
      },
      find: (query) => {
        const docs = [];
        for (const doc of store.values()) {
          if (matchQuery(doc, query)) docs.push(doc);
        }
        const createCursor = ({ projectionKeys, limitCount }) => {
          const withLimit = (arr) => {
            if (limitCount == null) return arr;
            const n = Number(limitCount);
            if (!Number.isFinite(n) || n < 0) return arr;
            return arr.slice(0, n);
          };

          return {
            project: (projection) => {
              const keys = projection ? Object.keys(projection).filter((k) => projection[k]) : [];
              return createCursor({ projectionKeys: keys, limitCount });
            },
            limit: (n) => createCursor({ projectionKeys, limitCount: n }),
            toArray: async () => {
              const sliced = withLimit(docs);
              if (!projectionKeys || projectionKeys.length === 0) return sliced;
              return sliced.map((d) => {
                const out = {};
                for (const k of projectionKeys) out[k] = d[k];
                return out;
              });
            },
          };
        };

        return createCursor({ projectionKeys: null, limitCount: null });
      },
    };
  };

  return { collection };
};

const createStorage = ({ requireEnv, getEnv }) => {
  let mongo = null;
  let db = null;
  let cos = null;
  const devFiles = new Map();

  const getDb = async () => {
    if (db) return db;

    const uri = getEnv("MONGODB_URI");
    const dbName = getEnv("MONGODB_DBNAME");

    if (!uri || !dbName) {
      db = createMemoryDb();
      return db;
    }

    if (!mongo) mongo = new MongoClient(uri);
    await mongo.connect();
    db = mongo.db(dbName);

    await Promise.allSettled([
      db.collection("wy_checkins").createIndex({ openid: 1, dateKey: 1 }),
      db.collection("wy_kv").createIndex({ expireAt: 1 }),
      db.collection("wy_guardian_links").createIndex({ elderOpenid: 1 }),
      db.collection("wy_guardian_links").createIndex({ guardianMpOpenid: 1 }),
      db.collection("wy_users").createIndex({ openid: 1 }),
    ]);

    return db;
  };

  const getCos = () => {
    if (cos) return cos;
    cos = new COS({
      SecretId: requireEnv("COS_SECRET_ID"),
      SecretKey: requireEnv("COS_SECRET_KEY"),
    });
    return cos;
  };

  const registerDevFilesRoutes = (app) => {
    app.get(/^\/__dev_files\/(.+)$/, (req, res) => {
      const rawKey = req.params[0] || "";
      let key = rawKey;
      try {
        key = decodeURIComponent(String(rawKey));
      } catch (_) {
        key = String(rawKey);
      }
      const item = devFiles.get(key);
      if (!item) return res.status(404).type("text/plain").send("not found");
      if (item.contentType) res.set("Content-Type", item.contentType);
      return res.status(200).send(item.buffer);
    });

    const toNodeBuffer = (value) => {
      if (!value) return null;
      if (Buffer.isBuffer(value)) return value;
      if (value instanceof Uint8Array) return Buffer.from(value);
      if (typeof value === "string") return Buffer.from(value, "base64");
      if (typeof value === "object") {
        if (typeof value.value === "function") {
          try {
            const v = value.value(true);
            if (Buffer.isBuffer(v)) return v;
            if (v instanceof Uint8Array) return Buffer.from(v);
          } catch (_) {}
        }
        if (value.buffer) {
          if (Buffer.isBuffer(value.buffer)) return value.buffer;
          if (value.buffer instanceof Uint8Array) return Buffer.from(value.buffer);
        }
        if (value.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data);
      }
      return null;
    };

    app.get(/^\/__db_files\/(.+)$/, (req, res) => {
      const rawKey = req.params[0] || "";
      let key = rawKey;
      try {
        key = decodeURIComponent(String(rawKey));
      } catch (_) {
        key = String(rawKey);
      }
      getDb()
        .then((db) => db.collection("wy_files").findOne({ _id: String(key) }))
        .then((doc) => {
          if (!doc) return res.status(404).type("text/plain").send("not found");
          const contentTypeRaw = doc.contentType != null ? String(doc.contentType) : "";
          const contentType = contentTypeRaw ? contentTypeRaw.split(";")[0].trim() : "";
          const buf = toNodeBuffer(doc.buffer);
          if (contentType) res.set("Content-Type", contentType);
          if (!buf || !buf.length) return res.status(404).type("text/plain").send("not found");
          return res.status(200).send(buf);
        })
        .catch(() => res.status(500).type("text/plain").send("server error"));
    });
  };

  const uploadToCos = async ({ key, buffer, contentType }) => {
    const shouldUseDev =
      process.env.COS_DISABLE_UPLOAD === "true" ||
      !process.env.COS_SECRET_ID ||
      !process.env.COS_SECRET_KEY ||
      !process.env.COS_BUCKET ||
      !process.env.COS_REGION ||
      !process.env.COS_PUBLIC_BASE_URL;

    if (shouldUseDev) {
      const ct = contentType || "application/octet-stream";
      const now = new Date();
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
      const size = buf.length || 0;
      if (size > 3 * 1024 * 1024) throw new Error("file too large");

      const db = await getDb();
      await db.collection("wy_files").updateOne(
        { _id: String(key) },
        {
          $set: { buffer: buf, contentType: ct, size, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true }
      );

      const publicBaseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
      const encodedKey = encodeURIComponent(String(key));
      if (publicBaseUrl) return `${publicBaseUrl}/__db_files/${encodedKey}`;
      const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;
      return `http://localhost:${Number.isFinite(port) ? port : 3000}/__db_files/${encodedKey}`;
    }

    const Bucket = requireEnv("COS_BUCKET");
    const Region = requireEnv("COS_REGION");
    const baseUrl = requireEnv("COS_PUBLIC_BASE_URL").replace(/\/+$/, "");

    await new Promise((resolve, reject) => {
      getCos().putObject(
        {
          Bucket,
          Region,
          Key: key,
          Body: buffer,
          ContentType: contentType || "application/octet-stream",
        },
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });

    return `${baseUrl}/${key}`;
  };

  return { getDb, uploadToCos, registerDevFilesRoutes };
};

module.exports = { createStorage };
