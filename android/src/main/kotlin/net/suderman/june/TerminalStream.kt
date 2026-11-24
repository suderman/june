package net.suderman.june

import android.content.Context
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
    private var cols = 0
    private var rows = 0

    init {
        view.onInput = { bytes, auto -> send(bytes, auto) }
    }

    /** Attach at the view's size; RESUMED after a drop, so the size is taken only once the user types or resizes. */
    fun start(resumed: Boolean = false) {
        running = true
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
                            onState(State.Attached(m.optString("host"), m.optString("terminal"), m.optString("agent")))
                            // The view may have changed size while attaching.
                            if (view.cols != cols || view.rows != rows) resize(view.cols, view.rows)
                        }
                    }
                    "closed" -> main.post { onState(State.Closed(m.optString("reason"))) }
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
                    // 4409: the terminal is between programs (a kept terminal restarting); try again shortly.
                    if (code == 4409 && running) {
                        onState(State.Dropped(reason))
                        main.postDelayed({ if (running && socket == null) start(true) }, 3_000)
                    } else if (code != 1000 || reason != "closed by client") {
                        onState(State.Closed(when (code) {
                            4401 -> "June refused this phone's token"
                            4404 -> reason.ifEmpty { "not found" }
                            4429 -> "too many terminals open"
                            else -> reason.ifEmpty { "closed" }
                        }))
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                main.post {
                    if (socket !== webSocket) return@post
                    socket = null
                    attached = false
                    if (!running) return@post
                    onState(State.Dropped(t.message ?: "connection lost"))
                    main.postDelayed({ if (running && socket == null) start(true) }, 2_000)
                }
            }
        })
    }

    /** Detach; the agent keeps running. */
    fun stop() {
        running = false
        attached = false
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
        else if (running && socket == null) start()
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
        private val client by lazy { OkHttpClient.Builder().build() }
    }
}
