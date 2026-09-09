package com.example.notifyhub.ui

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.example.notifyhub.R
import com.example.notifyhub.api.Api
import com.example.notifyhub.api.KeyItem
import com.example.notifyhub.api.NotificationItem
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// 按 key 查看发送历史，含每条消息的触发与触达状态
class KeyHistoryActivity : AppCompatActivity() {

    private data class Row(
        val item: NotificationItem,
        val status: String,
        val statusColor: Int,
        val chipBg: Int
    )

    private val rows = mutableListOf<Row>()
    private lateinit var adapter: HistoryAdapter
    private var keys: List<KeyItem> = emptyList()
    private var suppressSpinnerCb = false

    private val fmt = SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_key_history)

        adapter = HistoryAdapter(rows)
        val rv = findViewById<RecyclerView>(R.id.rv)
        rv.layoutManager = LinearLayoutManager(this)
        rv.adapter = adapter

        findViewById<Button>(R.id.btnBack).setOnClickListener { finish() }
        findViewById<Button>(R.id.btnRefresh).setOnClickListener { loadKeysAndHistory() }

        val sp = findViewById<Spinner>(R.id.spKey)
        sp.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: android.widget.AdapterView<*>?, v: View?, pos: Int, id: Long) {
                if (suppressSpinnerCb) return
                loadHistory(if (pos <= 0) null else keys[pos - 1].id)
            }
            override fun onNothingSelected(p: android.widget.AdapterView<*>?) {}
        }

        loadKeysAndHistory()
    }

    private fun loadKeysAndHistory() {
        lifecycleScope.launch {
            try {
                keys = Api.safe { Api.instance(this@KeyHistoryActivity).listKeys() }.keys
                val sp = findViewById<Spinner>(R.id.spKey)
                suppressSpinnerCb = true
                sp.adapter = ArrayAdapter(
                    this@KeyHistoryActivity,
                    android.R.layout.simple_spinner_dropdown_item,
                    listOf("全部 Key") + keys.map { it.name ?: "未命名" }
                )
                // 从 key 卡片进入时预选该 key
                val pre = intent.getLongExtra("key_id", -1L)
                val idx = keys.indexOfFirst { it.id == pre }
                if (pre > 0 && idx >= 0) sp.setSelection(idx + 1) else sp.setSelection(0)
                suppressSpinnerCb = false
                loadHistory(if (idx >= 0) pre else null)
            } catch (e: Exception) {
                suppressSpinnerCb = false
                toast("加载 key 列表失败：${e.message}")
            }
        }
    }

    private fun loadHistory(keyId: Long?) {
        lifecycleScope.launch {
            val tvMsg = findViewById<TextView>(R.id.tvMsg)
            try {
                val resp = Api.safe { Api.instance(this@KeyHistoryActivity).listNotifications(100, keyId) }
                rows.clear()
                resp.notifications.forEach { n ->
                    rows.add(
                        if (n.deliveredAt != null) Row(n, "已触达", 0xFF17994F.toInt(), R.drawable.bg_chip_on)
                        else Row(n, "未触达", 0xFFC07F00.toInt(), R.drawable.bg_chip_off)
                    )
                }
                withContext(Dispatchers.Main) {
                    tvMsg.text = "共 ${resp.total} 条（显示最近 ${rows.size} 条）"
                    adapter.notifyDataSetChanged()
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) { tvMsg.text = "加载失败：${e.message}" }
            }
        }
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    private inner class HistoryAdapter(private val data: List<Row>) :
        RecyclerView.Adapter<HistoryAdapter.VH>() {

        inner class VH(v: View) : RecyclerView.ViewHolder(v) {
            val tvTitle: TextView = v.findViewById(R.id.tvTitle)
            val tvBody: TextView = v.findViewById(R.id.tvBody)
            val tvMeta: TextView = v.findViewById(R.id.tvMeta)
            val tvStatus: TextView = v.findViewById(R.id.tvStatus)
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH =
            VH(LayoutInflater.from(parent.context).inflate(R.layout.item_history, parent, false))

        @SuppressLint("SetTextI18n")
        override fun onBindViewHolder(h: VH, position: Int) {
            val row = data[position]
            val n = row.item
            h.tvTitle.text = n.title ?: "(无标题)"
            h.tvBody.text = n.body
            h.tvMeta.text = "「${n.keyName ?: "未知 Key"}」 · ${fmt.format(Date(n.createdAt))}"
            h.tvStatus.text = row.status
            h.tvStatus.setTextColor(row.statusColor)
            h.tvStatus.setBackgroundResource(row.chipBg)
        }

        override fun getItemCount() = data.size
    }
}
