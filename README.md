# Notify Hub

一个「通知消息」中转站：提供一个**全局的、GET/POST 通用的 webhook 接口**，把任意来源的消息推送到你的 **QQ 群**（经 QQ 官方机器人，合规、无封号风险、无网关容器）。

- **Web 控制台（Cloudflare Pages）**：全部配置 —— 注册/登录、Webhook Key 管理、定时任务、接入文档、账号。
- **后端（Cloudflare Worker + D1）**：账号体系（JWT）、Key 路由、通用 webhook、定时任务（Cron 每分钟扫描）、通知存储、QQ 官方机器人触达。
- **触达通道**：QQ 群消息（官方 OpenAPI）。消息一律先入库再推送 —— 推送失败不丢消息，历史里可见「未送达」。

> 线上：Worker `https://notify-hub-worker.sloan.dpdns.org` · Pages `https://notify-hub-pages.pages.dev`

---

## 架构

```
  任意来源 (脚本/CI/监控)          QQ 官方机器人
  curl / 程序 / 定时器 ──▶  GET/POST /hook/:key ──┐   ┌────────────────────────┐
                            Cloudflare Worker     ├──▶│ api.sgroup.qq.com      │
                            - 校验 key → 定位用户  │   │ /v2/groups/{openid}/…  │
                            - 写入 notifications  │   └───────────┬────────────┘
                            - QQ 群推送           │               ▼
  定时任务: Cron * * * * * ─▶ runDueJobs ──────────┘        QQ 群（成员可见）
  QQ 平台事件回调 ──────────▶ POST /api/qq/callback
                              （Ed25519 验签，自动捕获群 openid）
```

- **配置与执行分离**：定时任务存 D1，Worker Cron 每分钟扫描到期行（命中 `idx_jobs_due`，乐观锁防重），端侧零定时器。
- **唯一触达通道 = QQ 官方机器人**：`deliver()` 入库后调官方 OpenAPI 发群消息；成功写 `delivered_at`，失败仅记日志。
- **无 App / 无 WebSocket / 无 Durable Object**：App 推送链路已整体移除。

## QQ 机器人接入（一次性，约 10 分钟）

1. **注册机器人**：打开 [q.qq.com](https://q.qq.com) 扫码登录 → 创建机器人（个人身份证认证即可），记下 `AppID` 与 `AppSecret`（Secret 只显示一次，忘可重置）。
2. **配置 Worker 凭证**：
   ```bash
   cd worker
   npx wrangler secret put QQ_APP_ID
   npx wrangler secret put QQ_APP_SECRET
   ```
3. **配置回调 URL**：在机器人管理端「沙箱配置」（或正式配置）把回调地址设为：
   ```
   https://notify-hub-worker.sloan.dpdns.org/api/qq/callback
   ```
   平台做 URL 验证时，本服务会按官方要求回显 AppSecret；之后所有事件都会带 Ed25519 签名（密钥 seed = AppSecret），Worker 侧验签后才处理。
4. **绑定 QQ 群**：把机器人拉进你的 QQ 群，在群里 **@机器人 随便说句话**。`GROUP_AT_MESSAGE_CREATE` 事件里的 `group_openid` 会被自动存入 D1 `settings` 表 —— 绑定完成，之后所有通知都发到这个群。
   - 换群：在新群里再 @一次 即自动切换。
   - 多群/固定目标（可选）：`npx wrangler secret put QQ_GROUP_OPENID` 显式指定，优先于自动捕获。
5. **验证**：浏览器访问 `https://…/hook/<KEY>?message=hello`，QQ 群里应收到「key 名称 + hello」。

> 频控（官方规则）：单群 1000 条/天、Bot 维度 30~60 条/分钟 —— 自用通知场景绰绰有余。

## 部署

```bash
# 数据库迁移（settings 表；首次全新库需按 0001→0010 顺序全跑）
cd worker
npx wrangler d1 execute notify-hub --remote --file=./migrations/0010_settings.sql

# 后端（含 Cron）
npx wrangler deploy

# Web 控制台
npm run deploy:pages
```

`JWT_SECRET` / `QQ_APP_ID` / `QQ_APP_SECRET` 均为 Worker Secret，不在代码库里。

## Webhook 用法

标题固定为 **key 名称**（改名即可改标题），调用只需 `message`：

```bash
# GET 一键通知
curl "https://notify-hub-worker.sloan.dpdns.org/hook/<KEY>?message=CPU 使用率超过 90%"

# POST JSON（支持表单 / 纯文本）
curl -X POST "https://…/hook/<KEY>" \
  -H "Content-Type: application/json" \
  -d '{"message":"部署完成","dedup_key":"deploy-42"}'
```

| 参数 | 说明 |
|---|---|
| `message` | 通知内容（最长 8000 字符）；空内容只入库不推送（历史显示「空消息」） |
| `dedup_key` | 可选。显式防重：5 分钟窗口内相同 key 只推送一次（调用方超时重试场景） |

- **自定义模式（模板解析）**：key 编辑为 custom 后，`message` 作为模板，`${路径}` 占位符用 JSON 数据填充（点分路径、数组下标）；也可在 key 上配固定模板。
- **响应**：`{"ok":true,"id":71,"delivered":true}` —— `delivered=false` 表示 QQ 推送失败（消息已入库，不会丢）。
- **停用 key**：调用仍会留痕（`rejected=key_disabled`，历史显示「停用拒绝」），按 5 分钟时间桶去重防灌爆，然后返回 403。

## 定时任务

- 预设串：`every:5m` / `daily:09:00` / `weekly:1,09:00` / `once:2026-10-01T09:00`；时区固定为创建时的 UTC 偏移，不开放修改。
- **跳过节假日**（`skip_holiday`）：开启后，触发日为非工作日（含周末）时只顺延不推送；`once` 任务忽略此开关。节假日数据来自 `api.apisbo.com`，服务异常时宁可多提醒也不漏推。
- Cron 失败不重试不告警；任务列表展示「已发送 N 条」「下次/上次执行」自查。

## 目录

```
notify-hub/
├── worker/                # Cloudflare Worker 后端
│   ├── src/
│   │   ├── index.js       # 路由 + Cron 入口
│   │   ├── auth.js        # 注册/登录/JWT（WebCrypto PBKDF2）
│   │   ├── keys.js        # webhook key CRUD
│   │   ├── webhook.js     # /hook/:key（模板解析/防重/停用留痕）
│   │   ├── jobs.js        # 定时任务 CRUD + Cron 扫描执行
│   │   ├── schedule.js    # 预设串解析 / next_run_at 推进（整分钟粒度）
│   │   ├── holiday.js     # 节假日查询（按天缓存）
│   │   ├── qq.js          # QQ 官方机器人：token 缓存 / 群消息 / 回调验签
│   │   ├── deliver.js     # 投递公共函数：入库 + QQ 推送（失败隔离）
│   │   ├── notifications.js
│   │   └── utils.js
│   ├── migrations/        # 0001~0010（0010: settings 表，幂等）
│   └── test/              # schedule / jobs.smoke / routes 三套，npm test
└── pages/                 # Web 控制台（纯静态，无构建）
```

## 测试

```bash
cd worker && npm test
```

三套全绿：调度算法（42+ 断言）、任务/投递冒烟（内存 SQLite + mock QQ API，含失败隔离用例）、路由表回归（24 条路由钉死 + 已删路由反向对照 + 回调验签用例）。
