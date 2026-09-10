package com.example.notifyhub.ui

import android.app.Activity
import android.content.Intent
import android.content.res.ColorStateList
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import com.example.notifyhub.R

/**
 * 底部页签（首页 / 定时任务 / 设置）的选中态与跳转逻辑。
 *
 * 三个页面仍是彼此独立的 Activity（没有改造成 Fragment）：点页签用 FLAG_ACTIVITY_REORDER_TO_FRONT，
 * 栈内已有该页面就提到前台复用（触发 onResume 重新拉数据），否则新建；不 finish 当前页，
 * 所以「返回」仍然是回到上一个页签，与改造前的行为一致。
 */
object BottomNav {

    private const val ACTIVE = 0xFF4F6EF7.toInt()   // @color/primary
    private const val INACTIVE = 0xFF8A93A6.toInt() // @color/text_muted

    fun bind(activity: Activity, current: Class<out Activity>) {
        bindItem(activity, R.id.navHome, R.id.navHomeIcon, R.id.navHomeText,
            KeysActivity::class.java, current)
        bindItem(activity, R.id.navJobs, R.id.navJobsIcon, R.id.navJobsText,
            JobsActivity::class.java, current)
        bindItem(activity, R.id.navSettings, R.id.navSettingsIcon, R.id.navSettingsText,
            SettingsActivity::class.java, current)
    }

    private fun bindItem(
        activity: Activity,
        itemId: Int,
        iconId: Int,
        textId: Int,
        target: Class<out Activity>,
        current: Class<out Activity>
    ) {
        val item = activity.findViewById<View>(itemId) ?: return
        val icon = activity.findViewById<ImageView>(iconId)
        val label = activity.findViewById<TextView>(textId)

        val selected = target == current
        val color = if (selected) ACTIVE else INACTIVE
        icon?.imageTintList = ColorStateList.valueOf(color)
        label?.setTextColor(color)

        if (selected) {
            item.isClickable = false
            item.setOnClickListener(null)
        } else {
            item.isClickable = true
            item.setOnClickListener { switchTo(activity, target) }
        }
    }

    private fun switchTo(activity: Activity, target: Class<out Activity>) {
        runCatching {
            activity.startActivity(
                Intent(activity, target).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            )
            // 页签切换不要左右滑动的「进入下一层」动画，否则不像切 tab 而像跳页
            @Suppress("DEPRECATION")
            activity.overridePendingTransition(0, 0)
        }
    }
}
