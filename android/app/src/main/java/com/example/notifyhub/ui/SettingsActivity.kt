package com.example.notifyhub.ui

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.example.notifyhub.R
import com.example.notifyhub.api.Api
import com.example.notifyhub.api.ChangePwReq
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
        // "安装未知应用"授权后返回：自动继续安装
        com.example.notifyhub.data.UpdateChecker.resumePendingInstall(this)
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
