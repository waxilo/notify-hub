package com.example.notifyhub.data

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
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

    fun openDownload(ctx: Context, info: UpdateInfo) {
        ctx.startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse(info.downloadUrl))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }
}
