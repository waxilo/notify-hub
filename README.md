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
│   │            # jobs.js(定时任务 CRUD+执行) schedule.js(预设串解析) deliver.js(投递公共函数) push.js(DO)
│   ├── migrations/0001_init.sql  0002_jobs.sql
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
# 定时任务表 + 补齐 0001 之后新增的字段（首次部署或升级必跑，重复执行会报 duplicate column，属预期）
wrangler d1 execute notify-hub --file=./migrations/0002_jobs.sql
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
   wrangler pages deploy . --project-name notify-hub-pages
   ```
   或在 `worker/` 下一键：`npm run deploy:pages`。
   也可在 Cloudflare Pages 控制台连接仓库、构建输出目录设为 `pages/`、无需构建命令。

Web 控制台只做配置：**注册/登录 → 生成 Key（页面会给出完整 key 与 webhook 地址）→ 吊销 Key → 修改密码**。

---

## 三、安卓 App

1. 用 **Android Studio** 打开 `android/` 目录（会生成 Gradle wrapper）。
2. 首次进入 App 的「设置」页，填入 Worker 地址（`API_BASE`）与轮询间隔（秒）。
3. 登录/注册后，通知收件箱会自动轮询拉取。
4. 点击某条通知可标记已读。

> 每次推送到 `main` 会由 CI 自动构建并发布 APK（见下节），无需本地 Android SDK。

---

## 四、构建新版 APK（GitHub Actions + gh）

`android/` 未提交 Gradle wrapper，本地构建需 Android Studio；走 CI 更省事。推送到 `main` 会自动触发 `.github/workflows/build-android.yml`。

版本与签名规则：

- `versionCode` = GitHub run number，`versionName` = `1.0.<run_number>`（App 端靠 `versionCode` 比对检测更新）
- 使用固定签名 `android/app/notifyhub-release.p12`，覆盖安装不会报"签名不一致"
- 构建后覆盖发布到 tag `latest` 的 Release，下载地址固定为
  `https://github.com/waxilo/notify-hub/releases/latest/download/<asset>.apk`
- Worker 的 `/api/app/latest` 从 Release body 解析 `VERSION_CODE` / `VERSION_NAME`，仓库私有故由 Worker 用 `GITHUB_TOKEN` 代理下载

常用命令（`gh` 安装：`winget install GitHub.cli`，首次 `gh auth login`）：

```bash
gh workflow run build-android.yml                     # 不改代码也可手动构建
gh run list --workflow=build-android.yml --limit 5    # 查看构建历史
gh run watch                                          # 实时跟踪当前构建
gh run view --log-failed                              # 失败时看日志
gh release view latest --json name,assets             # 确认 APK 已发布
gh release download latest -p "*.apk"                 # 手动下载 APK
```

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
| GET  | `/api/jobs` | 列出我的定时任务 | 是 |
| POST | `/api/jobs` | 新建任务 `{name,key_id,schedule,tz,title,body,enabled}` | 是 |
| PUT  | `/api/jobs/:id` | 修改任务（含启停，改计划会重算下次执行时刻） | 是 |
| DELETE | `/api/jobs/:id` | 删除任务 | 是 |
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

## 五、定时任务（分钟级）

服务端持有配置与执行权：Worker 的 Cron Trigger 每分钟唤醒一次，扫描 `jobs` 表执行到期任务，
写通知后走既有的 Durable Object → WebSocket 链路推送给 App。**端侧（Web / App）只做配置，不跑任何定时器。**

| 项目 | 说明 |
|------|------|
| 触发精度 | 0–1 分钟（每分钟扫描一次，只会延迟不会提前） |
| 执行位置 | 服务端。App 离线、进程被杀、浏览器关闭都不影响触发 |
| schedule 预设串 | `every:5m` / `every:2h` / `daily:09:00` / `weekly:1,09:00` / `once:2026-09-10T09:30` |
| 时区 | 固定 UTC 偏移（`+08:00`），创建时即换算为 `next_run_at` 绝对时间戳 |
| 防重 | `dedup_key = job:{id}:{计划时刻}`，5 分钟窗口内幂等；并发由 `next_run_at` 乐观锁兜底 |
| 停机补偿 | **不补触发**：长时间不可用后恢复，直接跳到下一个未来时刻 |
| 额度占用 | 1 个 cron trigger；每分钟 1 次 Worker 请求（1440/天 ≈ 1.44%） |

调试（本地 `wrangler dev` 默认不会自动跑 cron，必须加 `--test-scheduled`）：

```bash
cd worker
npm run dev:cron                                   # = wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled"           # 手动触发一次扫描
npm test                                           # 调度算法 + 端到端冒烟测试（内存 SQLite）
```

> Cron 执行失败不会重试也不会告警，所以列表里展示了「上次执行」时间 —— 扫一眼就能发现任务是否悄悄停了。

---

## 安全说明

- 密码使用 **PBKDF2-HMAC-SHA256（10 万次）** 加盐哈希，无解密风险。
- JWT 用 HS256 + `JWT_SECRET` 签名，过期时间建议在 `auth.js` 的 payload 中加 `exp`。
- Webhook key 等同于「写通知的凭证」，请当密钥保管；列表接口只返回掩码，完整 key 仅在生成时展示一次。
- 当前 CORS 为 `*` 便于联调；生产建议把 `utils.js` / `index.js` 中的 `Access-Control-Allow-Origin` 改为你的 Pages 域名。
