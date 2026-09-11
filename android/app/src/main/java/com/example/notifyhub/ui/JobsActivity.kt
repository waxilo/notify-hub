package com.example.notifyhub.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.example.notifyhub.R
import com.example.notifyhub.api.Api
import com.example.notifyhub.api.CreateJobReq
import com.example.notifyhub.api.JobItem
import com.example.notifyhub.api.UpdateJobReq
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// 定时任务列表：只做配置。执行完全在服务端（Worker Cron 每分钟扫描 jobs 表），
// 所以 App 不需要 WorkManager / AlarmManager / 任何后台定时器，进程被杀、Doze、离线都不影响触发。
//
// 定时任务不挂 Key：Key 是外部系统调 /hook/:key 用的凭证，与站内定时提醒是两条独立来源。
// 任务触发后直接发「默认类型」通知 —— 标题 = 任务名称，正文 = 通知内容（留空则同任务名）。
class JobsActivity : AppCompatActivity() {

    private val jobs = mutableListOf<JobItem>()
    private lateinit var adapter: JobAdapter
    private val loading by lazy { LoadingOverlay(this) }

    private val dowNames = arrayOf("周日", "周一", "周二", "周三", "周四", "周五", "周六")
    private val kindNames = arrayOf("固定间隔", "每天", "每周", "一次性")
    private val unitNames = arrayOf("分钟", "小时")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_jobs)

        adapter = JobAdapter()
        findViewById<RecyclerView>(R.id.rv).apply {
            layoutManager = LinearLayoutManager(this@JobsActivity)
            adapter = this@JobsActivity.adapter
        }
        findViewById<Button>(R.id.btnRefresh).setOnClickListener { load() }
        findViewById<Button>(R.id.btnAdd).setOnClickListener { openEdit(null) }

        // 底部页签：首页 / 定时任务 / 设置
        BottomNav.bind(this, JobsActivity::class.java)

        load()
    }

    override fun onResume() {
        super.onResume()
        if (loadedOnce) load()   // 首次加载由 onCreate 负责，避免启动时打两遍接口
    }

    private var loadedOnce = false

    private fun load() {
        loading.show()
        lifecycleScope.launch {
            try {
                val api = Api.instance(this@JobsActivity)
                // 定时任务不挂 key，所以只拉任务列表
                val js = Api.safe { api.listJobs() }.jobs
                withContext(Dispatchers.Main) {
                    jobs.clear(); jobs.addAll(js)
                    adapter.notifyDataSetChanged()
                    loadedOnce = true
                    findViewById<TextView>(R.id.tvEmpty).visibility =
                        if (jobs.isEmpty()) View.VISIBLE else View.GONE
                }
            } catch (e: retrofit2.HttpException) {
                if (e.code() == 401) withContext(Dispatchers.Main) { finish() }
            } catch (_: Exception) {
            } finally {
                withContext(Dispatchers.Main) { loading.hide() }
            }
        }
    }

    private fun toast(msg: String) =
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    /* ---------- schedule 预设串与表单字段互转 ---------- */

    private data class Sched(
        val kind: String,
        val n: String = "5",
        val u: String = "m",
        val time: String = "09:00",
        val dow: Int = 1,
        val at: String = ""
    )

    private fun splitSchedule(s: String): Sched {
        Regex("^every:(\\d+)([mh])$").find(s)?.let {
            return Sched("every", n = it.groupValues[1], u = it.groupValues[2])
        }
        Regex("^daily:(\\d{2}:\\d{2})$").find(s)?.let { return Sched("daily", time = it.groupValues[1]) }
        Regex("^weekly:([0-6]),(\\d{2}:\\d{2})$").find(s)?.let {
            return Sched("weekly", dow = it.groupValues[1].toInt(), time = it.groupValues[2])
        }
        Regex("^once:(.+)$").find(s)?.let { return Sched("once", at = it.groupValues[1]) }
        return Sched("every")
    }

    private fun joinSchedule(v: View, kindIdx: Int): String? {
        val etN = v.findViewById<EditText>(R.id.etEveryN)
        val spUnit = v.findViewById<Spinner>(R.id.spEveryUnit)
        val etDaily = v.findViewById<EditText>(R.id.etDailyTime)
        val spDow = v.findViewById<Spinner>(R.id.spDow)
        val etWeekly = v.findViewById<EditText>(R.id.etWeeklyTime)
        val etOnce = v.findViewById<EditText>(R.id.etOnceAt)
        return when (kindIdx) {
            0 -> {
                val n = etN.text.toString().trim().toIntOrNull()
                if (n == null || n < 1) return null
                val u = if (spUnit.selectedItemPosition == 1) "h" else "m"
                "every:$n$u"
            }
            1 -> {
                val t = etDaily.text.toString().trim()
                if (!Regex("^\\d{2}:\\d{2}$").matches(t)) return null
                "daily:$t"
            }
            2 -> {
                val t = etWeekly.text.toString().trim()
                if (!Regex("^\\d{2}:\\d{2}$").matches(t)) return null
                "weekly:${spDow.selectedItemPosition},$t"
            }
            else -> {
                val a = etOnce.text.toString().trim()
                if (!Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$").matches(a)) return null
                "once:$a"
            }
        }
    }

    /* ---------- 新建 / 编辑 ---------- */

    // 不需要先建 Key：任务直接发以任务名称为标题的默认通知
    private fun openEdit(job: JobItem?) {
        val v = layoutInflater.inflate(R.layout.dialog_edit_job, null)
        val etName = v.findViewById<EditText>(R.id.etName)
        val etBody = v.findViewById<EditText>(R.id.etBody)
        val spKind = v.findViewById<Spinner>(R.id.spKind)
        val llEvery = v.findViewById<View>(R.id.llEvery)
        val etEveryN = v.findViewById<EditText>(R.id.etEveryN)
        val spUnit = v.findViewById<Spinner>(R.id.spEveryUnit)
        val etDaily = v.findViewById<EditText>(R.id.etDailyTime)
        val llWeekly = v.findViewById<View>(R.id.llWeekly)
        val spDow = v.findViewById<Spinner>(R.id.spDow)
        val etWeekly = v.findViewById<EditText>(R.id.etWeeklyTime)
        val etOnce = v.findViewById<EditText>(R.id.etOnceAt)
        val tvTzNote = v.findViewById<TextView>(R.id.tvTzNote)
        val cbStrongVibrate = v.findViewById<CheckBox>(R.id.cbStrongVibrate)
        val cbSkipHoliday = v.findViewById<CheckBox>(R.id.cbSkipHoliday)
        val cbEnabled = v.findViewById<CheckBox>(R.id.cbEnabled)

        val spinnerAdapter = { arr: Array<String> ->
            ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, arr)
        }
        spKind.adapter = spinnerAdapter(kindNames)
        spUnit.adapter = spinnerAdapter(unitNames)
        spDow.adapter = spinnerAdapter(dowNames)

        val sc = splitSchedule(job?.schedule ?: "")
        val kindKey = when (sc.kind) {
            "every" -> "固定间隔"
            "daily" -> "每天"
            "weekly" -> "每周"
            else -> "一次性"
        }
        val kindIdx = kindNames.indexOf(kindKey).let { if (it >= 0) it else 0 }

        etName.setText(job?.name ?: "")
        etBody.setText(job?.body ?: "")
        etEveryN.setText(sc.n)
        spUnit.setSelection(if (sc.u == "h") 1 else 0)
        etDaily.setText(sc.time)
        spDow.setSelection(sc.dow)
        etWeekly.setText(sc.time)
        etOnce.setText(sc.at)
        cbStrongVibrate.isChecked = job?.strongVibrate == 1
        cbSkipHoliday.isChecked = job?.skipHoliday == 1
        cbEnabled.isChecked = job?.enabled != 0
        spKind.setSelection(kindIdx)

        // 时区不可修改：新建任务取设备当前偏移，编辑已有任务沿用其创建时的时区 ——
        // 否则用户换了时区后再随手编辑一次，触发时刻会被静默平移。
        val tz = job?.tz ?: defaultTz()

        // 时区不可改，但要让用户知道「09:00」是按哪个时区算的（间隔型与绝对时刻无关，不提示）
        fun tzNote(k: Int): String {
            if (k == 0) return ""
            val local = defaultTz()
            return if (tz == local) "按 UTC$tz 执行（设备时区）"
            else "按 UTC$tz 执行（任务创建时的时区；设备现为 UTC$local）"
        }

        val syncFields = {
            val k = spKind.selectedItemPosition
            llEvery.visibility = if (k == 0) View.VISIBLE else View.GONE
            etDaily.visibility = if (k == 1) View.VISIBLE else View.GONE
            llWeekly.visibility = if (k == 2) View.VISIBLE else View.GONE
            etOnce.visibility = if (k == 3) View.VISIBLE else View.GONE
            val note = tzNote(k)
            tvTzNote.text = note
            tvTzNote.visibility = if (note.isEmpty()) View.GONE else View.VISIBLE
        }
        syncFields()
        spKind.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: android.widget.AdapterView<*>?, w: View?, pos: Int, id: Long) = syncFields()
            override fun onNothingSelected(p: android.widget.AdapterView<*>?) {}
        }

        val dialog = AlertDialog.Builder(this)
            .setTitle(if (job == null) "新建定时任务" else "编辑定时任务")
            .setView(v)
            .setPositiveButton("保存", null)
            .setNegativeButton("取消", null)
            .create()
        dialog.show()
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val name = etName.text.toString().trim()
            if (name.isEmpty()) { toast("任务名称不能为空"); return@setOnClickListener }
            val schedule = joinSchedule(v, spKind.selectedItemPosition)
            if (schedule == null) { toast("时间格式不正确"); return@setOnClickListener }

            lifecycleScope.launch {
                try {
                    val api = Api.instance(this@JobsActivity)
                    val res = if (job == null) {
                        Api.safe {
                            api.createJob(
                                CreateJobReq(
                                    name = name, schedule = schedule,
                                    tz = tz,
                                    body = etBody.text.toString(),
                                    enabled = cbEnabled.isChecked,
                                    strongVibrate = cbStrongVibrate.isChecked,
                                    skipHoliday = cbSkipHoliday.isChecked
                                )
                            )
                        }
                    } else {
                        Api.safe {
                            api.updateJob(
                                job.id,
                                UpdateJobReq(
                                    name = name, schedule = schedule,
                                    tz = tz,
                                    body = etBody.text.toString(),
                                    enabled = cbEnabled.isChecked,
                                    strongVibrate = cbStrongVibrate.isChecked,
                                    skipHoliday = cbSkipHoliday.isChecked
                                )
                            )
                        }
                    }
                    withContext(Dispatchers.Main) {
                        dialog.dismiss()
                        res.nextRunAt?.let { toast("已保存，下次执行 ${fmtAt(it, tz)}") }
                        load()
                    }
                } catch (e: Exception) {
                    withContext(Dispatchers.Main) { toast("保存失败：${e.message}") }
                }
            }
        }
    }

    private fun confirmDelete(job: JobItem) {
        AlertDialog.Builder(this)
            .setTitle("删除定时任务")
            .setMessage(
                "删除「${job.name ?: "未命名任务"}」？\n删除后不再触发，" +
                    "该任务已产生的 ${job.sentCount ?: 0} 条日志将一并清除，不可恢复。"
            )
            .setPositiveButton("删除") { _, _ ->
                lifecycleScope.launch {
                    try {
                        Api.safe { Api.instance(this@JobsActivity).deleteJob(job.id) }
                        withContext(Dispatchers.Main) { load() }
                    } catch (e: Exception) {
                        withContext(Dispatchers.Main) { toast("删除失败：${e.message}") }
                    }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun toggle(job: JobItem) {
        lifecycleScope.launch {
            try {
                Api.safe { Api.instance(this@JobsActivity).updateJob(job.id, UpdateJobReq(enabled = job.enabled != 1)) }
                withContext(Dispatchers.Main) { load() }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) { toast("操作失败：${e.message}") }
            }
        }
    }

    // 设备当前 UTC 偏移，作为新建任务的时区默认值
    private fun defaultTz(): String {
        val off = TimeZone.getDefault().rawOffset / 60000
        val sign = if (off >= 0) "+" else "-"
        val a = kotlin.math.abs(off)
        return sign + String.format(Locale.US, "%02d:%02d", a / 60, a % 60)
    }

    // 按任务自己的时区展示时间
    private fun fmtAt(ms: Long, tz: String): String {
        val f = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault())
        runCatching { f.timeZone = TimeZone.getTimeZone("GMT$tz") }
        return f.format(Date(ms))
    }

    /* ---------- 列表 ---------- */

    private inner class JobAdapter : RecyclerView.Adapter<JobAdapter.VH>() {

        inner class VH(v: View) : RecyclerView.ViewHolder(v) {
            val tvName: TextView = v.findViewById(R.id.tvName)
            val tvStatus: TextView = v.findViewById(R.id.tvStatus)
            val tvSchedule: TextView = v.findViewById(R.id.tvSchedule)
            val tvMeta: TextView = v.findViewById(R.id.tvMeta)
            val btnHistory: Button = v.findViewById(R.id.btnHistory)
            val btnEdit: Button = v.findViewById(R.id.btnEdit)
            val btnToggle: Button = v.findViewById(R.id.btnToggle)
            val btnDelete: Button = v.findViewById(R.id.btnDelete)
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH =
            VH(LayoutInflater.from(parent.context).inflate(R.layout.item_job, parent, false))

        @SuppressLint("SetTextI18n")
        override fun onBindViewHolder(h: VH, position: Int) {
            val j = jobs[position]
            val on = j.enabled == 1
            h.tvName.text = j.name ?: "未命名任务"
            if (on) {
                h.tvStatus.text = "启用中"
                h.tvStatus.setBackgroundResource(R.drawable.bg_chip_on)
                h.tvStatus.setTextColor(0xFF17994F.toInt())
            } else {
                h.tvStatus.text = "已停用"
                h.tvStatus.setBackgroundResource(R.drawable.bg_chip_off)
                h.tvStatus.setTextColor(0xFF8A93A6.toInt())
            }
            h.tvSchedule.text = j.desc ?: j.schedule
            val nextText = if (on) (j.nextRunAt?.let { fmtAt(it, j.tz ?: "+08:00") } ?: "—") else "（已停用）"
            val lastText = j.lastRunAt?.let { fmtAt(it, j.tz ?: "+08:00") } ?: "从未执行"
            // 通知标题固定为任务名称，正文是通知内容（留空则同任务名），与外部 key 无关
            val content = j.body?.takeIf { it.isNotBlank() } ?: "（与任务名称相同）"
            h.tvMeta.text = "内容：$content\n下次执行：$nextText · 上次执行：$lastText\n已发送 ${j.sentCount ?: 0} 条日志"
            h.itemView.alpha = if (on) 1f else 0.62f
            h.btnToggle.text = if (on) "停用" else "启用"
            h.btnHistory.setOnClickListener {
                val i = Intent(this@JobsActivity, HistoryActivity::class.java)
                i.putExtra("job_id", j.id)
                i.putExtra("title", "「${j.name ?: "未命名任务"}」执行日志")
                i.putExtra("subtitle", "该任务每次触发产生的通知记录")
                startActivity(i)
            }
            h.btnEdit.setOnClickListener { openEdit(j) }
            h.btnToggle.setOnClickListener { toggle(j) }
            h.btnDelete.setOnClickListener { confirmDelete(j) }
        }

        override fun getItemCount() = jobs.size
    }
}
