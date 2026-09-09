package com.example.notifyhub.data

import android.content.Context

// Worker 地址固定写死（不再提供设置项），保留常量形式便于统一修改
class ConfigStore(@Suppress("UNUSED_PARAMETER") context: Context) {
    val apiBase: String = DEFAULT_API_BASE

    companion object {
        const val DEFAULT_API_BASE = "https://notify-hub-worker.sloan.dpdns.org"
    }
}
