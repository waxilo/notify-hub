package com.example.notifyhub.ui

import android.app.Activity
import android.view.ViewGroup
import android.widget.FrameLayout
import com.example.notifyhub.R

// 全局加载遮罩：所有页面网络加载期间统一显示半透明遮罩 + 转圈，
// 计数器设计支持并发加载（show/hide 必须配对，建议 show 在 launch 前、hide 在 finally）
class LoadingOverlay(activity: Activity) {

    private val activityRef = activity
    private var overlay: ViewGroup? = null
    private var count = 0

    private val alive: Boolean
        get() = try {
            !activityRef.isFinishing &&
                !(android.os.Build.VERSION.SDK_INT >= 17 && activityRef.isDestroyed)
        } catch (_: Throwable) {
            false
        }

    // 退出登录 / 401 跳登录时 Activity 可能已销毁，而 hide() 常在协程 finally 里执行；
    // 对已销毁页面操作 View 会抛 IllegalArgumentException 并杀进程，故全部静默容错
    fun show() {
        try {
            if (!alive) return
            count++
            if (count > 1 || overlay != null) return
            val content = activityRef.findViewById<FrameLayout>(android.R.id.content)
            overlay = activityRef.layoutInflater.inflate(R.layout.view_loading, content, false) as ViewGroup
            content.addView(overlay)
        } catch (_: Throwable) {
            overlay = null
        }
    }

    fun hide() {
        try {
            count = (count - 1).coerceAtLeast(0)
            if (count == 0) {
                overlay?.let { (it.parent as? ViewGroup)?.removeView(it) }
                overlay = null
            }
        } catch (_: Throwable) {
            overlay = null
            count = 0
        }
    }
}
