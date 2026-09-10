package com.example.notifyhub.data

import android.os.Build
import android.os.Handler
import android.os.Looper
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

// 隐藏前台服务的常驻通知：
// 持有"通知使用权"后，监听到自己的前台服务通知（后台连接渠道）立即取消，
// 服务本身继续以前台状态运行，WebSocket 保活不受影响。
// 消息通知（notify_hub_push_v2 渠道）不受影响，正常展示。
//
// 加固：onListenerConnected 时通知快照可能尚未同步（尤其刚授权后），
// 用递增间隔多次重查；系统刷新前台服务重新贴出的通知由 onNotificationPosted 兜住。
class FgsDismissService : NotificationListenerService() {

    private val handler = Handler(Looper.getMainLooper())
    private var retries = 0

    override fun onListenerConnected() {
        retries = 0
        hideForegroundNotification()
        scheduleRetry()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null) return
        hideForegroundNotification()
    }

    private fun scheduleRetry() {
        if (retries >= RETRY_LIMIT) return
        val delay = (500L shl retries.coerceAtMost(5))  // 0.5s,1s,2s,4s,8s,16s…
        retries++
        handler.postDelayed({
            if (hideForegroundNotification()) scheduleRetry()
        }, delay)
    }

    // 返回 true 表示找到了目标通知（无论是否取消成功），需要继续盯防
    private fun hideForegroundNotification(): Boolean {
        var found = false
        val fgsChannel = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) PushService.FG_CHANNEL_ID else null
        for (sbn in activeNotifications) {
            if (sbn.packageName != packageName) continue
            if (sbn.id != PushService.FOREGROUND_ID) continue
            if (fgsChannel != null && sbn.notification.channelId != fgsChannel) continue
            found = true
            try {
                cancelNotification(sbn.key)
            } catch (_: Exception) {
            }
        }
        return found
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    companion object {
        private const val RETRY_LIMIT = 8
        const val ACTION_REPOST_FG = "com.example.notifyhub.REPOST_FG"
    }
}
