package com.example.notifyhub.api

import com.example.notifyhub.data.ConfigStore
import com.example.notifyhub.data.TokenStore
import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import retrofit2.Response
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.*

// ---------- 请求/响应模型 ----------
data class CredReq(val username: String, val password: String)
data class TokenResp(val token: String, @SerializedName("userId") val userId: Long)
data class ChangePwReq(val oldPassword: String, val newPassword: String)
data class CreateKeyReq(val name: String = "default")
data class UpdateKeyReq(
    val name: String? = null,
    val active: Boolean? = null,
    val mode: String? = null,
    val template: String? = null,
    // Gson 默认不序列化 null 字段 → 局部更新（如只改名称）不会把这个开关一起上报，
    // 服务端「字段不传就不改」的策略才有意义
    @SerializedName("strong_vibrate") val strongVibrate: Boolean? = null
)
data class KeyResp(val id: Long, val key: String, val name: String, val createdAt: Long)
data class KeyItem(
    val id: Long,
    val name: String?,
    val key: String,
    val keyFull: String?,
    val createdAt: Long?,
    @SerializedName("last_used") val lastUsed: Long?,
    val active: Int,
    val mode: String?,
    val template: String?,
    // 1 = 强力震动（无声、持续震到用户处理）；0 = 普通提醒（横幅 + 单次震动）
    @SerializedName("strong_vibrate") val strongVibrate: Int?
)
data class KeysResp(val keys: List<KeyItem>)
data class NotificationItem(
    val id: Long,
    val title: String?,
    val body: String?,
    val payload: String?,
    @SerializedName("key_id") val keyId: Long?,
    @SerializedName("key_name") val keyName: String?,
    // 非空表示这次调用被服务端拒绝（如 'key_disabled'），历史里展示为「停用拒绝」
    val rejected: String?,
    @SerializedName("created_at") val createdAt: Long,
    val read: Int,
    @SerializedName("delivered_at") val deliveredAt: Long?
)
data class NotifResp(val notifications: List<NotificationItem>, val total: Int)
data class ClearResp(val ok: Boolean, val deleted: Int?)

// ---------- 定时任务（配置在服务端，由 Worker Cron 每分钟扫描执行，App 不跑任何定时器） ----------
// 定时任务不挂 key：key 是外部系统调 /hook/:key 用的凭证。任务触发后直接发默认通知，
// 标题 = 任务名称（服务端回填 title 字段），正文 = 通知内容（留空则同任务名）。
data class JobItem(
    val id: Long,
    val name: String?,
    val schedule: String,
    val tz: String?,
    val title: String?,
    val body: String?,
    val enabled: Int,
    @SerializedName("next_run_at") val nextRunAt: Long?,
    @SerializedName("last_run_at") val lastRunAt: Long?,
    // 该任务已产生的日志条数（服务端聚合统计），用于列表展示
    @SerializedName("sent_count") val sentCount: Int?,
    // 1 = 强力震动；0 = 普通提醒。与 key 的同名字段互相独立（任务与外部 key 是两条来源）
    @SerializedName("strong_vibrate") val strongVibrate: Int?,
    // 1 = 跳过非工作日（含周末），当天不触发；仅周期型任务生效，once 忽略
    @SerializedName("skip_holiday") val skipHoliday: Int?,
    // 服务端算好的中文描述，如「每 5 分钟」「每天 09:00（+08:00）」
    val desc: String?
)
data class JobsResp(val jobs: List<JobItem>)
data class CreateJobReq(
    val name: String,
    val schedule: String,
    val tz: String,
    val body: String = "",
    val enabled: Boolean = true,
    @SerializedName("strong_vibrate") val strongVibrate: Boolean = false,
    @SerializedName("skip_holiday") val skipHoliday: Boolean = false
)
data class UpdateJobReq(
    val name: String? = null,
    val schedule: String? = null,
    val tz: String? = null,
    val body: String? = null,
    val enabled: Boolean? = null,
    @SerializedName("strong_vibrate") val strongVibrate: Boolean? = null,
    @SerializedName("skip_holiday") val skipHoliday: Boolean? = null
)
data class JobResp(val id: Long, @SerializedName("next_run_at") val nextRunAt: Long?, val desc: String?)

// ---------- API 定义 ----------
interface NotifyApi {
    @POST("/api/register") suspend fun register(@Body req: CredReq): TokenResp
    @POST("/api/login") suspend fun login(@Body req: CredReq): TokenResp
    @POST("/api/password") suspend fun changePassword(@Body req: ChangePwReq): Response<Unit>
    @POST("/api/keys") suspend fun createKey(@Body req: CreateKeyReq): KeyResp
    @GET("/api/keys") suspend fun listKeys(): KeysResp
    @PUT("/api/keys/{id}") suspend fun updateKey(@Path("id") id: Long, @Body req: UpdateKeyReq): Response<Unit>
    // DELETE /api/keys/{id}：彻底删除 key 及其全部发送历史（服务端同一路由）
    @DELETE("/api/keys/{id}") suspend fun deleteKey(@Path("id") id: Long): Response<Unit>
    // key_id 与 job_id 二选一（都不传 = 全部通知）；Retrofit 对 null 参数不拼进查询串
    @GET("/api/notifications") suspend fun listNotifications(
        @Query("limit") limit: Int = 10,
        @Query("offset") offset: Int = 0,
        @Query("key_id") keyId: Long? = null,
        @Query("job_id") jobId: Long? = null
    ): NotifResp
    // 批量清空历史：服务端要求必须带 key_id 或 job_id（刻意不提供「清空全部」）
    @DELETE("/api/notifications") suspend fun clearNotifications(
        @Query("key_id") keyId: Long? = null,
        @Query("job_id") jobId: Long? = null
    ): ClearResp
    @POST("/api/notifications/{id}/read") suspend fun markRead(@Path("id") id: Long): Response<Unit>
    @POST("/api/notifications/{id}/delivered") suspend fun markDelivered(@Path("id") id: Long): Response<Unit>
    @GET("/api/jobs") suspend fun listJobs(): JobsResp
    @POST("/api/jobs") suspend fun createJob(@Body req: CreateJobReq): JobResp
    @PUT("/api/jobs/{id}") suspend fun updateJob(@Path("id") id: Long, @Body req: UpdateJobReq): JobResp
    @DELETE("/api/jobs/{id}") suspend fun deleteJob(@Path("id") id: Long): Response<Unit>
}

// 自动附加 Bearer token
class AuthInterceptor(private val context: android.content.Context) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): okhttp3.Response {
        val token = TokenStore(context).token
        val req = if (token != null)
            chain.request().newBuilder().header("Authorization", "Bearer $token").build()
        else
            chain.request()
        return chain.proceed(req)
    }
}

// 懒加载单例：API 地址变化时重建
object Api {
    private var retrofit: Retrofit? = null
    private var baseUrl: String = ""

    fun instance(context: android.content.Context): NotifyApi {
        // Retrofit 要求 baseUrl 以 / 结尾（ConfigStore 存储时去掉了末尾斜杠）
        val raw = ConfigStore(context).apiBase
        val url = if (raw.endsWith("/")) raw else "$raw/"
        if (retrofit == null || baseUrl != url) {
            baseUrl = url
            val client = OkHttpClient.Builder()
                .addInterceptor(AuthInterceptor(context))
                .build()
            retrofit = Retrofit.Builder()
                .baseUrl(url)
                .addConverterFactory(GsonConverterFactory.create(Gson()))
                .client(client)
                .build()
        }
        return retrofit!!.create(NotifyApi::class.java)
    }

    suspend fun <T> safe(block: suspend () -> T): T = withContext(Dispatchers.IO) { block() }
}
