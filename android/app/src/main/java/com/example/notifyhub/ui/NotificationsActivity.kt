package com.example.notifyhub.ui

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.example.notifyhub.R
import com.example.notifyhub.api.Api
import com.example.notifyhub.api.NotificationItem
import com.example.notifyhub.data.ConfigStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class NotificationsActivity : AppCompatActivity() {
    private lateinit var adapter: NotificationAdapter
    private var polling = false

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
                delay(ConfigStore(this@NotificationsActivity).pollIntervalMs)
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
        } catch (_: Exception) {
            // 轮询时静默失败，避免刷屏
        }
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
}
