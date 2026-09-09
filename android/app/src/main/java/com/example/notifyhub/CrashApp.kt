package com.example.notifyhub

import android.app.Application
import android.content.ContentValues
import android.content.ContentUris
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// 启动诊断日志：事件追加写入私有文件，崩溃/启动时整体导出到公共「下载/NotifyHub」目录，
// 便于无法启动 App 时直接用文件管理器查看（无需 adb）
object LogHelper {

    private const val DIR = "NotifyHub"
    private const val LOG_NAME = "notify-hub.log"
    private const val MAX_LINES = 400
    private val fmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault())

    private fun logFile(ctx: Context): File {
        val d = File(ctx.filesDir, "logs")
        d.mkdirs()
        return File(d, LOG_NAME)
    }

    @Synchronized
    fun append(ctx: Context, msg: String) {
        try {
            val line = "[${fmt.format(Date())}] $msg\n"
            logFile(ctx).appendText(line)
            trim(ctx)
        } catch (_: Throwable) {
        }
    }

    private fun trim(ctx: Context) {
        try {
            val f = logFile(ctx)
            val lines = f.readLines()
            if (lines.size > MAX_LINES) f.writeText(lines.takeLast(MAX_LINES).joinToString("\n") + "\n")
        } catch (_: Throwable) {
        }
    }

    fun version(ctx: Context): String = try {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "?"
    } catch (_: Throwable) {
        "?"
    }

    // 崩溃：追加堆栈 → 导出日志与崩溃文件到公共下载目录 → 保留私有副本供 App 内弹窗展示
    fun crash(ctx: Context, thread: Thread, e: Throwable) {
        val trace = "\n----- CRASH -----\nthread=${thread.name}\nversion=${version(ctx)}\n" +
            Log.getStackTraceString(e)
        try {
            logFile(ctx).appendText(trace)
        } catch (_: Throwable) {
        }
        try {
            val dir = File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "crash")
            dir.mkdirs()
            File(dir, "last.txt").writeText(fullLog(ctx) + trace)
        } catch (_: Throwable) {
        }
        val ts = SimpleDateFormat("MMdd-HHmmss", Locale.getDefault()).format(Date())
        writePublic(ctx, "notify-hub-crash-$ts.txt", fullLog(ctx) + trace, false)
        writePublic(ctx, LOG_NAME, fullLog(ctx) + trace, true)
    }

    // 每次启动导出一次完整日志（便于未崩溃但起不来的场景排查）
    fun flush(ctx: Context) {
        writePublic(ctx, LOG_NAME, fullLog(ctx), true)
    }

    fun fullLog(ctx: Context): String = try {
        logFile(ctx).readText()
    } catch (_: Throwable) {
        ""
    }

    // Android 10+ 走 MediaStore（免权限），旧版直写公共下载目录
    private fun writePublic(ctx: Context, name: String, text: String, deleteOld: Boolean) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                val resolver = ctx.contentResolver
                val uriExt = MediaStore.Downloads.EXTERNAL_CONTENT_URI
                if (deleteOld) {
                    val c = resolver.query(
                        uriExt,
                        arrayOf(MediaStore.MediaColumns._ID),
                        "${MediaStore.MediaColumns.DISPLAY_NAME}=?",
                        arrayOf(name),
                        null
                    )
                    c?.use {
                        while (it.moveToNext()) {
                            resolver.delete(ContentUris.withAppendedId(uriExt, it.getLong(0)), null, null)
                        }
                    }
                }
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.MIME_TYPE, "text/plain")
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + DIR)
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val uri = resolver.insert(uriExt, values) ?: return
                resolver.openOutputStream(uri)?.use { it.write(text.toByteArray()) }
                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
            } else {
                val dir = File(
                    Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                    DIR
                )
                dir.mkdirs()
                File(dir, name).writeText(text)
            }
        } catch (_: Throwable) {
        }
    }
}

class CrashApp : Application() {

    override fun onCreate() {
        super.onCreate()
        LogHelper.append(this, "process start (version ${LogHelper.version(this)})")
        LogHelper.flush(this)
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            LogHelper.crash(this@CrashApp, t, e)
            prev?.uncaughtException(t, e)
        }
    }
}
