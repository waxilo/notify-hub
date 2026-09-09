package com.example.notifyhub.data

import android.content.Context

// 记住账号密码（SharedPreferences 明文存储，仅自托管场景使用）。
// 勾选「记住账号密码」后登录成功才写入；退出登录不清除，方便下次一键回填。
class CredStore(context: Context) {
    private val sp = context.getSharedPreferences("cred", Context.MODE_PRIVATE)

    var username: String
        get() = sp.getString("username", "").orEmpty()
        set(value) = sp.edit().putString("username", value).apply()

    var password: String
        get() = sp.getString("password", "").orEmpty()
        set(value) = sp.edit().putString("password", value).apply()

    var remember: Boolean
        get() = sp.getBoolean("remember", false)
        set(value) = sp.edit().putBoolean("remember", value).apply()

    fun save(username: String, password: String) {
        this.username = username
        this.password = password
        remember = true
    }

    fun clear() {
        sp.edit().clear().apply()
    }
}
