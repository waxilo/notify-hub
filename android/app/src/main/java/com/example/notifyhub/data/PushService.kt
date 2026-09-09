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
import com.example.notifyhub.ui.NotificationsActivity
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
    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate() {
        super.onCreate()
        startForeground(FOREGROUND_ID, buildForegroundNotification())
        connect()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // token 更新（重新登录）后重启服务会再次触发 connect 前 close
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
                        showNotification(
                            obj.optString("title").ifEmpty { "新通知" },
                            obj.optString("body"),
                            obj.optLong("id", 0L)
                        )
                    }
                } catch (_: Exception) {
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                scheduleReconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                scheduleReconnect()
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
                NotificationChannel(CHANNEL_ID, "通知推送", NotificationManager.IMPORTANCE_HIGH)
            )
        }
        return nm
    }

    private fun buildForegroundNotification(): Notification {
        ensureChannel()
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, NotificationsActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, CHANNEL_ID)
        else
            @Suppress("DEPRECATION") Notification.Builder(this)
        return b
            .setContentTitle("Notify Hub 运行中")
            .setContentText("实时接收推送通知")
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
    }

    private fun showNotification(title: String, body: String, id: Long) {
        val nm = ensureChannel()
        val pi = PendingIntent.getActivity(
            this, id.toInt().coerceAtLeast(1), Intent(this, NotificationsActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, CHANNEL_ID)
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
    }

    companion object {
        private const val CHANNEL_ID = "notify_hub_push"
        private const val FOREGROUND_ID = 1001
    }
}
