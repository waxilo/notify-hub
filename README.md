# Notify Hub

一个「通知消息」中转站：提供一个**全局的、GET/POST 通用的 webhook 接口**，把任意来源的消息推送到你的 **QQ 群或 QQ 私聊**（经 QQ 官方机器人，合规、无封号风险、无网关容器）。

- **Web 控制台（Cloudflare Pages）**：全部配置 —— 注册/登录、Webhook Key 管理、定时任务、接入文档、账号。
- **后端（Cloudflare Worker + D1）**：账号体系（JWT）、Key 路由、通用 webhook、定时任务（Cron 每分钟扫描）、通知存储、QQ 官方机器人触达。
- **触达通道**：QQ 群消息 / QQ 单聊消息（官方 OpenAPI，目标由 `QQ_TARGET` 选择）。消息一律先入库再推送 —— 推送失败不丢消息，历史里可见「未送达」。

> 线上：Worker `https://notify-hub-worker.sloan.dpdns.org` · Pages `https://notify-hub-pages.pages.dev`

---

## 架构

```
  任意来源 (脚本/CI/监控)          QQ 官方机器人
  curl / 程序 / 定时器 ──▶  GET/POST /hook/:key ──┐   ┌────────────────────────────┐
                            Cloudflare Worker     ├──▶│ api.sgroup.qq.com          │
                            - 校验 key → 定位用户  │   │ /v2/groups/{openid}/…  群  │
                            - 写入 notifications  │   │ /v2/users/{openid}/…  私聊 │
                            - QQ 推送(QQ_TARGET)  │   └───────────┬────────────────┘
  定时任务: Cron * * * * * ─▶ runDueJobs ──────────┘               ▼
  QQ 平台事件回调 ──────────▶ POST /api/qq/callback        QQ 群 / QQ 私聊
                              （Ed25519 验签，自动捕获群/用户 openid）
```

- **配置与执行分离**：定时任务存 D1，Worker Cron 每分钟扫描到期行（命中 `idx_jobs_due`，乐观锁防重），端侧零定时器。
- **唯一触达通道 = QQ 官方机器人**：`deliver()` 入库后按 `QQ_TARGET` 调官方 OpenAPI（群/私聊/都发）；至少一个目标送达即写 `delivered_at`，失败仅记日志。
- **无 App / 无 WebSocket / 无 Durable Object**：App 推送链路已整体移除。

## QQ 机器人接入（一次性，约 10 分钟）

1. **注册机器人**：打开 [q.qq.com](https://q.qq.com) 扫码登录 → 创建机器人（个人身份证认证即可；龙虾专用入口 q.qq.com/qqbot/openclaw 建的「私人机器人」也是标准机器人，同样适用），记下 `AppID` 与 `AppSecret`（Secret 只显示一次，忘可重置）。
2. **Web 控制台填凭证**：登录 Web 控制台 →「机器人」页 → 填入 AppID/AppSecret → 保存。**保存即生效，无需重新部署**；旁边「测试连接」会真实换取一次 access_token 验证凭证。
   - 也可走命令行兜底：`npx wrangler secret put QQ_APP_ID` / `QQ_APP_SECRET`（Web 配置的值优先于 env）。
3. **配置回调 URL**：在机器人管理端「沙箱配置」（或正式配置）把回调地址设为：
   ```
   https://notify-hub-worker.sloan.dpdns.org/api/qq/callback
   ```
   平台做 URL 验证时，本服务按官方算法用 AppSecret 派生 Ed25519 私钥签 `event_ts + plain_token` 并返回 `{plain_token, signature}`；之后所有事件都带 Ed25519 签名（seed = AppSecret 重复填充至 32 字节），Worker 侧验签后才处理。
4. **绑定触达目标**（openid 自动捕获存 D1 `settings` 表，**多群 / 多好友累积成推送名单**，「机器人」页可查看与移除）：
   - **绑定 QQ 私聊**：在 QQ 里搜索/添加机器人为好友（沙箱成员扫码即可），然后 **私聊机器人发一句话** → `C2C_MESSAGE_CREATE` 捕获 `user_openid` 加入名单。**每个加好友的用户都会收到推送**（扇出，任一送达即算成功；单好友 1000 条/天）。
   - **绑定 QQ 群**：把机器人拉进你的 QQ 群，在群里 **@机器人 随便说句话** → `GROUP_AT_MESSAGE_CREATE` 捕获 `group_openid` 加入名单。机器人所在的每个群都会收到推送。
   - 多群/固定目标（可选）：`npx wrangler secret put QQ_GROUP_OPENID` / `QQ_USER_OPENID` 显式指定，优先于自动捕获。
5. **选择触达目标**：Web 控制台「机器人」页直接切（私聊 / 群 / 都发，保存即生效）；`wrangler.toml` 的 `[vars] QQ_TARGET` 只是未在 Web 配置时的兜底值（当前为 `c2c`）。
   - **消息模板**（同页可改）：推送文本按模板渲染，占位符 `{title}`（标题）/ `{body}`（正文）/ `{time}`（发送时间，UTC+8）。默认模板带分隔线与时间戳；清空保存 = 恢复默认。QQ 文本消息仅支持纯文本排版（markdown/ark 模板需平台白名单）。
6. **验证**：浏览器访问 `https://…/hook/<KEY>?message=hello`，QQ 群/私聊应收到模板渲染后的通知。

> 龙虾（OpenClaw）用户注意：`q.qq.com/qqbot/openclaw` 专用入口创建的「私人机器人」就是标准 QQ 机器人（同一套 AppID/AppSecret/OpenAPI），notify-hub 直接用它的凭证接入即可 —— **不需要部署 OpenClaw，也不需要任何网关容器**。私人机器人官方建议私聊为主，正适合本场景。
>
> 频控（官方规则）：单群/单好友各 1000 条/天、Bot 维度 30~60 条/分钟 —— 自用通知场景绰绰有余。私聊主动消息的前提是接收方未关闭「允许主动发送」开关（默认开启）。

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

`JWT_SECRET` 为 Worker Secret；QQ 机器人凭证优先在 Web 控制台「机器人」页配置（存 D1 settings，改完即时生效），env/secret 仅作兜底。

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
│   │   ├── qq.js          # QQ 官方机器人：token 缓存 / 群消息 / 私聊消息 / 回调验签 + openid 捕获
│   │   ├── deliver.js     # 投递公共函数：入库 + QQ 推送（QQ_TARGET 扇出，失败隔离）
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
