package com.example.notifyhub.ui

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.example.notifyhub.R
import com.example.notifyhub.api.Api
import com.example.notifyhub.api.CredReq
import com.example.notifyhub.data.CredStore
import com.example.notifyhub.data.TokenStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class LoginActivity : AppCompatActivity() {

    private val loading by lazy { LoadingOverlay(this) }

    override fun onCreate(savedInstanceState: Bundle?) {

        // 已有登录态（JWT 无过期时间，服务端不吊销即长期有效）：直接进入主界面
        if (!TokenStore(this).token.isNullOrBlank()) {
            startActivity(Intent(this, KeysActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_login)

        val user = findViewById<EditText>(R.id.etUser)
        val pass = findViewById<EditText>(R.id.etPass)
        val msg = findViewById<TextView>(R.id.tvMsg)
        val cbRemember = findViewById<CheckBox>(R.id.cbRemember)

        // 回填记住的账号密码
        val cred = CredStore(this)
        if (cred.remember) {
            user.setText(cred.username)
            pass.setText(cred.password)
            cbRemember.isChecked = true
        }

        findViewById<Button>(R.id.btnLogin).setOnClickListener {
            doLogin(user.text.toString(), pass.text.toString(), cbRemember.isChecked, msg)
        }
    }

    private fun doLogin(username: String, password: String, remember: Boolean, msg: TextView) {
        if (username.isBlank() || password.length < 6) {
            msg.text = "用户名必填，密码至少 6 位"
            return
        }
        loading.show()
        lifecycleScope.launch {
            try {
                val api = Api.instance(this@LoginActivity)
                val resp = api.login(CredReq(username, password))
                TokenStore(this@LoginActivity).token = resp.token
                // 记住账号密码：登录成功才写入；未勾选则清除旧记录
                val cred = CredStore(this@LoginActivity)
                if (remember) cred.save(username, password) else cred.clear()
                startActivity(Intent(this@LoginActivity, KeysActivity::class.java))
                finish()
            } catch (e: Exception) {
                withContext(Dispatchers.Main) { msg.text = e.message ?: "请求失败" }
            } finally {
                loading.hide()
            }
        }
    }
}
