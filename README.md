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
│   ├── migrations/0001_init.sql  0002_schema_sync.sql  0003_jobs.sql  0004_jobs_detach_key.sql
│   │             0005_notifications_job_id.sql  0006_notifications_job_index.sql
│   │             0007_notifications_rejected.sql
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

> ⚠️ **wrangler v4 的 `d1 execute` 默认只操作本地库**，对线上库必须显式加 `--remote`。不加的话命令会"成功"但线上表根本没建，之后应用全部 500。

```bash
# 分七个文件，按顺序执行（全新库也可一条 npm run migrate:all 全跑）
npm run migrate        # 0001：基础三张表（users / keys / notifications）
npm run migrate:sync   # 0002：补齐 0001 之后手工 ALTER 出来的字段（不幂等，列已存在会报 duplicate column）
npm run migrate:jobs   # 0003：定时任务表 jobs + 扫描索引（幂等，可重复执行）
npm run migrate:detach # 0004：清空 jobs.key_id —— 定时任务与外部 key 解耦（幂等，可重复执行）
npm run migrate:notifjob # 0005：notifications 增加 job_id —— 任务日志可单独检索/清空（不幂等，只能跑一次）
npm run migrate:notifidx # 0006：job_id 检索索引 idx_notif_job（幂等，可重复执行）
npm run migrate:rejected # 0007：notifications 增加 rejected —— 停用 key 的调用留痕（不幂等，只能跑一次）
```

> `migrate:all` 里含 0002 / 0005 / 0007 三个**不幂等**的 ALTER，只适合全新库一次性跑完；已有库请只跑自己缺的那几个幂等文件。

说明：

- `0002_schema_sync.sql` 不幂等 —— SQLite 的 `ALTER TABLE ADD COLUMN` 没有 `IF NOT EXISTS`，且 `wrangler --file` 是**整批原子执行，一条失败全部回滚**。所以它和建表语句必须拆成两个文件，否则在已有库上会连带把建表也回滚掉。
- 已经手工 ALTER 过的线上库**不需要**跑 `migrate:sync`，只跑 `migrate:jobs` + `migrate:detach` 即可。
- 本地调试把 `:remote` 换成 `--local`（如 `npm run migrate:jobs:local`）。

### 5. 部署
```bash
npm run deploy
# 记下你的 Worker 地址，例如 https://notify-hub-worker.<sub>.workers.dev
```

`wrangler.toml` 里的 `[triggers] crons = ["* * * * *"]` 会随部署一起注册，输出中会显示 `schedule: * * * * *`。

本地调试：`wrangler dev`（会自动用本地 D1，需先跑 `:local` 版迁移）。

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

Web 控制台只做配置：**注册/登录 → 生成 Key（页面会给出完整 key 与 webhook 地址）→ 查看/清空某个 Key 的发送历史 → 吊销 Key → 创建定时任务 → 查看/清空任务日志 → 修改密码**。
控制台与 App 里都**没有「发送测试消息」入口** —— 消息一律由外部系统调 `/hook/:key` 写入，否则测试数据会混进真实历史。

---

## 三、安卓 App

1. 用 **Android Studio** 打开 `android/` 目录（会生成 Gradle wrapper）。
2. 首次进入 App 的「设置」页，填入 Worker 地址（`API_BASE`）。
3. 登录/注册后进入首页：底部三个页签 —— **首页（Key 管理）/ 定时任务 / 设置**。前台服务会保持 WebSocket 长连接，服务端有通知即刻弹出系统通知，离线消息在重新上线后由服务端重推。
4. Key 卡片提供「历史」（可查看与清空该 key 的写入记录）与「编辑」；长按卡片可删除 key（连同其历史）。
5. 定时任务卡片提供「日志」（可查看与清空该任务的触发记录）、编辑、启停、删除；删除任务会连同其日志一并清除。

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
| GET  | `/api/notifications?limit=50` | 拉取通知（可加 `key_id=` 按外部 key 过滤、`job_id=` 按定时任务过滤） | 是 |
| DELETE | `/api/notifications?key_id=N` | 清空某个 key 的全部历史（**必须带 key_id 或 job_id**，否则 400） | 是 |
| DELETE | `/api/notifications?job_id=N` | 清空某个定时任务的全部日志 | 是 |
| POST | `/api/notifications/:id/read` | 标记已读 | 是 |
| DELETE | `/api/notifications/:id` | 删除单条通知 | 是 |
| GET  | `/api/jobs` | 列出我的定时任务（含 `sent_count` = 已产生日志条数） | 是 |
| POST | `/api/jobs` | 新建任务 `{name,schedule,tz,body,enabled}` | 是 |
| PUT  | `/api/jobs/:id` | 修改任务（含启停，改计划会重算下次执行时刻） | 是 |
| DELETE | `/api/jobs/:id` | 删除任务（**连带清除该任务的日志**） | 是 |
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

> **key 停用后的调用**：返回 `403 {"error":"key is disabled"}`、不推送，但会往该 key 的历史里写一条**「停用拒绝」**记录（`rejected=key_disabled`，保留调用方原始参数与内容），方便排查「外部还在发、我这边什么都没收到」。同一 key 每 5 分钟最多留一条，避免调用方高频重试把历史刷爆。

---

## 五、定时任务（分钟级）

服务端持有配置与执行权：Worker 的 Cron Trigger 每分钟唤醒一次，扫描 `jobs` 表执行到期任务，
写通知后走既有的 Durable Object → WebSocket 链路推送给 App。**端侧（Web / App）只做配置，不跑任何定时器。**

| 项目 | 说明 |
|------|------|
| 触发精度 | 0–1 分钟（每分钟扫描一次，只会延迟不会提前） |
| 时间粒度 | **整分钟**。计划时刻一律对齐到整分钟、丢弃秒：创建时刻的秒（如 21:11:30）与 Cron 到达时刻的秒（如 21:12:10）都不参与判定，所以 `every:1m` 建在 21:11:30 时，21:12 这一分钟内的任意一刻触发都算命中（旧实现会把 :30 带进计划时刻，导致 21:12:10 被判为未到期、整条提醒晚一分钟） |
| 执行位置 | 服务端。App 离线、进程被杀、浏览器关闭都不影响触发 |
| 通知来源 | **不挂 key**。Key 是外部系统调 `/hook/:key` 的凭证，定时任务是站内自己产生的提醒，两者互不相干 —— 建任务不需要先造通道。触发后直接发「默认类型」通知：标题 = 任务名称，正文 = 通知内容（留空则同任务名），通知的 `key_id` 为 NULL，因此不会出现在任何 key 的发送历史里 |
| schedule 预设串 | `every:5m` / `every:2h` / `daily:09:00` / `weekly:1,09:00` / `once:2026-09-10T09:30` |
| 日志与清空 | 每次触发产生的通知记在 `notifications.job_id` 上，任务列表显示「已发送 N 条」，可进「日志」页查看明细并清空；删除任务时连同日志一并删除 |
| 时区 | **不对用户开放修改**：新建任务取设备/浏览器当前 UTC 偏移，编辑时沿用创建时的时区。存为固定偏移（`+08:00`），创建时即换算为 `next_run_at` 绝对时间戳 |
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
