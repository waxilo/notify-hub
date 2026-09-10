package com.example.notifyhub.ui

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
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

// 通用历史页：一份代码同时服务两种来源（两者在数据上互斥，不会同时有值）
//   key_id  → 外部系统调 /hook/:key 写入的记录（从首页 key 卡片进入）
//   job_id  → 定时任务每次触发产生的日志（从定时任务页进入）
// 除查询维度外两者完全一致：分页加载、触达状态、点击看原文、清空。
// 清空走服务端 DELETE /api/notifications（必须带 key_id 或 job_id），不可恢复，需二次确认。
class HistoryActivity : AppCompatActivity() {

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
    private lateinit var btnClear: Button
    private var keyId: Long? = null
    private var jobId: Long? = null
    private var total = 0

    private val fmt = SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_history)

        keyId = intent.getLongExtra("key_id", -1L).takeIf { it > 0 }
        jobId = intent.getLongExtra("job_id", -1L).takeIf { it > 0 }
        if (keyId == null && jobId == null) {
            toast("缺少 key_id / job_id 参数")
            finish()
            return
        }

        val title = intent.getStringExtra("title") ?: "历史记录"
        findViewById<TextView>(R.id.tvTitle).text = title
        intent.getStringExtra("subtitle")?.let { findViewById<TextView>(R.id.tvSubtitle).text = it }

        adapter = HistoryAdapter(rows)
        val rv = findViewById<RecyclerView>(R.id.rv)
        rv.layoutManager = LinearLayoutManager(this)
        rv.adapter = adapter

        tvMsg = findViewById(R.id.tvMsg)
        btnMore = findViewById(R.id.btnMore)
        btnClear = findViewById(R.id.btnClear)
        btnMore.setOnClickListener { loadPage(append = true) }
        findViewById<Button>(R.id.btnBack).setOnClickListener { finish() }
        findViewById<Button>(R.id.btnRefresh).setOnClickListener { loadPage(append = false) }
        btnClear.setOnClickListener { confirmClear(title) }

        loadPage(append = false)
    }

    private fun loadPage(append: Boolean) {
        loading.show()
        lifecycleScope.launch {
            try {
                val offset = if (append) rows.size else 0
                if (!append) rows.clear()
                val resp = Api.safe {
                    Api.instance(this@HistoryActivity).listNotifications(PAGE_SIZE, offset, keyId, jobId)
                }
                total = resp.total
                resp.notifications.forEach { n ->
                    // 空消息与触达状态互斥：内容为空的服务端不会推送，自然无触达概念。
                    // 「停用拒绝」优先判断：这类记录本就没推送，显示成「未触达」会让人以为是漏推了。
                    rows.add(
                        when {
                            n.rejected != null -> Row(n, "停用拒绝", 0xFFE5484D.toInt(), R.drawable.bg_chip_off)
                            n.body.isNullOrBlank() -> Row(n, "空消息", 0xFF8A93A6.toInt(), R.drawable.bg_chip_off)
                            n.deliveredAt != null -> Row(n, "已触达", 0xFF17994F.toInt(), R.drawable.bg_chip_on)
                            else -> Row(n, "未触达", 0xFFC07F00.toInt(), R.drawable.bg_chip_off)
                        }
                    )
                }
                tvMsg.text = if (total == 0) "暂无记录" else "已显示 ${rows.size} / 共 $total 条"
                btnClear.isEnabled = total > 0
                adapter.notifyDataSetChanged()
                btnMore.visibility = if (rows.size < total) View.VISIBLE else View.GONE
            } catch (e: Exception) {
                tvMsg.text = "加载失败：${e.message}"
            } finally {
                loading.hide()
            }
        }
    }

    // 清空：二次确认后调服务端，成功则回到第一页重新加载（列表变空态）
    private fun confirmClear(title: String) {
        if (total <= 0) return
        val n = total            // loadPage 会把它刷新为 0，先记下来用于提示
        AlertDialog.Builder(this)
            .setTitle("清空历史")
            .setMessage("确定清空「$title」的 $n 条记录？\n清空后不可恢复。")
            .setPositiveButton("清空") { _, _ ->
                loading.show()
                lifecycleScope.launch {
                    try {
                        Api.safe {
                            Api.instance(this@HistoryActivity).clearNotifications(keyId, jobId)
                        }
                        rows.clear()
                        adapter.notifyDataSetChanged()
                        loadPage(append = false)
                        toast("已清空 $n 条记录")
                    } catch (e: Exception) {
                        toast("清空失败：${e.message}")
                    } finally {
                        loading.hide()
                    }
                }
            }
            .setNegativeButton("取消", null)
            .show()
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
            // 点击条目查看原始数据（key 历史是调用方原始参数，任务日志是触发详情）
            h.itemView.setOnClickListener { showRawPayload(n) }
        }

        override fun getItemCount() = data.size
    }

    // 弹窗展示该条通知的原始数据：JSON 尽量格式化，纯文本原样展示，可复制
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
        AlertDialog.Builder(this)
            .setTitle(if (jobId != null) "触发详情（#${n.id}）" else "原始请求参数（#${n.id}）")
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
