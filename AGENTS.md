# Imfine Server AI Coding Baseline

Read this before changing Imfine backend code.

## Scope

- Product key: `imfine`
- User-facing name: `无恙每日`
- Local repo: `/Users/sidhu/server-work/Imfine-server`
- Remote repo: `https://github.com/sidhu-master/Imfine-server`
- Server workspace: `/home/ubuntu/workspace/imfine-server`
- Service: `imfine-server.service`

## Boundaries

- Imfine owns 无恙每日 product behavior, including Mini Program APIs, daily check-in/guardian logic, AI companion persona, memory, and prompt context.
- Company Official Account public `/mp/*` traffic enters through `company-wechat-gateway`.
- `POST https://api.sidhu.net.cn/mp/ai/companion` is public gateway traffic; gateway forwards it to Imfine internal `POST /internal/ai/companion`.
- Company layer owns AI model dispatch and model secrets. Imfine calls company-layer AI after building product context.
- Do not commit secrets, `.env`, event logs, local database files, access tokens, phone data, or generated backups.

## AI Companion

- Route: `POST /internal/ai/companion`
- Memory collection: `wy_ai_companion_memories`
- Memory key priority: `phone_number`, then Mini Program `openid`, then Official Account `mp_openid`, then `conversation_id`.
- The companion persona is “无恙陪伴员”: warm, grounded, concise, and focused on daily safety, family care, and small next actions.
- Never store passwords, verification codes, ID numbers, bank cards, private keys, API keys, or access tokens in memory.

## Verification

Run at least:

```bash
npm test
node --check app.js
node --check routes/internal.js
node --check lib/aiCompanion.js
git diff --check
```
