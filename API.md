# imfine-server 接口文档（小程序对接）

Base URL：`https://api.sidhu.net.cn`

## 鉴权

### 登录换取业务 Token

`POST /api/wxLogin`

用小程序 `wx.login()` 得到的 `code` 换取服务端 JWT（后续接口都用这个 JWT）。

请求：

```json
{
  "code": "wx.login 返回的 code"
}
```

响应（成功）：

```json
{
  "ok": true,
  "openid": "用户 openid",
  "token": "JWT 字符串"
}
```

响应（失败示例）：

```json
{
  "ok": false,
  "error": "错误描述（可能包含微信 errcode/errmsg）"
}
```

### Authorization 头

需要登录态的接口统一使用：

`Authorization: Bearer <token>`

## 用户信息

### 获取用户资料

`GET /api/userProfile`

响应：

```json
{
  "ok": true,
  "userId": "用户 openid",
  "profile": {
    "familyName": "王",
    "gender": "female",
    "age": 66,
    "avatarUrl": "头像URL"
  },
  "rule": {
    "deadline": "22:30",
    "graceMinutes": 1440
  },
  "guardians": [
    { "id": "守护人 openid", "nickname": "昵称", "avatarUrl": "头像URL", "acceptedAt": 1760000000000 }
  ]
}
```

如果尚未保存过资料，会返回空值：

```json
{
  "ok": true,
  "userId": "用户 openid",
  "profile": {
    "familyName": "",
    "gender": "",
    "age": null,
    "avatarUrl": ""
  },
  "rule": {
    "deadline": "22:30",
    "graceMinutes": 1440
  },
  "guardians": []
}
```

### 保存/更新用户资料

`POST /api/userProfile`

说明：

- 仅更新请求里带的字段（支持部分更新）
- `gender` 取值：`male` / `female`（也兼容 `男`/`女`、`M`/`F`、`1`/`2`）
- `age`：0~150 的整数

请求示例：

```json
{
  "familyName": "王",
  "gender": "女",
  "age": 66
}
```

响应（成功）：

```json
{
  "ok": true,
  "userId": "用户 openid",
  "profile": {
    "familyName": "王",
    "gender": "female",
    "age": 66,
    "avatarUrl": "头像URL"
  },
  "guardians": [
    { "id": "守护人 openid", "nickname": "昵称", "avatarUrl": "头像URL", "acceptedAt": 1760000000000 }
  ]
}
```

### 更新用户头像

`POST /api/userAvatar`

请求：

```json
{
  "avatarBase64": "可选，头像 base64（wx.getFileSystemManager().readFile 读到的 base64，或 data:image/...;base64,...）",
  "avatarUrl": "可选，头像 URL（http/https，传空字符串表示清空；和 avatarBase64 二选一）"
}
```

响应：

```json
{
  "ok": true,
  "userId": "用户 openid",
  "avatarUrl": "头像URL"
}
```

## 打卡

### 查询今天是否打卡

`GET /api/todayStatus`

响应：

```json
{
  "checkedIn": true,
  "dateKey": "YYYY-MM-DD",
  "timeText": "HH:mm"
}
```

未打卡时：

```json
{
  "checkedIn": false,
  "dateKey": "YYYY-MM-DD"
}
```

### 执行打卡

`POST /api/checkin`

响应：

```json
{
  "checkedIn": true,
  "dateKey": "YYYY-MM-DD",
  "timeText": "HH:mm"
}
```

## 守护人邀请/绑定（需要 COS 配置才会返回可访问图片）

imageUrl 说明：

- 优先返回 COS 的公开 HTTPS 地址（需要配置 COS_* 环境变量）
- 未配置 COS 时，会把图片存到 Mongo（`wy_files`）并返回 `${PUBLIC_BASE_URL}/__db_files/...`（需要配置 PUBLIC_BASE_URL 为已备案的 HTTPS 域名，并在小程序后台把该域名加入 downloadFile 合法域名）

### 生成邀请小程序码

`POST /api/notifyGuardian/createInviteWxaCode`

请求：

```json
{
  "inviterId": "邀请人ID（业务侧自定义）",
  "inviterName": "邀请人昵称",
  "env_version": "可选，develop | trial | release"
}
```

响应：

```json
{
  "ok": true,
  "sceneId": "wy_i_...",
  "imageUrl": "二维码/小程序码图片URL"
}
```

### 生成绑定公众号二维码

`POST /api/notifyGuardian/createBindQr`

请求：

```json
{
  "inviterId": "邀请人ID（业务侧自定义）",
  "inviterName": "邀请人昵称"
}
```

响应：

```json
{
  "ok": true,
  "scene": "wy_b_...",
  "imageUrl": "二维码图片URL",
  "cardUrl": "小程序短链URL"
}
```

### 解析邀请场景

`GET /api/notifyGuardian/resolveInviteScene?sceneId=wy_i_...`

响应：

```json
{
  "ok": true,
  "sceneId": "wy_i_...",
  "inviterId": "邀请人ID",
  "inviterName": "邀请人昵称",
  "inviterOpenid": "邀请人 openid",
  "expireAt": 1760000000000,
  "isExpired": false
}
```

### 接受邀请

`POST /api/notifyGuardian/acceptInvite`

请求：

```json
{
  "code": "wx.login() 返回的 code",
  "sceneId": "可选，扫码落地页携带的 scene（如 wy_i_...）",
  "inviterId": "可选兜底（无 sceneId 时使用）",
  "inviterName": "可选兜底（无 sceneId 时使用）",
  "inviteeName": "可选，被邀请人昵称",
  "inviteeAvatarBase64": "可选，被邀请人头像 base64（wx.getFileSystemManager().readFile 读到的 base64，或 data:image/...;base64,...）",
  "inviteeAvatarUrl": "可选，被邀请人头像 URL（http/https，和 inviteeAvatarBase64 二选一）",
  "channel": "可选，mini_landing",
  "env_version": "可选，develop | trial | release"
}
```

响应（成功）：

```json
{
  "ok": true,
  "relationId": "relation key",
  "alreadyAccepted": false,
  "acceptedAt": 1760000000000,
  "openid": "被邀请人 openid",
  "token": "JWT"
}
```

响应（失败示例）：

```json
{
  "ok": false,
  "error": "scene expired",
  "code": "SCENE_EXPIRED"
}
```

### 移除守护人

`POST /api/notifyGuardian/removeGuardian`

说明：从“我的守护人”中解绑/移除指定守护人。

请求：

```json
{
  "guardianOpenid": "要移除的守护人 openid（即 userProfile.guardians[i].id）"
}
```

响应：

```json
{
  "ok": true,
  "removedCount": 1
}
```

### 设置提醒规则

`POST /api/notifyGuardian/setRule`

说明：规则数据会保存到 `wy_users`（不再单独使用 `wy_user_rules`）。

请求：

```json
{
  "deadline": "HH:mm",
  "graceMinutes": 15
}
```

响应：

```json
{
  "ok": true
}
```

## App 版本管理

### 管理后台网址

- 正式访问地址：`https://sidhu.net.cn/app-release/manage`
- 本地/直连地址：`/app-release/manage`（兼容 `/appRelease/manage`）

### 获取版本信息

`GET /api/appRelease/version`

获取当前 App 版本信息，可用于检查更新和控制版本是否可用。

可选参数（建议客户端传）：

- Query：`versionCode=<当前客户端版本号>`
- 或 Header：`x-app-version-code: <当前客户端版本号>`

响应：

```json
{
  "versionName": "1.2.1",
  "versionCode": 9,
  "updateLog": "操作步数增至100\n无障碍切至内置shizuk授权",
  "downloadUrl": "https://dl.sidhu.net.cn/releases/app-release.apk",
  "downloadUrls": [
    { "name": "线路1", "url": "https://github.com/sidhu-master/AndroidAutoGLM/releases/download/v1.2.1/app-release.apk" },
    { "name": "线路2", "url": "https://dl.sidhu.net.cn/releases/app-release.apk" }
  ],
  "releasePage": "https://sidhu.net.cn/download.html",
  "releaseDate": "2026-03-14 15:07:36",
  "status": "active",
  "minVersionCode": null,
  "forceUpdate": false,
  "canUse": true,
  "inactiveMessage": "当前版本已停用，请更新至最新版本"
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `versionName` | string | 版本名称，如 "1.2.1" |
| `versionCode` | number | 版本号整数，如 9 |
| `updateLog` | string | 更新日志，支持 `\n` 换行 |
| `downloadUrl` | string | APK 下载地址 |
| `downloadUrls` | array | 多线路下载列表，每个元素含 `name` 和 `url` |
| `releasePage` | string | 版本发布页面链接 |
| `releaseDate` | string | 发布时间，格式 `YYYY-MM-DD HH:mm:ss` |
| `status` | string | 版本状态：`active`(正常)、`inactive`(停用)、`deprecated`(废弃) |
| `minVersionCode` | number \| null | 最低支持版本号，低于此版本号的客户端会被强制更新或停用 |
| `forceUpdate` | boolean | 是否强制更新，true 时客户端无法跳过更新 |
| `canUse` | boolean | 服务端综合判定该客户端版本是否可继续使用 |
| `inactiveMessage` | string | 当版本被停用时，提示用户的消息 |

### 客户端使用建议

1. **检查版本状态**：客户端获取版本信息后，先检查 `status` 字段：
   - `active`：正常可用
   - `inactive` 或 `deprecated`：显示 `inactiveMessage` 提示用户更新

2. **最低版本控制**：如果 `minVersionCode` 不为 null，比较客户端当前 `versionCode` 与该值：
   - 如果客户端 versionCode < minVersionCode：强制更新

3. **可用性判断**：直接根据 `canUse` 做拦截，`false` 时提示 `inactiveMessage` 并阻止继续使用

4. **强制更新**：在 `canUse=true` 的前提下，根据 `forceUpdate` 决定是否允许用户跳过更新弹窗

### 更新版本配置（内部接口）

`POST /internal/appRelease/version`

说明：只更新 `version.json`，不上传 APK 文件。适合在管理后台调节 `status`、`minVersionCode`、`forceUpdate` 等开关。

请求 Header：

```
Content-Type: application/json
x-internal-token: <INTERNAL_JOB_TOKEN>
```

请求体示例：

```json
{
  "versionName": "1.2.1",
  "versionCode": 9,
  "updateLog": "本次更新内容",
  "downloadUrl": "https://dl.sidhu.net.cn/releases/app-release.apk",
  "releasePage": "https://sidhu.net.cn/download.html",
  "releaseDate": "2026-03-14 15:07:36",
  "status": "inactive",
  "minVersionCode": 8,
  "forceUpdate": true,
  "disabledVersionCodes": [6, 7],
  "inactiveMessage": "该版本已停用，请升级到最新版",
  "downloadUrls": [
    { "name": "线路1", "url": "https://github.com/sidhu-master/AndroidAutoGLM/releases/download/v1.2.1/app-release.apk" },
    { "name": "线路2", "url": "https://dl.sidhu.net.cn/releases/app-release.apk" }
  ]
}
```

响应：

```json
{
  "ok": true,
  "version": { ... }
}
```

### 读取版本配置（内部接口）

`GET /internal/appRelease/version`

说明：返回完整版本配置（包含 `disabledVersionCodes`），供管理后台加载编辑。

请求 Header：

```
x-internal-token: <INTERNAL_JOB_TOKEN>
```

### 上传新版本（内部接口）

`POST /internal/appRelease/upload`

通过 HTTP Body 直接上传 APK 文件，版本信息通过 `X-App-Version` Header 传递（Base64 编码的 JSON）。

请求 Header：

```
Content-Type: application/octet-stream
X-App-Version: <base64 encoded json>
```

请求 Body：APK 文件二进制内容

X-App-Version JSON 示例：

```json
{
  "versionName": "1.2.1",
  "versionCode": 9,
  "updateLog": "操作步数增至100\n无障碍切至内置shizuk授权",
  "downloadUrl": "https://dl.sidhu.net.cn/releases/app-release.apk",
  "releasePage": "https://sidhu.net.cn/download.html",
  "status": "active",
  "minVersionCode": 5,
  "forceUpdate": false,
  "disabledVersionCodes": [3, 4],
  "inactiveMessage": "当前版本已停用，请更新至最新版本"
}
```

响应：

```json
{
  "ok": true,
  "size": 12345678,
  "version": { ... }
}
```

## AI 陪伴

### 小程序入口

小程序仍调用公司公众号 gateway 的公开地址：

`POST https://api.sidhu.net.cn/mp/ai/companion`

gateway 会转发到 Imfine 后端内部接口。无恙每日的人设、记忆系统、上下文组装属于 Imfine 后端；模型调度和密钥属于公司层。

### 内部接口

`POST /internal/ai/companion`

请求 Header：

```
Content-Type: application/json
x-internal-token: <INTERNAL_JOB_TOKEN>
```

请求体示例：

```json
{
  "conversation_id": "conv-1",
  "phone_number": "13800000000",
  "openid": "mini-openid",
  "mp_openid": "mp-openid",
  "messages": [
    { "role": "user", "content": "我今天有点累，陪我聊一句就好" }
  ]
}
```

记忆键优先级：

1. `phone_number`
2. `openid`
3. `mp_openid`
4. `conversation_id`

响应示例：

```json
{
  "ok": true,
  "conversation_id": "conv-1",
  "reply": "我在。先喝口水，慢慢说最累的那个点。",
  "product": "imfine",
  "model": {
    "role": "planner",
    "model_name": "doubao-seed-2.0-pro",
    "provider": "openai_compatible"
  },
  "usage": null,
  "memory": {
    "user_key": "phone:13800000000",
    "summary": "近期状态：疲惫",
    "recent_mood": "疲惫",
    "updated": true
  },
  "created_at": "2026-05-17T12:00:00.000+08:00"
}
```

人设定位：

- 名称：无恙陪伴员
- 产品语境：日常报平安、家人守护、轻量自我照顾
- 回复风格：温和、松弛、具体，默认 1-3 句
- 任务边界：陪聊、整理想法、给小步建议；不做医疗、法律、金融诊断
- 记忆原则：只记偏好、常聊主题、近期状态和重要关系线索；不保存密码、验证码、银行卡、身份证、私钥、API key 等敏感信息

## 公众号回调

### URL

`GET/POST /mp/callback`

用于公众号“服务器配置”验证与事件回调。
