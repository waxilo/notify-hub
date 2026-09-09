# Notify Hub

一个「通知消息」中转站：提供一个**全局的、GET/POST 通用的 webhook 接口**，把任意来源的消息路由到你的设备。

- **Web 端（Cloudflare Pages）**：只做配置 —— 注册/登录、生成与管理 Webhook Key、修改密码、查看配置。
- **安卓端（App）**：做配置 + **通知收件箱**（定时轮询拉取并展示）。
- **后端（Cloudflare Worker + D1）**：账号体系（JWT）、Key 路由、通用 webhook、通知存储。

> 推送策略：MVP 采用**轮询兜底**（端侧定时拉 `/api/notifications`），后续可无缝接入 Web Push(VAPID) 与安卓 FCM，无需改动 webhook 入口。

---

## 架构

```
                         ┌──────────────────────────┐
   任意来源 (脚本/CI/监控)  │  GET/POST /hook/:key      │
   curl / 程序 / 定时器 ──▶ │  Cloudflare Worker        │
                         │  - 校验 key → 定位用户     │
                         │  - 写入 notifications(D1)  │
                         └────────────┬─────────────┘
                                      │ D1 (SQLite)
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                        ▼
      Web 控制台(Pages)        安卓 App(轮询)            其他客户端
      仅配置/管理 key          拉取通知收件箱            (同一套 API)
```

## 目录

```
notify-hub/
├── worker/      # Cloudflare Worker 后端 + D1 schema
│   ├── src/     # index.js(路由) auth.js keys.js notifications.js webhook.js utils.js
│   ├── migrations/0001_init.sql
│   └── wrangler.toml
├── pages/       # Cloudflare Pages 静态控制台（仅配置，无构建）
│   ├── index.html  styles.css  src/{config,api,app}.js
│   └── wrangler.toml
└── android/     # 安卓 App 脚手架（Kotlin）
    └── app/     # Retrofit + 协程 + 轮询，需 Android Studio 编译
```

---

## 一、部署后端（Worker + D1）

### 1. 准备
```bash
npm install -g wrangler
wrangler login
cd notify-hub/worker
```

### 2. 创建 D1 数据库，拿到 database_id 填入 `wrangler.toml`
```bash
wrangler d1 create notify-hub
# 把输出的 id 填到 wrangler.toml 的 database_id
```

### 3. 设置 JWT 密钥（务必用 secret，不要写进文件）
```bash
wrangler secret put JWT_SECRET
# 输入任意随机长字符串，例如：openssl rand -hex 32
```

### 4. 初始化表
```bash
wrangler d1 execute notify-hub --file=./migrations/0001_init.sql
# 本地调试：加 --local
```

### 5. 部署
```bash
wrangler deploy
# 记下你的 Worker 地址，例如 https://notify-hub-worker.<sub>.workers.dev
```

本地调试：`wrangler dev`（会自动用本地 D1，需先 `migrate:local`）。

---

## 二、部署 Web 控制台（Pages）

1. 编辑 `pages/src/config.js`，把 `API_BASE` 改成你的 Worker 地址。
2. 部署：
   ```bash
   cd notify-hub/pages
   wrangler pages deploy .
   ```
   或在 Cloudflare Pages 控制台连接仓库、构建输出目录设为 `pages/`、无需构建命令。

Web 控制台只做配置：**注册/登录 → 生成 Key（页面会给出完整 key 与 webhook 地址）→ 吊销 Key → 修改密码**。

---

## 三、安卓 App

1. 用 **Android Studio** 打开 `android/` 目录（会生成 Gradle wrapper）。
2. 首次进入 App 的「设置」页，填入 Worker 地址（`API_BASE`）与轮询间隔（秒）。
3. 登录/注册后，通知收件箱会自动轮询拉取。
4. 点击某条通知可标记已读。

> 此目录为**可编译脚手架**，本环境无 Android SDK，未做编译验证，请在你本地 Android Studio 中构建。

---

## API 参考

所有路径前缀 `/api`，除 webhook 外均需 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| POST | `/api/register` | 注册 `{username,password}` → `{token}` | 否 |
| POST | `/api/login` | 登录 `{username,password}` → `{token}` | 否 |
| POST | `/api/password` | 改密 `{oldPassword,newPassword}` | 是 |
| POST | `/api/keys` | 生成 key `{name}` → `{id,key}` | 是 |
| GET  | `/api/keys` | 列出我的 key（掩码） | 是 |
| DELETE | `/api/keys/:id` | 吊销 key | 是 |
| GET  | `/api/notifications?limit=50` | 拉取通知 | 是 |
| POST | `/api/notifications/:id/read` | 标记已读 | 是 |
| DELETE | `/api/notifications/:id` | 删除通知 | 是 |
| GET/POST | `/hook/:key` | **通用 webhook**（无需鉴权） | 否 |

### Webhook 用法示例

```bash
# GET
curl "https://notify-hub-worker.<sub>.workers.dev/hook/<KEY>?title=CPU告警&body=负载90%"

# POST JSON
curl -X POST "https://notify-hub-worker.<sub>.workers.dev/hook/<KEY>" \
  -H "Content-Type: application/json" \
  -d '{"title":"部署完成","body":"v1.2.0 已上线"}'

# POST 表单 / 纯文本同样支持，body 取 message/body/text 字段
```

---

## 安全说明

- 密码使用 **PBKDF2-HMAC-SHA256（10 万次）** 加盐哈希，无解密风险。
- JWT 用 HS256 + `JWT_SECRET` 签名，过期时间建议在 `auth.js` 的 payload 中加 `exp`。
- Webhook key 等同于「写通知的凭证」，请当密钥保管；列表接口只返回掩码，完整 key 仅在生成时展示一次。
- 当前 CORS 为 `*` 便于联调；生产建议把 `utils.js` / `index.js` 中的 `Access-Control-Allow-Origin` 改为你的 Pages 域名。
