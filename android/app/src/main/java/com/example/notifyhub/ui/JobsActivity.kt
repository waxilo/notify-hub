package com.example.notifyhub.ui

import android.annotation.SuppressLint
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
import com.example.notifyhub.api.KeyItem
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
class JobsActivity : AppCompatActivity() {

    private val jobs = mutableListOf<JobItem>()
    private val keys = mutableListOf<KeyItem>()
    private lateinit var adapter: JobAdapter
    private val loading by lazy { LoadingOverlay(this) }

    private val dowNames = arrayOf("周日", "周一", "周二", "周三", "周四", "周五", "周六")
    private val tzList = arrayOf("+08:00", "+09:00", "+07:00", "+05:30", "+00:00", "-05:00", "-08:00")
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
                val ks = Api.safe { api.listKeys() }.keys
                val js = Api.safe { api.listJobs() }.jobs
                withContext(Dispatchers.Main) {
                    keys.clear(); keys.addAll(ks)
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

    private fun openEdit(job: JobItem?) {
        if (keys.isEmpty()) {
            toast("请先在首页创建一个通知通道，定时任务需要挂在通道下")
            return
        }
        val v = layoutInflater.inflate(R.layout.dialog_edit_job, null)
        val etName = v.findViewById<EditText>(R.id.etName)
        val spKey = v.findViewById<Spinner>(R.id.spKey)
        val etTitle = v.findViewById<EditText>(R.id.etTitle)
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
        val spTz = v.findViewById<Spinner>(R.id.spTz)
        val cbEnabled = v.findViewById<CheckBox>(R.id.cbEnabled)

        val spinnerAdapter = { arr: Array<String> ->
            ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, arr)
        }
        spKey.adapter = spinnerAdapter(keys.map { it.name ?: "未命名" }.toTypedArray())
        spKind.adapter = spinnerAdapter(kindNames)
        spUnit.adapter = spinnerAdapter(unitNames)
        spDow.adapter = spinnerAdapter(dowNames)
        spTz.adapter = spinnerAdapter(tzList)

        val sc = splitSchedule(job?.schedule ?: "")
        val kindKey = when (sc.kind) {
            "every" -> "固定间隔"
            "daily" -> "每天"
            "weekly" -> "每周"
            else -> "一次性"
        }
        val kindIdx = kindNames.indexOf(kindKey).let { if (it >= 0) it else 0 }

        etName.setText(job?.name ?: "")
        etTitle.setText(job?.title ?: "")
        etBody.setText(job?.body ?: "")
        etEveryN.setText(sc.n)
        spUnit.setSelection(if (sc.u == "h") 1 else 0)
        etDaily.setText(sc.time)
        spDow.setSelection(sc.dow)
        etWeekly.setText(sc.time)
        etOnce.setText(sc.at)
        cbEnabled.isChecked = job?.enabled != 0
        spKind.setSelection(kindIdx)

        val tz = job?.tz ?: defaultTz()
        spTz.setSelection(tzList.indexOf(tz).let { if (it >= 0) it else 0 })
        val keyIdx = keys.indexOfFirst { it.id == job?.keyId }
        if (keyIdx >= 0) spKey.setSelection(keyIdx)

        // 高级设置默认收起，缩短表单。已填过标题、改过时区，或任务处于停用状态时自动展开，
        // 避免用户以为原有配置丢了。
        val tvAdvanced = v.findViewById<TextView>(R.id.tvAdvanced)
        val llAdvanced = v.findViewById<View>(R.id.llAdvanced)
        fun advLabel(open: Boolean) = (if (open) "▾ " else "▸ ") + "高级设置（通知标题 / 时区）"
        if (!job?.title.isNullOrEmpty() || tz != defaultTz() || job?.enabled == 0) {
            llAdvanced.visibility = View.VISIBLE
        }
        tvAdvanced.text = advLabel(llAdvanced.visibility == View.VISIBLE)
        tvAdvanced.setOnClickListener {
            val open = llAdvanced.visibility == View.VISIBLE
            llAdvanced.visibility = if (open) View.GONE else View.VISIBLE
            tvAdvanced.text = advLabel(!open)
        }

        val syncFields = {
            val k = spKind.selectedItemPosition
            llEvery.visibility = if (k == 0) View.VISIBLE else View.GONE
            etDaily.visibility = if (k == 1) View.VISIBLE else View.GONE
            llWeekly.visibility = if (k == 2) View.VISIBLE else View.GONE
            etOnce.visibility = if (k == 3) View.VISIBLE else View.GONE
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
                    val keyId = keys[spKey.selectedItemPosition].id
                    val res = if (job == null) {
                        Api.safe {
                            api.createJob(
                                CreateJobReq(
                                    keyId = keyId, name = name, schedule = schedule,
                                    tz = tzList[spTz.selectedItemPosition],
                                    title = etTitle.text.toString().trim(),
                                    body = etBody.text.toString(),
                                    enabled = cbEnabled.isChecked
                                )
                            )
                        }
                    } else {
                        Api.safe {
                            api.updateJob(
                                job.id,
                                UpdateJobReq(
                                    keyId = keyId, name = name, schedule = schedule,
                                    tz = tzList[spTz.selectedItemPosition],
                                    title = etTitle.text.toString().trim(),
                                    body = etBody.text.toString(),
                                    enabled = cbEnabled.isChecked
                                )
                            )
                        }
                    }
                    withContext(Dispatchers.Main) {
                        dialog.dismiss()
                        res.nextRunAt?.let { toast("已保存，下次执行 ${fmtAt(it, tzList[spTz.selectedItemPosition])}") }
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
            .setMessage("删除「${job.name ?: "未命名任务"}」？删除后不再触发，已产生的通知历史不受影响。")
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
            h.tvMeta.text = "通道：${j.keyName ?: "(已删除)"}\n下次执行：$nextText · 上次执行：$lastText"
            h.itemView.alpha = if (on) 1f else 0.62f
            h.btnToggle.text = if (on) "停用" else "启用"
            h.btnEdit.setOnClickListener { openEdit(j) }
            h.btnToggle.setOnClickListener { toggle(j) }
            h.btnDelete.setOnClickListener { confirmDelete(j) }
        }

        override fun getItemCount() = jobs.size
    }
}
