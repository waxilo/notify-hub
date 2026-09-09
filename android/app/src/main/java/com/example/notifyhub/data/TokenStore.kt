package com.example.notifyhub.data

import android.content.Context
import android.content.SharedPreferences

// 登录态：仅保存 JWT
class TokenStore(context: Context) {
    private val sp: SharedPreferences = context.getSharedPreferences("nh_auth", Context.MODE_PRIVATE)

    var token: String?
        get() = sp.getString("token", null)
        set(value) = sp.edit().putString("token", value).apply()

    fun clear() = sp.edit().remove("token").apply()
}
