package com.example.notifyhub.ui

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.example.notifyhub.R
import com.example.notifyhub.api.Api
import com.example.notifyhub.api.CredReq
import com.example.notifyhub.data.TokenStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class LoginActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_login)

        val user = findViewById<EditText>(R.id.etUser)
        val pass = findViewById<EditText>(R.id.etPass)
        val msg = findViewById<TextView>(R.id.tvMsg)

        findViewById<Button>(R.id.btnLogin).setOnClickListener {
            doAuth(user.text.toString(), pass.text.toString(), false, msg)
        }
        findViewById<Button>(R.id.btnRegister).setOnClickListener {
            doAuth(user.text.toString(), pass.text.toString(), true, msg)
        }
    }

    private fun doAuth(username: String, password: String, register: Boolean, msg: TextView) {
        if (username.isBlank() || password.length < 6) {
            msg.text = "用户名必填，密码至少 6 位"
            return
        }
        lifecycleScope.launch {
            try {
                val api = Api.instance(this@LoginActivity)
                val resp = if (register) api.register(CredReq(username, password))
                else api.login(CredReq(username, password))
                TokenStore(this@LoginActivity).token = resp.token
                startActivity(Intent(this@LoginActivity, NotificationsActivity::class.java))
                finish()
            } catch (e: Exception) {
                withContext(Dispatchers.Main) { msg.text = e.message ?: "请求失败" }
            }
        }
    }
}
