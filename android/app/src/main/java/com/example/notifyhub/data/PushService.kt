package com.example.notifyhub.data

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import com.example.notifyhub.LogHelper
import com.example.notifyhub.api.Api
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
// 视觉提醒统一为**一条横幅通知**（点开进主界面），不做全屏告警页。
// 原因：全屏必须依赖 fullScreenIntent，而它必然要「启动一个 Activity」，
// 于是受 Android 10+ 的后台启动限制（BAL）与国产 ROM 的「后台弹出界面」开关管辖 ——
// 这两道闸门都在系统侧、普通应用无法自行争取（系统闹钟等预装应用在白名单里），
// 实测多台设备上「通知权限 + 全屏通知 + 悬浮窗」全开仍会被拦下。属不可控项，故放弃。
//
// 「确保被注意到」的可靠通道是**持续震动**：vibrate=true 的消息（key/job 开关或
// `?vibrate=1`）在本服务内直接驱动马达循环震动，直到用户点击横幅 / 滑掉通知 / 30 秒超时。
// 震动放在 Service 而不是 Activity，正是因为它不依赖任何界面是否被拉起 ——
// 若绑在 Activity 生命周期上，恰好在最需要它的场景（界面没弹出来）直接失效。
// 马达直调不受锁屏/亮屏、静音模式、勿扰策略影响。
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
            LogHelper.append(this, "PushService onStartCommand: stop vibrate")
            stopStrongVibrate()
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
                        if (vibrate) startStrongVibrate(msgId)
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

    private fun startStrongVibrate(id: Long) {
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

    // 三条停止入口都汇到这里：点击强震横幅（经 KeysActivity 转成广播）、滑掉通知、30 秒超时。
    // 只停震动，不碰通知 —— 通知的处置权在用户手上（点击会自行消失、滑掉已经没了）。
    fun stopStrongVibrate() {
        handler.removeCallbacks(stopVibrateRunnable)
        if (!vibrating) return
        vibrating = false
        runCatching { vibrator?.cancel() }
        LogHelper.append(this, "strong vibrate stop")
    }

    // 超时无人处理：停止震动。横幅本身在几秒后会自动收回通知栏，无需额外处理。
    private fun onVibrateTimeout() {
        LogHelper.append(this, "strong vibrate timeout after ${VIBRATE_TIMEOUT_MS / 1000}s")
        stopStrongVibrate()
    }

    // ---------- 通知 ----------

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
        // 通知 id 使用独立高位段，绝不与前台服务通知 id（1001）冲突：
        // 一旦消息 id 撞上 FGS 通知 id，该通知会被系统按前台服务通知对待（一键清除无法移除）
        nm.notify(messageNotifId(id), buildMessageNotification(title, body, id, vibrate))
        // 已触达回调：通知成功弹出到系统通知栏后，上报 Worker 修正该消息的触达状态
        if (id > 0) {
            CoroutineScope(Dispatchers.IO).launch {
                try { Api.instance(this@PushService).markDelivered(id) } catch (_: Exception) {}
            }
        }
    }

    // 视觉提醒统一是一条横幅：标题 + 正文（BigTextStyle 展开全文）。
    // vibrate=true 时额外挂 deleteIntent —— 滑掉通知即停止震动，这是强震消息专属的快捷出口；
    // 普通消息不挂，否则滑掉一条普通通知会误停另一条强震消息正在进行的震动。
    private fun buildMessageNotification(
        title: String,
        body: String,
        id: Long,
        vibrate: Boolean,
    ): Notification {
        val rc = messageNotifId(id)

        // 点击统一进主界面：强震消息额外带停震标记（点开 = 已经看到了），
        // 由 KeysActivity 转成停止广播送回本服务（见 KeysActivity.handleStopVibrate）。
        // 普通消息不带该标记 —— 否则点击它会误停另一条强震消息正在进行的震动。
        val contentPi = PendingIntent.getActivity(
            this, rc,
            Intent(this, KeysActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(EXTRA_STOP_VIBRATE, vibrate),
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
            .setCategory(Notification.CATEGORY_MESSAGE)
            // 锁屏显示完整内容：默认 PRIVATE 在部分 ROM 上会被抹成「内容已隐藏」，
            // 而这条通知存在的意义就是让用户不用解锁也看得清是什么事
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            // 绝不 setOngoing(true)：ongoing 通知在锁屏设备上无法被用户划掉，
            // 会直接破坏「滑掉通知即停止震动」这条路径。
            .setOngoing(false)
            .setAutoCancel(true)

        if (vibrate) {
            // 滑掉通知 = 停止震动。刻意用 getService 而不是 getBroadcast：系统代为发出
            // PendingIntent 时，「动态注册的接收器 + 导出标志」是否放行存在版本差异，
            // 走 startService 没有这层歧义，由 onStartCommand 识别 ACTION_STOP_VIBRATE 处理。
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
        const val PUSH_CHANNEL_ID = "notify_hub_push_v2"
        private const val LEGACY_PUSH_CHANNEL_ID = "notify_hub_push"
        const val FG_CHANNEL_ID = "notify_hub_foreground"
        const val FOREGROUND_ID = 1001

        // 震动停止指令：点击强震横幅 / 滑掉通知 / 30 秒超时 都汇到这一个入口
        const val ACTION_STOP_VIBRATE = "com.example.notifyhub.STOP_VIBRATE"
        // 随通知点击 Intent 携带（true = 这是一条强震消息）：KeysActivity 见到就发一次停止广播。
        // 桌面图标 / 最近任务进入不带该 extra，因此不会误停。
        const val EXTRA_STOP_VIBRATE = "stop_vibrate"

        private val VIBRATE_PATTERN = longArrayOf(0L, 700L, 500L)  // 震 700ms → 停 500ms，循环
        private const val VIBRATE_TIMEOUT_MS = 30_000L             // 30 秒兜底自动停

        private const val MESSAGE_ID_BASE = 1_000_000  // 消息通知 id 段起点，避开 FGS 通知 id
        private const val DEDUP_WINDOW_MS = 3000L  // 防重缓存窗口：3 秒内同 key 只弹一次

        // 同一条通知里 contentIntent 与 deleteIntent 的 requestCode 分段：
        // 共用 rc 基址 + 偏移，既保证互不覆盖，又保证同一条消息每次重建时命中同一个 PendingIntent
        private const val DELETE_REQUEST_OFFSET = 300_000

        // 服务端为每条消息生成唯一 dedup_key（srv-<uuid>），重推消息由本缓存判重；
        // id 高位段映射，保证与前台服务通知 id 不冲突
        fun messageNotifId(id: Long): Int =
            (MESSAGE_ID_BASE + (id % MESSAGE_ID_BASE)).toInt().coerceAtLeast(1)

        // 推送渠道当前重要性。渠道被关闭（IMPORTANCE_NONE）或低于「高」时，横幅与震动会退化，
        // 而渠道一旦被用户手动调低，App 就再也改不回来（只能引导用户去系统设置）。
        // 返回 -1 表示渠道还没创建（从未收到过推送）。
        fun pushChannelImportance(ctx: Context): Int =
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) NotificationManager.IMPORTANCE_HIGH
            else runCatching {
                (ctx.getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
                    .getNotificationChannel(PUSH_CHANNEL_ID)?.importance ?: -1
            }.getOrDefault(-1)
    }
}
