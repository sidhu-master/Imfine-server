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

### 生成邀请公众号二维码

`POST /api/notifyGuardian/createInviteMpQr`

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
  "scene": "wy_i_...",
  "imageUrl": "二维码图片URL"
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
  "imageUrl": "二维码图片URL"
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

## 公众号回调

### URL

`GET/POST /mp/callback`

用于公众号“服务器配置”验证与事件回调。
