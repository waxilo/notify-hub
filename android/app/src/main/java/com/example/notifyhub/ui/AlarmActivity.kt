package com.example.notifyhub.ui

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.example.notifyhub.LogHelper
import com.example.notifyhub.R
import com.example.notifyhub.data.PushService

// 强力震动的锁屏告警页：由通知的 fullScreenIntent 拉起。
//
// 为什么单独建一个 Activity 而不是复用主界面（MainActivity/KeysActivity）：
// 覆盖锁屏的这个「身份」自带三条约束，只有专用页才能干净地满足 ——
//   ① 多实例叠加 → launchMode="singleInstance"（Manifest）
//   ② 最近任务里的僵尸条目 → excludeFromRecents + finishAndRemoveTask()
//   ③ 自动关闭必须与震动停止同源 → 下面 dismiss() 里发同一条广播
// 复用主界面则 ② 无解：主界面必须留在最近任务里，而这些约束会直接落到 App 的正常启动路径上。
//
// 亮屏解锁态系统一定降级为横幅，本页不会启动 —— 此时用户看到的是「关不掉的横幅」。
class AlarmActivity : AppCompatActivity() {

    private val handler = Handler(Looper.getMainLooper())
    private val autoClose = Runnable { dismiss("timeout") }

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

        findViewById<Button>(R.id.btnStop).setOnClickListener { dismiss("user") }
        findViewById<Button>(R.id.btnOpenApp).setOnClickListener {
            // 看详情不停震：用户点的是「我看看是什么事」，不是「我知道了」
            startActivity(
                Intent(this, KeysActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            )
        }

        bind(intent)
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
        val title = i?.getStringExtra(EXTRA_TITLE).orEmpty().ifEmpty { "新通知" }
        val body = i?.getStringExtra(EXTRA_BODY).orEmpty()
        findViewById<TextView>(R.id.tvAlarmTitle).text = title
        findViewById<TextView>(R.id.tvAlarmBody).text = body
        findViewById<TextView>(R.id.tvAlarmBody).visibility =
            if (body.isBlank()) android.view.View.GONE else android.view.View.VISIBLE
        // 30 秒自动关闭：与震动超时同一条广播、同一时长，避免出现「界面关了还在震」
        handler.removeCallbacks(autoClose)
        handler.postDelayed(autoClose, AUTO_CLOSE_MS)
    }

    private fun dismiss(reason: String) {
        handler.removeCallbacks(autoClose)
        // 震动停止统一走这条广播 —— 与 PushService 的 stopReceiver / 超时兜底是同一个入口，
        // 不存在「两边各自停一半」的可能
        sendBroadcast(Intent(PushService.ACTION_STOP_VIBRATE).setPackage(packageName))
        LogHelper.append(this, "AlarmActivity dismiss: $reason")
        // 整任务移除：否则最近任务里会留一条打不开的僵尸条目（配合 Manifest 的 excludeFromRecents）
        finishAndRemoveTask()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    // 离开语义：按 Home / 电源键 / Back 离开**不停震** ——
    // 「能操作设备」不等于「已注意到内容」。震动仍可由通知栏划掉 / 超时终止。

    companion object {
        const val EXTRA_TITLE = "alarm_title"
        const val EXTRA_BODY = "alarm_body"
        private const val AUTO_CLOSE_MS = 30_000L
    }
}
