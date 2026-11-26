package net.suderman.june

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Which agent terminal to show: a herdr: session link, or a host and terminal address. */
data class TerminalTarget(val host: String, val terminal: String = "", val link: String = "") {
    val key get() = link.ifEmpty { "$host/$terminal" }

    companion object {
        fun of(link: String): TerminalTarget? =
            Regex("""^herdr:([a-z0-9-]+)/[a-z]+:[0-9a-f-]{36}(?:@[A-Za-z0-9:]+)?$""").find(link)?.let { TerminalTarget(it.groupValues[1], link = link) }
    }
}

/**
 * One agent terminal on show: a WebSocket to the daemon's /terminal (see "Terminal streams" in docs/architecture.org),
 * whose output feeds VIEW and whose keys go back. A new attach starts a fresh emulator, since herdr-core sends a full
 * first paint; a drop reconnects as resumed, so a phone coming back in the background never takes the terminal's size.
 * Closing it only detaches: the agent keeps running.
 */
class TerminalStream(
    private val context: Context,
    val target: TerminalTarget,
    private val view: TerminalView,
    private val onState: (State) -> Unit,
) {
    sealed interface State {
        data object Connecting : State
        data class Attached(val host: String, val terminal: String, val agent: String) : State
        data class Closed(val reason: String) : State
        data class Dropped(val reason: String) : State
    }

    private val main = Handler(Looper.getMainLooper())
    private val feeder = Executors.newSingleThreadExecutor()
    private var socket: WebSocket? = null
    private var attached = false
    private var automatic = false
    private var running = false
    private var focused = false
    private var cols = 0
    private var rows = 0
    private var backoffMs = 1_000L
    private var retryTask: Runnable? = null
    private var netCallback: ConnectivityManager.NetworkCallback? = null
    // Files sent with put, by request id, until the daemon says where each landed. Main thread only.
    private val puts = HashMap<String, (String?, String?) -> Unit>()
    private var nextPut = 0
    private var onKilled: ((String?) -> Unit)? = null

    init {
        view.onInput = { bytes, auto -> send(bytes, auto) }
    }

    private fun cancelRetry() {
        retryTask?.let { main.removeCallbacks(it) }
        retryTask = null
    }

    private fun watchNetwork() {
        if (netCallback != null) return
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                main.post {
                    if (running && socket == null && retryTask != null) {
                        cancelRetry()
                        backoffMs = 1_000L
                        start(resumed = true)
                    }
                }
            }
        }
        if (runCatching { cm.registerDefaultNetworkCallback(cb) }.isSuccess) netCallback = cb
    }

    private fun unwatchNetwork() {
        val cb = netCallback ?: return
        netCallback = null
        runCatching { context.getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb) }
    }

    private fun scheduleReconnect(delayMs: Long) {
        cancelRetry()
        val task = Runnable {
            retryTask = null
            if (running && socket == null) start(resumed = true)
        }
        retryTask = task
        main.postDelayed(task, delayMs)
    }

    /** Attach at the view's size; RESUMED after a drop, so the size is taken only once the user types or resizes. */
    fun start(resumed: Boolean = false) {
        running = true
        cancelRetry()
        watchNetwork()
        if (socket != null || view.cols == 0) return
        val pairing = Pairing.load(context) ?: return onState(State.Closed("June is not paired"))
        view.reset()
        cols = view.cols
        rows = view.rows
        val hello = JSONObject().put("op", "hello").put("token", pairing.token).put("protocol", 1)
            .put("cols", cols).put("rows", rows).put("history", 2000).put("resumed", resumed)
            .put("display", JSONObject().put("fg", hex(view.foreground)).put("bg", hex(view.background)).put("cursor", hex(view.cursorColor))
                .put("cell", JSONArray().put(view.cellWidth).put(view.cellHeight)))
        if (target.link.isNotEmpty()) hello.put("link", target.link) else hello.put("host", target.host).put("terminal", target.terminal)
        onState(State.Connecting)
        val url = pairing.url.trimEnd('/') + "/terminal"
        socket = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(hello.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val m = runCatching { JSONObject(text) }.getOrNull() ?: return
                when (m.optString("type")) {
                    "attached" -> {
                        automatic = m.optBoolean("automaticInput")
                        attached = true
                        main.post {
                            if (socket !== webSocket) return@post
                            backoffMs = 1_000L
                            onState(State.Attached(m.optString("host"), m.optString("terminal"), m.optString("agent")))
                            if (focused) webSocket.send(JSONObject().put("op", "focus").put("on", true).toString())
                            // The view may have changed size while attaching.
                            if (view.cols != cols || view.rows != rows) resize(view.cols, view.rows)
                        }
                    }
                    "closed" -> main.post {
                        if (socket !== webSocket) return@post
                        running = false
                        cancelRetry()
                        unwatchNetwork()
                        onState(State.Closed(m.optString("reason")))
                    }
                    "put" -> main.post {
                        val path = m.optString("path").takeIf { it.isNotEmpty() }
                        puts.remove(m.optString("id"))?.invoke(path, if (path == null) m.optString("error", "not sent") else null)
                    }
                    "killed" -> main.post {
                        val cb = onKilled
                        onKilled = null
                        val err = m.optString("error").takeIf { it.isNotEmpty() }
                        if (err == null) {
                            running = false
                            cancelRetry()
                            unwatchNetwork()
                        }
                        cb?.invoke(err)
                    }
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val data = bytes.toByteArray()
                if (data.isEmpty() || data[0].toInt() != 0) return
                feeder.execute {
                    if (socket !== webSocket) return@execute
                    val out = data.copyOfRange(1, data.size)
                    val replies = view.feed(out)
                    if (replies.isNotEmpty()) send(replies, true)
                    webSocket.send(JSONObject().put("op", "credit").put("bytes", out.size).toString())
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                main.post {
                    if (socket !== webSocket) return@post
                    socket = null
                    attached = false
                    failPuts()
                    // 4409: the terminal is between programs (a kept terminal restarting); try again shortly.
                    if (code == 4409 && running) {
                        onState(State.Dropped(reason))
                        scheduleReconnect(3_000L)
                    } else {
                        running = false
                        cancelRetry()
                        unwatchNetwork()
                        if (code != 1000 || reason != "closed by client") {
                            onState(State.Closed(when (code) {
                                4401 -> "June refused this phone's token"
                                4404 -> reason.ifEmpty { "not found" }
                                4429 -> "too many terminals open"
                                else -> reason.ifEmpty { "closed" }
                            }))
                        }
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                main.post {
                    if (socket !== webSocket) return@post
                    socket = null
                    attached = false
                    failPuts()
                    if (!running) return@post
                    onState(State.Dropped(t.message ?: "connection lost"))
                    val wait = backoffMs
                    backoffMs = (backoffMs * 2).coerceAtMost(15_000L)
                    scheduleReconnect(wait)
                }
            }
        })
    }

    /** Tell herdr-core whether this phone view currently holds focus. */
    fun focus(on: Boolean) {
        focused = on
        if (attached) socket?.send(JSONObject().put("op", "focus").put("on", on).toString())
    }

    /**
     * Send a file to lie beside the terminal on its machine (herdr-core's terminal.put); DONE hears, on the main thread,
     * the path it landed at or why it did not.
     */
    fun put(drop: Drop, done: (path: String?, error: String?) -> Unit) {
        val s = socket
        if (!attached || s == null) return done(null, "not attached")
        val id = "p${nextPut++}"
        puts[id] = done
        Thread {
            val data = android.util.Base64.encodeToString(drop.bytes, android.util.Base64.NO_WRAP)
            if (!s.send(JSONObject().put("op", "put").put("id", id).put("name", drop.name).put("data", data).toString()))
                main.post { puts.remove(id)?.invoke(null, "connection lost") }
        }.start()
    }

    /** End the terminal's program and remove the pane on its host (terminal.kill + terminal.rm). */
    fun kill(done: (error: String?) -> Unit) {
        val s = socket
        if (!attached || s == null) return done("not attached")
        onKilled = done
        if (!s.send(JSONObject().put("op", "kill").toString())) {
            onKilled = null
            done("connection lost")
        }
    }

    private fun failPuts() {
        val waiting = puts.values.toList()
        puts.clear()
        waiting.forEach { it(null, "connection lost") }
        val k = onKilled
        onKilled = null
        k?.invoke("connection lost")
    }

    /** Detach; the agent keeps running. */
    fun stop() {
        running = false
        focused = false
        attached = false
        backoffMs = 1_000L
        cancelRetry()
        unwatchNetwork()
        failPuts()
        socket?.let { s ->
            socket = null
            runCatching { s.send(JSONObject().put("op", "close").toString()) }
            s.close(1000, "away")
        }
    }

    fun release() {
        stop()
        feeder.shutdown()
    }

    fun resize(cols: Int, rows: Int) {
        if (cols == this.cols && rows == this.rows) return
        this.cols = cols
        this.rows = rows
        if (attached) socket?.send(JSONObject().put("op", "resize").put("cols", cols).put("rows", rows).toString())
        else if (running && socket == null && retryTask == null) start()
    }

    private fun send(bytes: ByteArray, auto: Boolean) {
        if (!attached) return
        val frame = ByteArray(bytes.size + 1)
        frame[0] = if (auto && automatic) 6 else 0
        bytes.copyInto(frame, 1)
        socket?.send(frame.toByteString())
    }

    private fun hex(c: Int) = String.format("#%06x", c and 0xFFFFFF)

    companion object {
        private val client by lazy { OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build() }
    }
}
