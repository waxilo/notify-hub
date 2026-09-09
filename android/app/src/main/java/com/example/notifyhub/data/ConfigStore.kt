package com.example.notifyhub.data

import android.content.Context
import android.content.SharedPreferences

// 本地配置：Worker 地址
class ConfigStore(context: Context) {
    private val sp: SharedPreferences = context.getSharedPreferences("nh_cfg", Context.MODE_PRIVATE)

    var apiBase: String
        get() = sp.getString("api_base", "https://notify-hub-worker.sloan.dpdns.org")!!
        set(value) = sp.edit().putString("api_base", value.trim().removeSuffix("/")).apply()
}
