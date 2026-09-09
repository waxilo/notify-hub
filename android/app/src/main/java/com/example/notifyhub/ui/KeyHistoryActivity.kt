package com.example.notifyhub.ui

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.example.notifyhub.R
import com.example.notifyhub.api.Api
import com.example.notifyhub.api.NotificationItem
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// 单个 key 的发送历史（只能从 key 卡片进入，不可切换 key）；
// 触达状态以服务端 delivered_at 为准（App 弹出通知后回调修正）
class KeyHistoryActivity : AppCompatActivity() {

    private data class Row(
        val item: NotificationItem,
        val status: String,
        val statusColor: Int,
        val chipBg: Int
    )

    private val rows = mutableListOf<Row>()
    private lateinit var adapter: HistoryAdapter
    private lateinit var tvKeyName: TextView
    private lateinit var tvMsg: TextView
    private var keyId: Long = -1L
    private var keyLabel: String = ""

    private val fmt = SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_key_history)

        keyId = intent.getLongExtra("key_id", -1L)
        if (keyId <= 0) {
            toast("缺少 key 参数")
            finish()
            return
        }

        adapter = HistoryAdapter(rows)
        val rv = findViewById<RecyclerView>(R.id.rv)
        rv.layoutManager = LinearLayoutManager(this)
        rv.adapter = adapter

        tvKeyName = findViewById(R.id.tvKeyName)
        tvMsg = findViewById(R.id.tvMsg)
        findViewById<Button>(R.id.btnBack).setOnClickListener { finish() }
        findViewById<Button>(R.id.btnRefresh).setOnClickListener { refresh() }

        refresh()
    }

    private fun refresh() {
        lifecycleScope.launch {
            try {
                // 拉取 key 名称用于标题展示
                val k = Api.safe { Api.instance(this@KeyHistoryActivity).listKeys() }
                    .keys.firstOrNull { it.id == keyId }
                keyLabel = k?.name ?: "…${(k?.keyFull ?: k?.key ?: "").takeLast(6)}"
                withContext(Dispatchers.Main) { tvKeyName.text = keyLabel }
                loadHistory()
            } catch (e: Exception) {
                withContext(Dispatchers.Main) { toast("加载失败：${e.message}") }
            }
        }
    }

    private suspend fun loadHistory() {
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

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    private inner class HistoryAdapter(private val data: List<Row>) :
        RecyclerView.Adapter<HistoryAdapter.VH>() {

        inner class VH(v: View) : RecyclerView.ViewHolder(v) {
            val tvTitle: TextView = v.findViewById(R.id.tvTitle)
            val tvBody: TextView = v.findViewById(R.id.tvBody)
            val tvMeta: TextView = v.findViewById(R.id.tvMeta)
            val tvStatus: TextView = v.findViewById(R.id.tvStatus)
        }

        override fun onCreateViewHolder(parent: android.view.ViewGroup, viewType: Int): VH =
            VH(LayoutInflater.from(parent.context).inflate(R.layout.item_history, parent, false))

        @SuppressLint("SetTextI18n")
        override fun onBindViewHolder(h: VH, position: Int) {
            val row = data[position]
            val n = row.item
            h.tvTitle.text = n.title ?: "(无标题)"
            h.tvBody.text = n.body
            h.tvMeta.text = fmt.format(Date(n.createdAt))
            h.tvStatus.text = row.status
            h.tvStatus.setTextColor(row.statusColor)
            h.tvStatus.setBackgroundResource(row.chipBg)
        }

        override fun getItemCount() = data.size
    }
}
