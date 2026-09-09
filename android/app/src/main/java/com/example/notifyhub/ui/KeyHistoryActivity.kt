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
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// 单个 key 的发送历史（只能从 key 卡片进入，不可切换 key）；
// 分页加载：默认拉取最新 10 条，点击"加载更多"向后追加；
// 触达状态以服务端 delivered_at 为准（App 弹出通知后回调修正）
class KeyHistoryActivity : AppCompatActivity() {

    private data class Row(
        val item: NotificationItem,
        val status: String,
        val statusColor: Int,
        val chipBg: Int
    )

    private val rows = mutableListOf<Row>()
    private val loading by lazy { LoadingOverlay(this) }
    private lateinit var adapter: HistoryAdapter
    private lateinit var tvMsg: TextView
    private lateinit var btnMore: Button
    private var keyId: Long = -1L
    private var total = 0

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

        tvMsg = findViewById(R.id.tvMsg)
        btnMore = findViewById(R.id.btnMore)
        btnMore.setOnClickListener { loadPage(append = true) }
        findViewById<Button>(R.id.btnBack).setOnClickListener { finish() }
        findViewById<Button>(R.id.btnRefresh).setOnClickListener { loadPage(append = false) }

        loadPage(append = false)
    }

    private fun loadPage(append: Boolean) {
        loading.show()
        lifecycleScope.launch {
            try {
                val offset = if (append) rows.size else 0
                if (!append) rows.clear()
                val resp = Api.safe {
                    Api.instance(this@KeyHistoryActivity).listNotifications(PAGE_SIZE, offset, keyId)
                }
                total = resp.total
                resp.notifications.forEach { n ->
                    rows.add(
                        if (n.deliveredAt != null) Row(n, "已触达", 0xFF17994F.toInt(), R.drawable.bg_chip_on)
                        else Row(n, "未触达", 0xFFC07F00.toInt(), R.drawable.bg_chip_off)
                    )
                }
                tvMsg.text = "已显示 ${rows.size} / 共 $total 条"
                adapter.notifyDataSetChanged()
                btnMore.visibility = if (rows.size < total) View.VISIBLE else View.GONE
            } catch (e: Exception) {
                tvMsg.text = "加载失败：${e.message}"
            } finally {
                loading.hide()
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
            // 点击条目查看原始请求参数（完整、未解析的 payload）
            h.itemView.setOnClickListener { showRawPayload(n) }
        }

        override fun getItemCount() = data.size
    }

    // 弹窗展示调用方发送的原始参数：JSON 尽量格式化，纯文本原样展示，可复制
    private fun showRawPayload(n: NotificationItem) {
        val raw = n.payload
        if (raw.isNullOrBlank()) {
            toast("该记录没有原文（可能是纯文本或早期消息）")
            return
        }
        val pretty = try {
            val el = com.google.gson.JsonParser.parseString(raw)
            com.google.gson.GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create().toJson(el)
        } catch (_: Exception) {
            raw
        }
        val tv = TextView(this).apply {
            text = pretty
            setTextIsSelectable(true)
            typeface = android.graphics.Typeface.MONOSPACE
            textSize = 13f
            setPadding(48, 32, 48, 32)
        }
        val scroll = android.widget.ScrollView(this).apply { addView(tv) }
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("原始请求参数（#${n.id}）")
            .setView(scroll)
            .setPositiveButton("复制") { _, _ ->
                val cm = getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                cm.setPrimaryClip(android.content.ClipData.newPlainText("payload", pretty))
                toast("已复制原文")
            }
            .setNegativeButton("关闭", null)
            .show()
    }

    companion object {
        private const val PAGE_SIZE = 10  // 默认查询最新 10 条
    }
}
