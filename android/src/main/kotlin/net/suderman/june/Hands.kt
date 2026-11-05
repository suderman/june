package net.suderman.june

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Color
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.TextView
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.UUID

/**
 * June's hands on this phone: an accessibility service that keeps its own connection to June, offers to act (`hands`),
 * and does each `act` she sends, answering with `acted` (see "June's hands on the phone" in docs/architecture.org).
 * Jon gave her full access, with no hand-over; while she acts a bar across the top says so, and a tap on it stops her
 * until he next opens June. Nothing here decides what to do: June asks, and this only reads the screen or acts.
 */
class Hands : AccessibilityService() {
    private val main = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder().build()
    private var socket: WebSocket? = null
    private var connected = false
    private var backoff = 2_000L
    private var bar: TextView? = null
    private val hideBar = Runnable { bar?.let { runCatching { windowManager().removeView(it) } }; bar = null }

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.i(TAG, "hands: service connected")
        connected = true
        connect()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

    override fun onInterrupt() {}

    override fun onDestroy() {
        connected = false
        main.removeCallbacksAndMessages(null)
        socket?.close(1000, "hands withdrawn")
        socket = null
        hideBar.run()
        super.onDestroy()
    }

    private fun connect() {
        if (!connected) return
        val pairing = Pairing.load(this) ?: return retry()
        socket = client.newWebSocket(Request.Builder().url(pairing.url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(JSONObject().put("op", "hello").put("requestId", "hands-${UUID.randomUUID()}").put("token", pairing.token).put("protocol", 1).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val message = runCatching { JSONObject(text) }.getOrNull() ?: return
                main.post {
                    if (webSocket !== socket) return@post
                    when (message.optString("type")) {
                        "hello" -> {
                            backoff = 2_000L
                            webSocket.send(JSONObject().put("op", "hands").put("requestId", "hands-${UUID.randomUUID()}").toString())
                            Log.i(TAG, "hands: offered to ${message.optString("device")}")
                        }
                        "act" -> act(message) { ok, said -> webSocket.send(JSONObject().put("op", "acted").put("requestId", message.optString("requestId")).put("ok", ok).put("text", said).toString()) }
                        "error" -> Log.w(TAG, "hands: ${message.optString("message")}")
                    }
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = ended(webSocket, code, reason)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = ended(webSocket, null, t.message ?: t.toString())

            private fun ended(webSocket: WebSocket, code: Int?, reason: String) {
                main.post {
                    if (webSocket !== socket) return@post
                    socket = null
                    Log.i(TAG, "hands: link ended: ${code ?: "failure"} $reason")
                    // 4401: the token was refused; pairing again starts the app's own link, and this one with the service.
                    if (code != 4401) retry()
                }
            }
        })
    }

    private fun retry() {
        main.postDelayed({ connect() }, backoff)
        backoff = (backoff * 2).coerceAtMost(60_000L)
    }

    // The actions. Each answers once: what it saw or did, and the app now in front, so June can check before her next.

    private fun act(message: JSONObject, answer: (Boolean, String) -> Unit) {
        val action = message.optString("action")
        if (System.currentTimeMillis() < stoppedUntil) return answer(false, "Jon stopped you from the phone; wait until he asks again")
        // June's own sheet covers the apps and the power menu; it closes before she acts, so Jon sees what she does.
        if (action != "screen" && JuneSession.dismiss()) {
            main.postDelayed({ act(message, answer) }, 400)
            return
        }
        Log.i(TAG, "hands: $action ${if (action == "type") "" else message.optString("target").ifBlank { message.optString("text").take(40) }}")
        showBar()
        val done = { ok: Boolean, said: String ->
            main.removeCallbacks(hideBar)
            main.postDelayed(hideBar, 1_500)
            // Never the screen's words in the log: they may be private.
            Log.i(TAG, "hands: ${if (ok) "done" else "failed"}: ${if (action == "screen") "${said.length} characters" else said.take(120)}")
            answer(ok, said)
        }
        val settled = { ok: Boolean, said: String ->
            if (!ok) done(false, said) else main.postDelayed({ done(true, "$said; in front: ${front()}") }, 700)
            Unit
        }
        try {
            when (action) {
                "screen" -> done(true, screen())
                "tap" -> tap(message, settled)
                "type" -> type(message, settled)
                "scroll" -> scroll(message, settled)
                "open" -> open(message.optString("text"), settled)
                "global" -> global(message.optString("text"), settled)
                else -> done(false, "unknown action $action")
            }
        } catch (e: Exception) {
            Log.w(TAG, "hands: $action failed: $e")
            done(false, "$action failed: ${e.message ?: e}")
        }
    }

    private fun front(): String = rootInActiveWindow?.packageName?.toString() ?: "unknown"

    /** Every window's controls but this service's own bar: one line per control worth naming, indented by depth. */
    private fun screen(): String {
        val out = StringBuilder()
        for (window in windows) {
            val root = window.root ?: continue
            if (root.packageName == packageName) continue
            out.append("— ${window.title ?: "window"} (${root.packageName})\n")
            describe(root, 0, out)
            if (out.length > LIMIT) break
        }
        if (out.length > LIMIT) out.setLength(LIMIT).also { out.append("\n… (cut)") }
        return out.toString().ifBlank { "(nothing readable on screen)" }
    }

    private fun describe(node: AccessibilityNodeInfo, depth: Int, out: StringBuilder) {
        if (!node.isVisibleToUser) return
        val words = node.text?.toString()?.takeIf { it.isNotBlank() } ?: node.contentDescription?.toString()?.takeIf { it.isNotBlank() }
        val id = node.viewIdResourceName?.substringAfter(":id/")
        val does = listOfNotNull(
            "tap".takeIf { node.isClickable }, "hold".takeIf { node.isLongClickable }, "edit".takeIf { node.isEditable },
            "scroll".takeIf { node.isScrollable }, (if (node.isChecked) "on" else "off").takeIf { node.isCheckable }, "focused".takeIf { node.isFocused },
        )
        val shown = words != null || node.isEditable || (node.isClickable && id != null)
        if (shown) {
            val box = Rect().also { node.getBoundsInScreen(it) }
            out.append("  ".repeat(depth)).append(words?.replace("\n", " ")?.take(160) ?: "(${node.className?.toString()?.substringAfterLast('.')})")
            if (id != null) out.append(" [").append(id).append("]")
            out.append(" @").append(box.centerX()).append(",").append(box.centerY())
            if (does.isNotEmpty()) out.append(" {").append(does.joinToString(" ")).append("}")
            out.append("\n")
        }
        for (i in 0 until node.childCount) node.getChild(i)?.let { describe(it, if (shown) depth + 1 else depth, out) }
    }

    /** The visible control `target` names (its words or description, an exact match first) or `id` names. */
    private fun find(target: String?, id: String?): AccessibilityNodeInfo? {
        val all = mutableListOf<AccessibilityNodeInfo>()
        fun walk(node: AccessibilityNodeInfo) {
            if (!node.isVisibleToUser) return
            all.add(node)
            for (i in 0 until node.childCount) node.getChild(i)?.let(::walk)
        }
        for (window in windows) window.root?.takeIf { it.packageName != packageName }?.let(::walk)
        if (!id.isNullOrBlank()) return all.firstOrNull { it.viewIdResourceName == id || it.viewIdResourceName?.endsWith(":id/$id") == true }
        if (target.isNullOrBlank()) return null
        val said = { n: AccessibilityNodeInfo -> listOfNotNull(n.text?.toString(), n.contentDescription?.toString()) }
        return all.firstOrNull { n -> said(n).any { it.equals(target, ignoreCase = true) } }
            ?: all.firstOrNull { n -> said(n).any { it.contains(target, ignoreCase = true) } }
    }

    private fun tap(message: JSONObject, answer: (Boolean, String) -> Unit) {
        val target = message.optString("target").takeIf { it.isNotBlank() }
        val id = message.optString("id").takeIf { it.isNotBlank() }
        if (target == null && id == null) {
            if (!message.has("x") || !message.has("y")) return answer(false, "tap needs a target, an id, or x and y")
            return gesture(message.getInt("x").toFloat(), message.getInt("y").toFloat(), answer)
        }
        val node = find(target, id) ?: return answer(false, "no control named ${target ?: id} on screen")
        var clickable: AccessibilityNodeInfo? = node
        while (clickable != null && !clickable.isClickable) clickable = clickable.parent
        if (clickable != null && clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return answer(true, "tapped ${target ?: id}")
        val box = Rect().also { node.getBoundsInScreen(it) }
        gesture(box.exactCenterX(), box.exactCenterY(), answer)
    }

    private fun gesture(x: Float, y: Float, answer: (Boolean, String) -> Unit) {
        val stroke = GestureDescription.StrokeDescription(Path().apply { moveTo(x, y) }, 0, 60)
        val sent = dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) = answer(true, "tapped at ${x.toInt()},${y.toInt()}")
            override fun onCancelled(gestureDescription: GestureDescription?) = answer(false, "the tap at ${x.toInt()},${y.toInt()} was cancelled")
        }, main)
        if (!sent) answer(false, "the phone refused the tap")
    }

    private fun type(message: JSONObject, answer: (Boolean, String) -> Unit) {
        val target = message.optString("target").takeIf { it.isNotBlank() }
        val id = message.optString("id").takeIf { it.isNotBlank() }
        val node = (if (target != null || id != null) find(target, id) else findFocus(AccessibilityNodeInfo.FOCUS_INPUT))
            ?: return answer(false, if (target != null || id != null) "no field named ${target ?: id} on screen" else "no field has focus; tap one first")
        if (!node.isEditable) return answer(false, "${target ?: id ?: "the focused control"} is not a text field")
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, message.optString("text")) }
        answer(node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args), "typed into ${target ?: id ?: "the focused field"}")
    }

    private fun scroll(message: JSONObject, answer: (Boolean, String) -> Unit) {
        val target = message.optString("target").takeIf { it.isNotBlank() }
        val id = message.optString("id").takeIf { it.isNotBlank() }
        var node = if (target != null || id != null) find(target, id) else null
        if (node == null) {
            val queue = ArrayDeque(windows.mapNotNull { it.root?.takeIf { r -> r.packageName != packageName } })
            while (queue.isNotEmpty() && node == null) {
                val n = queue.removeFirst()
                if (n.isScrollable && n.isVisibleToUser) node = n
                for (i in 0 until n.childCount) n.getChild(i)?.let(queue::add)
            }
        } else while (node != null && !node.isScrollable) node = node.parent
        node ?: return answer(false, "nothing on screen scrolls")
        val up = message.optString("text").equals("up", ignoreCase = true)
        val ok = node.performAction(if (up) AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD else AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
        answer(ok, if (ok) "scrolled ${if (up) "up" else "down"}" else "it would not scroll ${if (up) "up" else "down"}")
    }

    private fun open(name: String, answer: (Boolean, String) -> Unit) {
        if (name.isBlank()) return answer(false, "open needs an app's name or package")
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = packageManager.queryIntentActivities(launcher, 0)
        val label = { info: android.content.pm.ResolveInfo -> info.loadLabel(packageManager).toString() }
        val app = apps.firstOrNull { it.activityInfo.packageName == name }
            ?: apps.firstOrNull { label(it).equals(name, ignoreCase = true) }
            ?: apps.firstOrNull { label(it).contains(name, ignoreCase = true) }
            ?: return answer(false, "no app called $name")
        startActivity(Intent(launcher).setClassName(app.activityInfo.packageName, app.activityInfo.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED))
        answer(true, "opened ${label(app)}")
    }

    private fun global(name: String, answer: (Boolean, String) -> Unit) {
        val action = when (name) {
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
            "quick_settings" -> GLOBAL_ACTION_QUICK_SETTINGS
            "power_menu" -> GLOBAL_ACTION_POWER_DIALOG
            "lock" -> GLOBAL_ACTION_LOCK_SCREEN
            "screenshot" -> GLOBAL_ACTION_TAKE_SCREENSHOT
            else -> return answer(false, "unknown global action $name")
        }
        val ok = performGlobalAction(action)
        answer(ok, if (ok) "did $name" else "the phone refused $name")
    }

    // The bar that says June is driving. A tap stops her until Jon next opens June.

    private fun windowManager() = getSystemService(WindowManager::class.java)

    private fun showBar() {
        main.removeCallbacks(hideBar)
        if (bar != null) return
        val view = TextView(this).apply {
            text = "June is driving · tap to stop"
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.argb(230, 106, 76, 168))
            gravity = Gravity.CENTER
            textSize = 13f
            setPadding(0, 18, 0, 18)
            setOnClickListener {
                stoppedUntil = Long.MAX_VALUE
                Log.i(TAG, "hands: stopped by the user")
                hideBar.run()
            }
        }
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = Gravity.TOP }
        runCatching { windowManager().addView(view, params); bar = view }.onFailure { Log.w(TAG, "hands: no bar: $it") }
    }

    companion object {
        private const val LIMIT = 24_000

        /** While now is before this, every action is refused: Jon tapped the bar. Opening June clears it. */
        @Volatile var stoppedUntil = 0L

        fun resume() {
            stoppedUntil = 0L
        }
    }
}
