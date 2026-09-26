# Notify Hub

一个「通知消息」中转站：提供一个**全局的、GET/POST 通用的 webhook 接口**，把任意来源的消息推送到你的 **QQ 群或 QQ 私聊**（经 QQ 官方机器人，合规、无封号风险、无网关容器）。

- **Web 控制台**：全部配置 —— 注册/登录、Webhook Key 管理、机器人接入、定时任务、接入文档、账号。与 API 同源，由同一个容器提供。
- **后端（Node 服务 + MySQL）**：账号体系（JWT）、Key 路由、通用 webhook、定时任务（每分钟扫描到期行）、通知存储、QQ 官方机器人触达。
- **触达通道**：QQ 群消息 / QQ 单聊消息（官方 OpenAPI）。消息一律先入库再推送 —— 推送失败不丢消息，历史里可见「未送达」。
- **账号隔离**：Key、定时任务、**机器人**全部归属到账号。你的机器人凭证、推送名单、消息模板只有你自己能看到和修改，别的账号既改不动也看不见。

> 服务地址：`https://notify-hub.sloan.dpdns.org`（本机 Docker，经共享网关 `../gw` 出公网）· 数据库：共享容器 `../mysql-server`
> Worker 时代的 `notify-hub-worker.sloan.dpdns.org` 在网关上**没有 vhost**，写死旧名的端要改地址或补别名 vhost，见「切流量与 Cloudflare 收尾」第 6 步

---

## 架构

```
  任意来源 (脚本/CI/监控)          每个机器人各自配置回调 URL（都指向下面这一条）
  curl / 程序 / 定时器 ──▶  GET/POST /hook/:key ──┐   ┌────────────────────────────┐
                     notify-hub 容器 (Node 24)    ├──▶│ api.sgroup.qq.com          │
                     - 校验 key → 定位用户         │   │ /v2/groups/{openid}/…  群  │
                     - 写入 notifications          │   │ /v2/users/{openid}/…  私聊 │
                     - 按 key/job 绑定的机器人推送  │   └───────────┬────────────────┘
  内置定时器 每分钟 ──▶ runDueJobs ────────────────┘               ▼
                                                            QQ 群 / QQ 私聊
  QQ 平台事件回调 ─────▶ POST /api/qq/callback
                         （X-Bot-Appid + Ed25519 验签 → 定位到账号与机器人）

        ▲ HTTPS                         
        │  notify-hub.sloan.dpdns.org                   
  ┌─────┴──────────────┐  gw_default 网络        ┌────────────────────┐
  │ ../gw 共享网关      │ ──────────────────────▶ │ notify-hub:8787    │
  │ cloudflared 通配    │                         │ (只绑 127.0.0.1)   │
  │ + nginx 按 Host 分发│                         └─────────┬──────────┘
  └────────────────────┘                                   │ mysql-server_default
                                                    ┌──────┴───────────┐
                                                    │ ../mysql-server  │
                                                    │ 库 notify_hub     │
                                                    └──────────────────┘
```

- **机器人 = 账号级资源**：一个账号可接多个机器人（其中一个为**默认**），Key 与定时任务各自指定用哪个（不指定就走默认）。
- **回调地址是同一个**：QQ 开放平台的回调按机器人配置，但都填同一个 `/api/qq/callback`。请求头 `X-Bot-Appid` 指明是哪个机器人；头缺失时用各机器人 AppSecret 派生的 Ed25519 公钥**试签名**，验签通过的那个即归属账号 —— 签名本身就是身份。
- **配置与执行分离**：定时任务存 MySQL，进程内定时器每分钟对齐整分唤醒一次扫描（命中 `idx_jobs_due`，乐观锁防重），端侧零定时器。原来的 Cloudflare Cron Trigger 在容器里换成什么，见下面「定时任务的执行」。
- **唯一触达通道 = QQ 官方机器人**：`deliver()` 入库后按机器人解析凭证与名单，逐目标发送；至少一个目标送达即写 `delivered_at`，失败仅记日志。
- **无 App / 无 WebSocket / 无对象存储**：App 推送链路已整体移除；通知只存 MySQL。

## QQ 机器人接入（每个账号各做一次，约 10 分钟）

1. **注册机器人**：打开 [q.qq.com](https://q.qq.com) 扫码登录 → 创建机器人（个人身份证认证即可；龙虾专用入口 q.qq.com/qqbot/openclaw 建的「私人机器人」也是标准机器人，同样适用），记下 `AppID` 与 `AppSecret`（Secret 只显示一次，忘可重置）。
2. **控制台接入**：登录 Web 控制台 →「机器人」页 →「＋ 新建机器人」→ 填 AppID/AppSecret → 保存。**保存即生效，无需重新部署**；卡片上的「测试连接」会真实换取一次 access_token 验证凭证。
   - 需要多个就再新建一个（如「私人机器人」发日常提醒、「运维机器人」发告警），然后在 Key / 定时任务里各自指定。
   - ⚠️ 一个 AppID 只能归属一个账号：已被别人接入的 AppID 会被拒绝（409），否则回调不知道该把 openid 记给谁。
3. **配置回调 URL**：在该机器人的管理端「沙箱配置」（或正式配置）把回调地址设为（控制台每张机器人卡片上可一键复制）：
   ```
   https://notify-hub.sloan.dpdns.org/api/qq/callback
   ```
   平台做 URL 验证时，本服务按官方算法用 AppSecret 派生 Ed25519 私钥签 `event_ts + plain_token` 并返回 `{plain_token, signature}`；之后所有事件都带 Ed25519 签名（seed = AppSecret 重复填充至 32 字节），服务端验签后才处理。
4. **绑定触达目标**（openid 由回调自动捕获，存 MySQL `bot_targets`，**记到触发它的那个机器人名下**；多群 / 多好友累积成推送名单，控制台可查看与移除）：
   - **绑定 QQ 私聊**：在 QQ 里搜索/添加机器人为好友，然后 **私聊机器人发一句话** → `C2C_MESSAGE_CREATE` 捕获 `user_openid` 加入名单。**每个加好友的用户都会收到推送**（扇出，任一送达即算成功；单好友 1000 条/天）。
   - **绑定 QQ 群**：把机器人拉进你的 QQ 群，在群里 **@机器人 随便说句话** → `GROUP_AT_MESSAGE_CREATE` 捕获 `group_openid` 加入名单。
5. **选择触达目标**：在机器人卡片上直接切（私聊 / 群 / 都发，保存即生效）。
   - **消息模板**（同卡片可改）：推送文本按模板渲染，占位符 `{title}`（标题）/ `{body}`（正文）/ `{time}`（发送时间，UTC+8）。留空 = 内置默认模板（带分隔线与时间戳）。QQ 文本消息仅支持纯文本排版（markdown/ark 模板需平台白名单）。
6. **验证**：浏览器访问 `https://…/hook/<KEY>?message=hello`，对应的 QQ 群/私聊应收到模板渲染后的通知（未在 Key 上指定机器人时走默认机器人）。

> 龙虾（OpenClaw）用户注意：`q.qq.com/qqbot/openclaw` 专用入口创建的「私人机器人」就是标准 QQ 机器人（同一套 AppID/AppSecret/OpenAPI），notify-hub 直接用它的凭证接入即可 —— **不需要部署 OpenClaw，也不需要任何网关容器**。私人机器人官方建议私聊为主，正适合本场景。
>
> 频控（官方规则）：单群/单好友各 1000 条/天、Bot 维度 30~60 条/分钟 —— 自用通知场景绰绰有余。私聊主动消息的前提是接收方未关闭「允许主动发送」开关（默认开启）。
>
> ⚠️ 早期用 `wrangler secret put QQ_APP_ID / QQ_APP_SECRET / QQ_TARGET / QQ_GROUP_OPENID / QQ_USER_OPENID` 配置的**全局 env 兜底已整体移除**（它们是全局单份的，会让没配机器人的账号共用同一个机器人、把消息发到号主的群里）。现在机器人凭证只有控制台一个入口（存 `bots` 表，按账号隔离），`.env` 里只剩数据库连接与 `JWT_SECRET` 两项。

## 部署（本机 Docker）

前置：同级两个共享容器已在跑 —— `../mysql-server`（数据库）、`../gw`（公网入口，可选）。

```bash
./scripts/db-init.sh      # 一次性：建库建账号 + 建表 + 生成 .env / .env.test（随机强密码）
./scripts/deploy.sh       # npm test 闸门 → 构建镜像 → 起容器 → 等健康检查
./scripts/gw-join.sh      # 可选：把 notify-hub.sloan.dpdns.org 指到本容器（不带参数即短域名）
```

三步各解决一件事，顺序是有意的：`.env` 不存在时服务拒绝启动（`startup_misconfigured`），所以先 `db-init`；`deploy.sh` 把 `npm test` 放在构建前面，因为三套测试直接跑在真实 MySQL 上（SQL 方言、索引命中、账号隔离、回调验签都在里面），镜像构建本身不跑任何测试；`gw-join.sh` 最后跑，公网入口没接上之前本机也能完整验证。

`db-init.sh` 只在共享库上开本项目那两个库（`notify_hub` / `notify_hub_test`）和两个专用账号，其它库一概不碰。它需要 `mysql-server` 的 root：密码默认取自 `../mysql-server/.env`，那份与容器实际状态不一致时用 `MYSQL_ROOT_PASSWORD='<真实密码>' ./scripts/db-init.sh` 覆盖一次即可（脚本在动手写任何文件之前先探一次连接，失败会把两种修法打出来）。别拿容器的 `healthy` 当依据 —— 那里的 healthcheck 用 `mysqladmin ping`，鉴权失败也照样回 "mysqld is alive" 并退出 0。

配置都在 `.env`（模板见 `.env.example`）：

| 变量 | 作用 |
|---|---|
| `DB_HOST/PORT/NAME/USER/PASSWORD` | 连哪个库。容器内 `DB_HOST=mysql`（共享容器的服务名），本机直连用 `127.0.0.1:3306` |
| `JWT_SECRET` | 登录 token 的 HMAC 密钥，≥32 字符。**换掉它 = 安卓端与控制台全部掉线一次** |
| `TRUST_PROXY` | 经 `../gw` 对外服务时必须 `1`：回调地址由请求 origin 拼出，不信任转发头就会回给 QQ 一个 `http://127.0.0.1:8787` |
| `APP_BIND_ADDR` / `APP_PORT` | 宿主机端口映射，默认 `127.0.0.1:8788`（8787 是 writing-assistant 的，80/443 是 gw 的） |

机器人凭证、消息模板、推送名单**都不在 env 里**，一律在控制台「机器人」页配置（存 `bots` / `bot_targets` 表，按账号隔离，改完即时生效）。

## 数据搬迁（D1 → MySQL）

```bash
./scripts/d1-import.sh              # 导出线上 D1 + 干跑，只看差异不写数据
./scripts/d1-import.sh --apply      # 正式写入 + 逐行逐字段回读校验
```

搬运规则（细节写在 `scripts/d1-to-mysql.mjs` 顶部）：主键 id 原样搬（安卓端和外部脚本引用着这些 id，重新编号等于把引用全打断）；导入后把 `AUTO_INCREMENT` 重排到 `max(id)+1`；D1 有而 MySQL 没有的列逐条报出来，不静默丢；目标库非空时直接拒绝写入（残留一行要么撞主键，要么让「MySQL 行数 == D1 行数」的逐行回读校验失真）。导出文件 `worker/.d1-export/dump.sql` 含密码哈希与 AppSecret，已 gitignore，确认无误后删掉。

脚本在宿主机上跑，所以它把 `DB_HOST` 默认改成 `127.0.0.1:3306`（`.env` 里那份 `DB_HOST=mysql` 只有容器内解析得到，否则会撞 `getaddrinfo ENOTFOUND mysql`）。

## 切流量与 Cloudflare 收尾（2026-09-26 已全部执行完）

顺序不能反，而且真正的危险不是「域名还没切过来」，是**两个定时器同时接单**：容器的 tick 不看域名，云上 Worker 的 Cron Trigger 也照跑，而两边的库互不可见 —— 任务级去重（`dedup_key = job:<id>:<计划时刻>`）只在同一个库里比，跨库拦不住，同一个提醒会推两遍到真实的群和好友。所以下面的顺序原则是「宁可空几分钟，不可双推」，落地有二选：

- **A. 先停 cron，再起容器**：控制台 → Workers & Pages → `notify-hub-worker` → Settings → Cron Triggers → Remove，然后正常 `./scripts/deploy.sh`。
- **B. 把「删 Worker」当成停 cron 那一步用**（本次走的这条）：容器带 `JOBS_TICK_DISABLED=1` 起（定时器一行都不装），域名先切过去、验证全通过，再一次性 `DELETE` 掉 Worker —— cron 随 Worker 一起消失，最后删掉开关重启，容器成为唯一执行者。空窗只有「删 Worker 到去掉开关」那几分钟，而且不需要 API Token。

第 1~6 步两种走法相同，只有第 2 步的写法不同。

1. 导入时容器保持停止：`docker compose stop` → `./scripts/d1-import.sh --apply`。
2. （走 A 才做）停掉云上 Worker 的 Cron Trigger。走 B 就跳过这步，第 7 步删 Worker 会连着它一起删。
   不要用「改掉 `worker/wrangler.toml` 的 `[triggers]` 再 `wrangler deploy`」来停：现在仓库里的 `worker/src/` 已经是 MySQL 方言（`INSERT IGNORE`、反引号保留字），重新部署会把老 Worker 换成跑不了的代码。控制台删 trigger 不碰代码，即时生效。
   命令行侧记一条实测：wrangler 自带的 **OAuth token 删不掉 cron** —— `DELETE`/`POST /accounts/<acc>/workers/scripts/<w>/schedules` 回 `405 Method not allowed for this authentication scheme`（`GET` 能读到 `{"schedules":[{"cron":"* * * * *"}]}`），而同一个 token 删 `workers/domains`、删 `workers/scripts/<w>` 都是允许的。也就是说不必为这一步单独换 **API Token**（`Workers Scripts: Edit`）；真要只停 cron 不删 Worker，才用它：
   ```bash
   export HTTPS_PROXY=http://127.0.0.1:7897        # 直连 api.cloudflare.com 拨不通
   curl -s -X POST -H "Authorization: Bearer $CF_API_TOKEN" -H 'Content-Type: application/json' \
     -d '{"crons":[]}' \
     https://api.cloudflare.com/client/v4/accounts/33d023f61ebac424923f7285f9b142f8/workers/scripts/notify-hub-worker/schedules
   # 判据：再 GET 一次，result.schedules 应为空数组
   ```
3. 本机验证（HTTP 全通、定时器不装）：
   ```bash
   JOBS_TICK_DISABLED=1 ./scripts/deploy.sh         # 只验接口，不碰 cron
   curl -s http://127.0.0.1:8788/healthz            # {"status":"ok","database":true}
   curl -s "http://127.0.0.1:8788/hook/<KEY>?message=本机验证"
   docker logs notify-hub | grep jobs_tick_disabled
   ```
   这个开关存在的理由就是第 2 步和验证之间的手滑余地：compose 里默认 `0`，带 `JOBS_TICK_DISABLED=1` 起容器时日志一定是 `jobs_tick_disabled`。
4. 正式接单：删掉 `.env` 里那行 `JOBS_TICK_DISABLED=1`，`./scripts/deploy.sh` 起回来，容器定时器成为唯一执行者。判据别看错：正常情况下**不会**每分钟打一行日志 —— `worker/src/index.js` 只在真的扫到到期任务或有错误时才打 `jobs_tick {"scanned":1,...}`。所以启动日志里有 `jobs_tick_armed` 就算装上了；想立刻验一次投递，在控制台建一个「一分钟后」的临时任务，到点应出现一行 `jobs_tick`，且该任务的「上次执行」时间前进。
5. 抢域名：先 `./scripts/gw-join.sh`（vhost 就位、`TRUST_PROXY=1`），**再删 Worker 的 custom domain 路由**（`DELETE /accounts/<acc>/workers/domains/<id>`，或控制台 Workers & Pages → `notify-hub-worker` → Settings → Domains & Routes）。路由在的时候 CF 边缘把这个名字接走，`gw` 收不到流量；实测删完立刻换人（下面两条判别式）。顺序反过来（先删路由再 gw-join）就是几秒 502。
   ```bash
   # 谁在应答这个名字：Worker 的 404 带 "service"，容器的 /healthz 只有 status
   IP=$(dig +short notify-hub-worker.sloan.dpdns.org | head -1)     # 拿 CF 边缘 IP，绕开本机 hosts
   curl -s --resolve notify-hub-worker.sloan.dpdns.org:443:$IP https://notify-hub-worker.sloan.dpdns.org/healthz
   #   切之前：{"error":"not found","service":"notify-hub"} + server: cloudflare   ← Worker
   #   切之后：{"status":"ok","database":true}                + cf-ray 仍在        ← 本机容器
   ```
   ⚠️ 别用本机 `curl` 或本机代理判断公网状态：`gw-add-host.sh` 会往 `/etc/hosts` 写这个名字（撤销就删那两行），本机解析到的是 `127.0.0.1`，代理也跟着它 —— 删路由之前就能「验出」容器，纯属假象。
6. 到 q.qq.com 的机器人配置页把回调 URL **重新保存验证一次** —— 验证请求现在由本机应答，这是唯一能证明公网链路真的通了的地方；同时看控制台「通知」页历史是否连续。
   ⚠️ **实际落地的 vhost 是短域名 `notify-hub.sloan.dpdns.org`，不是 Worker 时代的 `notify-hub-worker.…`**（`../gw/conf.d/notify-hub.conf` 由 gw 管理端按短域名生成）。原计划「沿用同一个域名、端上一个字都不用改」没有成立：网关按 Host 白名单转发，旧名字现在由 `gw` 应答 `404 gw: no upstream configured`，凡是写死 `-worker` 的 hook 地址、回调 URL、安卓端 API 都收不到。两条路：把配置改成短域名，或补一个别名 vhost（零 DNS 改动，通配记录本来就覆盖它）：
   ```bash
   ./scripts/gw-join.sh notify-hub-worker.sloan.dpdns.org
   ```
   DNS 侧两种走法都不用操作：隧道带的是 `*.sloan.dpdns.org` 通配记录，Cloudflare 侧零操作。
7. 下线云上（本次已执行，逐条留下判据）。删除 Worker 会连带删掉那条 `* * * * *` 的 Cron Trigger，所以第 4 步必须排在它后面：
   ```bash
   export HTTPS_PROXY=http://127.0.0.1:7897
   # 先留一份云上终态备份，再删（删完就没得导了）
   cd worker && npx --yes wrangler@4 d1 export notify-hub --remote --skip-confirmation \
     -c wrangler.toml --output .d1-export/final-backup.sql
   # 删 Worker（cron 一起没）与 Pages 项目；notify-hub-pages 的 pages.dev 域名同时失效
   curl -s -X DELETE -H "Authorization: Bearer $TOKEN" .../accounts/<acc>/workers/scripts/notify-hub-worker
   curl -s -X DELETE -H "Authorization: Bearer $TOKEN" .../accounts/<acc>/pages/projects/notify-hub-pages
   ```
   判据：`GET /accounts/<acc>/workers/scripts` 与 `GET .../pages/projects` 里都不再出现这两个名字；`GET .../workers/scripts/notify-hub-worker` 回 `10007 This Worker does not exist`；同一个 token 就够用（删 scripts/projects 都在 OAuth 允许范围内，只有 `schedules` 那个子资源回 `405`）。
   ⚠️ `JWT_SECRET` 在 Cloudflare 上读不回明文（API 只给名字），所以**所有端需要重新登录一次** —— 这是切流量的既定成本，不是故障。webhook 的 key 存在库里，不受影响。
8. `worker/migrations/` 自此只是历史档案（本机库结构的唯一真源是 `worker/db/schema.mysql.sql`），不要再对任何库执行。

### 云上收尾的执行记录（2026-09-26，账号 `33d023f6…`）

| 对象 | 动作 | 事后判据 |
|---|---|---|
| Worker `notify-hub-worker`（含 Cron Trigger `* * * * *`，2026-09-10 建） | 删除 | `workers/scripts` 列表只剩 `cred-broker`、`cv-api`；直读该 Worker 回 `10007` |
| Pages 项目 `notify-hub-pages`（`notify-hub-pages.pages.dev`） | 删除 | `pages/projects` 只剩 `cv-web` |
| Worker 的 custom domain 路由 | 删除（切流量当天做的，早于本步） | 边缘 `--resolve` 两条 CF IP 都回容器自己的 `/healthz` |
| D1 库 `notify-hub`（`2f5cf556-d3dd-4047-a55a-6c6613058c17`） | **保留**，未动 | `wrangler d1 delete` 不可撤销；等本机跑稳一周再决定 |
| `cred-broker` / `cv-api` / `cv-web` / `cv-db`、其它项目的 gw vhost 与 mysql 库 | 非目标，未碰 | 列表与删除前后一致 |

备份落在 `worker/.d1-export/`（已 gitignore）：`final-backup.sql` 与导入用的 `dump.sql` **字节一致**（cmp 通过），说明导入之后云上再没写进新东西（那段窗口里没有任务到期，18:30 的「下班提醒」由本机容器补上第一次执行）。这两个文件里是**明文 AppSecret 和密码哈希**，确认不需要回滚后 `rm worker/.d1-export/*.sql`。

## 定时任务的执行

Cloudflare Cron Trigger 在容器里没有对应物，`worker/src/server.js` 用一个进程内定时器顶替：每分钟对齐到整分后 2 秒调用一次 `worker.scheduled()`（就是原来 Worker 的入口，一行没改）。

- **错过就补**：扫描条件是 `next_run_at <= 本分钟`，机器休眠 / 重启漏掉的 tick 会在下一次唤醒时一并执行，不会像云端 cron 那样丢档。
- **不会重复**：`dedup_key = job:<id>:<计划时刻>` + 5 分钟窗口，且推进 `next_run_at` 带乐观锁（`WHERE id=? AND next_run_at=?`），并发或重入都只投一次。注意这套去重比的是**同一个库里的行** —— 迁移期云上 Worker 和本机容器各读各的库，谁也不知道对方投过，所以两边同时跑一定会双推（这正是「切流量与 Cloudflare 收尾」开头那两条走法要解决的事；2026-09-26 删掉 Worker 后，云上已不存在第二个执行者）。
- **不会叠跑**：上一 tick 没跑完时本次直接跳过并打 `jobs_tick_skipped` 日志（QQ 接口卡住时不会越堆越多）。
- 计划时刻与 tick 都按**整分钟**粒度比较，「秒」不参与判定 —— 创建任务那一刻的秒数不可控，不丢秒会让整条提醒晚一分钟。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/hook/:key` | 通用 webhook（公开，key 即身份） |
| POST | `/api/qq/callback` | QQ 平台事件回调（公开，Ed25519 验签） |
| GET/POST | `/api/bots` | 机器人列表 / 新建 |
| PUT/DELETE | `/api/bots/:id` | 编辑（凭证·目标·模板·设为默认）/ 删除 |
| POST | `/api/bots/:id/test` | 用该机器人凭证真实换取一次 access_token |
| DELETE | `/api/bots/:id/targets` | 从推送名单移除某个群 / 好友 |
| GET/PUT | `/api/qq/config`、`POST /api/qq/test` | **旧接口兼容**：等价于操作「默认机器人」，新代码请用 `/api/bots` |
| — | `/api/keys`、`/api/notifications`、`/api/jobs`、`/api/register`、`/api/login`、`/api/password` | 账号 / key / 通知 / 定时任务 |

## Webhook 用法

标题固定为 **key 名称**（改名即可改标题），调用只需 `message`：

```bash
# GET 一键通知
curl "https://notify-hub.sloan.dpdns.org/hook/<KEY>?message=CPU 使用率超过 90%"

# POST JSON（支持表单 / 纯文本）
curl -X POST "https://…/hook/<KEY>" \
  -H "Content-Type: application/json" \
  -d '{"message":"部署完成","dedup_key":"deploy-42"}'
```

| 参数 | 说明 |
|---|---|
| `message` | 通知内容（最长 8000 字符）；空内容只入库不推送（历史显示「空消息」） |
| `dedup_key` | 可选。显式防重：5 分钟窗口内相同 key 只推送一次（调用方超时重试场景） |

- **推给哪个机器人**：Key 编辑弹窗里选（不选 = 跟随账号默认机器人）。
- **自定义模式（模板解析）**：key 编辑为 custom 后，`message` 作为模板，`${路径}` 占位符用 JSON 数据填充（点分路径、数组下标）；也可在 key 上配固定模板。
- **响应**：`{"ok":true,"id":71,"delivered":true}` —— `delivered=false` 表示 QQ 推送失败（消息已入库，不会丢）。
- **停用 key**：调用仍会留痕（`rejected=key_disabled`，历史显示「停用拒绝」），按 5 分钟时间桶去重防灌爆，然后返回 403。

## 定时任务

- 预设串：`every:5m` / `daily:09:00` / `weekly:1,09:00` / `once:2026-10-01T09:00`；时区固定为创建时的 UTC 偏移，不开放修改。
- 弹窗里可指定推给哪个机器人（不指定 = 账号默认机器人）。
- **跳过节假日**（`skip_holiday`）：开启后，触发日为非工作日（含周末）时只顺延不推送；`once` 任务忽略此开关。节假日数据来自 `api.apisbo.com`，服务异常时宁可多提醒也不漏推。
- Cron 失败不重试不告警；任务列表展示「已发送 N 条」「下次/上次执行」自查。执行机制（进程内定时器如何顶替 Cloudflare Cron）见上面「定时任务的执行」。

## 目录

```
notify-hub/
├── Dockerfile             # node:24-alpine 单镜像：API + 静态控制台（构建上下文 = 仓库根）
├── docker-compose.yml     # 引用两个 external 共享网络：mysql-server_default / gw_default
├── .env.example           # 运行参数模板（真实值在 .env，由 db-init.sh 生成，不提交）
├── scripts/
│   ├── db-init.sh         # 建库建账号 + 建表 + 生成 .env / .env.test
│   ├── deploy.sh          # npm test 闸门 → 构建 → 起容器 → 等健康
│   ├── gw-join.sh         # 接共享公网入口（域名 → notify-hub:8787，TRUST_PROXY=1）
│   ├── d1-import.sh       # 导出线上 D1（经代理、指定 -c）+ 调下面的搬运器
│   └── d1-to-mysql.mjs    # D1 → MySQL 搬运与逐字段回读校验（一次性，带 --apply 才写）
├── worker/
│   ├── src/
│   │   ├── server.js      # 容器进程入口：node:http ↔ Worker 的 fetch/scheduled + 内置每分钟定时器
│   │   ├── db.js          # MySQL 驱动，对外暴露与 D1 同形的 env.DB（prepare/bind/all/first/run）
│   │   ├── index.js       # 路由表（表驱动）+ scheduled 入口
│   │   ├── auth.js        # 注册/登录/JWT（WebCrypto PBKDF2）
│   │   ├── keys.js        # webhook key CRUD（含绑定机器人）
│   │   ├── webhook.js     # /hook/:key（模板解析/防重/停用留痕）
│   │   ├── jobs.js        # 定时任务 CRUD + 到期扫描执行
│   │   ├── schedule.js    # 预设串解析 / next_run_at 推进（整分钟粒度）
│   │   ├── holiday.js     # 节假日查询（按天缓存）
│   │   ├── bots.js        # 机器人（账号隔离）：CRUD / 名单 / 模板 / 回调路由 / 旧接口兼容
│   │   ├── qq.js          # QQ 官方机器人协议：token 缓存 / 群消息 / 私聊消息 / Ed25519 验签（不碰 DB）
│   │   ├── deliver.js     # 投递公共函数：入库 + 按机器人推送（失败隔离）
│   │   ├── notifications.js
│   │   └── utils.js
│   ├── db/schema.mysql.sql  # 本机库结构唯一真源（合并 D1 0001~0012 的终态，头部记录五处方言差异）
│   ├── migrations/          # 【档案】D1 时代的 0001~0012，不再对任何库执行
│   └── test/                # schedule / jobs.smoke / routes 三套，npm test
└── pages/                 # Web 控制台（纯静态，无构建；由同一容器提供）
```

SQL 一律写成 MySQL 方言。表名/列名与 D1 时代完全一致 —— 接口的 JSON 字段、安卓端与控制台都按这些名字读，改名属于跨端协议变更，不在「换运行时」的范围内。

## 测试

```bash
./scripts/db-init.sh        # 建过测试库 notify_hub_test 与 .env.test 之后
cd worker && npm test       # 三套全绿，201 条断言
```

- `schedule.test.js`：调度算法纯函数（42+ 条）。
- `jobs.smoke.js`：**跑在真实 MySQL 上**（每次 DROP 并按 `db/schema.mysql.sql` 重建，只允许连 `*_test` 库），外部 HTTP 全部 mock。覆盖到期触发、乐观锁防重、历史归档与清空、失败隔离、**账号隔离**、key 绑定机器人、解绑回落默认机器人、`skip_holiday`、秒对齐，以及两条 `EXPLAIN` 索引命中断言（会先灌 400 行让选择性是真的）。
- `routes.test.js`：路由表回归（全部路由钉死 + 已删路由反向对照 + 回调的多机器人验签路由与伪造防护）。

连不上数据库时测试**直接失败退出**而不是跳过 —— 静默的绿比红危险，这个项目被「静默 404」藏过好几个月。

## 日常运维

```bash
docker logs -f notify-hub                                   # 只有 scanned/errors 非空才打 jobs_tick
docker inspect -f '{{.State.Health.Status}}' notify-hub     # healthy / unhealthy / starting
curl -s http://127.0.0.1:8788/healthz                       # {"status":"ok","database":true}
docker compose restart                                      # 改完 .env 不用重建镜像时
./scripts/deploy.sh                                         # 改完代码：重建并重启（带测试闸门）
docker exec mysql-server sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction notify_hub' \
  > backup-$(date +%F).sql                                  # 备份（库在共享容器里，别只备应用）
```

`worker/wrangler.toml` 已经不再描述任何在跑的资源：云上 Worker 与 Pages 于 2026-09-26 删除，只剩 D1 库 `notify-hub` 还留着当回滚档（见「收尾的执行记录」）。它现在的唯一用途是给 `scripts/d1-import.sh` 提供库绑定名，以便最后再导出一次；确认不需要回滚后，`wrangler d1 delete` + 连 `worker/wrangler.toml`、`scripts/d1-*` 一并删掉即可。`wrangler deploy` / `migrate:*` 一类上云命令已随迁出一并删除。
