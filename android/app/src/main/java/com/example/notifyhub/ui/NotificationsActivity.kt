package com.example.notifyhub.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.example.notifyhub.R
import com.example.notifyhub.api.Api
import com.example.notifyhub.api.NotificationItem
import com.example.notifyhub.data.PushService
import com.example.notifyhub.data.TokenStore
import com.example.notifyhub.data.UpdateChecker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class NotificationsActivity : AppCompatActivity() {
    private lateinit var adapter: NotificationAdapter
    private var polling = false

    private val notifPermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_notifications)

        adapter = NotificationAdapter { item -> markRead(item) }
        val rv = findViewById<RecyclerView>(R.id.rv)
        rv.layoutManager = LinearLayoutManager(this)
        rv.adapter = adapter

        findViewById<Button>(R.id.btnSettings).setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
        findViewById<Button>(R.id.btnRefresh).setOnClickListener { loadOnce() }

        ensureNotificationPermission()
        // 启动前台服务：WebSocket 长连接，收到推送立即弹系统通知（替代纯轮询）
        ContextCompat.startForegroundService(this, Intent(this, PushService::class.java))

        // 静默检查更新，仅在有新版本时弹窗提示
        lifecycleScope.launch {
            val latest = UpdateChecker.latest(this@NotificationsActivity) ?: return@launch
            if (UpdateChecker.isNewer(latest, this@NotificationsActivity)) {
                withContext(Dispatchers.Main) {
                    androidx.appcompat.app.AlertDialog.Builder(this@NotificationsActivity)
                        .setTitle("发现新版本")
                        .setMessage("最新版本：v${latest.versionName ?: "?"}（code ${latest.versionCode}），是否下载？")
                        .setPositiveButton("下载") { _, _ ->
                            UpdateChecker.openDownload(this@NotificationsActivity, latest)
                        }
                        .setNegativeButton("忽略", null)
                        .show()
                }
            }
        }
    }

    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            notifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun onResume() {
        super.onResume()
        polling = true
        startPolling()
    }

    override fun onPause() {
        polling = false
        super.onPause()
    }

    private fun startPolling() {
        lifecycleScope.launch {
            while (polling && isActive) {
                loadOnceSuspend()
                delay(REFRESH_INTERVAL_MS)
            }
        }
    }

    private fun loadOnce() {
        lifecycleScope.launch { loadOnceSuspend() }
    }

    private suspend fun loadOnceSuspend() {
        try {
            val resp = Api.safe { Api.instance(this@NotificationsActivity).listNotifications(50) }
            withContext(Dispatchers.Main) { adapter.submit(resp.notifications) }
        } catch (e: retrofit2.HttpException) {
            if (e.code() == 401) backToLogin()  // token 失效：清登录态并踢回登录页
        } catch (_: Exception) {
            // 轮询时静默失败，避免刷屏
        }
    }

    private fun backToLogin() {
        TokenStore(this).clear()
        startActivity(Intent(this, LoginActivity::class.java))
        finish()
    }

    private fun markRead(item: NotificationItem) {
        lifecycleScope.launch {
            try {
                Api.safe { Api.instance(this@NotificationsActivity).markRead(item.id) }
                loadOnceSuspend()
            } catch (_: Exception) {
            }
        }
    }

    companion object {
        // 页面内列表自动刷新间隔（仅刷新界面，与实时推送无关）
        private const val REFRESH_INTERVAL_MS = 10_000L
    }
}
