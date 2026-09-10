package com.example.notifyhub.ui

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.example.notifyhub.LogHelper
import com.example.notifyhub.R
import com.example.notifyhub.data.PushService

// 强力震动的锁屏告警页。三个入口：
//   ① 通知的 fullScreenIntent（系统放行时自动拉起）
//   ② 用户点击那条横幅（系统降级为横幅时的必经路径）
//   ③ PushService 直接 startActivity（拿到悬浮窗权限、但 ROM 拦下了 FSI 时的兜底）
//
// 为什么单独建一个 Activity 而不是复用主界面（MainActivity/KeysActivity）：
// 覆盖锁屏的这个「身份」自带三条约束，只有专用页才能干净地满足 ——
//   ① 多实例叠加 → launchMode="singleInstance"（Manifest）
//   ② 最近任务里的僵尸条目 → excludeFromRecents + finishAndRemoveTask()
//   ③ 自动关闭必须与震动停止同源 → 下面 requestStop() 与超时都汇到 PushService 同一个入口
// 复用主界面则 ② 无解：主界面必须留在最近任务里，而这些约束会直接落到 App 的正常启动路径上。
//
// 页面只有标题、正文、关闭三样东西。亮屏解锁态系统一定降级为横幅，本页不会自动启动 ——
// 那时它就是「点横幅」的落点。
class AlarmActivity : AppCompatActivity() {

    private val handler = Handler(Looper.getMainLooper())
    private val autoClose = Runnable { dismiss("timeout") }

    // 本次要撤的通知 id（= PushService.messageNotifId(消息 id)）；0 表示未知，只停震不撤通知
    private var notifId = 0

    // 震动是否已经停了。点横幅进来时立刻置 true（用户已经看到了）
    private var stopped = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 锁屏下必须显式声明，否则既不亮屏也不显示在锁屏之上（API 27+）；
        // 27 以下只能走已废弃的 window flag
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                    WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            )
        }
        setContentView(R.layout.activity_alarm)

        findViewById<Button>(R.id.btnStop).setOnClickListener {
            // 停止 = 停震 + 撤横幅 + 关页面。「关闭」这个动作的语义就是让提醒彻底消失，
            // 内容在通知栏与历史页都还查得到，所以不必把页面留着。
            if (!stopped) requestStop(withNotifId = true, reason = "user")
            stopped = true
            dismiss("user")
        }

        bind(intent)
        // 上报启动时刻：PushService 的直拉复核据此判断这一次到底有没有被系统静默拦下
        // （被 BAL 拦截时 startActivity 既不抛异常也不回调，只有这个信号能证明页面真的起来了）
        PushService.alarmStartedAt = SystemClock.elapsedRealtime()
        LogHelper.append(this, "AlarmActivity onCreate")
    }

    // singleInstance：连收多条强震消息时不会叠出多个页面，改走这里刷新内容并重置倒计时
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        bind(intent)
        LogHelper.append(this, "AlarmActivity onNewIntent")
    }

    private fun bind(i: Intent?) {
        notifId = i?.getIntExtra(EXTRA_NOTIF_ID, 0) ?: 0
        stopped = false

        // 点横幅进来 = 用户已经看到这条提醒了：立刻停震并撤掉横幅（横幅不撤会一直挂在屏幕顶部），
        // 但页面留着让他把正文看完 —— 这与全屏页自动拉起的语义不同，后者用户还没看到任何东西。
        if (i?.getBooleanExtra(EXTRA_FROM_TAP, false) == true) {
            requestStop(withNotifId = true, reason = "tap notification")
            stopped = true
        }

        val title = i?.getStringExtra(EXTRA_TITLE).orEmpty().ifEmpty { "新通知" }
        val body = i?.getStringExtra(EXTRA_BODY).orEmpty()
        findViewById<TextView>(R.id.tvAlarmTitle).text = title
        findViewById<TextView>(R.id.tvAlarmBody).text = body
        findViewById<Button>(R.id.btnStop).text = if (stopped) "关闭" else "停止震动"

        // 30 秒自动关闭：与震动超时同一时长，避免出现「界面关了还在震」
        handler.removeCallbacks(autoClose)
        handler.postDelayed(autoClose, AUTO_CLOSE_MS)
    }

    // 停震请求统一交给 PushService —— 它是唯一持有震动状态的地方，不存在「两边各自停一半」。
    // withNotifId=true 时 PushService 会顺手撤销这条通知（用户主动停止 → 提醒应当彻底消失）；
    // 超时自动关闭时不带 id，通知由 PushService 的 retractHeadsUp 收回通知栏留着可回看。
    private fun requestStop(withNotifId: Boolean, reason: String) {
        val useId = withNotifId && notifId > 0
        val i = Intent(this, PushService::class.java).setAction(PushService.ACTION_STOP_VIBRATE)
        if (useId) i.putExtra(PushService.EXTRA_NOTIF_ID, notifId)
        try {
            startService(i)
        } catch (_: Exception) {
        }
        LogHelper.append(this, "AlarmActivity stop request: $reason (cancelNotif=$useId)")
    }

    private fun dismiss(reason: String) {
        handler.removeCallbacks(autoClose)
        // 超时走出这条路径：震动停掉，通知由 PushService 收回通知栏
        if (!stopped) {
            stopped = true
            requestStop(withNotifId = false, reason = reason)
        }
        LogHelper.append(this, "AlarmActivity dismiss: $reason")
        // 整任务移除：否则最近任务里会留一条打不开的僵尸条目（配合 Manifest 的 excludeFromRecents）
        finishAndRemoveTask()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    // 离开语义：按 Home / 电源键 / Back 离开**不停震** ——
    // 「能操作设备」不等于「已注意到内容」。震动仍可由通知栏划掉 / 通知上的停止按钮 / 超时终止。

    companion object {
        const val EXTRA_TITLE = "alarm_title"
        const val EXTRA_BODY = "alarm_body"
        // 本条消息对应的通知 id（= PushService.messageNotifId 的值），停止时用它撤销通知
        const val EXTRA_NOTIF_ID = "alarm_notif_id"
        // true = 用户点击横幅进页（不是系统/服务拉起）→ 进页即视为已看到，立刻停震
        const val EXTRA_FROM_TAP = "alarm_from_tap"
        private const val AUTO_CLOSE_MS = 30_000L
    }
}
