package com.example.notifyhub.data

import android.app.ActivityOptions
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.view.View
import android.view.WindowManager
import com.example.notifyhub.LogHelper
import com.example.notifyhub.api.Api
import com.example.notifyhub.ui.AlarmActivity
import com.example.notifyhub.ui.KeysActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

// 前台服务：维持与 Worker 的 WebSocket 长连接，收到推送立即弹系统通知
//
// 强力震动（vibrate=true 的消息）在本服务内完成，**不放在 Activity**：
// 全屏 Intent（FSI）只在锁屏/灭屏时真正拉起 Activity，解锁态下系统一律降级为横幅、
// Activity 根本不启动 —— 把震动绑在 Activity 生命周期上，恰好在最需要它的场景直接失效。
// 震动在这里只是「马达直调」，不受锁屏/亮屏、静音模式、勿扰策略影响。
//
// 全屏告警页走两条并行通道：① 通知的 fullScreenIntent（请系统代为启动，由系统判定是否放行）；
// ② 拿到悬浮窗权限后本服务自己把告警页拉起来（见 tryLaunchAlarmDirectly）。
// 只留 ① 的话，ROM 的 BAL / 「后台弹出界面」闸门会让息屏场景退化成「只有横幅」。
class PushService : Service() {

    private val client = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)   // 协议层保活
        .connectTimeout(15, TimeUnit.SECONDS)
        .build()
    private var ws: WebSocket? = null
    private var retry = 0
    private var authFailed = false          // token 无效（401）时停止重试，等重新登录后再启动
    private val recentKeys = HashMap<String, Long>()  // 防重缓存：key -> 首次收到时间戳
    private val handler = Handler(Looper.getMainLooper())

    // ---------- 强力震动 ----------
    private val vibrator: Vibrator? by lazy { resolveVibrator() }
    private var vibrating = false
    private var stopReceiver: BroadcastReceiver? = null
    // 超时兜底：用户一直不处理时自动停，避免无限震动耗电 / 无法操作设备
    private val stopVibrateRunnable = Runnable { onVibrateTimeout() }
    // 超时后要把横幅收回通知栏，所以得记住这条通知的内容
    private var strongMsgId = 0L
    private var strongTitle: String? = null
    private var strongBody: String = ""

    // ---------- 直拉告警页（第二条通道）的状态 ----------
    // 让应用「具有可见窗口」的 1×1 透明悬浮窗，用完即撤（见 showLaunchOverlay）
    private var launchOverlay: View? = null
    // 直拉后的复核任务：判断这次到底有没有被系统放行
    private var pendingVerify: Runnable? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        // 根因修复（v1.0.39 起退出登录后闪退）：
        // 退出登录后 token 已清空，但 START_STICKY 服务仍会被系统反复重启；
        // 后台进程调用 startForeground 会被 Android 12+ 拒绝并杀进程，形成崩溃循环。
        // 因此：无登录态时根本不尝试前台化，直接停止
        if (TokenStore(this).token.isNullOrBlank()) {
            LogHelper.append(this, "PushService onCreate: no token -> stopSelf (skip foreground)")
            stopSelf()
            return
        }
        try {
            startForeground(FOREGROUND_ID, buildForegroundNotification())
            LogHelper.append(this, "PushService startForeground ok")
        } catch (e: Exception) {
            // 后台重启被系统拒绝：静默停掉自己并留痕，避免崩溃循环导致 App 无法进入
            LogHelper.append(this, "startForeground rejected: ${e.javaClass.simpleName}: ${e.message}")
            stopSelf()
            return
        }
        registerStopReceiver()
        connect()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 「滑掉通知」的 deleteIntent 走 startService 送达（见 buildMessageNotification 的说明）
        if (intent?.action == ACTION_STOP_VIBRATE) {
            // 带 notif_id = 用户主动按了「停止震动」（通知上的按钮 / 告警页按钮）：
            // 停震之外还要把横幅撤掉。持 USE_FULL_SCREEN_INTENT 时那条横幅是 persistent 的，
            // 不会自己消失 —— 只停震不撤通知，用户回来会看到「横幅还挂着但已经没动静」。
            // 不带 id = 滑掉通知（已经没了）或超时，无需 cancel。
            val notifId = intent.getIntExtra(EXTRA_NOTIF_ID, 0)
            LogHelper.append(this, "PushService onStartCommand: stop vibrate notifId=$notifId")
            stopStrongVibrate()
            if (notifId > 0) {
                runCatching {
                    (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(notifId)
                }
            }
            if (TokenStore(this).token.isNullOrBlank()) {
                stopSelf()
                return START_NOT_STICKY
            }
            return START_STICKY
        }
        LogHelper.append(this, "PushService onStartCommand")
        // 已退出登录：不重连，且返回 START_NOT_STICKY，阻止系统再次拉起（切断崩溃循环）
        if (TokenStore(this).token.isNullOrBlank()) {
            LogHelper.append(this, "no token -> stopSelf, START_NOT_STICKY")
            stopSelf()
            return START_NOT_STICKY
        }
        // 重新登录后再次 startService：重置鉴权失败标记并在未连接时重新 connect
        if (authFailed) {
            authFailed = false
            retry = 0
            connect()
        } else if (ws == null) {
            connect()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        // 服务没了震动必须停：留着一个没人能取消的震动比不震更糟
        stopStrongVibrate()
        // 悬浮窗也必须撤：服务被清掉后没人再来回收它
        hideLaunchOverlay()
        stopReceiver?.let {
            try { unregisterReceiver(it) } catch (_: Exception) {}
        }
        stopReceiver = null
        ws?.close(1000, "service destroyed")
        ws = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ---------- 连接 ----------

    private fun wsUrl(): String? {
        val cfg = ConfigStore(this)
        val token = TokenStore(this).token ?: return null
        val base = cfg.apiBase.trim().trimEnd('/')
        val url = try { java.net.URL(base) } catch (_: Exception) { return null }
        val scheme = if (url.protocol == "https") "wss" else "ws"
        val port = if (url.port != -1) ":${url.port}" else ""
        return "$scheme://${url.host}$port/ws?token=$token"
    }

    private fun connect() {
        val url = wsUrl() ?: return  // 未登录或地址无效：不连
        ws?.cancel()
        val req = Request.Builder().url(url).build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                retry = 0
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text == "pong") return
                try {
                    val obj = JSONObject(text)
                    if (obj.optString("type") == "notification") {
                        // 3 秒防重缓存：服务端超时重推同一条消息时，不重复弹通知
                        val now = System.currentTimeMillis()
                        recentKeys.entries.removeAll { now - it.value > DEDUP_WINDOW_MS }
                        val dedupKey = obj.optString("dedup_key").ifEmpty { "id:${obj.optLong("id")}" }
                        if (recentKeys.put(dedupKey, now) != null) return
                        // 通知标题：有 key 的通知（外部 webhook）用 key 名，没有 key 的（定时任务）
                        // 用服务端下发的 title —— 它就是任务名称。正文 = 消息内容。
                        // 服务端的 title 与 key 名一致时不会重复拼进正文。
                        val keyName = obj.optString("key_name")
                        val msgTitle = obj.optString("title")
                        val msgBody = obj.optString("body")
                        val msgId = obj.optLong("id", 0L)
                        // 服务端按 key/job 的开关下发此字段（旧版服务端不会带，取默认 false →
                        // 退化为普通提醒，两端可独立上线）
                        val vibrate = obj.optBoolean("vibrate", false)
                        val title = keyName.ifEmpty { msgTitle.ifEmpty { "新通知" } }
                        showNotification(title, msgBody, msgId, vibrate)
                        // 先弹通知再起震动：渠道自带的那一次短震也在这条路径里
                        if (vibrate) {
                            startStrongVibrate(msgId, title, msgBody)
                            // FSI 之外的第二条路：见 tryLaunchAlarmDirectly 的说明
                            tryLaunchAlarmDirectly(msgId, messageNotifId(msgId), title, msgBody)
                        }
                    }
                } catch (_: Exception) {
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                ws = null
                if (response?.code == 401) {
                    // token 已失效：停止重试，等待用户重新登录后由 onStartCommand 触发重连
                    authFailed = true
                    TokenStore(this@PushService).clear()
                    return
                }
                scheduleReconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                ws = null
                if (!authFailed) scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        retry = minOf(retry + 1, 6)
        handler.postDelayed({ connect() }, retry * 5_000L)
    }

    // ---------- 强力震动：启动 / 停止 ----------

    private fun resolveVibrator(): Vibrator? = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        else @Suppress("DEPRECATION") getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
    }.getOrNull()

    private fun registerStopReceiver() {
        if (stopReceiver != null) return
        val filter = IntentFilter(ACTION_STOP_VIBRATE)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                LogHelper.append(this@PushService, "stop vibrate broadcast received")
                stopStrongVibrate()
            }
        }
        stopReceiver = receiver
        try {
            // 仅应用内广播：API 33+ 必须显式声明导出标志
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
            else
                registerReceiver(receiver, filter)
        } catch (e: Exception) {
            stopReceiver = null
            LogHelper.append(this, "register stop receiver failed: ${e.message}")
        }
    }

    private fun startStrongVibrate(id: Long, title: String, body: String) {
        // 规则：用户已把本应用的通知关掉时不应震动 —— 否则就是「我把通知关了它还在震」，
        // 这种体验被投诉是必然的。
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (!nm.areNotificationsEnabled()) {
            LogHelper.append(this, "strong vibrate skipped: notifications disabled")
            return
        }
        val v = vibrator
        if (v == null || !v.hasVibrator()) {
            LogHelper.append(this, "strong vibrate skipped: no vibrator")
            return
        }

        strongMsgId = id
        strongTitle = title
        strongBody = body

        // 连续多条消息到达：只刷新超时，不叠加震动（同一条马达没法叠加）
        handler.removeCallbacks(stopVibrateRunnable)
        if (!vibrating) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    // repeat=0 → 从 timings[0] 起无限循环，必须 cancel() 才停
                    v.vibrate(VibrationEffect.createWaveform(VIBRATE_PATTERN, 0))
                else
                    @Suppress("DEPRECATION") v.vibrate(VIBRATE_PATTERN, 0)
                vibrating = true
                LogHelper.append(this, "strong vibrate start id=$id")
            } catch (e: Exception) {
                LogHelper.append(this, "strong vibrate failed: ${e.javaClass.simpleName}: ${e.message}")
            }
        }
        handler.postDelayed(stopVibrateRunnable, VIBRATE_TIMEOUT_MS)
    }

    // 用户主动处理（点击通知 / 滑掉通知 / 告警页按钮）：只停震动，不动通知 ——
    // 通知的处置权在用户手上（点击会自行消失、滑掉已经没了）
    fun stopStrongVibrate() {
        handler.removeCallbacks(stopVibrateRunnable)
        if (!vibrating) return
        vibrating = false
        runCatching { vibrator?.cancel() }
        LogHelper.append(this, "strong vibrate stop")
    }

    // 超时无人处理：停震 + 把横幅收回通知栏。
    // 持 USE_FULL_SCREEN_INTENT 时解锁态那条横幅是 persistent，不会自己消失；
    // 若只停震不管通知，用户回来会看到「横幅还挂着但已经没动静」，无从判断是否已处理。
    private fun onVibrateTimeout() {
        stopStrongVibrate()
        retractHeadsUp()
    }

    private fun retractHeadsUp() {
        val id = strongMsgId
        val title = strongTitle
        if (id <= 0 || title == null) return
        try {
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            // 同一 id 重发一条**不带 fullScreenIntent** 的通知：横幅收回通知栏，内容仍可回看。
            // （若真机上横幅未被收回，退化为 nm.cancel(messageNotifId(id)) 即可。）
            nm.notify(
                messageNotifId(id),
                buildMessageNotification(title, strongBody, id, withFullScreen = false, onlyAlertOnce = true)
            )
            LogHelper.append(this, "strong vibrate timeout -> heads-up retracted id=$id")
        } catch (e: Exception) {
            LogHelper.append(this, "retract heads-up failed: ${e.message}")
        }
    }

    // ---------- 通知 ----------

    // 兜底通道：不依赖系统 FSI，自己把告警页拉到锁屏之上。
    //
    // 为什么需要它：FSI 是「请系统代为启动 Activity」，而系统在代为启动前还要过一道更外面的
    // 闸门 —— Android 10+ 的**后台启动 Activity 限制**（BAL）。官方例外清单里，我们能自己
    // 争取的有两条：
    //   ① 应用已获得 SYSTEM_ALERT_WINDOW（悬浮窗）权限
    //   ② 应用具有可见窗口
    // 关键点：只满足 ① 往往不够。Android 15 起对 SAW 的收紧正是要求「持权限**且**存在可见的
    // overlay 窗口」；部分 ROM 的实现也按「有可见窗口」判定。而后台服务本身**没有任何窗口** ——
    // 这就是「权限全绿、依然只剩横幅」的最后一环。
    // 所以这里两步都做：先挂一个 1×1 透明悬浮窗把 ② 补上，再启动告警页。
    //
    // 启动方式用 PendingIntent 而非裸 startActivity：Android 14 起系统不再默认给 PendingIntent
    // 授予 BAL 特权，必须显式声明 MODE_BACKGROUND_ACTIVITY_START_ALLOWED —— 这是官方为
    // 「后台启动 Activity」留的正规口子，比依赖隐式豁免更明确。
    //
    // 与 FSI 并行而非二选一：系统放行哪条就走哪条，两条都到也无害 —— AlarmActivity 是
    // singleInstance，只会有一个实例，第二次进入走 onNewIntent 刷新内容。
    private fun tryLaunchAlarmDirectly(id: Long, notifId: Int, title: String, body: String) {
        // WindowManager.addView 必须在有 Looper 的线程上执行，而本方法由 WS 回调（OkHttp 线程）调用
        handler.post { launchAlarmOnMain(id, notifId, title, body) }
    }

    private fun launchAlarmOnMain(id: Long, notifId: Int, title: String, body: String) {
        if (!Settings.canDrawOverlays(this)) {
            recordLaunchResult("未尝试：悬浮窗权限未开启，只剩系统全屏通知一条通道")
            LogHelper.append(this, "direct launch skipped: no overlay permission id=$id")
            return
        }
        // 场景闸门与 AOSP 的 FSI 判定保持一致：息屏、锁屏 → 全屏；
        // 用户正在使用设备（亮屏且已解锁）→ 只用横幅，不抢占他手上正在做的事。
        val screenOn = runCatching {
            (getSystemService(POWER_SERVICE) as PowerManager).isInteractive
        }.getOrDefault(true)
        val locked = runCatching {
            (getSystemService(KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked
        }.getOrDefault(false)
        if (screenOn && !locked) {
            recordLaunchResult("未尝试：屏幕亮且已解锁，按设计只给横幅（点横幅可进告警页）")
            LogHelper.append(this, "direct launch skipped: interactive & unlocked id=$id")
            return
        }

        val overlay = showLaunchOverlay(id)
        val t0 = SystemClock.elapsedRealtime()
        val sent = sendAlarmIntent(notifId, title, body)
        LogHelper.append(
            this,
            "direct launch attempt id=$id (screenOn=$screenOn locked=$locked overlay=${overlay != null} sent=$sent)"
        )

        // 被 BAL 拦下时系统是**静默丢弃**（不抛异常、不回调），所以判断成败不能看返回值，
        // 只能过一小会儿看 AlarmActivity 有没有真的 onCreate。结论落到 SharedPreferences，
        // 设置页直接读出来 —— 用户不必抓日志就知道卡在哪一层。
        pendingVerify?.let { handler.removeCallbacks(it) }
        val verify = Runnable {
            hideLaunchOverlay()
            val ok = alarmStartedAt >= t0
            recordLaunchResult(
                when {
                    ok -> "成功：全屏告警页已弹出"
                    !sent -> "失败：启动调用抛异常，详见诊断日志"
                    else -> "失败：启动被系统拦截（只剩横幅）—— 多为厂商「后台弹出界面」未允许"
                }
            )
            LogHelper.append(
                this,
                "direct launch verify id=$id -> ${if (ok) "alarm activity started" else "blocked by system"}"
            )
        }
        pendingVerify = verify
        handler.postDelayed(verify, LAUNCH_VERIFY_MS)
    }

    // 1×1 全透明、不抢焦点、不接收触摸的悬浮窗。用户看不见它，唯一作用是让本应用
    // 「具有可见窗口」—— 官方 BAL 例外清单里的独立一条，也是 Android 15 起 SAW 豁免
    // 收紧后额外要求的条件。必须等告警页拉起之后再回收，否则判定当场失效。
    @Suppress("DEPRECATION")
    private fun showLaunchOverlay(id: Long): View? {
        hideLaunchOverlay()
        return try {
            val wm = getSystemService(WINDOW_SERVICE) as WindowManager
            val v = View(this)
            val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else
                WindowManager.LayoutParams.TYPE_PHONE
            wm.addView(
                v,
                WindowManager.LayoutParams(
                    1, 1, type,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                    PixelFormat.TRANSLUCENT
                )
            )
            launchOverlay = v
            v
        } catch (e: Exception) {
            // 挂不上不致命：FSI 通道仍在，只是少了一重豁免
            LogHelper.append(this, "launch overlay failed: ${e.javaClass.simpleName}: ${e.message} id=$id")
            null
        }
    }

    private fun hideLaunchOverlay() {
        val v = launchOverlay ?: return
        launchOverlay = null
        runCatching { (getSystemService(WINDOW_SERVICE) as WindowManager).removeView(v) }
    }

    // 返回值只表示「调用有没有抛异常」，**不代表 Activity 真的起来了** ——
    // 被 BAL 拦截时系统静默丢弃，既不抛异常也不回调，只能靠 launchAlarmOnMain 里的复核判断。
    private fun sendAlarmIntent(notifId: Int, title: String, body: String): Boolean {
        val i = Intent(this, AlarmActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(AlarmActivity.EXTRA_TITLE, title)
            .putExtra(AlarmActivity.EXTRA_BODY, body)
            .putExtra(AlarmActivity.EXTRA_NOTIF_ID, notifId)
        return try {
            if (Build.VERSION.SDK_INT >= 34) {
                // Android 14 起 PendingIntent 不再默认携带 BAL 特权，须显式 opt-in
                val options = ActivityOptions.makeBasic()
                    .setPendingIntentBackgroundActivityStartMode(
                        ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED
                    )
                    .toBundle()
                PendingIntent.getActivity(
                    this, RC_ALARM_DIRECT, i,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    options
                ).send()
            } else {
                startActivity(i)
            }
            true
        } catch (e: Exception) {
            LogHelper.append(this, "send alarm intent failed: ${e.javaClass.simpleName}: ${e.message}")
            false
        }
    }

    private fun recordLaunchResult(result: String) {
        runCatching {
            getSharedPreferences(PREFS_STATE, MODE_PRIVATE).edit()
                .putString(KEY_LAST_LAUNCH, result)
                .putLong(KEY_LAST_LAUNCH_TS, System.currentTimeMillis())
                .apply()
        }
    }

    private fun ensureChannel(): NotificationManager {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // 静音渠道：setSound(null, null) —— 要「无声只震」就必须换渠道 id，
            // 因为渠道的声音属性创建后不可修改（旧 id 上已建过的渠道改不动）。
            // 渠道自带震动保留并显式开启：普通消息天然就是「横幅 + 单次震动」，
            // 开了强力震动的消息在此基础上再叠加服务层的循环震动，不需要第二套渠道。
            // 不设 setVibrationPattern：保持系统默认单次波形，循环由 PushService 负责。
            nm.createNotificationChannel(
                NotificationChannel(PUSH_CHANNEL_ID, "通知推送", NotificationManager.IMPORTANCE_HIGH).apply {
                    setSound(null, null)
                    enableVibration(true)
                }
            )
            // 旧渠道已无任何通知投递，删除以免在系统设置里留下一个永远静不掉的喇叭
            runCatching { nm.deleteNotificationChannel(LEGACY_PUSH_CHANNEL_ID) }
            // 前台服务必须展示一条通知（系统限制），降为最低优先级：
            // 无声音、无状态栏图标，折叠在通知栏最底部"后台运行"分组里
            nm.createNotificationChannel(
                NotificationChannel(FG_CHANNEL_ID, "后台连接", NotificationManager.IMPORTANCE_MIN)
            )
        }
        return nm
    }

    private fun buildForegroundNotification(): Notification {
        val pi = PendingIntent.getActivity(
            this, 0,
            Intent(this, KeysActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, FG_CHANNEL_ID)
        else
            @Suppress("DEPRECATION") Notification.Builder(this)
        return b
            .setContentTitle("Notify Hub 运行中")
            .setContentText("实时接收推送通知")
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentIntent(pi)
            .setPriority(Notification.PRIORITY_MIN)
            .setShowWhen(false)
            .setOngoing(true)
            .build()
    }

    private fun showNotification(title: String, body: String, id: Long, vibrate: Boolean) {
        val nm = ensureChannel()
        if (vibrate) logFsiFacts()
        // 通知 id 使用独立高位段，绝不与前台服务通知 id（1001）冲突：
        // 一旦消息 id 撞上 FGS 通知 id，该通知会被系统按前台服务通知对待（一键清除无法移除）
        nm.notify(messageNotifId(id), buildMessageNotification(title, body, id, withFullScreen = vibrate))
        // 已触达回调：通知成功弹出到系统通知栏后，上报 Worker 修正该消息的触达状态
        if (id > 0) {
            CoroutineScope(Dispatchers.IO).launch {
                try { Api.instance(this@PushService).markDelivered(id) } catch (_: Exception) {}
            }
        }
    }

    // 锁屏全屏页（FSI）能否弹出，卡在几个**都在用户手上、App 只能读不能改**的外部开关上：
    //   ① USE_FULL_SCREEN_INTENT 权限（Android 14+）
    //   ② 推送渠道重要性（官方要求 ≥ IMPORTANCE_HIGH，且渠道一旦被调低就再也改不回来）
    //   ③ 通知总开关
    //   ④ SYSTEM_ALERT_WINDOW（悬浮窗）—— 不满足时 FSI 仍可能被 BAL/ROM 拦下，
    //      满足时服务可以自己把告警页拉起来（tryLaunchAlarmDirectly）
    // 出问题时现场只在日志里，所以每条强震消息都把这五项快照打出来。
    // 判定方法：日志里若「strong vibrate start」之后既没有「AlarmActivity onCreate」也没有
    // 「direct launch alarm activity」，说明这一次被系统降级成了横幅。
    private fun logFsiFacts() {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        val screenOn = runCatching {
            (getSystemService(POWER_SERVICE) as PowerManager).isInteractive
        }.getOrDefault(true)
        LogHelper.append(
            this,
            "fsi facts: sdk=${Build.VERSION.SDK_INT} fsiPerm=${canUseFullScreenIntent(this)} " +
                "channelImportance=${pushChannelImportance(this)} notifEnabled=${nm.areNotificationsEnabled()} " +
                "overlayPerm=${canDrawOverlays(this)} screenOn=$screenOn"
        )
    }

    // withFullScreen=true 时挂 fullScreenIntent → 锁屏/灭屏拉起 AlarmActivity；
    // 亮屏解锁态、或 Android 13+ 判定「用户正在使用设备」时，系统一律降级为横幅，Activity 不会启动
    // —— 这也是震动必须留在服务层的原因（见类头注释）。
    private fun buildMessageNotification(
        title: String,
        body: String,
        id: Long,
        withFullScreen: Boolean,
        onlyAlertOnce: Boolean = false,
    ): Notification {
        val rc = messageNotifId(id)

        // 点击目标分两路，语义完全不同：
        //   强力震动 → 告警页：用户此刻最需要的是「让它停下来」，先把出口摆在面前
        //   普通消息 → 主界面：无事发生，直接看列表
        // 用不同 requestCode：PendingIntent 按 (requestCode + Intent 等价性) 匹配，
        // contentIntent 与 fullScreenIntent 若共用同一个 rc，同一条通知里会互相更新 extras，
        // 最后表现为「点横幅进错页」这类极难定位的问题。
        val tapIntent = if (withFullScreen) {
            Intent(this, AlarmActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(AlarmActivity.EXTRA_TITLE, title)
                .putExtra(AlarmActivity.EXTRA_BODY, body)
                .putExtra(AlarmActivity.EXTRA_NOTIF_ID, rc)
                .putExtra(AlarmActivity.EXTRA_FROM_TAP, true)  // 点横幅 = 已经看到了，进页即停震
        } else {
            // 普通通知刻意不带停震标记：否则点击它会误停「另一条强震消息」正在进行的震动
            Intent(this, KeysActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val contentPi = PendingIntent.getActivity(
            this, rc,
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, PUSH_CHANNEL_ID)
        else
            @Suppress("DEPRECATION") Notification.Builder(this)
        b.setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentIntent(contentPi)
            // ALARM 而不是 MESSAGE：官方把 FSI 的适用场景限定为「来电 / 闹钟」，
            // 归到闹钟类能让系统与各家 ROM 在锁屏展示、FSI 判定上给出更宽的通道；
            // 语义上也贴切 —— 强力震动提醒本质就是用户自己设的闹钟。
            .setCategory(if (withFullScreen) Notification.CATEGORY_ALARM else Notification.CATEGORY_MESSAGE)
            // 锁屏显示完整内容：默认 PRIVATE 在部分 ROM 上会被抹成「内容已隐藏」，
            // 而这条通知存在的意义就是让用户不用解锁也看得清是什么事
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            // 绝不 setOngoing(true)：ongoing 通知在锁屏设备上无法被用户划掉，
            // 会直接破坏「滑掉通知即停止震动」这条路径。
            .setOngoing(false)
            .setAutoCancel(true)
            .setOnlyAlertOnce(onlyAlertOnce)

        if (withFullScreen) {
            val fsPi = PendingIntent.getActivity(
                this, rc + FS_REQUEST_OFFSET,
                Intent(this, AlarmActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra(AlarmActivity.EXTRA_TITLE, title)
                    .putExtra(AlarmActivity.EXTRA_BODY, body)
                    .putExtra(AlarmActivity.EXTRA_NOTIF_ID, rc),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            b.setFullScreenIntent(fsPi, true)

            // 不在通知上挂「停止震动」action 按钮：横幅本身空间有限，
            // 按钮在部分 ROM 上会把标题正文挤成一行，反而看不清是什么事。
            // 停止路径仍有三条：点横幅进告警页、滑掉通知、30 秒超时。

            // 滑掉通知 = 停止震动。只给强震通知挂：否则滑掉一条普通通知会误停
            // 另一条消息正在进行的震动。
            // 这里刻意用 getService 而不是 getBroadcast：系统代为发出 PendingIntent 时，
            // 「动态注册的接收器 + 导出标志」是否放行存在版本差异，走 startService 没有这层歧义，
            // 由 onStartCommand 识别 ACTION_STOP_VIBRATE 处理。
            // 不带 notif_id：通知已经被划掉了，再 cancel 一次没有意义。
            b.setDeleteIntent(
                PendingIntent.getService(
                    this, rc + DELETE_REQUEST_OFFSET,
                    Intent(this, PushService::class.java).setAction(ACTION_STOP_VIBRATE),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            )
        }
        return b.build()
    }

    companion object {
        // v2：旧渠道 notify_hub_push 是「有声音」的，而渠道声音属性创建后不可修改，
        // 要做到无声只能换 id（旧渠道在 ensureChannel 里删除）
        // 对设置页开放：渠道重要性是 FSI 的硬门槛，设置页要读它并引导用户
        const val PUSH_CHANNEL_ID = "notify_hub_push_v2"
        private const val LEGACY_PUSH_CHANNEL_ID = "notify_hub_push"
        const val FG_CHANNEL_ID = "notify_hub_foreground"
        const val FOREGROUND_ID = 1001

        // 震动停止指令：点击通知 / 滑掉通知 / 告警页按钮 / 超时关闭 都汇到这一个入口
        const val ACTION_STOP_VIBRATE = "com.example.notifyhub.STOP_VIBRATE"
        // 随停止指令携带的通知 id：>0 表示「连横幅一起撤掉」（用户主动停止），
        // 缺省表示只停震（滑掉通知 / 超时，通知本身已消失或另有收回逻辑）
        const val EXTRA_NOTIF_ID = "notif_id"
        // 旧版遗留：点击通知进 KeysActivity 时带的停震标记。现在强震通知的点击目标是告警页，
        // 普通通知不再带它 —— 保留常量仅为兼容系统里可能残留的旧 PendingIntent。
        const val EXTRA_STOP_VIBRATE = "stop_vibrate"

        private val VIBRATE_PATTERN = longArrayOf(0L, 700L, 500L)  // 震 700ms → 停 500ms，循环
        private const val VIBRATE_TIMEOUT_MS = 30_000L             // 30 秒兜底自动停

        private const val MESSAGE_ID_BASE = 1_000_000  // 消息通知 id 段起点，避开 FGS 通知 id
        private const val DEDUP_WINDOW_MS = 3000L  // 防重缓存窗口：3 秒内同 key 只弹一次

        // 同一条通知下三种 PendingIntent 的 requestCode 分段：共用 rc 基址 + 各自偏移，
        // 既保证互不覆盖，又保证同一条消息每次重建时能命中同一个 PendingIntent
        private const val FS_REQUEST_OFFSET = 100_000
        private const val DELETE_REQUEST_OFFSET = 300_000

        // 服务端为每条消息生成唯一 dedup_key（srv-<uuid>），重推消息由本缓存判重；
        // id 高位段映射，保证与前台服务通知 id 不冲突
        fun messageNotifId(id: Long): Int =
            (MESSAGE_ID_BASE + (id % MESSAGE_ID_BASE)).toInt().coerceAtLeast(1)

        // 全屏通知权限检测（Android 14+）：权限丢失后连锁屏都只剩 60 秒横幅，
        // 所以设置页要能把用户引导到系统开关。
        fun canUseFullScreenIntent(ctx: Context): Boolean =
            if (Build.VERSION.SDK_INT < 34) true
            else runCatching {
                (ctx.getSystemService(NOTIFICATION_SERVICE) as NotificationManager).canUseFullScreenIntent()
            }.getOrDefault(true)

        // 悬浮窗权限（显示在其他应用上层）：后台启动 Activity 的硬豁免，设置页据此引导用户
        fun canDrawOverlays(ctx: Context): Boolean =
            runCatching { Settings.canDrawOverlays(ctx) }.getOrDefault(false)

        // 推送渠道当前重要性。官方硬性要求：渠道低于 IMPORTANCE_HIGH 时系统**不会**启动 FSI，
        // 而渠道重要性一旦被用户手动调低，App 就再也改不回来（只能引导用户去系统设置）。
        // 返回 IMPORTANCE_NONE 表示渠道被关闭，-1 表示渠道还没创建（从未收到过推送）。
        fun pushChannelImportance(ctx: Context): Int =
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) NotificationManager.IMPORTANCE_HIGH
            else runCatching {
                (ctx.getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
                    .getNotificationChannel(PUSH_CHANNEL_ID)?.importance ?: -1
            }.getOrDefault(-1)

        // ---- 直拉告警页（第二条通道）----
        private const val RC_ALARM_DIRECT = 900_001
        // 启动后等待 Activity onCreate 的复核窗口：太短会误判失败，太长会把悬浮窗挂得过久
        private const val LAUNCH_VERIFY_MS = 2500L

        // AlarmActivity.onCreate 时写入（elapsedRealtime，单调时钟，不受系统时间调整影响）。
        // 直拉是否真被系统放行，就看它有没有在这次尝试之后更新 —— 被 BAL 拦截时
        // startActivity 是静默丢弃的，没有任何其他信号可用。
        @Volatile
        var alarmStartedAt = 0L

        // 上一次强力提醒的投递结论。设置页直接读这一项，用户不必去翻日志文件。
        const val PREFS_STATE = "notify_hub_state"
        const val KEY_LAST_LAUNCH = "last_launch_result"
        const val KEY_LAST_LAUNCH_TS = "last_launch_ts"

        fun lastLaunchResult(ctx: Context): Pair<String, Long>? {
            val p = ctx.getSharedPreferences(PREFS_STATE, Context.MODE_PRIVATE)
            val s = p.getString(KEY_LAST_LAUNCH, null) ?: return null
            return s to p.getLong(KEY_LAST_LAUNCH_TS, 0L)
        }
    }
}
