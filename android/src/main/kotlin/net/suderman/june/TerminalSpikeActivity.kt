package net.suderman.june

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.KeyEvent
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.LinearLayout
import android.widget.TextView
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

/**
 * The embedded terminal spike (june.org, "Spike: render a live herdr-core terminal"): one agent's terminal over
 * wss://…/terminal, drawn by libghostty-vt, with a row of keys the phone keyboard lacks. Started over ADB only:
 *   adb shell am start -n net.suderman.june/.TerminalSpikeActivity --es host kit --es terminal t6q
 *   adb shell am start -n net.suderman.june/.TerminalSpikeActivity --es link herdr:kit/claude:SESSION
 */
class TerminalSpikeActivity : Activity() {
    private lateinit var terminal: TerminalView
    private lateinit var status: TextView
    private val client = OkHttpClient.Builder().build()
    private var socket: WebSocket? = null
    private var automatic = false
    private var attached = false
    private val feeder = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var pendingGrid: Runnable? = null
    private var visible = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        terminal = TerminalView(this)
        status = TextView(this).apply {
            setTextColor(Color.parseColor("#A0A8B8")); textSize = 12f; setPadding(24, 12, 24, 12)
            setBackgroundColor(Color.parseColor("#12141A"))
            text = "connecting…"
        }
        val keys = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setBackgroundColor(Color.parseColor("#12141A")) }
        lateinit var ctrlKey: TextView
        lateinit var altKey: TextView
        fun key(label: String, act: () -> Unit) = TextView(this).apply {
            text = label; textSize = 15f; gravity = Gravity.CENTER; setTextColor(Color.parseColor("#D8DEE9"))
            setPadding(0, 26, 0, 26)
            setOnClickListener { act() }
            keys.addView(this, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }
        fun mark() {
            ctrlKey.setTextColor(if (terminal.ctrl) Color.parseColor("#F0A35E") else Color.parseColor("#D8DEE9"))
            altKey.setTextColor(if (terminal.alt) Color.parseColor("#F0A35E") else Color.parseColor("#D8DEE9"))
        }
        key("esc") { terminal.press(120, 0) }
        ctrlKey = key("ctrl") { terminal.ctrl = !terminal.ctrl; mark() }
        altKey = key("alt") { terminal.alt = !terminal.alt; mark() }
        key("tab") { terminal.press(64, 0) }
        key("⇧tab") { terminal.press(64, 1) }
        key("←") { terminal.press(76, 0) }
        key("↓") { terminal.press(75, 0) }
        key("↑") { terminal.press(78, 0) }
        key("→") { terminal.press(77, 0) }
        terminal.onModifiersUsed = { main.post { mark() } }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#12141A"))
            addView(status, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(terminal, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
            addView(keys, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        // Edge to edge: keep clear of the bars, and shrink above the keyboard so the terminal resizes with it.
        root.setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsets.CONSUMED
        }
        setContentView(root)
        terminal.onInput = { bytes, auto -> send(bytes, auto) }
        terminal.onGrid = { cols, rows, _, _ ->
            // One resize after the keyboard settles, not one per animation frame.
            pendingGrid?.let(main::removeCallbacks)
            pendingGrid = Runnable {
                if (socket == null) connect(false) else if (attached) socket?.send(JSONObject().put("op", "resize").put("cols", cols).put("rows", rows).toString())
            }.also { main.postDelayed(it, 150) }
        }
    }

    override fun onStart() {
        super.onStart()
        visible = true
        if (terminal.cols > 0 && socket == null) connect(false)
    }

    override fun onStop() {
        visible = false
        socket?.close(1000, "away")
        socket = null
        attached = false
        super.onStop()
    }

    override fun onDestroy() {
        feeder.shutdown()
        terminal.release()
        super.onDestroy()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean =
        if (keyCode != KeyEvent.KEYCODE_BACK && terminal.onKeyDown(keyCode, event)) true else super.onKeyDown(keyCode, event)

    private fun send(bytes: ByteArray, auto: Boolean) {
        if (!attached) return
        val frame = ByteArray(bytes.size + 1)
        frame[0] = if (auto && automatic) 6 else 0
        bytes.copyInto(frame, 1)
        socket?.send(frame.toByteString())
    }

    private fun connect(resumed: Boolean) {
        val pairing = Pairing.load(this) ?: run { status.text = "not paired"; return }
        terminal.reset()
        val hello = JSONObject().put("op", "hello").put("token", pairing.token).put("protocol", 1)
            .put("cols", terminal.cols).put("rows", terminal.rows).put("history", 1000).put("resumed", resumed)
            .put("display", JSONObject().put("fg", hex(terminal.foreground)).put("bg", hex(terminal.background)).put("cursor", hex(terminal.cursorColor))
                .put("cell", JSONArray().put(terminal.cellWidth).put(terminal.cellHeight)))
        intent.getStringExtra("link")?.let { hello.put("link", it) }
        intent.getStringExtra("host")?.let { hello.put("host", it) }
        intent.getStringExtra("terminal")?.let { hello.put("terminal", it) }
        val url = pairing.url.trimEnd('/') + "/terminal"
        status.text = "connecting to ${hello.optString("host", hello.optString("link"))} ${hello.optString("terminal")}…"
        socket = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(hello.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val m = JSONObject(text)
                when (m.optString("type")) {
                    "attached" -> {
                        automatic = m.optBoolean("automaticInput")
                        attached = true
                        main.post {
                            status.text = "${m.optString("agent")} · ${m.optString("host")}/${m.optString("terminal")} · ${terminal.cols}×${terminal.rows}"
                            terminal.showKeyboard()
                        }
                    }
                    "closed" -> main.post { status.text = "closed: ${m.optString("reason")}" }
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val data = bytes.toByteArray()
                if (data.isEmpty() || data[0].toInt() != 0) return
                feeder.execute {
                    val out = data.copyOfRange(1, data.size)
                    val replies = terminal.feed(out)
                    if (replies.isNotEmpty()) send(replies, true)
                    webSocket.send(JSONObject().put("op", "credit").put("bytes", out.size).toString())
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                main.post { if (socket === webSocket) status.text = "closed $code $reason" }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                main.post {
                    if (socket !== webSocket) return@post
                    status.text = "dropped: ${t.message}; reconnecting"
                    socket = null
                    attached = false
                    main.postDelayed({ if (visible && socket == null) connect(true) }, 2_000)
                }
            }
        })
    }

    private fun hex(c: Int) = String.format("#%06x", c and 0xFFFFFF)
}
