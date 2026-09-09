package com.example.notifyhub.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.RadioButton
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.example.notifyhub.R
import com.example.notifyhub.api.Api
import com.example.notifyhub.api.KeyItem
import com.example.notifyhub.api.UpdateKeyReq
import com.example.notifyhub.data.ConfigStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// 首页：Key 列表管理（测试 / 历史 / 编辑），收件箱与设置从顶栏进入
class KeysActivity : AppCompatActivity() {

    private val keys = mutableListOf<KeyItem>()
    private lateinit var adapter: KeyAdapter
    private val loading by lazy { LoadingOverlay(this) }
    private val fmt = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_keys)

        // 收件箱移除后由首页负责拉起前台推送服务，保证 WS 实时推送在线
        val svc = Intent(this, com.example.notifyhub.data.PushService::class.java)
        if (android.os.Build.VERSION.SDK_INT >= 26) startForegroundService(svc) else startService(svc)
        // Android 13+ 动态请求通知权限
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        adapter = KeyAdapter()
        val rv = findViewById<RecyclerView>(R.id.rv)
        rv.layoutManager = LinearLayoutManager(this)
        rv.adapter = adapter

        findViewById<Button>(R.id.btnSettings).setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
        findViewById<Button>(R.id.btnRefresh).setOnClickListener { loadKeys() }

        loadKeys()
    }

    override fun onResume() {
        super.onResume()
        loadKeys()  // 从编辑/收件箱返回后刷新状态
    }

    private fun loadKeys() {
        loading.show()
        lifecycleScope.launch {
            try {
                val list = Api.safe { Api.instance(this@KeysActivity).listKeys() }.keys
                keys.clear()
                keys.addAll(list)
                withContext(Dispatchers.Main) { adapter.notifyDataSetChanged() }
            } catch (e: retrofit2.HttpException) {
                if (e.code() == 401) backToLogin()
            } catch (_: Exception) {
            } finally {
                withContext(Dispatchers.Main) { loading.hide() }
            }
        }
    }

    private fun backToLogin() {
        com.example.notifyhub.data.TokenStore(this).clear()
        startActivity(Intent(this, LoginActivity::class.java))
        finish()
    }

    // ---------- 测试发送 ----------
    private fun sendTest(k: KeyItem, btn: Button) {
        btn.isEnabled = false
        btn.text = "发送中"
        lifecycleScope.launch {
            var result: String
            try {
                val full = k.keyFull ?: throw IllegalStateException("缺少完整 key")
                val base = ConfigStore(this@KeysActivity).apiBase.removeSuffix("/")
                val json = """{"message":"来自 App 的测试"}"""
                val req = Request.Builder()
                    .url("$base/hook/$full")
                    .post(json.toRequestBody("application/json".toMediaType()))
                    .build()
                val resp = Api.safe { OkHttpClient().newCall(req).execute() }
                resp.use { result = if (it.isSuccessful) "✅ 已送达「${k.name}」" else "❌ 失败（HTTP ${it.code}）" }
            } catch (e: Exception) {
                result = "❌ ${e.message}"
            }
            withContext(Dispatchers.Main) {
                Toast.makeText(this@KeysActivity, result, Toast.LENGTH_SHORT).show()
                btn.isEnabled = true
                btn.text = "测试"
            }
        }
    }

    // ---------- 编辑弹窗：名称 / 模式 / 启停 ----------
    private fun openEdit(k: KeyItem) {
        val view = layoutInflater.inflate(R.layout.dialog_edit_key, null)
        val etName = view.findViewById<EditText>(R.id.etName)
        val rbDefault = view.findViewById<RadioButton>(R.id.rbModeDefault)
        val rbCustom = view.findViewById<RadioButton>(R.id.rbModeCustom)
        val cbActive = view.findViewById<CheckBox>(R.id.cbActive)

        etName.setText(k.name)
        if (k.mode == "custom") rbCustom.isChecked = true else rbDefault.isChecked = true
        cbActive.isChecked = k.active == 1

        val dialog = AlertDialog.Builder(this)
            .setTitle("编辑 Key")
            .setView(view)
            .setPositiveButton("保存", null)
            .setNegativeButton("取消", null)
            .create()
        dialog.show()
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val name = etName.text.toString().trim()
            if (name.isEmpty()) {
                Toast.makeText(this, "名称不能为空", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            lifecycleScope.launch {
                try {
                    Api.safe {
                        Api.instance(this@KeysActivity).updateKey(
                            k.id,
                            UpdateKeyReq(
                                name = name,
                                active = cbActive.isChecked,
                                mode = if (rbCustom.isChecked) "custom" else "default"
                            )
                        )
                    }
                    dialog.dismiss()
                    loadKeys()
                } catch (e: Exception) {
                    withContext(Dispatchers.Main) {
                        Toast.makeText(this@KeysActivity, "保存失败：${e.message}", Toast.LENGTH_SHORT).show()
                    }
                }
            }
        }
    }

    // ---------- 列表 ----------
    private inner class KeyAdapter : RecyclerView.Adapter<KeyAdapter.VH>() {

        inner class VH(v: View) : RecyclerView.ViewHolder(v) {
            val tvName: TextView = v.findViewById(R.id.tvName)
            val tvStatus: TextView = v.findViewById(R.id.tvStatus)
            val tvMeta: TextView = v.findViewById(R.id.tvMeta)
            val btnTest: Button = v.findViewById(R.id.btnTest)
            val btnHistory: Button = v.findViewById(R.id.btnHistory)
            val btnEdit: Button = v.findViewById(R.id.btnEdit)
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH =
            VH(LayoutInflater.from(parent.context).inflate(R.layout.item_key, parent, false))

        @SuppressLint("SetTextI18n")
        override fun onBindViewHolder(h: VH, position: Int) {
            val k = keys[position]
            val on = k.active == 1
            h.tvName.text = k.name ?: "未命名"
            if (on) {
                h.tvStatus.text = "启用中"
                h.tvStatus.setBackgroundResource(R.drawable.bg_chip_on)
                h.tvStatus.setTextColor(0xFF17994F.toInt())
            } else {
                h.tvStatus.text = "已停用"
                h.tvStatus.setBackgroundResource(R.drawable.bg_chip_off)
                h.tvStatus.setTextColor(0xFF8A93A6.toInt())
            }
            val used = k.lastUsed?.let { "最近使用 ${fmt.format(Date(it))}" } ?: "从未使用"
            h.tvMeta.text = "…${(k.keyFull ?: k.key).takeLast(6)} · $used"
            h.itemView.alpha = if (on) 1f else 0.62f
            h.btnTest.isEnabled = on
            h.btnTest.setOnClickListener { sendTest(k, h.btnTest) }
            h.btnHistory.setOnClickListener {
                val i = Intent(this@KeysActivity, KeyHistoryActivity::class.java)
                i.putExtra("key_id", k.id)
                startActivity(i)
            }
            h.btnEdit.setOnClickListener { openEdit(k) }
        }

        override fun getItemCount() = keys.size
    }
}
