package net.suderman.june

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.UUID

/** Where the link stands, as the session shows it. */
sealed interface LinkStatus {
    data object Unpaired : LinkStatus
    data object Connecting : LinkStatus
    data class Linked(val device: String) : LinkStatus
    /** The daemon refused the token (4401): pairing is needed, so the link stops retrying. */
    data object Refused : LinkStatus
    data class Offline(val reason: String) : LinkStatus
}

/**
 * The phone's connection to June: the WebSocket listener's protocol (see "Client protocol for graphical clients" in
 * docs/architecture.org). It says hello with the device token, attaches to the folded view, keeps the items and state
 * as Compose state, and reconnects after a drop until closed. The session opens one while it shows; nothing runs in
 * the background.
 */
class Link(private val context: Context) {
    var status: LinkStatus by mutableStateOf(LinkStatus.Unpaired)
        private set
    var items: List<Item> by mutableStateOf(emptyList())
        private set
    var state: ViewState by mutableStateOf(ViewState())
        private set
    /** The daemon's host as the address names it, `kit` for wss://june.kit/, as the desktop's masthead says it. */
    val host: String
        get() = Pairing.load(context)?.url?.let { Regex("^wss?://(?:june\\.)?([^/:.]+)").find(it)?.groupValues?.get(1) } ?: "June"
    /** Where the daemon serves June's art to this device (the hello's `avatar`), when it has a set. */
    var avatarPath: String? by mutableStateOf(null)
        private set
    /** Where the daemon serves the pictures the user's messages brought (the hello's `attached`). */
    var attachedPath: String? by mutableStateOf(null)
        private set
    /** A command's reply or an error, shown briefly. */
    var notice: String by mutableStateOf("")
        private set

    /** Pending art requests, by reply, so repeated long presses cannot queue duplicate model calls. */
    var taking: Map<String, String> by mutableStateOf(emptyMap())
        private set

    private val main = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder().build()
    private var socket: WebSocket? = null
    private var active = false
    private var refusals = 0

    fun open() {
        active = true
        connect()
    }

    fun close() {
        active = false
        taking = emptyMap()
        main.removeCallbacksAndMessages(null)
        socket?.close(1000, "session hidden")
        socket = null
    }

    /**
     * Send the user's words, with `images` as base64 JPEG and `files` as they are; `followUp` queues them behind a busy
     * run rather than steering it.
     */
    fun submit(text: String, followUp: Boolean = false, images: List<String> = emptyList(), files: List<Attachment> = emptyList()): Boolean {
        if (text.isBlank() && images.isEmpty() && files.isEmpty()) return true
        val ws = socket ?: return false
        if (status !is LinkStatus.Linked) return false
        val request = JSONObject()
            .put("op", "submit").put("requestId", requestId()).put("text", text).put("source", "apk")
            .put("whenBusy", if (followUp) "followUp" else "steer")
        if (images.isNotEmpty()) request.put("images", org.json.JSONArray(images.map { JSONObject().put("type", "image").put("data", it).put("mimeType", "image/jpeg") }))
        if (files.isNotEmpty()) request.put("files", org.json.JSONArray(files.map { JSONObject().put("name", it.name).put("mimeType", it.mimeType).put("data", it.data) }))
        return ws.send(request.toString())
    }

    fun stop() {
        socket?.send(JSONObject().put("op", "command").put("requestId", requestId()).put("name", "stop").toString())
    }

    fun take(action: JSONObject) {
        val reply = action.optString("reply")
        val op = action.optString("op")
        val ws = socket ?: return
        if (status !is LinkStatus.Linked || reply in taking || op !in listOf("retake", "restore", "advance")) return
        val id = requestId()
        if (ws.send(JSONObject().put("op", op).put("requestId", id).put("reply", reply).put("revision", action.optString("revision")).toString())) {
            taking = taking + (reply to id)
            notice = when (op) {
                "retake" -> "choosing another take…"
                "restore" -> "restoring the previous take…"
                else -> "restoring the next take…"
            }
        }
    }

    private fun requestId() = "apk-${UUID.randomUUID()}"

    private fun connect() {
        val pairing = Pairing.load(context)
        if (pairing == null) {
            status = LinkStatus.Unpaired
            return
        }
        status = LinkStatus.Connecting
        var helloSeen = false
        socket = client.newWebSocket(Request.Builder().url(pairing.url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(JSONObject().put("op", "hello").put("requestId", requestId()).put("token", pairing.token).put("protocol", 1).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val reply = try { JSONObject(text) } catch (e: Exception) { return }
                main.post {
                    if (webSocket !== socket) return@post
                    if (reply.optString("type") in listOf("reply", "error")) taking = taking.filterValues { it != reply.optString("requestId") }
                    when (reply.optString("type")) {
                        "hello" -> {
                            helloSeen = true
                            refusals = 0
                            status = LinkStatus.Linked(reply.optString("device"))
                            avatarPath = reply.optString("avatar").takeIf { it.isNotEmpty() }
                            attachedPath = reply.optString("attached").takeIf { it.isNotEmpty() }
                            webSocket.send(JSONObject().put("op", "attach").put("requestId", requestId()).toString())
                        }
                        "view" -> {
                            items = if (reply.optBoolean("reset")) parseItems(reply.getJSONArray("items")) else applyChanges(items, reply.optJSONArray("changes") ?: org.json.JSONArray())
                            reply.optJSONObject("state")?.let { state = ViewState.from(it) }
                        }
                        "reply" -> notice = reply.optString("text")
                        "error" -> notice = reply.optString("message")
                    }
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = ended(webSocket, code, reason)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = ended(webSocket, null, t.message ?: t.toString())

            private fun ended(webSocket: WebSocket, code: Int?, reason: String) {
                main.post {
                    if (webSocket !== socket) return@post
                    Log.i(TAG, "link ended: ${code ?: "failure"} $reason")
                    socket = null
                    taking = emptyMap()
                    // 4401 is a refused token; a close before any hello twice running means the same.
                    if (code == 4401 || (!helloSeen && ++refusals >= 2 && code != null)) {
                        status = LinkStatus.Refused
                        return@post
                    }
                    status = LinkStatus.Offline(reason)
                    if (active) main.postDelayed({ if (active) connect() }, 2000)
                }
            }
        })
    }
}
