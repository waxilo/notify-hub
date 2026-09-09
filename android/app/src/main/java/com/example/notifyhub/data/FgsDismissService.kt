package com.example.notifyhub.data

import android.app.NotificationListenerService
import android.os.Build
import android.service.notification.StatusBarNotification

// 隐藏前台服务的常驻通知：
// 持有"通知使用权"后，监听到自己的前台服务通知（后台连接渠道）立即取消，
// 服务本身继续以前台状态运行，WebSocket 保活不受影响。
// 消息通知（notify_hub_push 渠道）不受影响，正常展示。
class FgsDismissService : NotificationListenerService() {

    override fun onListenerConnected() {
        hideForegroundNotification()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        hideForegroundNotification()
    }

    private fun hideForegroundNotification() {
        val fgsChannel = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) PushService.FG_CHANNEL_ID else null
        for (sbn in activeNotifications) {
            if (sbn.packageName != packageName) continue
            if (sbn.id != PushService.FOREGROUND_ID) continue
            if (fgsChannel != null && sbn.notification.channelId != fgsChannel) continue
            try {
                cancelNotification(sbn.key)
            } catch (_: Exception) {
            }
        }
    }
}
