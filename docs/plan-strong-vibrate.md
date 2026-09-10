# 强力震动（strong_vibrate）完整实施方案

> 状态：**待你拍板是否开工**。方案已按 `fe352d2`（origin/main）的真实代码逐处核对，文件与行号均可直接定位。
> 目标：某条推送到达时**无声、持续震动**，直到用户处理（点击通知 / 滑掉通知 / 30 秒超时）。

---

## 一、需求确认表（已定）

| # | 项 | 结论 |
|---|---|---|
| 1 | 提醒方式 | **只要震动，不要声音** |
| 2 | 震动节奏 | 脉冲式：震 700ms → 停 500ms，循环 |
| 3 | 停止方式 | ① 点击通知 ② 滑掉通知 ③ **30 秒**超时自动停 |
| 4 | 不做 | 通知内「停止」按钮、不做「打开 App 即停」 |
| 5 | 开关粒度 | **按 key** 与 **按 job** 各自独立开关（job 与 key 已解耦，是两条来源） |
| 6 | 开关存放 | 服务端字段持久化（`keys.strong_vibrate` / `jobs.strong_vibrate`），**不落本地** |
| 7 | 每次请求覆盖 | webhook 支持 `?vibrate=0/1` 按次覆盖 key 默认值 |
| 8 | 未开开关的消息 | 正常横幅 + **渠道单次震动**（不再额外循环） |
| 9 | 新建默认值 | **默认关闭** |
| 10 | 改动范围 | App + worker + Web 控制台（pages）三端对等 |

> 第 9、10 项在上一轮按推荐值落定（默认关闭 / 三端都改）。若要改成「默认开启」或「先只改 App」，说一句即可，其余部分不受影响。

---

## 二、端到端链路（改动点分布）

```
外部系统 ──GET/POST /hook/:key?message=..&vibrate=1──┐
                                                     │
定时任务 Cron(* * * * *) ── runDueJobs ── fireJob ────┤
                                                     ▼
                                        worker/src/deliver.js
                                        deliver(env, {..., vibrate})
                                                     │
                            写 notifications（不含 vibrate）
                                                     │
                                    DO /notify 广播 WS JSON
                                    {type,id,dedup_key,key_name,
                                     title,body,created_at, **vibrate**}
                                                     │
                                                     ▼
                                    PushService.onMessage()
                                    ├─ showNotification(...)  渠道自带单次震动
                                    └─ vibrate==true → startStrongVibrate() 循环震
                                                     │
                        停止 ← ACTION_STOP_VIBRATE 广播 ← ┌ 点击通知（KeysActivity 带 extra）
                                                          ├ 滑掉通知（setDeleteIntent）
                                                          └ 30 秒超时（handler 兜底）
```

关键点：**震动不落库**。`vibrate` 只走 WS 推送 payload，不写 `notifications` 表。理由：震动是端侧提醒策略，不是消息事实；落库会让历史回放误触发震动，还要多一列。

---

## 三、数据模型：新增迁移 `worker/migrations/0008_strong_vibrate.sql`

```sql
-- 0008：强力震动开关 —— keys 与 jobs 各加一列
--
-- 背景：某条推送需要「无声 + 持续震动到用户处理」。是否强震是**发送方的提醒策略**，
-- 因此按 key（外部 webhook）与按 job（站内定时任务）各存一个开关。
--
-- ⚠️ 非幂等：SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，只能执行一次
--    （重复执行报 duplicate column name: strong_vibrate）。
--
-- 执行（⚠️ 必须带 --remote，否则只作用于本地库）：
--   npx wrangler d1 execute notify-hub --remote --file=./migrations/0008_strong_vibrate.sql
--
-- 取值：0 = 普通提醒（横幅 + 单次震动）；1 = 强力震动（横幅 + 循环震动，最长 30 秒）。
ALTER TABLE keys ADD COLUMN strong_vibrate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN strong_vibrate INTEGER NOT NULL DEFAULT 0;
```

配套在 `worker/package.json` 的 `scripts` 里按既有风格补两条（并挂进 `migrate:all`）：

```json
"migrate:vibrate": "wrangler d1 execute notify-hub --remote --file=./migrations/0008_strong_vibrate.sql",
"migrate:vibrate:local": "wrangler d1 execute notify-hub --local --file=./migrations/0008_strong_vibrate.sql",
```

> 不幂等 → 线上只需跑一次。仓库既有 0002 / 0007 都是这个风格，跟随即可。

---

## 四、worker（服务端）改动

### 4.1 `worker/src/deliver.js`

- `opts` 解构（现 16–27 行）加 `vibrate = false`；
- WS payload（现 57–65 行）加一个字段：

```js
  const {
    userId, keyId = null, jobId = null, keyName = '', title = '', body = '',
    payload = null, dedupKey = '', dedup = false, rejected = null,
    vibrate = false,                    // 新增
  } = opts;
  ...
      body: JSON.stringify({
        type: 'notification',
        id,
        dedup_key: dk,
        key_name: keyName || '',
        title: t,
        body: b,
        vibrate: !!vibrate,             // 新增：端侧据此决定是否循环震动
        created_at: Date.now(),
      }),
```

`rejected` / `empty` 两条早返回在推送之前，不受影响。

### 4.2 `worker/src/webhook.js`

- 查 key 时多取一列（现 45 行）：

```js
const row = await env.DB.prepare(
  'SELECT id, name, user_id, active, mode, template, strong_vibrate FROM keys WHERE key=?'
).bind(key).first();
```

- 解析「按次覆盖」：URL query 优先，其次 POST body/form 字段。放在参数解析之后、`deliver` 之前。

```js
// 震动开关：显式传参 > key 默认值。
// 显式传参识别 '1'/'true'/'0'/'false'（query、JSON body、form 三种来源通用）。
function parseVibrate(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v === true || v === '1' || v === 'true' || v === 'yes') return true;
  if (v === false || v === '0' || v === 'false' || v === 'no') return false;
  return null;
}
...
const explicit = parseVibrate(new URL(request.url).searchParams.get('vibrate'))
             ?? parseVibrate(payloadObj && typeof payloadObj === 'object' ? payloadObj.vibrate : null);
const vibrate = explicit === null ? !!row.strong_vibrate : explicit;
```

- `deliver` 调用（现 132–141 行）加 `vibrate,`。

> 副作用须知：GET 请求会把全部 query 参数原样存进 `notifications.payload`，所以 `vibrate=1` 会出现在 payload 里。这是现有设计（`dedup_key` 也一样），不额外处理。

### 4.3 `worker/src/jobs.js`

- `fireJob` 的 `deliver` 调用（现 59–69 行）加 `vibrate: !!job.strong_vibrate,`；
- `createJob`：
  - INSERT 列表加 `strong_vibrate` 列，绑定 `b.strong_vibrate ? 1 : 0`；
- `updateJob`：
  - 字段解析（现 156–165 行）加 `const strongVibrate = b.strong_vibrate !== undefined ? (b.strong_vibrate ? 1 : 0) : job.strong_vibrate;`
  - UPDATE 语句（现 173–176 行）加 `strong_vibrate=?` 与对应绑定；
- `listJobs` 是 `SELECT *`，新列自动带出，无需改。

### 4.4 `worker/src/keys.js`

- `listKeys` 的显式列表（现 22–24 行）加 `strong_vibrate`；
- `createKey` INSERT（现 15–17 行）加该列，默认 0（与迁移默认一致，显式写更清晰）；
- `updateKey` 加一条（沿用「字段不传就不改」策略）：

```js
  if (body.strong_vibrate !== undefined) {
    sets.push('strong_vibrate=?'); vals.push(body.strong_vibrate ? 1 : 0);
  }
```

> `DELIVER` 链路与 `push.js`（Durable Object）**无需改动** —— DO 的 `broadcast(msg)` 原样转发字符串。

---

## 五、Android 端改动

### 5.1 `AndroidManifest.xml`

```xml
<uses-permission android:name="android.permission.VIBRATE" />
```

普通权限，无需运行时申请、无需用户确认。

### 5.2 `PushService.kt`

**新增 import**：`android.content.BroadcastReceiver` / `Context` / `IntentFilter`、`android.os.VibrationEffect` / `Vibrator` / `VibratorManager`。

**新增字段**（现 37–38 行附近）：

```kotlin
    // ---------- 强力震动（无声，持续震到用户处理）----------
    // 放在 Service 而非 Activity：全屏 Intent 只在锁屏生效，解锁态下 Activity 根本不启动，
    // 把震动绑在 Activity 生命周期上会在最需要它的场景直接失效。
    private val vibrator: Vibrator? by lazy { resolveVibrator() }
    private var vibrating = false
    private var stopReceiver: BroadcastReceiver? = null
    private val stopVibrateRunnable = Runnable { stopStrongVibrate() }
```

**渠道改造**（现 `ensureChannel()` 164–177 行）——渠道属性创建后不可改，必须换 id：

```kotlin
    private fun ensureChannel(): NotificationManager {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // 新建 v2：静音（setSound(null,null)）+ 保留渠道震动。
            // 「通知推送」渠道的声音属性创建后不可修改，所以只能换 id 才能做到无声；
            // 渠道级震动保留 → 普通消息天然是「横幅 + 单次震动」。
            nm.createNotificationChannel(
                NotificationChannel(PUSH_CHANNEL_ID, "通知推送", NotificationManager.IMPORTANCE_HIGH).apply {
                    setSound(null, null)
                    enableVibration(true)
                }
            )
            // 旧渠道已无通知投递，删除以免在系统设置里留下一个永远静不掉的喇叭
            nm.deleteNotificationChannel(LEGACY_PUSH_CHANNEL_ID)
            nm.createNotificationChannel(
                NotificationChannel(FG_CHANNEL_ID, "后台连接", NotificationManager.IMPORTANCE_MIN)
            )
        }
        return nm
    }
```

**生命周期挂载**：

```kotlin
    override fun onCreate() {
        ...
        registerStopReceiver()          // startForeground 成功之后
        connect()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        stopStrongVibrate()
        stopReceiver?.let { runCatching { unregisterReceiver(it) } }
        stopReceiver = null
        ws?.close(1000, "service destroyed")
        ws = null
        super.onDestroy()
    }
```

**震动核心**：

```kotlin
    private fun resolveVibrator(): Vibrator? = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        else @Suppress("DEPRECATION") getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
    }.getOrNull()

    private fun registerStopReceiver() {
        val f = IntentFilter(ACTION_STOP_VIBRATE)
        stopReceiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) { stopStrongVibrate() }
        }
        // 仅应用内广播：API 33+ 必须显式声明导出标志
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            registerReceiver(stopReceiver, f, Context.RECEIVER_NOT_EXPORTED)
        else
            registerReceiver(stopReceiver, f)
    }

    private fun startStrongVibrate() {
        val v = vibrator ?: return
        if (!v.hasVibrator()) return
        handler.removeCallbacks(stopVibrateRunnable)   // 连续多条：只刷新超时，不叠加震动
        if (!vibrating) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    // repeat=0 → 从 timings[0] 无限循环；必须由 cancel() 显式停止
                    v.vibrate(VibrationEffect.createWaveform(VIBRATE_PATTERN, 0))
                else
                    @Suppress("DEPRECATION") v.vibrate(VIBRATE_PATTERN, 0)
                vibrating = true
                LogHelper.append(this, "strong vibrate start")
            } catch (e: Exception) {
                LogHelper.append(this, "strong vibrate failed: ${e.javaClass.simpleName}: ${e.message}")
            }
        }
        handler.postDelayed(stopVibrateRunnable, VIBRATE_TIMEOUT_MS)
    }

    fun stopStrongVibrate() {
        handler.removeCallbacks(stopVibrateRunnable)
        if (!vibrating) return
        vibrating = false
        runCatching { vibrator?.cancel() }
        LogHelper.append(this, "strong vibrate stop")
    }
```

**`onMessage`**（现 113–137 行）：解析 `vibrate` 并传入 `showNotification`：

```kotlin
                        val vibrate = obj.optBoolean("vibrate", false)
                        showNotification(
                            keyName.ifEmpty { msgTitle.ifEmpty { "新通知" } },
                            msgBody,
                            obj.optLong("id", 0L),
                            vibrate
                        )
                        if (vibrate) startStrongVibrate()
```

**`showNotification(title, body, id, vibrate)`**：加两个 PendingIntent ——

```kotlin
        // 点击通知：带 extra 打开 App（KeysActivity 收到后发停止广播）。
        // 用 extra 而不是「onResume 无条件停」，是为了精确区分「点击通知」与「从桌面图标进 App」。
        val pi = PendingIntent.getActivity(
            this, id.toInt().coerceAtLeast(1),
            Intent(this, KeysActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(EXTRA_STOP_VIBRATE, true),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        // 滑掉通知：系统代本应用发出该广播，动态注册的 NOT_EXPORTED receiver 能收到
        val del = PendingIntent.getBroadcast(
            this, id.toInt().coerceAtLeast(1),
            Intent(ACTION_STOP_VIBRATE).setPackage(packageName),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val n = b
            ...
            .setContentIntent(pi)
            .setDeleteIntent(del)
            .build()
```

**companion 常量**：

```kotlin
    companion object {
        private const val PUSH_CHANNEL_ID = "notify_hub_push_v2"
        private const val LEGACY_PUSH_CHANNEL_ID = "notify_hub_push"
        const val FG_CHANNEL_ID = "notify_hub_foreground"
        const val FOREGROUND_ID = 1001
        const val ACTION_STOP_VIBRATE = "com.example.notifyhub.STOP_VIBRATE"
        const val EXTRA_STOP_VIBRATE = "stop_vibrate"
        private val VIBRATE_PATTERN = longArrayOf(0L, 700L, 500L)  // 震 700ms / 停 500ms
        private const val VIBRATE_TIMEOUT_MS = 30_000L            // 30 秒兜底自动停
        private const val MESSAGE_ID_BASE = 1_000_000
        private const val DEDUP_WINDOW_MS = 3000L
        fun messageNotifId(id: Long): Int = (MESSAGE_ID_BASE + (id % MESSAGE_ID_BASE)).toInt().coerceAtLeast(1)
    }
```

> 渠道 id 变更**只影响消息通知**：`FgsDismissService` 只用 `FG_CHANNEL_ID`（已核实），不受影响。

### 5.3 `KeysActivity.kt`

- 接管「点击通知」的停止指令（不改动其它入口行为）：

```kotlin
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ...
        handleStopVibrate(intent)     // 放在 setContentView 之后即可
        ...
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleStopVibrate(intent)
    }

    // 只有「点击通知进入」才停震动；从桌面图标/最近任务进入不带该 extra，不会误停
    private fun handleStopVibrate(i: Intent?) {
        if (i?.getBooleanExtra(PushService.EXTRA_STOP_VIBRATE, false) != true) return
        i.removeExtra(PushService.EXTRA_STOP_VIBRATE)
        sendBroadcast(Intent(PushService.ACTION_STOP_VIBRATE).setPackage(packageName))
    }
```

- `openEdit`（现 150–204 行）：读取/回填/提交新开关：

```kotlin
        val cbStrongVibrate = view.findViewById<CheckBox>(R.id.cbStrongVibrate)
        cbStrongVibrate.isChecked = k.strongVibrate == 1
        ...
            UpdateKeyReq(
                name = name,
                active = cbActive.isChecked,
                mode = if (rbCustom.isChecked) "custom" else "default",
                template = if (rbCustom.isChecked) etTemplate.text.toString().trim() else "",
                strongVibrate = cbStrongVibrate.isChecked      // 新增
            )
```

### 5.4 `JobsActivity.kt`

`openEdit`（现 158–279 行）同样三处：`findViewById(R.id.cbStrongVibrate)`、`cbStrongVibrate.isChecked = job?.strongVibrate == 1`、提交进 `CreateJobReq` / `UpdateJobReq` 的 `strongVibrate`。

### 5.5 `api/NotifyApi.kt`

```kotlin
data class UpdateKeyReq(
    val name: String? = null,
    val active: Boolean? = null,
    val mode: String? = null,
    val template: String? = null,
    @SerializedName("strong_vibrate") val strongVibrate: Boolean? = null   // 新增
)

data class KeyItem(
    ...,
    @SerializedName("strong_vibrate") val strongVibrate: Int?              // 新增
)

data class JobItem(
    ...,
    @SerializedName("strong_vibrate") val strongVibrate: Int?              // 新增
)

data class CreateJobReq(
    val name: String, val schedule: String, val tz: String,
    val body: String = "", val enabled: Boolean = true,
    @SerializedName("strong_vibrate") val strongVibrate: Boolean = false   // 新增
)

data class UpdateJobReq(
    val name: String? = null, val schedule: String? = null, val tz: String? = null,
    val body: String? = null, val enabled: Boolean? = null,
    @SerializedName("strong_vibrate") val strongVibrate: Boolean? = null   // 新增
)
```

> Gson 默认**不序列化 null 字段** → `UpdateKeyReq(active = ...)` 这类局部更新不会把 `strong_vibrate` 一起上报，服务端「字段不传就不改」的策略天然成立。

### 5.6 布局

`dialog_edit_key.xml` / `dialog_edit_job.xml` 各加一个 CheckBox（key 的放在 `cbActive` 之前，job 的放在 `cbEnabled` 之前）：

```xml
        <CheckBox
            android:id="@+id/cbStrongVibrate"
            android:text="强力震动（无声，持续震动到点击/滑掉通知，最长 30 秒）"
            android:textSize="14sp"
            android:layout_marginTop="10dp"
            android:layout_width="match_parent"
            android:layout_height="wrap_content" />
```

> 列表项（`item_key.xml` / `item_job.xml`）**不加标记**，保持界面克制。若你想在列表上一眼看出哪个开了强震，可后续在 `tvMeta` 文本或状态 chip 旁补一个「强震」小标 —— 属于可选增强，本次不做。

---

## 六、Web 控制台（pages）改动

- `pages/src/app.js` key 编辑表单：在「启用此 key」那行旁加

```js
<label class="check-row"><input type="checkbox" name="strong_vibrate" ${k.strong_vibrate ? 'checked' : ''}/> 强力震动（无声，持续震动到用户处理）</label>
```

  提交时并入 payload：`strong_vibrate: F.strong_vibrate.checked`。

- job 编辑表单（`enabled` 那行旁）同样加一个 checkbox，并入 `createJob` / `updateJob` 的 payload。
- 可选：key / job 列表行加一个 `<span class="badge mode">强震</span>`（复用现有样式类，无需改 CSS）。

---

## 七、边界与已知约束（照实说明，不打包票）

| # | 约束 | 影响 | 本次是否解决 |
|---|---|---|---|
| 1 | 震动完全依赖 `PushService` 存活 | 国产 ROM 清后台 → 服务没 → 震动没了 | ❌ 属「送达层」问题，见下 |
| 2 | 自建 WebSocket 在小米/华为/OPPO/vivo 后台必被清 | 消息可能压根到不了手机 | ❌ 需另做轮询/厂商通道 |
| 3 | OEM 省电策略、勿扰模式可能拦截震动 | 直调 `Vibrator` 不受响铃/静音模式限制，但 OEM 策略不受我们控制 | ⚠️ 只能靠引导白名单 |
| 4 | 换渠道 id 的代价 | 旧渠道 `notify_hub_push` 会从系统设置里消失，你对它的个性化设置（重要性、勿扰例外）重置为新渠道默认 | 预期内 |
| 5 | 无限震动若无人处理 | 已用 30 秒超时兜底 | ✅ |
| 6 | 多条消息连到 | 只刷新超时、不叠加震动 | ✅ |

**第 1、2 条是本方案的真实天花板。** 本方案解决的是「已经到达手机的消息，如何强到你注意到」，属于「叫醒层」。若你的核心痛点是「消息经常压根没到」，那更该先补的是送达层（`WorkManager` 15 分钟轮询兜底、或厂商推送通道），那是**另一个独立方案**，不混进这次改动。

---

## 八、一处更正（上一轮我说错的）

上一轮我写过「高重要性但既无声音也无震动的渠道，在部分 AOSP 设备上可能不再触发 heads-up 横幅」——**这个说法不准确，就此更正**。

Android 官方文档（Notifications 指南）对 Android 8.0+ 的 heads-up 触发条件只有一条：

> The notification channel has high importance on devices running Android 8.0 (API level 26) and higher.

即**由渠道 importance 决定，与渠道是否静音无关**（`setPriority` 在 8.0+ 被忽略）。所以：

- 静音渠道**不会**丢横幅，之前那个「为保横幅资格才留渠道震动」的理由不成立；
- 但仍然**保留渠道震动**，理由换成真实的那个：让**普通消息**天然就是「横幅 + 单次震动」（需求 #8），不必为此再单独开第二套渠道。

这个更正不影响方案结构，只影响一条代码注释的措辞——已按更正后的理由写进 5.2 节。

---

## 九、改动文件清单（共 15 个）

| 层 | 文件 | 类型 |
|---|---|---|
| DB | `worker/migrations/0008_strong_vibrate.sql` | 新增 |
| worker | `worker/package.json` | 改（migration scripts） |
| worker | `worker/src/deliver.js` | 改 |
| worker | `worker/src/webhook.js` | 改 |
| worker | `worker/src/jobs.js` | 改 |
| worker | `worker/src/keys.js` | 改 |
| App | `android/app/src/main/AndroidManifest.xml` | 改 |
| App | `.../data/PushService.kt` | 改（核心） |
| App | `.../ui/KeysActivity.kt` | 改 |
| App | `.../ui/JobsActivity.kt` | 改 |
| App | `.../api/NotifyApi.kt` | 改 |
| App | `res/layout/dialog_edit_key.xml` | 改 |
| App | `res/layout/dialog_edit_job.xml` | 改 |
| Web | `pages/src/app.js` | 改 |
| Web | `pages/src/styles.css` | 可能改（仅当选做「强震」徽标时） |

---

## 十、验证方案

### 10.1 服务端（本地/线上）

```bash
cd worker
npm run migrate:vibrate                      # ⚠️ 必须带 --remote（脚本内已带）
npx wrangler d1 execute notify-hub --remote --command "SELECT id,name,strong_vibrate FROM keys"
npx wrangler deploy
```

端到端触发（带普通 UA，避免被 Worker 按 UA 拦截）：

```bash
# 开强震
curl -H "User-Agent: Mozilla/5.0" \
  "https://notify-hub-worker.sloan.dpdns.org/hook/<KEY>?message=强震测试&vibrate=1"

# 按 key 默认值（key 关了开关就是普通提醒）
curl -H "User-Agent: Mozilla/5.0" \
  "https://notify-hub-worker.sloan.dpdns.org/hook/<KEY>?message=普通测试"
```

期望：两条都返回 `{"ok":true,"id":N}`（HTTP 201）。

### 10.2 Android 构建

仓库未提交 Gradle wrapper，走 CI 构建（`.github/workflows/build-android.yml`：push 到 main → 构建 debug APK → 覆盖发布到 `latest` Release）：

```bash
git add -A && git commit -m "feat: 强力震动开关（keys/jobs + webhook 覆盖）" && git push
# 产物：https://github.com/waxilo/notify-hub/releases/latest/download/app-debug.apk
```

### 10.3 真机手测清单

| # | 场景 | 期望 |
|---|---|---|
| 1 | key 开强震 → 发 `?vibrate=1` | 锁屏/解锁态**都**震，脉冲式，无声音 |
| 2 | 同上，点击该通知 | 震动立即停，进入 App |
| 3 | 同上，滑掉该通知 | 震动立即停 |
| 4 | 同上，什么都不做 | 30 秒后自动停 |
| 5 | 期间再发一条强震消息 | 超时刷新为 30 秒，不叠加、不卡顿 |
| 6 | key 关强震 → 发消息 | 横幅 + 单次震动，不循环 |
| 7 | 桌面图标进 App（未点通知） | **不**停震动（验证 extra 逻辑没误伤） |
| 8 | 定时任务开强震 → 到点触发 | 同场景 1 |
| 9 | 系统设置 → 通知 → Notify Hub | 只剩「通知推送」「后台连接」两个渠道，旧渠道消失 |
| 10 | 杀进程后重进 App | 服务重建，渠道/权限状态正常，无崩溃 |

---

## 十一、风险与工作量

| 项 | 说明 |
|---|---|
| 主要风险 | 渠道 id 变更导致你此前的渠道级设置重置（第 4 条约束）；可接受 |
| 次要风险 | 部分 OEM 对「后台服务持续震动」有额外限制，可能只震几下 —— 属设备策略，非代码问题 |
| 回滚方式 | 全部改动集中在 15 个文件、无破坏性变更；`git revert` 单个提交即可回退。DB 两列保留亦无害（旧代码不读它） |
| 先后顺序建议 | 迁移 → worker 部署 →（此时旧版 App 收到 `vibrate` 字段会直接忽略，**兼容、不报错**）→ App 发版 → pages 部署 |

> 兼容性说明：旧版 App 用 `JSONObject.optBoolean("vibrate")` 的对应物不存在，多余字段被忽略；新版 App 对接未升级的 worker 时 `optBoolean` 取默认 `false`，退化为普通提醒。**两端可独立上线，无强制同步。**

---

## 十二、待你决定

1. **是否开工**（本方案已可直接实施）。
2. 第 9、10 项是否维持「默认关闭 / 三端都改」。
3. 是否要把上面第 7 条约束（送达层：国产 ROM 后台被杀）作为**下一个独立方案**排进来 —— 我建议排，因为那才是「收不到」的根因；但它不阻塞本次。

---

# 十三、扩展分析：全屏通知 + 持续震动，能否覆盖「锁屏 + 亮屏」两种状态

> 本章回答一个问题：**能不能做到无论锁屏还是亮屏，都弹全屏、都持续震动？**
> 结论先给，再拆复杂度。

## 13.1 结论速览

| 目标 | 锁屏 / 灭屏 | 亮屏且用户正在用 |
|---|---|---|
| **持续震动** | ✅ 能 | ✅ 能 |
| **全屏通知** | ✅ 能（FSI 原生路径） | ❌ **系统明确不允许**；唯一办法是拿到悬浮窗权限后自己强拉 Activity |

**一句话**：震动与设备状态无关，能 100% 做到；全屏在锁屏侧是顺手的事，在亮屏侧要**绕开系统的明令禁止**，能绕，但代价是一个特殊权限 + 国产 ROM 的额外白名单。

## 13.2 官方事实（三条硬约束，均已核对原文）

**① 亮屏且用户正在用 → 系统 UI 一律降级为 heads-up，intent 根本不会启动。**

`Notification.Builder.setFullScreenIntent()` 官方文档原文：

> Prior to `Build.VERSION_CODES.TIRAMISU`, the system **may** display a heads up notification … instead of launching the intent, while the user is using the device. **From `Build.VERSION_CODES.TIRAMISU`（Android 13 / API 33）, the system UI will display a heads up notification, instead of launching this intent, while the user is using the device.**

注意措辞变化：Android 13 之前是「**may**（可能）」——理论上还有机会；**Android 13 起变成了「will（一定）」**，没有任何回旋余地。所以「亮屏也能弹全屏」在 FSI 这条路上是**死路**，不是配置问题。

**② 但如果持有 `USE_FULL_SCREEN_INTENT`，那条 heads-up 会「赖着不走」。**

同一份文档：

> If the posting app holds `USE_FULL_SCREEN_INTENT`, then the heads up notification **will appear persistently until the user dismisses or snoozes it, or the app cancels it.** If the posting app does not hold `USE_FULL_SCREEN_INTENT`, then the notification will appear as heads up notification even when the screen is locked or turned off, and this notification will **only be persistent for 60 seconds**.

这条很有价值：**没有权限时，连锁屏都拿不到全屏**（只给一条 60 秒的 heads-up）；**有权限时，亮屏态的横幅会一直挂在屏幕上**。这直接决定了权限检查是必需项，不是可选项。

**③ 亮屏强拉 Activity 的唯一合法通道：`SYSTEM_ALERT_WINDOW` 是官方承认的 BAL 豁免条件。**

`Activity security`（Backgound Activity Launch 限制）官方文档，豁免清单原文：

> An app can start an activity from the background if one of the following conditions is met: … **The app has the `SYSTEM_ALERT_WINDOW` permission granted by the user.** …

即：拿到「显示在其他应用上层」权限后，`PushService` 里直接 `startActivity()` **不再受后台启动限制**，可以在解锁态把全屏 Activity 拉到用户眼前。这是绕过 13.2① 的唯一非 root 手段。

## 13.3 四条路径与复杂度

| 路径 | 做法 | 新增改动 | 复杂度 | 锁屏 | 亮屏 |
|---|---|---|---|---|---|
| **A** 持续震动 | `Vibrator` 直调（**已在第十二章方案内**） | 0 | — | ✅ | ✅ |
| **B** 锁屏全屏 | FSI + `USE_FULL_SCREEN_INTENT` + `AlarmActivity` | +3 文件 | 🟢 低 | ✅ | ❌ |
| **C** 亮屏全屏 | B + `SYSTEM_ALERT_WINDOW` + 状态分支 + 权限引导 | +3 文件 + 改 2 处 | 🟡 中 | ✅ | ✅（需授权 + ROM 白名单） |
| **D** 亮屏「不消失的横幅」 | 只做 B，利用 13.2② 的持续性 | +2 文件 | 🟢 低 | ✅ | ⚠️ 半全屏 |

### 为什么 A 能 100% 覆盖两种状态

`Vibrator.vibrate()` 是对振动马达的**直接调用**，与屏幕开关、键盘锁状态、响铃/静音模式都无关（这与「通知渠道自带振动」不同，后者受勿扰策略约束）。所以震动这一层**不需要为锁屏/亮屏做任何区分**——第十二章的方案已经天然覆盖。

### B 的复杂度：低（+约 120 行）

```xml
<uses-permission android:name="android.permission.USE_FULL_SCREEN_INTENT" />
<uses-permission android:name="android.permission.WAKE_LOCK" />

<activity android:name=".ui.AlarmActivity"
    android:exported="false"
    android:launchMode="singleInstance"
    android:excludeFromRecents="true"     <!-- 不在最近任务里留残影 -->
    android:showWhenLocked="true"
    android:turnScreenOn="true" />
```

```kotlin
class AlarmActivity : AppCompatActivity() {
    override fun onCreate(s: Bundle?) {
        super.onCreate(s)
        // API 27+ 必须显式声明，否则锁屏下不亮屏；27 以下走已废弃的 window flag
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true); setTurnScreenOn(true)
        } else @Suppress("DEPRECATION") window.addFlags(
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_alarm)
        findViewById<Button>(R.id.btnStop).setOnClickListener { stop("user") }
        // 30 秒后自动关：与震动超时同步，否则用户回来会看到一个残留的大界面
        Handler(Looper.getMainLooper()).postDelayed({ stop("timeout") }, 30_000L)
    }
    private fun stop(reason: String) {
        sendBroadcast(Intent(PushService.ACTION_STOP_VIBRATE).setPackage(packageName))
        LogHelper.append(this, "alarm dismiss: $reason")
        finishAndRemoveTask()
    }
    @Deprecated("锁屏页返回键等同「已处理」") override fun onBackPressed() = stop("back")
}
```

**B 的坑（不踩就会出问题）**：
- 必须 `launchMode="singleInstance"` + `FLAG_ACTIVITY_CLEAR_TASK`，否则连收多条会叠出多个全屏页面；
- 必须 `excludeFromRecents` + `finishAndRemoveTask()`，否则最近任务里躺着一条打不开的僵尸条目；
- 30 秒超时关闭**必须**与震动停止共用同一条广播，否则会出现「界面没了但还在震」或反之。

### C 的复杂度：中（+约 90 行，改 2 处）

关键是**按设备状态分流**，避免锁屏态被拉起两个 Activity：

```kotlin
// PushService 内：vibrate == true 时走这条升级路径
private fun escalate(id: Long, title: String, body: String) {
    startStrongVibrate()                       // 与设备状态无关，先震起来

    val km = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    val screenUsable = pm.isInteractive && !km.isKeyguardLocked

    // 1) 通知照发：锁屏态由 FSI 通道拉起全屏；亮屏态退化为「持续 heads-up」
    showNotification(title, body, id, vibrate = true, fullScreen = true)

    // 2) 亮屏且用户在用：FSI 已被系统判定降级，改走 BAL 豁免强拉全屏
    if (screenUsable && Settings.canDrawOverlays(this)) {
        runCatching {
            startActivity(
                Intent(this, AlarmActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            )
            LogHelper.append(this, "alarm force-launch (overlay exemption)")
        }.onFailure { LogHelper.append(this, "alarm force-launch failed: ${it.message}") }
    }
    // 3) 没授权：不硬来，靠 13.2② 的持续 heads-up 兜底（降级但不失效）
}
```

权限引导（并入 `SettingsActivity`，两项逐条检测 + 一键跳转）：

```kotlin
// 全屏通知（Android 14+ 才需要检查）
if (Build.VERSION.SDK_INT >= 34 && !nm.canUseFullScreenIntent()) {
    startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT)
        .setData(Uri.fromParts("package", packageName, null)))
}
// 悬浮窗（亮屏强拉全屏的前提）
if (!Settings.canDrawOverlays(this)) {
    startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)
        .setData(Uri.fromParts("package", packageName, null)))
}
```

### D 为什么值得认真考虑

多数人不知道的一点：**只要持有 `USE_FULL_SCREEN_INTENT`，亮屏态那条 heads-up 不会自动消失**（13.2②）。也就是说 B 方案顺手就带来了这个效果：

> 锁屏 → 全屏弹窗；亮屏 → 屏幕顶部挂着一条赶不走的横幅 + 一直在震

对「必须被注意到」这个目标来说，**「不消失的横幅 + 一直震」的打扰程度其实低于「全屏弹窗」**，但它同样无法被忽略。而它**不需要悬浮窗权限、不需要 ROM 白名单、不会被 Google 判为滥用**。如果你的真实目的只是「确保我注意到」，D 就是性价比最高的答案；只有当你确实要求「必须占满屏幕、必须挡住我正在看的画面」时，才需要上 C。

## 13.4 国产 ROM 的现实（C 方案的真正门槛）

C 方案在原生 Android 上够用，但在华为 / 小米 / OPPO / vivo 上**还有第三道门**：厂商自建的「后台弹出界面」权限，**默认关闭**，且关闭时**上面两条官方路径全部失效**。社区做法是通过 `AppOpsManager` 反射查询（华为 op 100000 / 小米 op 10021 / vivo 走 `com.vivo.permissionmanager` provider），但这些**不是官方 API，会随 ROM 版本失效**。

因此我在方案里的取舍是：**只做两项官方检测**（`canUseFullScreenIntent()` + `canDrawOverlays()`），厂商权限写进设置页的**文字清单**引导用户手动开（"小米：设置 → 应用设置 → 权限管理 → 后台弹出界面"），不做反射探测——因为探测代码一失效就是静默误判，比不探测更糟。

## 13.5 长期可用性风险（必须知情）

| 风险 | 说明 |
|---|---|
| 平台持续收紧 | `SYSTEM_ALERT_WINDOW` 的豁免权正在被逐版本收窄。Android 15 已把「SAW 豁免后台启动**前台服务**」加上「必须已有可见 overlay 窗口」的附加条件；BAL 的 SAW 豁免目前还完整，但方向明确 |
| targetSdk 升级即失效 | 本方案基于当前 `targetSdk 34`。升到 35+ 时需要重新核对 SAW 与 FSI 的行为变更 |
| 体验激进 | 亮屏强拉全屏 = 用户正在发消息/看视频时被生生打断。这正是 Android 设这道墙的原因，也是最可能招致「把这个 App 通知关掉」的操作 |
| Play 政策 | 该做法在 Play 上属滥用；本项目侧载自用可控，一旦上架必须收敛 |

## 13.6 复杂度汇总（含本章扩展）

| 组合 | 文件数 | 估算代码量 | 能力 |
|---|---|---|---|
| 仅第十二章方案（A） | 15 | ~250 行 | 锁屏/亮屏都持续震；亮屏有横幅 |
| A + B + D | 18 | ~370 行 | 锁屏全屏；亮屏「赶不走的横幅」+ 持续震 |
| A + B + C | 20 | ~460 行 | 锁屏全屏；亮屏全屏（需悬浮窗 + ROM 白名单） |

**我的判断**：A + B + D 是甜点位——用 3 个文件、100 多行，把「锁屏全屏」和「亮屏赶不走的横幅」都拿到，且不引入任何特殊权限。C 建议做成**开关**（默认关，想要的人自己去设置页开），而不是默认行为；这样既留了后路，又不用为少数场景承担体验与政策风险。

## 13.7 需要你决定

1. 全屏这一层，要走 **B + D**（不引入特殊权限），还是直接上 **A + B + C**（亮屏也强制全屏）？
2. C 若采纳，是**默认开启**还是做成设置页里的**开关（默认关）**？我建议后者。
3. 全屏必须配套**超时自动关闭**与**同源停止广播**（13.3 B 的三个坑），这一点不接受"看情况"——不做就会留下僵尸界面或停不掉的震动。

---

# 第十四章　若亮屏允许降级，方案可以明显更简单

## 14.1 决定复杂度的那一条官方原文

`Notification.Builder.setFullScreenIntent()` 的官方文档（已核对原文）里有四句话，逐字决定了两件事：

> - **From `TIRAMISU`, the system UI *will* display a heads up notification, instead of launching this intent, while the user is using the device.** —— 亮屏是**一定**降级，不是"可能"。
> - **If the posting app holds `USE_FULL_SCREEN_INTENT`, then the heads up notification will appear persistently until the user dismisses or snoozes it, or the app cancels it.** —— 持有权限 → 亮屏横幅**关不掉**。
> - **If the posting app does not hold `USE_FULL_SCREEN_INTENT`, then the notification will appear as heads up notification even when the screen is locked or turned off, and this notification will only be persistent for 60 seconds.** —— 不持有 → **连锁屏都只剩 60 秒横幅**。
> - **To be launched as a full screen intent, the notification must also be posted to a channel with importance level set to `IMPORTANCE_HIGH` or higher.**

**读出来的结论**：`USE_FULL_SCREEN_INTENT` 不是"全屏开关"，而是**提醒强度总开关**——它同时决定「锁屏能否真全屏」与「亮屏横幅能否持久」。这两个行为你无法分开配置，**由系统按设备状态自动分流**。这恰好就是本章的方案基础。

## 14.2 接受降级 = 整个 C 方案被砍掉

第十三章里 C 的复杂度**全部集中在"亮屏也要抢屏"这一件事上**。一旦接受降级，下面这些一次性全部不需要：

| C 方案引入的东西 | 降级后 |
|---|---|
| `SYSTEM_ALERT_WINDOW` 悬浮窗权限 | 不需要 |
| 依赖 BAL 的 SAW 豁免去后台 `startActivity()` | 不需要 |
| 华为 / 小米「后台弹出界面」白名单 | 不需要 |
| 锁屏 / 亮屏状态分流判断 | 不需要（系统自己分） |
| `AppOpsManager` 反射探测（非官方 API） | 不需要 |
| 设置页多项授权引导 | 只剩 FSI 一项 |

**净减少约 4 个文件 / 90 行代码，且方案内不再出现任何非官方 API 与非官方权限。**

## 14.3 四档对比

| 档 | 组成 | 锁屏 / 灭屏 | 亮屏 / 已解锁 | 新增权限 | 新增类 |
|---|---|---|---|---|---|
| **A** | 高重要性渠道 + 循环震动 | 普通横幅（短）+ 持续震 | 普通横幅（短）+ 持续震 | `VIBRATE` | 0 |
| **A + D′** | A + FSI 权限 + `setFullScreenIntent` 指向**现有 `MainActivity`** | 真全屏（App 主界面覆盖锁屏） | **关不掉的横幅** + 持续震 | +`USE_FULL_SCREEN_INTENT` | **0** |
| **A + B** | A + FSI + 专用 `AlarmActivity` | 真全屏（专用告警页） | 关不掉的横幅 + 持续震 | 同上 | 1 |
| ~~A + B + C~~ | 上述 + 悬浮窗 | 真全屏 | 强行全屏 | +`SYSTEM_ALERT_WINDOW` | 3 |

**D′ 是本章的新东西**：不新建 Activity，把 `fullScreenIntent` 的 `PendingIntent` 直接指向已有的 `MainActivity`，即拿到"锁屏全屏 + 亮屏关不掉的横幅"，同时**绕开 13.3 里 B 的三个坑**——因为那三个坑（`singleInstance` 防多实例、`excludeFromRecents` 防僵尸任务条目、30 秒自动关闭与震动停止同源）**全都是"自建告警 Activity"才产生的问题**，复用主界面时不存在。

## 14.4 初版推荐：A + D′（已被 14.9 更正，见下）

1. **震动是主叫醒手段**。`Vibrator` 是马达直调，不受锁屏/亮屏、键盘锁、静音模式影响，已 100% 覆盖两种状态，不需要任何分支。
2. **亮屏真正要的是"横幅别飘走"**，不是"界面挡在我脸上"。官方给持权限 App 的正是 persistent heads-up——**必须用户手动划掉**，强度足够、侵略性更低。
3. **锁屏要的是"亮起来给我看"**，系统拉起 `MainActivity` 已满足；不想要专用告警页就一行代码都不用加。
4. **省掉三个必踩坑**（见 14.3）。

## 14.5 D′ 的两个代价（必须知情）

**代价一：锁屏拉起的是 App 主界面，不是告警页。** 若 `MainActivity.onCreate` 有登录态检查，未登录会重定向到 `LoginActivity`，锁屏上看到的就是登录页。两种处理：

- 给 `fullScreenIntent` 的 Intent 加 extra（如 `EXTRA_FROM_ALARM=true`），`MainActivity` 见到就跳过重定向、直接展示通知列表；
- 或放弃 D′，回到 B（自建极简告警页）。

**代价二：Android 14 的 FSI 授权检测依然不能省，而且省掉的后果比想象中重。** 按 14.1 第三条，**权限丢失后连锁屏都只剩 60 秒横幅**：

```kotlin
if (Build.VERSION.SDK_INT >= 34 &&
    !getSystemService(NotificationManager::class.java).canUseFullScreenIntent()) {
    startActivity(
        Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT)
            .setData(Uri.fromParts("package", packageName, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    )
}
```

> 自签侧载在 Android 14 上默认**已授予**（撤销动作由 Play 安装时执行），但小米/华为等 OEM 行为不一致，检测不能省。

## 14.6 与降级无关、仍然不能省的两项

| 项 | 原因 |
|---|---|
| 渠道必须 `IMPORTANCE_HIGH` | 官方硬要求；低于 HIGH 的渠道上 FSI 完全不生效 |
| 换渠道 id `notify_hub_push_v2` | 渠道声音属性创建后不可修改，要无声必须换新 id |

## 14.7 结论

**"亮屏允许降级"是这轮讨论里性价比最高的一次让步。** 它把方案从「用户要手动开两个特殊权限 + 依赖非官方探测」压缩到「零特殊权限、零非官方依赖」，而**提醒强度几乎不降**——因为亮屏态本来也拿不到全屏，能拿到的最强形态就是"关不掉的横幅"。

于是真正剩下的选择只有一个：**锁屏全屏用「现有主界面」（D′，+0 文件）还是「专用告警页」（B，+1 文件）**。

> ⚠️ **本条推荐已在 14.9 补论中更正为 `A + B`。** 14.4 里"D′ 省 1 个文件、绕开三个坑"的说法在成本核算上是错的——三个坑随"覆盖锁屏的 Activity"这个**身份**而存在，不随"是否新建文件"而存在。详见 14.9。

## 14.8 需要你决定

1. 走 **A + D′**（复用 `MainActivity`）还是 **A + B**（专用极简告警页）？
2. 若选 D′：锁屏希望直接看到 App 通知列表（加 extra 跳过登录重定向），还是接受可能停在登录页？
3. 震动参数（脉冲 700ms / 间隔 500ms、30 秒超时）沿用已确认值，不再重复确认。

---

## 14.9 补论：B 的性价比确实更高（更正 14.4 / 14.7）

**结论先行：你对。** 14.4 推荐 A + D′ 的两条理由里，"省掉 1 个文件"是真的，"绕开三个坑"是**假的**。

三个坑不是"新建 Activity"带来的，而是 **"被 FSI 拉起的、覆盖锁屏的 Activity"这个身份**带来的。D′ 里承担这个身份的是 `MainActivity`——**坑一个都没少，只是没人去填**。不填，它们就从"实现成本"变成"线上 bug"。

### 坑没有消失，只是变成了 bug

| 坑 | B 的解法 | D′ 不填的后果 |
|---|---|---|
| 多实例叠加 | `android:launchMode="singleInstance"` | 须在 `MainActivity` 上加 launchMode，**改的是正常启动路径**；不加则锁屏拉起会叠在已有实例上 |
| 僵尸任务条目 | `excludeFromRecents` + `finishAndRemoveTask()` | **`excludeFromRecents` 根本不能设**——把主界面从最近任务里藏起来是错的。于是"30 秒自动关闭"也不能 `finishAndRemoveTask()`，否则**会把用户正在用的 App 关掉** |
| 自动关闭与停震同源 | 专用 Activity 内 1 个 handler 调已有 `stopAll()` | 在 `MainActivity` 里做自动关闭 = **30 秒后自动关掉用户的主界面**，行为错误 |

**第 2 条是死结**：「主界面必须留在最近任务里」与「FSI 拉起物要能被整体移除」这两个约束**直接互斥**，D′ 无解。这不是代码量问题，是设计冲突。

### D′ 还有三笔额外成本

1. **改 `MainActivity` 的启动分支**（登录重定向要加 extra 判断）——动的是**正常启动的关键路径**，风险大于新增一个文件。
2. **`MainActivity` 会跑自己的启动逻辑**（通知列表刷新、`UpdateChecker`），锁屏下白跑。
3. **"停止震动"按钮要塞进主界面 UI**——主界面本是给人看通知的，被塞进告警控制。

### B 的真实成本（比我上一轮写的小）

| 项 | 量 |
|---|---|
| `AlarmActivity.kt` | ~80 行（其中三个坑的"解法"就是 3 个 XML 属性 + 复用已有的停震函数，**不是新逻辑**） |
| `activity_alarm.xml` | ~40 行（大字标题 + 正文 + 一个停止按钮） |
| Manifest | 新增 1 条 `<activity>` |

**关键差别不在文件数，而在改动落点：**

| | **B** | **D′** |
|---|---|---|
| 改动性质 | **纯新增**，不碰任何现有代码路径 | **改现有代码**（manifest / launchMode / 启动分支 / 主界面 UI） |
| 回退 | 删 2 个文件 + 删 1 行 manifest，`git revert` 即净 | 需逐处还原，容易留残 |
| 故障半径 | 只影响告警页 | **影响 App 正常启动与最近任务** |
| 可单独测试 | 可，`am start` 直接拉起 | 否，与主流程耦合 |

### 更正后的推荐：A + B

理由从上一轮的"界面可以做得更专业"改成更实在的那条：**B 用 1 个文件换来了与主流程的完全解耦**——而这正是你从最初就在意的东西（方案先行、可回退、故障可控）。

D′ 唯一的真实优势是"点进去就是完整 App"。这个优势可以补齐：B 的告警页在"停止震动"之外再挂一个「查看详情 → 打开 `MainActivity`」的动作即可。而告警场景本来也不该先甩给用户一个信息过载的主界面。

> 14.8 中的两个待决问题（走 D′ 还是 B、锁屏是否跳过登录重定向）随之作废，只剩一个决定：**是否按 A + B 开工。**

---

# 第十五章　A + B 的全场景行为

## 15.1 两层分工（这是理解所有场景的钥匙）

| 层 | 由谁实现 | 依赖 | 提供 |
|---|---|---|---|
| **视觉层** | 通知 + FSI + `AlarmActivity` | 通知未被关闭 + FSI 权限 + ROM 不拦 | 锁屏 → 全屏告警页；亮屏 → 关不掉的横幅 |
| **震动层** | `PushService` 持有 `Vibrator` | **仅需进程存活** | 脉冲循环震动 |

**两层的依赖完全不同**，这是整个方案的关键：视觉层可能被权限 / ROM / 勿扰挡住，**震动层不会**——只要服务活着就震。所以"以震动为主叫醒手段"不是妥协，是把可靠性压在唯一不受系统策略影响的通道上。

## 15.2 视觉层：AOSP 官方验证矩阵

以下是 AOSP 官方文档《Full-screen intent limits》里逐状态列出的验证矩阵（**不是我推演的，是官方原文**）：

| FSI 权限 | 解锁屏 | 锁屏 | 灭屏 | AOD |
|---|---|---|---|---|
| **已授予** | Persistent HUN（带 pill 按钮） | **拉起全屏** | **拉起全屏** | **拉起全屏** |
| **未授予** | HUN，60 秒 | HUN，60 秒（排在列表最前） | **点亮 AOD** + HUN 60 秒 | HUN，60 秒 |

三条要点：

1. **分流依据是"屏幕是否解锁"，不是"屏幕是否亮着"**。锁屏但屏幕亮着，仍然拉起全屏——这里我上一轮表述含糊，现按官方矩阵更正。
2. **AOD 状态也走全屏**（未授予时则是"点亮 AOD + 横幅"），不需要额外处理。
3. **"Persistent HUN"**：持权限时亮屏横幅是**关不掉**的，且系统会**以 pill 按钮样式展示通知动作**——这意味着亮屏态也能有一键操作入口（详见 15.5 规则三）。

> 补充（官方同页）：Android 14 起 `USE_FULL_SCREEN_INTENT` **对全新安装默认授予**，由 Google Play 在安装时对非通话/闹钟类应用**撤销**。本项目自签侧载，故默认应为已授予；OEM 另有 `PERMISSION_STATE_*` 要求。

## 15.3 震动层：上表 8 种情况**完全相同**

- 波形 `[0, 700, 500]`，`repeat = 0` → 震 700ms、停 500ms，无限循环
- **不受**静音 / 震动模式 / 勿扰 / 屏幕状态影响——`Vibrator.vibrate()` 是马达直调，不经过通知策略
- 30 秒无处理 → 自动停震（防耗电、防"设备无法操作"）
- 多条消息连续到达 → 只刷新超时，不叠加震动

## 15.4 逐场景叙事

**场景 1　手机在兜里，灭屏。**
震动先起（渠道自带一次短震 + 服务脉冲），系统随即点亮屏幕、`AlarmActivity` 盖住锁屏（**不需要解锁**），显示标题 / 正文与「停止震动」。掏出点按钮 → 停震、页面关闭、通知撤销。不点 → 30 秒后停震并关闭页面。

**场景 2　手机在桌上，亮屏解锁，你正在刷手机。**
顶部滑入一条**划不掉的横幅**（带 pill 按钮）+ 持续震动。点横幅 → 打开 App 并停震；划掉横幅 → 停震；什么都不做 → 30 秒后停震，横幅按 15.5 规则一收回通知栏。

**场景 3　手机在桌上，亮屏但停在锁屏界面。**
按官方矩阵仍走**全屏**——告警页直接盖在锁屏上。这是"手机就在眼前但没解锁"的常见情况，覆盖完整。

**场景 4　勿扰模式开着。**
通知可能被勿扰拦下 → 横幅与全屏都不出现（除非渠道开 `setBypassDnd` 且用户授予「勿扰访问」）。**但震动照旧**——它是服务直接调马达，不经过通知策略。**这是本方案最强的一点：勿扰也挡不住它。**

**场景 5　FSI 权限没给，或被 ROM 拦（小米/华为「后台弹出界面」默认关）。**
按矩阵第二行退化：锁屏只剩 60 秒横幅，亮屏普通横幅。**震动不受任何影响**。

**场景 6　推送服务已被系统清掉。**
WebSocket 断 → 消息压根没到手机 → 通知和震动都不会发生。这是**送达层**短板，本方案不解决（见第七章）。

**场景 7　普通消息（未开强力震动开关）。**
横幅 + 渠道自带单次震动。无全屏、无循环。

## 15.5 推演中发现的四条必须配套的规则

**规则一：超时后必须收回横幅，否则留下"悬空状态"。**
持权限时亮屏横幅是 persistent，**它不会自己消失**；而震动 30 秒后就停了。若只停震不管通知，用户回来会看到"横幅还挂着但已经没动静"，无从判断是否已处理。
**做法**：超时 = 停震 + 用**同一 id** 重新 `notify()` 且**不带** `setFullScreenIntent` → 横幅收回通知栏，内容仍可回看。若真机上横幅未被收回，退化为直接 `cancel()`。
（此行为需真机验证，我未找到官方明文保证。）

**规则二：通知被用户关闭时，不应震动。**
否则会出现"我明明把这个 App 的通知关了，它还在震"。发布前判 `areNotificationsEnabled()`，为 `false` 直接跳过震动——否则这是必然被投诉的行为。

**规则三：绝不要设 `setOngoing(true)`。**
`ongoing` 通知在锁屏设备上**无法被用户划掉**，会直接破坏"滑掉通知停止震动"这条路径。另外系统在亮屏态给的 pill 按钮正是**通知动作**的展示位——如果之后想给亮屏态也加一键停震，落点就在这里（当前按你的选择：不加按钮）。

**规则四：告警页的离开语义要明确。**
建议：只有**「点停止按钮」**和**「30 秒超时」**算已处理；按 Home / 电源 / Back 离开告警页**不停震**——"能操作设备"不等于"已注意到内容"。震动仍可由通知栏划掉终止。若觉得过强，可改成 `onStop` 即停。

## 15.6 一句话总结

**锁屏（含亮屏未解锁 / 灭屏 / AOD）→ 全屏告警页 + 持续震；亮屏已解锁 → 关不掉的横幅 + 持续震。两者由同一条循环震动兜底，而震动是唯一不受权限、勿扰、ROM 影响的通道。**

## 15.7 还剩下的决定

1. **是否按 A + B 开工**（本方案在第十四 / 十五章后已冻结）。
2. 规则四的强度：按 Home / 电源键离开告警页是否也停震？（默认：不停）

---

# 第十六章　现状核查：当前普通通知有没有震动

## 16.1 代码现状（`PushService.kt` 原文）

渠道创建只有一行、三个参数（`ensureChannel()`）：

```kotlin
nm.createNotificationChannel(
    NotificationChannel(PUSH_CHANNEL_ID, "通知推送", NotificationManager.IMPORTANCE_HIGH)
)
```

**全文没有任何** `setSound()` / `enableVibration()` / `setVibrationPattern()` / `setLights()` 调用；`showNotification()` 里也没有 `setDefaults()` / `setVibrate()`。

**结论：当前行为完全由「`IMPORTANCE_HIGH` + 系统默认」决定，代码没有做任何保证。**

## 16.2 官方对"默认"的两句话，互不覆盖

| 出处 | 原话 | 覆盖范围 |
|---|---|---|
| 渠道创建指南 | "By default, all notifications posted to a given channel use the **visual and auditory** behaviors defined by the importance level" | 视觉 + **声音**，**未提震动** |
| `setVibrationPattern` 文档 | "If the provided pattern is valid … will enable vibration. **Otherwise, vibration will be disabled unless `enableVibration(true)` is used**" | 倾向"不显式开就不震" |

两条加起来：**官方没有为"高重要性渠道默认震动"背书。** 这属于"实际能跑、但没有承诺"的灰色地带——所以不能把它当作设计前提。

## 16.3 实机侧证据指向"默认开"

抓到的真实渠道 dump：

```
mImportance=4, mVibrationEnabled=true, mVibration=null
```

振动**已启用**且无自定义波形 → 操作系统播放**系统默认通知振动模式**。所以当前手机上大体是**有震动的，且是单次**（跟随系统默认波形，不是循环）。

> 但这不是保证：渠道属性建好后即锁死，且**用户可在系统设置里单独关掉**。你手机上的实际值，以 `设置 → 应用 → 通知 → 「通知推送」 → 振动` 开关为准。

## 16.4 对本次改动的两个影响（这是本章的重点）

**影响一：换渠道会重置振动设置。**
要无声必须换 id（渠道声音属性创建后不可改）。新渠道 `notify_hub_push_v2` 的振动会回到默认值——如果你曾在系统设置里关过「通知推送」的振动，换渠道后会重新变回默认（大概率是开）。

**影响二：新渠道必须显式写 `enableVibration(true)`。**
原计划的写法是 `IMPORTANCE_HIGH + setSound(null, null)`。但按 16.2 第二句话，**只关声音而不显式开振动，在部分设备上存在被判为"不震动"的风险**。为避免歧义，应显式声明：

```kotlin
NotificationChannel(PUSH_CHANNEL_ID_V2, "通知推送", NotificationManager.IMPORTANCE_HIGH).apply {
    setSound(null, null)      // 无声
    enableVibration(true)     // 显式打开：保证"普通消息 = 横幅 + 单次震动"
    // 不设 setVibrationPattern：保持系统默认波形（单次）；循环震动由 PushService 负责
}
```

这样第五章里"普通消息 = 横幅 + 单次震动"这条设计假设才**有代码保证**；强力消息则是同一次渠道震动叠加服务层的循环震动。

> 反过来，如果将来想让普通消息**完全静默**，就必须显式 `enableVibration(false)`——不写是靠不住的（同 16.2）。

## 16.5 一条待真机确认的事项

新渠道建好后，在 `设置 → 应用 → 通知 → 通知推送` 里确认：**声音已关闭、振动为开**。若振动开关是关的，手动打开（或调整代码后重装）。

---

# 第十七章　实施记录（已开工：A + B）

> 状态：**已实现**，代码在工作区（未提交）。改动 21 个代码文件（18 改 + 3 新增），另更新本方案文档。

## 17.1 与方案的唯一偏离（需你知情）

**滑掉通知的停止指令，由 `PendingIntent.getBroadcast` 改为 `PendingIntent.getService`。**

- 方案原文（5.2 节）用的是广播 + 动态注册的 `BroadcastReceiver`。
- 实际改为：`setDeleteIntent` 指向 `PushService`，由 `onStartCommand` 识别 `ACTION_STOP_VIBRATE`。
- 原因：系统代为发出 PendingIntent 时，「动态注册的接收器 + `RECEIVER_NOT_EXPORTED`」是否放行**存在版本差异**；`startService` 没有这层歧义（PendingIntent 的 `startService` 送达是确定的）。
- 代价：若 Service 已被杀，滑掉一条旧通知会把它重新拉起（原本 `START_STICKY` 也会被系统拉起，不构成新行为）。
- `AlarmActivity`（停止按钮）与 `KeysActivity`（点击通知）仍走 `sendBroadcast` —— 它们由本应用直接发送，同应用广播无歧义。

## 17.2 与方案一致、已实现的关键项

| 项 | 落地位置 |
|---|---|
| 渠道 `notify_hub_push_v2` + `setSound(null,null)` + `enableVibration(true)` + 删旧渠道 | `PushService.ensureChannel()` |
| `[0,700,500]` `repeat=0` 无限循环 + 30 秒超时 | `PushService.startStrongVibrate()` / `stopVibrateRunnable` |
| 超时收回横幅（同 id 重发、不带 FSI） | `PushService.retractHeadsUp()` |
| 通知被禁用时不震动（规则二） | `startStrongVibrate()` 首行 `areNotificationsEnabled()` |
| 绝不 `setOngoing(true)`（规则三） | `buildMessageNotification()` |
| 告警页离开语义：Home/电源/Back **不停震**（规则四） | `AlarmActivity` 未覆写 `onBackPressed` |
| 三个坑：`singleInstance` / `excludeFromRecents`+`finishAndRemoveTask()` / 超时与停震同源 | Manifest + `AlarmActivity.dismiss()` |
| 数据链路 `0008` + `deliver` + `webhook` + `jobs` + `keys` | 见第四章 |
| 三端开关 | `dialog_edit_key/job.xml` + `KeysActivity`/`JobsActivity`；`pages/src/app.js` |

## 17.3 新增（方案未包含）：设置页「提醒权限」卡片

`SettingsActivity` + `activity_settings.xml` 增加两项**官方检测**：

- `areNotificationsEnabled()` —— 关闭时明确提示「通知与震动都不会触发」；
- `canUseFullScreenIntent()`（Android 14+）—— 未授权时给出跳转按钮，并说明「退化范围仅限视觉层，震动不受影响」。

厂商「后台弹出界面」权限按 13.4 的取舍**不做反射探测**，仅在需要时文字说明。

## 17.4 验证状态

| 层 | 手段 | 结果 |
|---|---|---|
| worker | `npm test`（3 个测试文件，含新增 10 条 `strong_vibrate` 断言） | **ALL PASS** |
| pages | `node --check`（ES module 语法） | 通过 |
| 资源 | XML / JSON 解析校验 | 通过 |
| Android | —— | **未编译**：本机无 Java / Android SDK / Gradle，需 push 触发 GitHub Actions |

真机手测仍按 10.3 的 10 条清单执行，重点三条：**滑掉通知是否停震**、**超时后横幅是否收回**（此行为无官方明文保证，是本方案唯一未验证的假设）、**新渠道「声音关、振动开」**。

## 17.5 仍未决

规则四的强度：当前按方案默认**「按 Home / 电源 / Back 离开告警页不停震」**。若想改成「Back 即停」，在 `AlarmActivity` 加一个调用 `dismiss("back")` 的 `onBackPressed` 覆写即可（约 3 行）。

---

## 18. 上线记录（2026-09-10 执行完毕）

### 18.1 执行顺序与结果

| 步骤 | 命令 | 结果 |
|---|---|---|
| D1 迁移 | `wrangler d1 execute notify-hub --remote --file=./migrations/0008_strong_vibrate.sql --yes` | ✅ 成功；已回查 `pragma_table_info` 确认 `keys` / `jobs` 两列存在 |
| worker 部署 | `wrangler deploy -c wrangler.toml` | ✅ Version `6d7a3cc3-62cc-47df-8733-d062a5185bc3`；自定义域名与 cron `* * * * *` 完好 |
| 提交推送 | `git commit` → `git push` | ✅ `3f4d5b9`（22 文件，+1841 / −45） |
| APK 构建 | GitHub Actions run `34479374182` | ✅ succeeded（2m20s）；产物 `notify-hub-v1.0.56-c56.apk`（4.1 MB，sha256 `ef0b0d5d…`）已发布到 `latest` Release |
| pages 部署 | `npm run deploy:pages` | ✅ `https://a1867ef4.notify-hub-pages.pages.dev` |
| 线上探活 | `GET /hook/<无效 key>` | ✅ HTTP 404 `{"error":"invalid key"}`（无副作用，仅验存活） |

**Kotlin 编译验证**：此前唯一未验证项（本机无 Android SDK）已由 CI 补齐——构建通过，说明 `AlarmActivity` / `PushService` / 布局 / Manifest 均无编译错误。

### 18.2 ⚠️ 执行中撞上的真实障碍：一个游离配置吃掉了 `wrangler deploy`

`wrangler deploy` 连续三次以 **exit 137、零输出** 被杀，看起来像网络或权限问题，实则是配置发现问题：

- **根因**：本机存在 `/Users/waxilo/Desktop/Code/wrangler.jsonc`——一个残留配置（`name:"ode"`、`compatibility_date:"2026-09-09"`、**`assets.directory:"CodeCliManager"`**，生成于 09-09 15:03，同批还留下 `~/Desktop/Code/.wrangler/`）。
- **机制**：wrangler 会**向 CWD 的上级目录搜索配置文件，且优先采用 `.jsonc`**。于是从 `worker/` 执行时，`Code/` 下的这个 jsonc 压过了本项目的 `wrangler.toml`，wrangler 转而把整个 Tauri 项目 `CodeCliManager` 当作静态资源目录——扫到 63161 个文件、撞上 66 MB 的 `src-tauri/target/debug/.../dep-graph.bin`，报 "Asset too large" 后被 OOM 杀掉。
- **定位过程**：`deploy --help` 正常 → `--dry-run` 同样被杀 → 把输出落盘到文件才拿到那行关键报错（管道/前台运行时空输出，因为进程被 SIGKILL 前缓冲未刷）。
- **绕过**：`wrangler deploy -c wrangler.toml` 显式指定配置即可。**`wrangler pages deploy` 不支持 `-c`**（报 "Pages does not support custom paths for the Wrangler configuration file"），但其场景下 wrangler 只对该残留文件告警（"missing pages_build_output_dir … Ignoring configuration file for now"）并正常部署。
- **⚠️ 仍需处理**：`worker/package.json` 的 `deploy` 脚本未带 `-c`，因此**该残留文件不清理，`npm run deploy` 依旧会失败**；它同样影响 `~/Desktop/Code/` 下的 CV、WiterDemo 等所有 wrangler 项目。建议删除或改名 `/Users/waxilo/Desktop/Code/wrangler.jsonc`（已把该陷阱记入项目与用户级记忆）。

### 18.3 推送凭据

`origin` URL 内嵌空 token（`https://x-access-token:@github.com/waxilo/notify-hub.git`），直接 `git push` 报 "Invalid username or token"。本次用 `gh auth token` 注入 URL 完成推送（`gh` 已登录账号 `waxilo`，含 `repo`/`workflow` 权限），**未改动任何 git 配置**。

### 18.4 上线后待办

1. **真机验收**（10.3 的 10 条清单），重点三条：滑掉通知是否停震、30 秒超时后横幅是否收回、新渠道「声音关 / 振动开」。
2. **清理 `~/Desktop/Code/wrangler.jsonc`**（见 18.2）。
3. 规则四强度仍为默认值（见 17.5）。

---

## 19. 上线后抢修：`PUT /api/jobs/:id` 返回 500

### 19.1 现象与根因

上线约 6 分钟后，编辑定时任务（`PUT /api/jobs/8`）返回 **500**。

根因是**本次实现引入的**：`worker/src/jobs.js` 的 `updateJob` 中，SQL 已加 `strong_vibrate=?` 占位符、`bind()` 也已加 `strongVibrate`，**但变量声明那一行在早前「并行编辑同一文件发生竞争、部分改动未落盘」时丢失**——于是每次编辑任务都抛 `ReferenceError: strongVibrate is not defined`。

顺带查出第二处漏改：`createJob` 的 INSERT **整列都没带 `strong_vibrate`**，新建任务时该开关被静默丢弃（默认 0）。

### 19.2 为什么测试没拦住（这才是真正要记的）

| 缺口 | 说明 |
|---|---|
| 写入路径完全未覆盖 | `jobs.smoke.js` 只 import 了 `deleteJob` / `listJobs`；`createJob` / `updateJob` **一次都没被调用过**。它测的是 `fireJob` *读取* `strong_vibrate`，而写入路径从未被执行。 |
| 内存 D1 适配层过于宽容 | 适配层的 `bind()` 把 `undefined` 原样交给 `node:sqlite` 而不报错；**真实 D1 会抛 `D1_TYPE_ERROR`**。这个「静默吞掉 undefined」的行为恰好是 bug 逃逸的通道，也是它与生产环境最危险的一处偏离。 |

### 19.3 修复

| 文件 | 改动 |
|---|---|
| `worker/src/jobs.js` | ① `updateJob` 补上 `const strongVibrate = b.strong_vibrate !== undefined ? (b.strong_vibrate ? 1 : 0) : job.strong_vibrate;`（沿用 `updateKey` 的「字段不传就不改」，旧客户端局部更新不会误清开关）。② `createJob` 的 INSERT 补上 `strong_vibrate` 列与对应 bind。 |
| `worker/test/jobs.smoke.js` | ① 新增 5 条断言覆盖 createJob / updateJob 的写入路径，**payload 直接采用用户报错时的那一条**（`daily:21:01` + `+08:00` + `strong_vibrate:true`）。② 适配层 `bind()` 改为对 `undefined` 抛错，对齐真实 D1 的 `D1_TYPE_ERROR`——让同类错误在本地就暴露。 |

### 19.4 验证与上线

- `npm test`：**全绿，76 条通过 / 0 失败**（含新增 5 条）。
- worker 重新部署：Version `0d7f8ab0-faa7-48b4-a2a0-beab78910fe9`。
- 数据侧确认：`SELECT id,name,schedule,strong_vibrate FROM jobs WHERE id=8` → `strong_vibrate = 0`，**证明那次 500 确实没有写入**，用户重试即可生效。
- 提交 `229933f` 已推送（与 `75a34a0` 文档提交一并，经直连绕过不稳定的代理）。

### 19.5 教训

1. **「并行编辑同一文件」这条约定已经造成一次线上事故**——它丢掉的不是格式，而是一行变量声明。凡涉及同一文件的多次改动，一律串行。
2. **测试替身必须比生产更严格，而不是更宽容**。内存 D1 适配层缺的那一个 `undefined` 校验，直接换来了 6 分钟的线上 500。
3. **新增列时，INSERT / UPDATE / 读取三处都要逐一核对**，只改其中两处会在最不容易被测试覆盖的地方留下缺口。

---

## 20. 真机反馈修正：点击横幅进告警页 + 快捷停止按钮 + FSI 失效诊断（2026-09-10）

A+B 上线后用户实测反馈三条：① 息屏时只出现横幅 + 震动（设置页却显示「全屏通知已允许」）；② 点击横幅进入的是主界面，不是告警页；③ 告警页缺一个停止按钮。

### 20.1 「息屏只有横幅」的根因

官方 `setFullScreenIntent` 文档写死了 FSI 的触发条件，逐条对照即可定位：

| 条件 | 现状 | 结论 |
|---|---|---|
| 渠道 importance ≥ IMPORTANCE_HIGH | 渠道 `notify_hub_push_v2` 创建时即为 HIGH | 满足 —— 但可能被用户改低，见下 |
| 声明并持有 USE_FULL_SCREEN_INTENT | 已声明；设置页自检 `canUseFullScreenIntent()` 为 true | 满足 |
| **SystemUI 判定「用户没有在使用设备」** | **App 无法保证，也无法绕过** | **最可疑** |

第二条的官方原文（Android 开发者文档 · `Notification.Builder#setFullScreenIntent`）：

> From `Build.VERSION_CODES.TIRAMISU`, **the system UI will display a heads up notification, instead of launching this intent, while the user is using the device.** This notification will display with emphasized action buttons. **If the posting app holds USE_FULL_SCREEN_INTENT, then the heads up notification will appear persistently until the user dismisses or snoozes it, or the app cancels it.**

所以：
- **亮屏解锁态必然降级为横幅** —— 这是设计行为，不是 bug，App 无解。
- 息屏但系统仍判定「在用」（屏幕状态滞后、抬手亮屏、Smart Lock 免解锁等）同样降级。
- 国产 ROM 另有「后台弹出界面 / 锁屏显示」等自建闸门，进一步收紧。
- 顺带解释了「为什么那条横幅一直挂在那不消失」：持有 FSI 权限时，降级出来的 heads-up 是 **persistent** 的，只在用户划掉/稍后提醒/应用主动取消时才消失。

**结论：全屏告警页定位为「尽力而为的加分项」，持续震动才是可靠的核心。** 这与方案阶段把震动从 Activity 解耦出来的判断一致 —— 若当初把震动绑在 Activity 上，恰好在这种最需要震动的场景里完全失效。

另有一条**App 读得到、却改不回来**的隐患需要单独处理：**渠道重要性**。官方要求 FSI 必须落在 IMPORTANCE_HIGH 及以上的渠道上，而渠道一旦被用户手动调低，`createNotificationChannel` 再也改不回来。设置页此前只查了权限、没查渠道，于是会出现「权限全绿但全屏页不弹」。本次补上检测与跳转入口。

### 20.2 改动

| 文件 | 改动 |
|---|---|
| `PushService.kt` | ① 强震通知的 `contentIntent` 改指向 `AlarmActivity`；普通通知仍进主界面，且**去掉**停震标记 —— 原实现里点一条普通通知会误停「另一条强震消息」正在进行的震动。② 强震通知新增「停止震动」action（停震 + 撤掉 persistent 横幅）。③ 强震通知 `category` 用 `CATEGORY_ALARM`（官方 FSI 的合法用途就是来电/闹钟，同类归置在系统与 ROM 判定中更宽松）。④ 新增 `VISIBILITY_PUBLIC`，锁屏显示正文而不是「内容已隐藏」。⑤ 同一条通知下三类 PendingIntent 的 requestCode 分段（+100k / +200k / +300k），杜绝同 rc 互相更新 extras 造成的「点横幅进错页」。⑥ `ACTION_STOP_VIBRATE` 支持携带 `notif_id`：带 → 停震 + 撤通知；不带 → 只停震（滑掉 / 超时）。⑦ 新增 `logFsiFacts()`，每条强震消息记录 `fsiPerm / channelImportance / notifEnabled / screenOn`。⑧ `PUSH_CHANNEL_ID` 公开，新增 `pushChannelImportance()` 供设置页使用。 |
| `AlarmActivity.kt` | ① 新增状态行实时倒计时（`震动中 · N 秒后自动停止` / `已停止震动`）。② 停止按钮改走 `startService` 并携带 `notifId`：点击 = 停震 + 撤横幅 + 关页面。③ 超时自动关闭**不带** id，横幅交给 `retractHeadsUp` 收回通知栏、保留可回看。④ 新增 `EXTRA_FROM_TAP`：点横幅进页视为「已看到」，进页即停震，但页面留着让用户看完正文。⑤ 按钮文案随状态切换（`停止震动` / `关闭`）。 |
| `activity_alarm.xml` | 新增 `tvAlarmStatus` 倒计时行；底部提示改为「点『停止震动』立即结束；离开本页不会停止震动」（把规则四写进界面）。 |
| `SettingsActivity.kt` · `activity_settings.xml` | 「提醒权限」卡片新增第三项检测：推送渠道重要性分四档（未创建 / 已关闭 / 低于「高」/ 正常），异常时出现「去检查推送渠道设置」按钮直达系统渠道页；说明文案补充 FSI 的三个前置条件与 Android 13 起的降级行为。 |

### 20.3 怎么自证（不依赖 adb）

App 诊断日志写在 `下载/NotifyHub/notify-hub.log`。收到一条强震消息后比对：

- `fsi facts: fsiPerm=true channelImportance=4 notifEnabled=true screenOn=false` → 三个外部开关都正常（`4` 即 IMPORTANCE_HIGH）。
- 紧接着出现 `AlarmActivity onCreate` → 全屏页确实被拉起了。
- **只有 `strong vibrate start`、没有 `AlarmActivity onCreate`** → 这一次被系统降级为横幅（Android 13+ 的「用户在使用设备」判定，或 ROM 拦截）。震动不受影响，点横幅可直接进告警页。

### 20.4 仍未决

- 规则四（按 Home / 电源 / Back 离开告警页不停震）维持不变，但已在告警页界面上明示。
- 30 秒超时后横幅是否真的被收回通知栏，仍需真机确认（官方无明文保证）。
- 若某台设备上 FSI 长期不可用，可考虑震动期间由服务侧周期性刷新通知以强化「横幅常驻」，但会牺牲通知栏整洁度，暂不做。

## 21. 告警页精简：移除「查看详情」按钮（2026-09-10）

**动机**：告警页被拉起的场景是「锁屏/灭屏下的强力提醒」，此时要用户做的只有一件事 —— 决定是否让它继续响。多一个「查看详情」按钮会把页面变成半个入口，既分散注意力，也让「停止」这个唯一动作不够突出。

**改动**（纯删减，无新增逻辑）：

- `activity_alarm.xml`：删除 `btnOpenApp`。
- `AlarmActivity.kt`：删除对应 `setOnClickListener`（原先跳 `KeysActivity` 且不停震）。

**未受影响的路径**：告警页仍只有「停止震动」一个按钮，其余停止入口（通知上的快捷停止、滑掉通知、30 秒超时）不变；用户仍可通过通知栏/桌面图标自行进入 App 查看详情 —— 只是不再由告警页代劳。

## 22. 告警页精简 + 息屏全屏的真正解法（2026-09-10）

### 22.1 告警页只留三样东西

`activity_alarm.xml` / `AlarmActivity.kt`：删掉「强力提醒」标签、震动状态行（含倒计时）、底部提示语与「查看详情」按钮，页面上只剩**标题 + 正文 + 一个按钮**。

- 理由：这一页被拉起的场景是「息屏/锁屏下的强力提醒」，用户要做的唯一决定是「让它继续响还是停」。任何附加信息都在稀释这个决定。
- 连带删除：`AlarmActivity` 里的 `tick` 倒计时 `Runnable` 与 `deadline` 字段（`tvAlarmStatus` 已不存在，留着会 NPE）。**30 秒自动关闭行为保留**，只是不再显示倒计时。
- 按钮文案仍随状态变化：震动中显示「停止震动」，已停显示「关闭」。

### 22.2 「系统闹钟能全屏，本应用只剩横幅」—— 根因不在 FSI 本身

真机现象：通知权限、全屏通知、渠道重要性三项全绿，息屏依然只有横幅；而系统闹钟一切正常。

根因是 **FSI 之外还有一道更外面的闸门：Android 10 起的「后台启动 Activity 限制」（BAL）**。`setFullScreenIntent()` 的语义是「请系统代为启动 Activity」，系统在代为启动前，仍要判断发起方是否被允许从后台启动 Activity。官方给的豁免清单里，与系统闹钟/通话相关的是**预装应用的默认白名单**；第三方应用不在其中。国产 ROM（小米/华为等）还额外加了一个「后台弹出界面」开关，**默认关闭，且一旦关闭会把上述所有通道一并废掉** —— 系统时钟应用天然在白名单里，所以它能全屏，我们不行。这也解释了为什么权限检查全绿却毫无作用：那些检查都对，只是闸门在更外面。

### 22.3 解法：SYSTEM_ALERT_WINDOW 是 BAL 的硬豁免

官方豁免清单中，**「应用已获得 SYSTEM_ALERT_WINDOW 权限」是普通应用能自己争取到的那一条**（其余多是系统组件或设备所有者）。拿到「显示在其他应用上层」后，应用可以从后台启动自己的 Activity，**锁屏下同样生效**。

据此新增第二条并行通道：

| | 通道 ①  | 通道 ②（新增） |
|---|---|---|
| 机制 | 通知 `fullScreenIntent`，请系统代为启动 | 服务直接 `startActivity`，自己启动 |
| 前提 | 全屏通知权限 + 渠道 ≥ HIGH + 系统/ROM 放行 | **悬浮窗权限** |
| 受影响面 | 被 BAL / ROM「后台弹出界面」拦截 | 只要能拿到悬浮窗权限即可 |

实现要点：

1. `AndroidManifest.xml` 增加 `SYSTEM_ALERT_WINDOW`（特殊权限，只能跳系统页手动开，无运行时弹窗）。
2. `PushService.tryLaunchAlarmDirectly()`：仅当 `Settings.canDrawOverlays()` 为真、**且设备处于息屏或锁屏时**才直接拉起 `AlarmActivity`，并带 `FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_REORDER_TO_FRONT`。
   - 场景闸门与 AOSP 的 FSI 判定保持一致（息屏/锁屏 → 全屏；亮屏使用中 → 只给横幅），避免抢占用户手上正在做的事。
   - 未获权限时 `startActivity` 被系统**静默拦截**（不抛异常、不崩溃），因此无需额外防护。
   - 与 FSI **并行而非二选一**：放行哪条走哪条；两条都到也无害 —— `AlarmActivity` 是 `singleInstance`，只会有一个实例，第二次进入走 `onNewIntent`。
3. 设置页新增「悬浮窗权限」状态行与跳转按钮（`ACTION_MANAGE_OVERLAY_PERMISSION`，带 package 的入口个别 ROM 不认，已退到权限列表页），并在卡片底部补上「后台弹出界面」的文字引导（非官方 API，**不做反射探测** —— 失效的探测比不探测更糟）。
4. `logFsiFacts()` 增加 `overlayPerm=` 一项。新的自证方式：`strong vibrate start` 之后若既无 `AlarmActivity onCreate` 也无 `direct launch alarm activity`，才说明两条通道都被拦了。

**验证顺序**（真机）：设置页 → 开启悬浮窗权限 → 息屏触发 Test job → 观察是否直接弹出全屏告警页；对照日志确认走的是 `direct launch alarm activity` 还是 FSI。

## 23. 开了悬浮窗权限仍未全屏：补齐「可见窗口」例外（2026-09-10）

### 23.1 现象

第 22 章上线后，用户在设置页开启「悬浮窗权限」，息屏触发 Test job，仍然只有横幅 + 震动。

### 23.2 查证：BAL 的例外清单里，SAW 不是唯一条件

官方《活动安全性》文档（`developer.android.com/guide/components/activities/secure-bal`）列出了
「应用可以从后台启动 activity」的全部例外，其中**两条是我们能自己争取的**：

1. **应用具有可见窗口**（例如前台有 Activity）；
2. 应用已获得用户授予的 **SYSTEM_ALERT_WINDOW** 权限。

真正的缺口在第 1 条：第 22 章的实现只满足了第 2 条。而后台 Service **本身没有任何窗口**。

Android 15 的行为变更印证了这个方向 —— 文件 `about/versions/15/behavior-changes-15` 中
「Restrictions on starting foreground services while an app holds the SYSTEM_ALERT_WINDOW
permission」一段：

> If an app targets Android 15, this exemption is now narrower. The app now needs to have the
> SYSTEM_ALERT_WINDOW permission **and also have a visible overlay window**. That is, the app needs
> to first launch a `TYPE_APPLICATION_OVERLAY` window and the window needs to be visible before you
> start a foreground service.

该变更原文针对「启动前台服务」，但它明确了 Google 对 SAW 豁免的收紧方向：
**光有权限不够，必须真的存在一个可见的 overlay 窗口。** 部分 ROM 的后台启动判定同样按
「有可见窗口」这一条走。

此外，Android 14 起 **PendingIntent 不再默认携带 BAL 特权**，须由发送方显式 opt-in：

> 如需选择启用，应用应将包含 `setPendingIntentBackgroundActivityStartMode(
> ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)` 的 ActivityOptions 软件包
> 传递给 `PendingIntent.send()` 或类似方法。

### 23.3 修复

| 项 | 改动 |
|---|---|
| 补「可见窗口」 | `PushService.showLaunchOverlay()`：直拉前先挂一个 **1×1 全透明 `TYPE_APPLICATION_OVERLAY`** 悬浮窗（不可触摸、不抢焦点），拉起告警页后再回收 |
| 显式 opt-in | `PushService.sendAlarmIntent()`：Android 14+ 走 `PendingIntent` + `MODE_BACKGROUND_ACTIVITY_START_ALLOWED`；低版本仍用 `startActivity` |
| 线程约束 | `WindowManager.addView` 要求有 Looper，而 WS 回调跑在 OkHttp 线程上 —— `tryLaunchAlarmDirectly` 改为 `handler.post` 到主线程再执行 |
| 资源回收 | `onDestroy` 补 `hideLaunchOverlay()`；连续多条消息时，新一次直拉会先撤掉旧窗口 |

### 23.4 诊断回路：不再依赖用户抓日志

`startActivity` 被 BAL 拦截时是**静默丢弃**（不抛异常、不回调），返回值毫无意义。
因此改为**事后复核**：

- `AlarmActivity.onCreate` 写入 `PushService.alarmStartedAt`（`elapsedRealtime`，单调时钟）；
- `launchAlarmOnMain` 在启动后 2.5 秒比对时间戳，把结论写入 `SharedPreferences`；
- **设置页「提醒权限」卡片直接显示这一条**，四类结论各自对应一个明确的断点：

| 显示 | 含义 | 下一步 |
|---|---|---|
| 未尝试：悬浮窗权限未开启 | 权限没真正授予（或开成了厂商的「后台弹出界面」） | 重新到系统设置授权 |
| 未尝试：屏幕亮且已解锁 | 设计行为，此时只用横幅 | 息屏/锁屏后再测 |
| 成功：全屏告警页已弹出 | 通道 ② 生效 | — |
| 失败：启动被系统拦截 | 厂商「后台弹出界面」未允许 | 到应用信息里打开该开关 |

日志同步新增 `direct launch attempt ... overlay= sent=` 与
`direct launch verify ... -> blocked by system`。

### 23.5 仍需确认

- 用户手上的 APK 是否已包含第 22 章的直拉逻辑（`v1.0.63` 起才有）。
- 厂商「后台弹出界面」是否已允许（小米/华为等独立开关，默认关闭，且会同时废掉两条通道）。
- 若两者都满足仍失败，则回到「震动 + 横幅」这一形态 —— 震动不受 BAL 影响，
  本来就是最可靠的叫醒手段。

---

## 24. 移除通知上的「停止震动」按钮（2026-09-10）

### 24.1 决策

第 20 章给强震通知挂过一个 `addAction` 的「停止震动」按钮，本版**去掉**。

理由：通知横幅的可视面积本就有限，挂上动作按钮后部分 ROM 会把标题与正文压缩到一行，
反而看不清「是什么事」—— 而告警场景下，用户第一眼要获取的信息恰恰是这个。
按钮提供的便利（少点一步）不值得用它换掉正文的可读性。

### 24.2 改动

| 文件 | 变更 |
|---|---|
| `PushService.kt` | 删除 `buildMessageNotification` 中的 `b.addAction(...)` 整块；顺带删除只被它使用的 `ACTION_REQUEST_OFFSET` 常量 |

### 24.3 停止路径不受影响

去掉按钮后仍有**三条**入口，覆盖全部使用场景：

| 入口 | 行为 | 适用场景 |
|---|---|---|
| 点横幅 → 告警页 → 「关闭」 | 停震 + 撤横幅 + 关页面 | 已拿到全屏页 / 点横幅进入 |
| 滑掉通知 | 停震 | 通知栏直接清理 |
| 30 秒超时 | 停震，横幅收回通知栏保留可回看 | 用户未处理 |

`EXTRA_NOTIF_ID` 常量保留 —— 告警页按钮仍走它（`>0` 表示「连横幅一起撤掉」），
只是不再有第二个调用方。同类 requestCode 偏移现在只剩 `FS_REQUEST_OFFSET` 与
`DELETE_REQUEST_OFFSET` 两个，仍保持互不覆盖。

---

## 25. 开满权限仍无全屏：改用悬浮窗直绘（第三条通道，2026-09-10）

### 25.1 复核结论：代码没有缺口，卡点在系统

逐行核对了实现，四个环节都是对的：

| 环节 | 状态 |
|---|---|
| `tryLaunchAlarmDirectly` 是否被调用 | ✅ 在 `onMessage` 里随 `startStrongVibrate` 一起调用 |
| 悬浮窗 1×1 可见窗口（BAL 例外「应用具有可见窗口」） | ✅ `addView` 成功才继续 |
| Android 14 的 PendingIntent 显式 opt-in | ✅ `MODE_BACKGROUND_ACTIVITY_START_ALLOWED` |
| 告警页自身的锁屏能力 | ✅ `setShowWhenLocked` / `setTurnScreenOn` + Manifest 同名属性 |

也就是说：**①② 两条通道的实现都是完整的，被拦的是「启动 Activity」这个动作本身。**

官方文档（`background-starts`）确认的例外清单里，我们够得着的两条是
「应用具有可见窗口」与「已获 SYSTEM_ALERT_WINDOW」；而国产 ROM 在此之上还有一道
**「后台弹出界面」**开关（默认关闭，位置在「应用信息」里而不是「特殊应用权限」）——
它是厂商自己的实现，一旦拦下，①② 会**同时**失效。这正是「三项权限全绿、依然只出横幅」。

### 25.2 换的方案：把告警页画成悬浮窗

关键认识：**悬浮窗不走「启动 Activity」这条路。** `WindowManager.addView` 由本进程直接完成，
BAL 与「后台弹出界面」都管辖不到它，只需要悬浮窗权限 —— 而用户已经开了。

于是新增第三条通道：**直接把 `activity_alarm.xml` 渲染到一个全屏 `TYPE_APPLICATION_OVERLAY`
窗口上**，外观与 Activity 版完全一致（复用同一份布局）。

| 项 | 取值 | 作用 |
|---|---|---|
| 窗口类型 | `TYPE_APPLICATION_OVERLAY` | 悬浮窗，唯一需 `SYSTEM_ALERT_WINDOW` |
| `FLAG_SHOW_WHEN_LOCKED` | — | 盖在锁屏之上 |
| `FLAG_TURN_SCREEN_ON` | — | 点亮屏幕 |
| `FLAG_KEEP_SCREEN_ON` | — | 页面展示期间不熄屏（窗口移除即失效，不漏电） |
| `FLAG_NOT_FOCUSABLE` | — | 不抢输入焦点；触摸事件仍投递到本窗口，按钮可点 |
| 唤醒锁 | `ACQUIRE_CAUSES_WAKEUP`，10 秒 | `FLAG_TURN_SCREEN_ON` 对非 Activity 窗口各家支持不一，兜底（新增 `WAKE_LOCK` 权限） |

### 25.3 触发时机：复核失败即自动切换

不新增用户开关 —— 沿用已有的 2.5 秒复核：

```
直拉 Activity → 2.5s 后看 AlarmActivity 有没有 onCreate
  ├─ 起了 → 记录「成功（Activity 通道）」，什么都不做
  └─ 没起 → 记录被拦，立刻 showAlarmOverlay() 画悬浮窗
              └─ 成功 → 「成功：全屏告警页已弹出（悬浮窗通道）」
```

好处：Activity 能用时优先用 Activity（有独立任务栈、返回键行为正常）；被拦时自动降级，
用户不必自己去猜是哪个开关没开。**代价是最迟 2.5 秒后才出现悬浮窗** —— 期间震动照常，
所以体感上仍是「一收到就开始响」。

### 25.4 生命周期与停止路径

悬浮窗的回收挂进了 `stopStrongVibrate()`，因此四条停止入口自动全部覆盖：

| 入口 | 效果 |
|---|---|
| 悬浮窗上的「关闭」 | 停震 + 撤通知 + 撤悬浮窗 |
| 通知被滑掉 / 告警页按钮 / 通知快捷停止 | 停震 → 连带撤悬浮窗 |
| 30 秒超时 | 停震 → 连带撤悬浮窗；另有独立的 30 秒定时只撤窗 |
| 服务 `onDestroy` | 显式 `hideAlarmOverlay()`，不留残影 |

场景闸门不变：**亮屏且已解锁时三条通道都不走**，只给横幅（不抢占用户手上的事）。
此时设置页「上次强力提醒」会显示「未尝试：屏幕亮且已解锁」—— 这是设计行为，不是故障。

### 25.5 两个 Kotlin 陷阱（已规避）

- **隐式接收者歧义**：`findViewById<Button>(...).apply { … setOnClickListener { getSystemService(…) } }`
  里的 `getSystemService` 会命中 `View.getSystemService`（Button 是外层隐式接收者），
  静默走错实现。全部改成显式 `this@PushService.xxx`。
- **`inflate` 用的主题**：Service 上下文没有 AppCompat 主题。`activity_alarm.xml` 只用框架属性
  （`android:*`）与自定义 drawable，不引用 `?attr/*`，因此普通 `LayoutInflater.from(service)` 可安全渲染。

### 25.6 真机验证

1. 装 v1.0.66+，设置页确认「悬浮窗权限：已开启」；
2. **息屏**（不要亮屏，也不要解锁）触发 Test job；
3. 预期：震动开始 → 最迟 2.5 秒后弹出全屏告警页并点亮屏幕；
4. 设置页「上次强力提醒」应显示「成功：全屏告警页已弹出（悬浮窗通道）」。

若这一条也失败，说明该 ROM 连 `TYPE_APPLICATION_OVERLAY` 盖锁屏都禁止
（少数深度定制 ROM 如此）—— 那就只剩「震动 + 横幅」这一形态，
而震动本来就不受这些限制，仍是最可靠的叫醒手段。

---

## 26. 放弃全屏：移除三条通道，回归「横幅 + 持续震动」（2026-09-10）

### 26.1 结论

第 22–25 章连续三次尝试全屏，全都在用户真机上失败：

| 迭代 | 手段 | 结果 |
|---|---|---|
| 第 22 章 | `SYSTEM_ALERT_WINDOW` 后服务自拉 Activity | ❌ 仍只有横幅 |
| 第 23 章 | 补「可见窗口」例外（1×1 overlay）+ PendingIntent 显式 opt-in | ❌ 仍只有横幅 |
| 第 25 章 | 完全绕开 Activity 启动，把告警页画成 `TYPE_APPLICATION_OVERLAY` 全屏悬浮窗 | ❌ 仍只有横幅 |

第 25 章那条**已经不经过 Activity 启动**，BAL 与厂商「后台弹出界面」都管辖不到它 ——
它仍然失败，说明该 ROM 连「应用悬浮窗覆盖锁屏」本身也禁止。这已属**系统侧不可控项**，
继续加通道只会堆积代码而不会改变结果。

于是改为**主动收窄范围**：视觉提醒统一为一条横幅通知，「确保被注意到」由持续震动单独承担 ——
震动从一开始就不依赖任何界面是否被拉起，是这套方案里唯一 100% 可靠的通道。

### 26.2 移除清单

| 文件 | 移除内容 |
|---|---|
| `PushService.kt` | `tryLaunchAlarmDirectly` / `launchAlarmOnMain` / `showLaunchOverlay` / `hideLaunchOverlay` / `showAlarmOverlay` / `hideAlarmOverlay` / `wakeScreenBriefly` / `sendAlarmIntent` / `recordLaunchResult` / `logFsiFacts` / `retractHeadsUp` |
| `PushService.kt` | `buildMessageNotification` 的 `fullScreenIntent` 分支、`FS_REQUEST_OFFSET`、`withFullScreen` 判定；`EXTRA_NOTIF_ID` 与「停震并撤通知」分支；直拉/悬浮窗的全部字段与常量；`canUseFullScreenIntent()` / `canDrawOverlays()` / `lastLaunchResult()` |
| `PushService.kt` | 18 个已无用途的 import（`ActivityOptions`、`KeyguardManager`、`PixelFormat`、`SystemClock`、`Settings`、`Gravity`、`LayoutInflater`、`View`、`WindowManager`、`PowerManager`、`Button`、`TextView`、`R` 等） |
| `AlarmActivity.kt`、`activity_alarm.xml` | 整文件删除 —— 它只服务于「全屏告警页」这一个目的 |
| `AndroidManifest.xml` | `USE_FULL_SCREEN_INTENT`、`SYSTEM_ALERT_WINDOW`、`WAKE_LOCK` 三项权限 + `AlarmActivity` 声明 |
| `SettingsActivity.kt` | 全屏通知状态行、悬浮窗状态行、「上次强力提醒」结论行，及其三个跳转方法与相关 import |
| `activity_settings.xml` | `tvFsiStatus` / `btnFsiSetting` / `tvOverlayStatus` / `btnOverlaySetting` / `tvLastLaunch` 五个控件与三段说明文字 |

### 26.3 保留与调整

**保留**：持续震动（循环波形 `0,700,500`、30 秒超时、通知被禁用时不震）、横幅通知
（渠道 `notify_hub_push_v2`、静音、`VISIBILITY_PUBLIC`）、防重缓存、已触达回调。

调整两处语义：

- **点击强震横幅 → 主界面并停震**（原先指向告警页）。复用 `KeysActivity.handleStopVibrate()`：
  通知的 contentIntent 带 `EXTRA_STOP_VIBRATE=true`，`KeysActivity` 见到就发一次停止广播。
  普通消息带 `false`，因此不会误停另一条强震消息 —— 这个区分从第 20 章起就存在，现在把落点从
  告警页改回主界面。
- **通知分类改回 `CATEGORY_MESSAGE`**。`CATEGORY_ALARM` 是专为 FSI 判定放宽而选的
  （官方把 FSI 的合法用途限定为来电/闹钟），全屏既然移除，就没必要再借闹钟的语义。
- **`retractHeadsUp()` 一并删除**。它存在的唯一理由是「持 `USE_FULL_SCREEN_INTENT` 时，
  解锁态那条横幅是 persistent、不会自己消失」；权限移除后横幅几秒后自动收回通知栏，
  超时只需停震。

### 26.4 最终的停止路径（三条）

| 入口 | 行为 |
|---|---|
| 点击强震横幅 | 进主界面 + 立即停震 |
| 滑掉通知 | 停震（`deleteIntent` → `startService`，见第 19 章的版本差异说明） |
| 30 秒超时 | 停震 |

### 26.5 设置页文案

「提醒权限」卡片收敛为**两项检测**：通知权限、推送渠道重要性。说明文字改为如实描述：

> 强力提醒 = 无声横幅 + 持续震动（最长 30 秒）。点击横幅、滑掉通知都会立即停止震动。
> 震动由后台连接直接驱动，与是否锁屏、是否静音、是否处于勿扰无关；但需要上面两项都正常……
> 若长时间收不到提醒，请再到系统「应用信息」里允许后台运行。

主动删掉「全屏」「悬浮窗」「后台弹出界面」等已不再适用的话术 —— 保留一个做不到的承诺，
比不承诺更糟。

---

## 27. 移除后全项目复查（2026-09-10）

结论：**全屏相关代码已移除干净，无残留引用、无孤立资源、无断裂链路。**
以下为逐项核查方法与结果，可复现。

### 27.1 符号残留

| 检查项 | 方法 | 结果 |
|---|---|---|
| 源码关键字 | 全仓 grep `AlarmActivity` / `activity_alarm` / `fullScreenIntent` / `Overlay` / `悬浮窗` / `全屏` / `后台弹出`（限 `*.kt/xml/js/html/gradle/toml`） | 仅命中「无关词」与「刻意保留的说明注释」（见 27.4） |
| 文件是否真删 | 按路径探测 | `ui/AlarmActivity.kt`、`res/layout/activity_alarm.xml` 均不存在 |
| Manifest | 列出全部 `uses-permission` 与组件 | 7 项权限（INTERNET / POST_NOTIFICATIONS / FOREGROUND_SERVICE / FOREGROUND_SERVICE_DATA_SYNC / REQUEST_INSTALL_PACKAGES / VIBRATE / WRITE_EXTERNAL_STORAGE）；5 个 Activity（Login/Keys/Settings/Jobs/History）+ FileProvider + PushService。**无** `USE_FULL_SCREEN_INTENT` / `SYSTEM_ALERT_WINDOW` / `WAKE_LOCK`，无告警页声明 |
| 布局控件 | 导出 `activity_settings.xml` 全部 `@+id` | 12 个 id，**无** `tvFsiStatus` / `btnFsiSetting` / `tvOverlayStatus` / `btnOverlaySetting` / `tvLastLaunch` |
| Kotlin 常量 | 复核 `PushService.companion object` | 只剩 `DELETE_REQUEST_OFFSET`；`FS_REQUEST_OFFSET` 与 `EXTRA_NOTIF_ID` 已删 |

### 27.2 资源孤立性

删掉的 `activity_alarm.xml` 只用过 `@color/bg` / `card` / `text_main` / `text_secondary` ——
四处**都仍被其他布局引用**，因此本次移除**没有孤立任何资源**。

（另发现 `colors.xml` 中 `ok` / `warn` / `warn_bg` / `danger_bg` 从未被 `@color/` 引用。
`git log -S"@color/warn"` 无任何命中，证明其为**既存**现象，与本次移除无关：原因是
`SettingsActivity` 等直接把色值写成 `0xFFC07F00.toInt()`，未使用 `@color/` 引用。）

### 27.3 链路与语法

- **停震链路完整**：`PushService` 写入 `EXTRA_STOP_VIBRATE=vibrate` → `KeysActivity.handleStopVibrate()`
  取出并 `removeExtra` → 发 `ACTION_STOP_VIBRATE` 广播 → `PushService` 停震。普通消息带 `false`，
  不会误停他条。
- **通知构建**：`buildMessageNotification` 中已无 `setFullScreenIntent` / `addAction` / `EXTRA_NOTIF_ID`；
  `CATEGORY_MESSAGE` + `VISIBILITY_PUBLIC`；`deleteIntent` 仅在 `vibrate=true` 时挂。
- 全部 Kotlin 文件括号平衡；全部 XML 通过 `xml.dom.minidom` 解析。
- **未使用 import：0 处**（此前 `UpdateChecker.kt` 残留一个 `android.app.PendingIntent`，已清）。

### 27.4 刻意保留的两处「命中」

| 位置 | 内容 | 为何保留 |
|---|---|---|
| `PushService.kt` 顶部注释 | 「不做全屏告警页」及其原因（BAL + 厂商「后台弹出界面」） | 防止后人重新踩同一个坑，是**决策依据的留档**而非死代码 |
| `pages/src/app.js` | `悬浮面板`（hover 面板）、`服务器告警`（示例文案） | 与通知提醒无关的同形词 |

### 27.5 工具教训（重要）

macOS 自带 **BSD `grep` 不支持 `\b` 词边界**：`grep -E "\bView\b"` 会静默返回空，
据此会误判「import 未使用」。本次核查中 `SettingsActivity.kt` 的 `import android.view.View`
差点因此被误删 —— 它实际被第 137/142/147/152 行的 `View.GONE` / `View.VISIBLE` 使用。

**判定未使用符号必须用 Python `re`（支持 `\b`）或 `grep -w`，不要用 BSD grep 的 `\b`。**

