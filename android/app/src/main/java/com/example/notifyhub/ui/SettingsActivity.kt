package com.example.notifyhub.ui

import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.example.notifyhub.R
import com.example.notifyhub.api.Api
import com.example.notifyhub.api.ChangePwReq
import com.example.notifyhub.data.PushService
import com.example.notifyhub.data.TokenStore
import com.example.notifyhub.data.UpdateChecker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class SettingsActivity : AppCompatActivity() {

    private val loading by lazy { LoadingOverlay(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        // 底部页签：首页 / 定时任务 / 设置
        BottomNav.bind(this, SettingsActivity::class.java)

        // ---- 提醒权限（强力震动的全屏链路依赖的三项系统开关）----
        findViewById<Button>(R.id.btnFsiSetting).setOnClickListener { openFullScreenIntentSetting() }
        findViewById<Button>(R.id.btnChannelSetting).setOnClickListener { openChannelSetting() }
        findViewById<Button>(R.id.btnOverlaySetting).setOnClickListener { openOverlaySetting() }
        refreshPermissionState()

        // ---- 版本与更新 ----
        val tvVersion = findViewById<TextView>(R.id.tvVersion)
        val tvUpdate = findViewById<TextView>(R.id.tvUpdateMsg)
        val btnCheck = findViewById<Button>(R.id.btnCheckUpdate)
        tvVersion.text = "当前版本：${UpdateChecker.installedVersionName(this)}（code ${UpdateChecker.installedVersionCode(this)}）"
        btnCheck.setOnClickListener {
            tvUpdate.text = "检查中…"
            loading.show()
            lifecycleScope.launch {
                try { checkUpdate(tvUpdate) } finally { loading.hide() }
            }
        }

        // ---- 修改密码 ----
        val etOld = findViewById<EditText>(R.id.etOld)
        val etNew = findViewById<EditText>(R.id.etNew)
        val tvMsg = findViewById<TextView>(R.id.tvMsg)
        findViewById<Button>(R.id.btnChangePw).setOnClickListener {
            val old = etOld.text.toString()
            val new = etNew.text.toString()
            if (new.length < 6) {
                tvMsg.text = "新密码至少 6 位"
                return@setOnClickListener
            }
            loading.show()
            lifecycleScope.launch {
                try {
                    Api.safe { Api.instance(this@SettingsActivity).changePassword(ChangePwReq(old, new)) }
                    withContext(Dispatchers.Main) {
                        tvMsg.text = "密码已更新"
                        etOld.text.clear()
                        etNew.text.clear()
                    }
                } catch (e: Exception) {
                    withContext(Dispatchers.Main) { tvMsg.text = e.message ?: "修改失败" }
                } finally {
                    loading.hide()
                }
            }
        }

        // ---- 退出登录 ----
        findViewById<Button>(R.id.btnLogout).setOnClickListener {
            AlertDialog.Builder(this)
                .setTitle("退出登录")
                .setMessage("退出后将停止推送连接并清除登录状态，需要重新登录。")
                .setPositiveButton("退出") { _, _ -> doLogout() }
                .setNegativeButton("取消", null)
                .show()
        }
    }

    private fun doLogout() {
        // 清除登录态并停止前台推送服务（WS 断开、常驻通知移除）
        TokenStore(this).clear()
        try {
            stopService(Intent(this, com.example.notifyhub.data.PushService::class.java))
        } catch (_: Exception) {
        }
        val i = Intent(this, LoginActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        try {
            startActivity(i)
        } catch (_: Exception) {
        }
        // 结束本任务栈内所有页面，确保回到登录页（比单独 finish 更干净）
        finishAffinity()
    }

    override fun onResume() {
        super.onResume()
        // 从系统设置返回后刷新权限状态
        refreshPermissionState()
        // "安装未知应用"授权后返回：自动继续安装
        com.example.notifyhub.data.UpdateChecker.resumePendingInstall(this)
    }

    // 四项检测：
    //   ① 通知总开关 —— 关掉后我们**不会**震动（否则就是「我把通知关了它还在震」，必被投诉）
    //   ② 全屏通知（Android 14+）—— 未授权时连锁屏都只剩 60 秒横幅；但震动不受影响
    //   ③ 推送渠道重要性 —— 官方硬性要求 ≥ IMPORTANCE_HIGH，低于它系统绝不启动全屏页；
    //      而渠道一旦被用户调低，App 再也改不回来（只能引导用户去系统设置），所以必须读出来
    //   ④ 悬浮窗权限 —— 官方 API，能读能跳转。它是 Android 10+ 后台启动 Activity 的硬豁免，
    //      也是本应用在 ROM 拦下 FSI 时唯一能自己把告警页拉起来的手段，所以优先级最高
    // 厂商自建的「后台弹出界面」权限不做反射探测（非官方 API，ROM 一升级就静默误判），
    // 失效的探测比不探测更糟 —— 改为在卡片底部用文字引导用户手动前往。
    private fun refreshPermissionState() {
        val tvNotif = findViewById<TextView>(R.id.tvNotifStatus)
        val tvFsi = findViewById<TextView>(R.id.tvFsiStatus)
        val btnFsi = findViewById<Button>(R.id.btnFsiSetting)

        val notifOk = runCatching {
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).areNotificationsEnabled()
        }.getOrDefault(true)
        tvNotif.text = if (notifOk) "通知权限：已开启" else "通知权限：已关闭 —— 通知与震动都不会触发，请前往系统设置开启"
        tvNotif.setTextColor(if (notifOk) 0xFF17994F.toInt() else 0xFFE5484D.toInt())

        if (Build.VERSION.SDK_INT < 34) {
            // Android 14 以下 FSI 默认授予，无需检测
            tvFsi.text = "全屏通知：已允许（Android 14 以下默认授予）"
            tvFsi.setTextColor(0xFF17994F.toInt())
            btnFsi.visibility = View.GONE
        } else {
            val fsiOk = PushService.canUseFullScreenIntent(this)
            tvFsi.text = if (fsiOk) "全屏通知：已允许"
            else "全屏通知：未允许 —— 锁屏/灭屏时不会弹出全屏告警页（震动照常持续）"
            tvFsi.setTextColor(if (fsiOk) 0xFF17994F.toInt() else 0xFFC07F00.toInt())
            btnFsi.visibility = if (fsiOk) View.GONE else View.VISIBLE
        }

        // 悬浮窗（显示在其他应用上层）：官方检测 API，授予后可绕开后台启动界面限制
        val tvOv = findViewById<TextView>(R.id.tvOverlayStatus)
        val btnOv = findViewById<Button>(R.id.btnOverlaySetting)
        val ovOk = PushService.canDrawOverlays(this)
        tvOv.text = if (ovOk) "悬浮窗权限：已开启 —— 息屏/锁屏时会直接拉起全屏告警页"
        else "悬浮窗权限：未开启 —— 系统全屏通知被拦截时无法兜底，息屏只剩横幅"
        tvOv.setTextColor(if (ovOk) 0xFF17994F.toInt() else 0xFFC07F00.toInt())
        btnOv.visibility = if (ovOk) View.GONE else View.VISIBLE

        // 渠道重要性分档：-1 未创建 / NONE 被关闭 / <HIGH 被调低 / ≥HIGH 正常
        val tvCh = findViewById<TextView>(R.id.tvChannelStatus)
        val btnCh = findViewById<Button>(R.id.btnChannelSetting)
        val imp = PushService.pushChannelImportance(this)
        when {
            imp < 0 -> {
                tvCh.text = "推送渠道：尚未创建（收到第一条推送后自动生成）"
                tvCh.setTextColor(0xFF8A93A6.toInt())
                btnCh.visibility = View.GONE
            }
            imp == NotificationManager.IMPORTANCE_NONE -> {
                tvCh.text = "推送渠道：已关闭 —— 通知与震动都不会触发，请前往系统设置开启"
                tvCh.setTextColor(0xFFE5484D.toInt())
                btnCh.visibility = View.VISIBLE
            }
            imp < NotificationManager.IMPORTANCE_HIGH -> {
                tvCh.text = "推送渠道：已低于「高」—— 锁屏全屏告警页不会弹出（横幅与震动仍正常）"
                tvCh.setTextColor(0xFFC07F00.toInt())
                btnCh.visibility = View.VISIBLE
            }
            else -> {
                tvCh.text = "推送渠道：高 —— 横幅与锁屏全屏告警页均可用"
                tvCh.setTextColor(0xFF17994F.toInt())
                btnCh.visibility = View.GONE
            }
        }
    }

    // 直接落到「通知推送」这一个渠道的设置页：这里能看到并改回重要性、横幅、锁屏显示等开关，
    // 也是全屏告警页不弹时最该先查的一页
    private fun openChannelSetting() {
        try {
            startActivity(
                Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                    .putExtra(Settings.EXTRA_CHANNEL_ID, PushService.PUSH_CHANNEL_ID)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } catch (e: Exception) {
            // 个别 ROM 不认渠道级入口，退到应用级通知设置
            try {
                startActivity(
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (_: Exception) {
                findViewById<TextView>(R.id.tvChannelStatus).text =
                    "无法打开系统设置，请手动前往：设置 → 通知 → Notify Hub → 通知推送"
            }
        }
    }

    private fun openFullScreenIntentSetting() {
        try {
            startActivity(
                Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT)
                    .setData(Uri.fromParts("package", packageName, null))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } catch (e: Exception) {
            findViewById<TextView>(R.id.tvFsiStatus).text =
                "无法打开系统设置，请手动前往：设置 → 应用 → 特殊应用权限 → 全屏通知"
        }
    }

    // 「显示在其他应用上层」是特殊权限，只能跳到系统页由用户手动勾选（没有运行时弹窗可申请）
    private fun openOverlaySetting() {
        try {
            startActivity(
                Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)
                    .setData(Uri.fromParts("package", packageName, null))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } catch (e: Exception) {
            try {
                // 个别 ROM 不认带 package 的入口，退到权限列表页
                startActivity(
                    Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (_: Exception) {
                findViewById<TextView>(R.id.tvOverlayStatus).text =
                    "无法打开系统设置，请手动前往：设置 → 应用 → 特殊应用权限 → 显示在其他应用上层"
            }
        }
    }

    private suspend fun checkUpdate(tvUpdate: TextView) {
        val latest = UpdateChecker.latest(this)
        withContext(Dispatchers.Main) {
            when {
                latest == null -> tvUpdate.text = "检查失败：暂无可用版本信息或网络不通"
                UpdateChecker.isNewer(latest, this@SettingsActivity) -> {
                    tvUpdate.text = "发现新版本 v${latest.versionName ?: latest.versionCode}"
                    // 上次下载完成但未安装（如点了"稍后安装"）：直接安装，不重复下载
                    val ready = UpdateChecker.pendingApk(this@SettingsActivity, latest)
                    if (ready != null) {
                        AlertDialog.Builder(this@SettingsActivity)
                            .setTitle("安装包已就绪")
                            .setMessage("新版本 v${latest.versionName ?: "?"}（code ${latest.versionCode}）已下载完成，直接安装即可，无需重新下载。")
                            .setPositiveButton("安装") { _, _ ->
                                UpdateChecker.installApk(this@SettingsActivity, ready)
                                tvUpdate.text = "已打开安装程序，确认安装即可"
                            }
                            .setNegativeButton("以后再说", null)
                            .show()
                    } else {
                        AlertDialog.Builder(this@SettingsActivity)
                            .setTitle("发现新版本")
                            .setMessage("最新版本：v${latest.versionName ?: "?"}（code ${latest.versionCode}）\n下载完成后将自动打开安装程序。")
                            .setPositiveButton("下载") { _, _ ->
                                lifecycleScope.launch { downloadAndInstall(latest, tvUpdate) }
                            }
                            .setNegativeButton("以后再说", null)
                            .show()
                    }
                }
                else -> tvUpdate.text = "已是最新版本"
            }
        }
    }

    private suspend fun downloadAndInstall(latest: com.example.notifyhub.data.UpdateInfo, tvUpdate: TextView) {
        withContext(Dispatchers.Main) { tvUpdate.text = "静默下载中…" }
        try {
            val result = UpdateChecker.downloadAndInstall(this@SettingsActivity, latest) { p ->
                withContext(Dispatchers.Main) { tvUpdate.text = "下载中 $p%" }
            }
            withContext(Dispatchers.Main) {
                tvUpdate.text = if (result == "installing") "已打开安装程序，确认安装即可"
                else "请在授权页允许安装未知应用，返回后自动继续安装"
            }
        } catch (e: Exception) {
            withContext(Dispatchers.Main) { tvUpdate.text = "下载失败：${e.message}" }
        }
    }
}
