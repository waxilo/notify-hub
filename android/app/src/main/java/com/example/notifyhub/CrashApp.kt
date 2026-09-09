package com.example.notifyhub

import android.app.Application
import android.util.Log
import java.io.File

// 全局崩溃捕获：把未捕获异常的完整堆栈写入应用外部专属目录，
// 下次启动 LoginActivity 弹窗展示，用于无 adb 环境下定位闪退
class CrashApp : Application() {

    override fun onCreate() {
        super.onCreate()
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            try {
                val dir = File(getExternalFilesDir(null) ?: filesDir, "crash")
                dir.mkdirs()
                File(dir, "last.txt").writeText(
                    buildString {
                        appendLine("time=${System.currentTimeMillis()}")
                        appendLine("thread=${t.name}")
                        appendLine("version=${packageManager.getPackageInfo(packageName, 0).versionName}")
                        append(Log.getStackTraceString(e))
                    }
                )
            } catch (_: Throwable) {
            }
            prev?.uncaughtException(t, e)
        }
    }
}
