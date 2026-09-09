package com.example.notifyhub.ui

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.example.notifyhub.R
import com.example.notifyhub.api.Api
import com.example.notifyhub.api.ChangePwReq
import com.example.notifyhub.data.ConfigStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

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

        findViewById<Button>(R.id.btnTestNotify).setOnClickListener {
            lifecycleScope.launch { pickKeyAndTest() }
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

    private suspend fun pickKeyAndTest() {
        val tvTest = findViewById<TextView>(R.id.tvTestMsg)
        try {
            val keys = Api.safe { Api.instance(this).listKeys() }.keys.filter { it.active == 1 }
            withContext(Dispatchers.Main) {
                if (keys.isEmpty()) {
                    tvTest.text = "还没有启用的 key，请先到 Web 控制台生成"
                    return@withContext
                }
                val names = keys.map { "${it.name}（…${it.key.takeLast(4)}）" }.toTypedArray()
                AlertDialog.Builder(this@SettingsActivity)
                    .setTitle("选择要测试的 Key")
                    .setItems(names) { _, i -> lifecycleScope.launch { sendTest(keys[i]) } }
                    .setNegativeButton("取消", null)
                    .show()
            }
        } catch (e: Exception) {
            withContext(Dispatchers.Main) { tvTest.text = "获取 key 列表失败：${e.message}" }
        }
    }

    private suspend fun sendTest(key: com.example.notifyhub.api.KeyItem) {
        val tvTest = findViewById<TextView>(R.id.tvTestMsg)
        withContext(Dispatchers.Main) { tvTest.text = "发送中…" }
        try {
            val full = key.keyFull
                ?: throw IllegalStateException("缺少完整 key（请更新 App 或到 Web 控制台测试）")
            val base = ConfigStore(this).apiBase.removeSuffix("/")
            val json = """{"title":"Notify Hub 测试通知","body":"来自 App 的测试 · key「${key.name}」"}"""
            val req = Request.Builder()
                .url("$base/hook/$full")
                .post(json.toRequestBody("application/json".toMediaType()))
                .build()
            val resp = Api.safe { OkHttpClient().newCall(req).execute() }
            resp.use { r ->
                val body = r.body?.string().orEmpty()
                withContext(Dispatchers.Main) {
                    tvTest.text = if (r.isSuccessful)
                        "✅ 测试已送达「${key.name}」，请到通知收件箱查看"
                    else "❌ 发送失败（HTTP ${r.code}）：$body"
                }
            }
        } catch (e: Exception) {
            withContext(Dispatchers.Main) { tvTest.text = "❌ 发送失败：${e.message}" }
        }
    }
}
