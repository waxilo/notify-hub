package com.example.notifyhub.ui

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.example.notifyhub.R
import com.example.notifyhub.api.Api
import com.example.notifyhub.api.ChangePwReq
import com.example.notifyhub.data.ConfigStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class SettingsActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        val cfg = ConfigStore(this)
        val etApi = findViewById<EditText>(R.id.etApi)
        val etPoll = findViewById<EditText>(R.id.etPoll)
        etApi.setText(cfg.apiBase)
        etPoll.setText((cfg.pollIntervalMs / 1000).toString())

        findViewById<Button>(R.id.btnSaveCfg).setOnClickListener {
            cfg.apiBase = etApi.text.toString().trim()
            cfg.pollIntervalMs = (etPoll.text.toString().toLongOrNull() ?: 10) * 1000
            Toast.makeText(this, "配置已保存", Toast.LENGTH_SHORT).show()
        }

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
                }
            }
        }
    }
}
