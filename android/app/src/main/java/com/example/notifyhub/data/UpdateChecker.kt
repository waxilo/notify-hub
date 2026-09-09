package com.example.notifyhub.data

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.Toast
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

// App 检测更新：调 Worker /api/app/latest（Worker 侧代理并缓存 GitHub Release 信息）
data class UpdateInfo(
    val versionCode: Long,
    val versionName: String?,
    val downloadUrl: String,
)

object UpdateChecker {

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    private const val DL_CHANNEL_ID = "notify_hub_update"
    private const val DOWNLOAD_NOTIF_ID = 2002
    private const val PREFS = "nh_update"
    private const val KEY_PENDING = "pending_apk"
    private const val KEY_DOWNLOADED = "downloaded_code"  // 已完整下载的 APK 对应 versionCode

    fun installedVersionCode(ctx: Context): Long {
        val info = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        return if (Build.VERSION.SDK_INT >= 28) info.longVersionCode
        else @Suppress("DEPRECATION") info.versionCode.toLong()
    }

    fun installedVersionName(ctx: Context): String =
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "1.0"

    // 拉取最新版本信息；无 CI 版本数据（versionCode 缺失）或网络失败返回 null
    suspend fun latest(ctx: Context): UpdateInfo? = withContext(Dispatchers.IO) {
        val base = ConfigStore(ctx).apiBase.trim().trimEnd('/')
        val req = Request.Builder().url("$base/api/app/latest").build()
        try {
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@withContext null
                val obj = JSONObject(resp.body?.string() ?: return@withContext null)
                val code = obj.optLong("versionCode", -1L)
                if (code <= 0) return@withContext null
                UpdateInfo(
                    versionCode = code,
                    versionName = obj.optString("versionName").ifEmpty { null },
                    downloadUrl = "$base/api/app/download",
                )
            }
        } catch (_: Exception) {
            null
        }
    }

    fun isNewer(info: UpdateInfo, ctx: Context): Boolean =
        info.versionCode > installedVersionCode(ctx)

    // ---------- 静默下载 + 直接跳安装 ----------

    // 静默下载 APK（不经浏览器，仅低优先级进度通知）；返回下载文件
    suspend fun downloadApk(
        ctx: Context,
        info: UpdateInfo,
        onProgress: (suspend (Int) -> Unit)? = null,
    ): File = withContext(Dispatchers.IO) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(DL_CHANNEL_ID, "更新下载", NotificationManager.IMPORTANCE_LOW)
            )
        }
        fun progressNotif(progress: Int, indeterminate: Boolean): Notification {
            val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                Notification.Builder(ctx, DL_CHANNEL_ID)
            else @Suppress("DEPRECATION") Notification.Builder(ctx)
            return b
                .setContentTitle("正在下载更新")
                .setContentText(if (indeterminate) "准备中…" else "$progress%")
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setOnlyAlertOnce(true)
                .setOngoing(true)
                .setProgress(100, progress, indeterminate)
                .build()
        }
        nm.notify(DOWNLOAD_NOTIF_ID, progressNotif(0, true))

        val req = Request.Builder().url(info.downloadUrl).build()
        val dlClient = client.newBuilder()
            .readTimeout(60, TimeUnit.SECONDS)
            .build()
        dlClient.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IllegalStateException("HTTP ${resp.code}")
            val body = resp.body ?: throw IllegalStateException("空响应")
            val total = body.contentLength()
            val file = File(ctx.cacheDir, "update.apk")
            var read = 0L
            var lastNotified = -5
            body.byteStream().use { input ->
                file.outputStream().use { output ->
                    val buf = ByteArray(8192)
                    while (true) {
                        val r = input.read(buf)
                        if (r == -1) break
                        output.write(buf, 0, r)
                        read += r
                        if (total > 0) {
                            val p = (read * 100 / total).toInt()
                            if (p >= lastNotified + 5) {
                                lastNotified = p
                                nm.notify(DOWNLOAD_NOTIF_ID, progressNotif(p, false))
                                onProgress?.invoke(p)
                            }
                        }
                    }
                }
            }
            nm.cancel(DOWNLOAD_NOTIF_ID)
            onProgress?.invoke(100)
            // 标记该版本安装包已完整落盘：后续点「检测更新」可直接安装，无需重复下载
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putInt(KEY_DOWNLOADED, info.versionCode.toInt()).apply()
            file
        }
    }

    // 直接拉起系统安装器；返回 false 表示需要先授权"安装未知应用"（已自动跳授权页）
    fun installApk(ctx: Context, file: File): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !ctx.packageManager.canRequestPackageInstalls()
        ) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY_PENDING, file.absolutePath).apply()
            ctx.startActivity(
                Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${ctx.packageName}")
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
            return false
        }
        doInstall(ctx, file)
        return true
    }

    private fun doInstall(ctx: Context, file: File) {
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
        ctx.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(
                    Intent.FLAG_GRANT_READ_URI_PERMISSION
                        or Intent.FLAG_ACTIVITY_NEW_TASK
                )
        )
    }

    // 授权"安装未知应用"后返回 App 时调用：自动继续未完成的安装
    fun resumePendingInstall(ctx: Context) {
        val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val path = sp.getString(KEY_PENDING, null) ?: return
        val file = File(path)
        if (!file.exists()) {
            sp.edit().remove(KEY_PENDING).apply()
            return
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            ctx.packageManager.canRequestPackageInstalls()
        ) {
            sp.edit().remove(KEY_PENDING).apply()
            doInstall(ctx, file)
            Toast.makeText(ctx, "已打开安装程序", Toast.LENGTH_SHORT).show()
        }
    }

    // 已完整下载且版本匹配的安装包；不存在/版本不匹配返回 null（并清理标记）
    fun pendingApk(ctx: Context, info: UpdateInfo): File? {
        val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val file = File(ctx.cacheDir, "update.apk")
        val ok = sp.getInt(KEY_DOWNLOADED, -1) == info.versionCode.toInt() && file.exists() && file.length() > 0
        if (!ok) {
            sp.edit().remove(KEY_DOWNLOADED).apply()
            return null
        }
        return file
    }

    // 一键流程：静默下载 → 跳安装；返回 "installing" 或 "need-permission"（授权后 onResume 自动续装）
    suspend fun downloadAndInstall(
        ctx: Context,
        info: UpdateInfo,
        onProgress: (suspend (Int) -> Unit)? = null,
    ): String {
        val file = downloadApk(ctx, info, onProgress)
        return if (installApk(ctx, file)) "installing" else "need-permission"
    }
}
