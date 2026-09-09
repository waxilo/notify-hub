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
        startForeground(FOREGROUND_ID, buildForegroundNotification())
        connect()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
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
                        // 通知标题显示 key 名称（消息来源），消息标题与内容作为正文
                        val keyName = obj.optString("key_name")
                        val msgTitle = obj.optString("title")
                        val msgBody = obj.optString("body")
                        val body = when {
                            keyName.isEmpty() -> if (msgBody.isEmpty()) msgTitle else "$msgTitle\n$msgBody"
                            msgBody.isEmpty() -> msgTitle
                            msgTitle.isEmpty() -> msgBody
                            else -> "$msgTitle\n$msgBody"
                        }
                        showNotification(
                            keyName.ifEmpty { msgTitle.ifEmpty { "新通知" } },
                            body,
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
            .setAutoCancel(true)
            .build()
        nm.notify((id % Int.MAX_VALUE).toInt().coerceAtLeast(1), n)
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
        private const val DEDUP_WINDOW_MS = 3000L  // 防重缓存窗口：3 秒内同 key 只弹一次
    }
}
