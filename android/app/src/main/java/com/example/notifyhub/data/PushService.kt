package com.example.notifyhub.data

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
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
        connect()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
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
                        showNotification(
                            keyName.ifEmpty { msgTitle.ifEmpty { "新通知" } },
                            msgBody,
                            obj.optLong("id", 0L)
                        )
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

    // ---------- 通知 ----------

    private fun ensureChannel(): NotificationManager {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(PUSH_CHANNEL_ID, "通知推送", NotificationManager.IMPORTANCE_HIGH)
            )
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

    private fun showNotification(title: String, body: String, id: Long) {
        val nm = ensureChannel()
        val pi = PendingIntent.getActivity(
            this, id.toInt().coerceAtLeast(1),
            Intent(this, KeysActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, PUSH_CHANNEL_ID)
        else
            @Suppress("DEPRECATION") Notification.Builder(this)
        val n = b
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentIntent(pi)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setOngoing(false)
            .setAutoCancel(true)
            .build()
        // 通知 id 使用独立高位段，绝不与前台服务通知 id（1001）冲突：
        // 一旦消息 id 撞上 FGS 通知 id，该通知会被系统按前台服务通知对待（一键清除无法移除）
        nm.notify(messageNotifId(id), n)
        // 已触达回调：通知成功弹出到系统通知栏后，上报 Worker 修正该消息的触达状态
        if (id > 0) {
            CoroutineScope(Dispatchers.IO).launch {
                try { Api.instance(this@PushService).markDelivered(id) } catch (_: Exception) {}
            }
        }
    }

    companion object {
        private const val PUSH_CHANNEL_ID = "notify_hub_push"
        const val FG_CHANNEL_ID = "notify_hub_foreground"
        const val FOREGROUND_ID = 1001
        private const val MESSAGE_ID_BASE = 1_000_000  // 消息通知 id 段起点，避开 FGS 通知 id
        private const val DEDUP_WINDOW_MS = 3000L  // 防重缓存窗口：3 秒内同 key 只弹一次

        // 服务端为每条消息生成唯一 dedup_key（srv-<uuid>），重推消息由本缓存判重；
        // id 高位段映射，保证与前台服务通知 id 不冲突
        fun messageNotifId(id: Long): Int =
            (MESSAGE_ID_BASE + (id % MESSAGE_ID_BASE)).toInt().coerceAtLeast(1)
    }
}
