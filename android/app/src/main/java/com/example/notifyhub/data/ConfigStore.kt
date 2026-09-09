package com.example.notifyhub.data

import android.content.Context
import android.content.SharedPreferences

// 本地配置：Worker 地址、轮询间隔
class ConfigStore(context: Context) {
    private val sp: SharedPreferences = context.getSharedPreferences("nh_cfg", Context.MODE_PRIVATE)

    var apiBase: String
        get() = sp.getString("api_base", "https://notify-hub-worker.<your-subdomain>.workers.dev")!!
        set(value) = sp.edit().putString("api_base", value.trim().removeSuffix("/")).apply()

    var pollIntervalMs: Long
        get() = sp.getLong("poll_ms", 10_000L)
        set(value) = sp.edit().putLong("poll_ms", value.coerceAtLeast(2000)).apply()
}
