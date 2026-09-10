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
import com.example.notifyhub.LogHelper
import com.example.notifyhub.R
import com.example.notifyhub.api.Api
import com.example.notifyhub.api.KeyItem
import com.example.notifyhub.api.UpdateKeyReq
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// 首页：Key 列表管理（历史 / 编辑）；定时任务与设置从底部页签进入
class KeysActivity : AppCompatActivity() {

    private val keys = mutableListOf<KeyItem>()
    private lateinit var adapter: KeyAdapter
    private val loading by lazy { LoadingOverlay(this) }
    private val fmt = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_keys)

        LogHelper.append(this, "KeysActivity onCreate")

        // 收件箱移除后由首页负责拉起前台推送服务，保证 WS 实时推送在线
        // 无登录态时不拉起（退出登录后残留任务栈可能再次进入本页）
        if (com.example.notifyhub.data.TokenStore(this).token.isNullOrBlank()) {
            LogHelper.append(this, "no token -> skip startForegroundService")
        } else {
            val svc = Intent(this, com.example.notifyhub.data.PushService::class.java)
            try {
                if (android.os.Build.VERSION.SDK_INT >= 26) startForegroundService(svc) else startService(svc)
                LogHelper.append(this, "startForegroundService ok")
            } catch (e: Exception) {
                LogHelper.append(this, "startForegroundService failed: ${e.javaClass.simpleName}: ${e.message}")
            }
        }
        // Android 13+ 动态请求通知权限
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        adapter = KeyAdapter()
        val rv = findViewById<RecyclerView>(R.id.rv)
        rv.layoutManager = LinearLayoutManager(this)
        rv.adapter = adapter

        findViewById<Button>(R.id.btnRefresh).setOnClickListener { loadKeys() }

        // 底部页签：首页 / 定时任务 / 设置
        BottomNav.bind(this, KeysActivity::class.java)

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
                LogHelper.append(this@KeysActivity, "listKeys ok size=${list.size}")
                keys.clear()
                keys.addAll(list)
                // 不必切 Main：Api.safe 的 withContext(IO) 在返回时已恢复调用方（主线程）上下文，
                // 再套一层 withContext(Main) 只是内嵌同一个 dispatcher，没有意义
                adapter.notifyDataSetChanged()
            } catch (e: retrofit2.HttpException) {
                LogHelper.append(this@KeysActivity, "listKeys http ${e.code()}")
                if (e.code() == 401) backToLogin()
            } catch (_: Exception) {
            } finally {
                loading.hide()
            }
        }
    }

    private fun backToLogin() {
        com.example.notifyhub.data.TokenStore(this).clear()
        startActivity(Intent(this, LoginActivity::class.java))
        finish()
    }

    // ---------- 快捷启停 ----------
    // 不做二次确认：启停完全可逆，误触后按钮文字、状态 chip 与整条透明度会同时变化，
    // 一眼就能看出来；真误停了再点一下即恢复。toast 里把后果说清楚即可。
    private fun toggle(k: KeyItem, currentlyOn: Boolean) {
        val active = !currentlyOn
        lifecycleScope.launch {
            try {
                Api.safe { Api.instance(this@KeysActivity).updateKey(k.id, UpdateKeyReq(active = active)) }
                val name = k.name ?: "未命名"
                Toast.makeText(
                    this@KeysActivity,
                    if (active) "已启用「$name」" else "已停用「$name」，外部调用将被拒绝",
                    Toast.LENGTH_SHORT
                ).show()
                loadKeys()
            } catch (e: Exception) {
                Toast.makeText(this@KeysActivity, "操作失败：${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // ---------- 长按条目：删除 key ----------
    private fun confirmDelete(k: KeyItem) {
        AlertDialog.Builder(this)
            .setTitle("删除 Key")
            .setMessage("彻底删除「${k.name}」？\n该 key 的 Hook 地址将失效，已写入的全部历史一并清除，不可恢复。")
            .setPositiveButton("删除") { _, _ ->
                lifecycleScope.launch {
                    try {
                        Api.safe { Api.instance(this@KeysActivity).deleteKey(k.id) }
                        Toast.makeText(this@KeysActivity, "已删除「${k.name}」", Toast.LENGTH_SHORT).show()
                        loadKeys()
                    } catch (e: Exception) {
                        Toast.makeText(this@KeysActivity, "删除失败：${e.message}", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ---------- 编辑弹窗：名称 / 模式 / 模板 / 启停 ----------
    private fun openEdit(k: KeyItem) {
        val view = layoutInflater.inflate(R.layout.dialog_edit_key, null)
        val etName = view.findViewById<EditText>(R.id.etName)
        val rbDefault = view.findViewById<RadioButton>(R.id.rbModeDefault)
        val rbCustom = view.findViewById<RadioButton>(R.id.rbModeCustom)
        val cbActive = view.findViewById<CheckBox>(R.id.cbActive)
        val tplFields = view.findViewById<View>(R.id.tplFields)
        val etTemplate = view.findViewById<EditText>(R.id.etTemplate)

        etName.setText(k.name)
        if (k.mode == "custom") rbCustom.isChecked = true else rbDefault.isChecked = true
        cbActive.isChecked = k.active == 1
        etTemplate.setText(k.template ?: "")
        val syncTpl = { tplFields.visibility = if (rbCustom.isChecked) View.VISIBLE else View.GONE }
        syncTpl()
        rbDefault.setOnClickListener { syncTpl() }
        rbCustom.setOnClickListener { syncTpl() }

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
                                mode = if (rbCustom.isChecked) "custom" else "default",
                                template = if (rbCustom.isChecked) etTemplate.text.toString().trim() else ""
                            )
                        )
                    }
                    dialog.dismiss()
                    loadKeys()
                } catch (e: Exception) {
                    // 这里已经在主线程（Api.safe 内部切到 IO，异常抛出后回到调用方上下文），
                    // 不要再套 withContext(Dispatchers.Main) —— 那是内嵌而非切换，
                    // 会让 toast 被静默吞掉，表现为「点保存没反应」
                    Toast.makeText(this@KeysActivity, "保存失败：${e.message}", Toast.LENGTH_SHORT).show()
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
            val btnHistory: Button = v.findViewById(R.id.btnHistory)
            val btnEdit: Button = v.findViewById(R.id.btnEdit)
            val btnToggle: Button = v.findViewById(R.id.btnToggle)
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
            h.btnHistory.setOnClickListener {
                val i = Intent(this@KeysActivity, HistoryActivity::class.java)
                i.putExtra("key_id", k.id)
                i.putExtra("title", "「${k.name ?: "未命名"}」发送历史")
                i.putExtra("subtitle", "外部系统调用该 key 写入的通知记录")
                startActivity(i)
            }
            h.btnEdit.setOnClickListener { openEdit(k) }
            // 快捷启停：不用进编辑弹窗，误触也容易察觉（按钮文字与状态 chip 会同时变）
            h.btnToggle.text = if (on) "停用" else "启用"
            h.btnToggle.setOnClickListener { toggle(k, on) }
            h.itemView.setOnLongClickListener { confirmDelete(k); true }
        }

        override fun getItemCount() = keys.size
    }
}
