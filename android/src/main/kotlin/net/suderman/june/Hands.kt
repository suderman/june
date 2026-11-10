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
    // One overlay at the top: the driving bar, and her words under it.
    private var overlay: android.widget.LinearLayout? = null
    private var bar: TextView? = null
    // Her words while she drives: the conversation's view, attached at her first action, and the card that shows them.
    private var attached = false
    private var items: List<Item> = emptyList()
    private val seen = mutableSetOf<String>()
    private var drivingUntil = 0L
    private var said: TextView? = null
    private var saying: String? = null
    private val hideSaid = Runnable { said?.visibility = android.view.View.GONE; saying = null; tidy() }
    private val resumed = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: android.content.Context, intent: Intent) {
            stoppedUntil = 0L
        }
    }
    private val hideBar = Runnable { bar?.visibility = android.view.View.GONE; tidy() }

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.i(TAG, "hands: service connected")
        connected = true
        registerReceiver(resumed, android.content.IntentFilter(RESUME), RECEIVER_NOT_EXPORTED)
        connect()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

    override fun onInterrupt() {}

    override fun onDestroy() {
        connected = false
        runCatching { unregisterReceiver(resumed) }
        main.removeCallbacksAndMessages(null)
        socket?.close(1000, "hands withdrawn")
        socket = null
        hideBar.run()
        hideSaid.run()
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
                            attached = false
                            webSocket.send(JSONObject().put("op", "hands").put("requestId", "hands-${UUID.randomUUID()}").toString())
                            Log.i(TAG, "hands: offered to ${message.optString("device")}")
                        }
                        "act" -> act(message) { ok, said, image -> webSocket.send(JSONObject().put("op", "acted").put("requestId", message.optString("requestId")).put("ok", ok).put("text", said).also { if (image != null) it.put("image", image) }.toString()) }
                        "view" -> view(message)
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

    private fun act(message: JSONObject, answer: (Boolean, String, JSONObject?) -> Unit) {
        val action = message.optString("action")
        if (System.currentTimeMillis() < stoppedUntil) return answer(false, "Jon stopped you from the phone; wait until he asks again", null)
        // June's own sheet covers the apps and the power menu; it closes before she acts, so Jon sees what she does.
        if (action != "screen" && sheetShowing()) {
            sendBroadcast(Intent(DISMISS).setPackage(packageName))
            main.postDelayed({ act(message, answer) }, 400)
            return
        }
        drivingUntil = System.currentTimeMillis() + DRIVING_MS
        if (!attached) socket?.send(JSONObject().put("op", "attach").put("requestId", "hands-${UUID.randomUUID()}").toString())?.also { attached = it }
        Log.i(TAG, "hands: $action ${if (action == "type") "" else message.optString("target").ifBlank { message.optString("text").take(40) }}")
        showBar()
        val done = { ok: Boolean, said: String, image: JSONObject? ->
            main.removeCallbacks(hideBar)
            main.postDelayed(hideBar, 1_500)
            // Never the screen's words in the log: they may be private.
            Log.i(TAG, "hands: ${if (ok) "done" else "failed"}: ${if (action == "screen") "${said.length} characters" else said.take(120)}")
            answer(ok, said, image)
        }
        val settled = { ok: Boolean, said: String ->
            if (!ok) done(false, said, null) else main.postDelayed({ done(true, "$said; in front: ${front()}", null) }, 700)
            Unit
        }
        try {
            when (action) {
                "screen" -> done(true, screen(), null)
                "capture" -> capture(done)
                "tap" -> tap(message, settled)
                "type" -> type(message, settled)
                "scroll" -> scroll(message, settled)
                "open" -> open(message.optString("text"), settled)
                "global" -> global(message.optString("text"), settled)
                else -> done(false, "unknown action $action", null)
            }
        } catch (e: Exception) {
            Log.w(TAG, "hands: $action failed: $e")
            done(false, "$action failed: ${e.message ?: e}", null)
        }
    }

    /**
     * The screen as it is, as a JPEG at most 1568 px on its long side, the size the model sees: once her sheet has gone
     * (act closes it) and with the driving bar hidden, so the picture is the app and not her.
     */
    private fun capture(done: (Boolean, String, JSONObject?) -> Unit) {
        main.removeCallbacks(hideBar)
        hideBar.run()
        main.postDelayed({
            takeScreenshot(android.view.Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
                override fun onSuccess(result: ScreenshotResult) {
                    val shot = android.graphics.Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace)?.copy(android.graphics.Bitmap.Config.ARGB_8888, false)
                    result.hardwareBuffer.close()
                    if (shot == null) return done(false, "the screen could not be read", null)
                    val scale = minOf(1f, 1568f / maxOf(shot.width, shot.height))
                    val sized = if (scale < 1f) android.graphics.Bitmap.createScaledBitmap(shot, (shot.width * scale).toInt(), (shot.height * scale).toInt(), true) else shot
                    val out = java.io.ByteArrayOutputStream()
                    sized.compress(android.graphics.Bitmap.CompressFormat.JPEG, 85, out)
                    val image = JSONObject().put("mimeType", "image/jpeg").put("data", android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP))
                    done(true, "captured the screen; in front: ${front()}", image)
                }

                override fun onFailure(errorCode: Int) = done(false, "the screen could not be captured (error $errorCode)", null)
            })
        }, 300)
    }

    /** Whether June's own sheet is on screen: a window of this app that is not the driving bar. */
    private fun sheetShowing(): Boolean = windows.any { it.type != android.view.accessibility.AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY && it.root?.packageName == packageName }

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

    // Off-screen controls are listed too, marked, so a long page (an email's body) reads without scrolling; only what is
    // on screen has a point to tap.
    private fun describe(node: AccessibilityNodeInfo, depth: Int, out: StringBuilder) {
        val visible = node.isVisibleToUser
        val words = node.text?.toString()?.takeIf { it.isNotBlank() } ?: node.contentDescription?.toString()?.takeIf { it.isNotBlank() }
        val id = node.viewIdResourceName?.substringAfter(":id/")
        val does = listOfNotNull(
            "tap".takeIf { node.isClickable }, "hold".takeIf { node.isLongClickable }, "edit".takeIf { node.isEditable },
            "scroll".takeIf { node.isScrollable }, (if (node.isChecked) "on" else "off").takeIf { node.isCheckable }, "focused".takeIf { node.isFocused },
        )
        val shown = words != null || node.isEditable || (node.isClickable && id != null)
        if (shown) {
            val box = Rect().also { node.getBoundsInScreen(it) }
            out.append("  ".repeat(depth)).append(words?.replace("\n", " ")?.take(if (node.isClickable || node.isEditable) 160 else 4_000) ?: "(${node.className?.toString()?.substringAfterLast('.')})")
            if (id != null) out.append(" [").append(id).append("]")
            if (visible) out.append(" @").append(box.centerX()).append(",").append(box.centerY()) else out.append(" (off screen)")
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
            // The largest scrolling area on screen: the content being read, not a strip of tabs or a side list.
            var area = 0
            val queue = ArrayDeque(windows.mapNotNull { it.root?.takeIf { r -> r.packageName != packageName } })
            while (queue.isNotEmpty()) {
                val n = queue.removeFirst()
                if (n.isScrollable && n.isVisibleToUser) {
                    val box = Rect().also { n.getBoundsInScreen(it) }
                    if (box.width() * box.height() > area) {
                        area = box.width() * box.height()
                        node = n
                    }
                }
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

    // Her words while she drives. The sheet is closed so Jon can watch, so what she says (her replies and patter) shows
    // in a small card at the top as it streams, and goes a few seconds after she finishes; a tap closes it sooner.

    private fun view(message: JSONObject) {
        if (message.optBoolean("reset")) {
            items = parseItems(message.getJSONArray("items"))
            // What she said before this drive is not news.
            seen.addAll(items.map { it.id })
            return
        }
        items = applyChanges(items, message.optJSONArray("changes") ?: org.json.JSONArray())
        if (System.currentTimeMillis() > drivingUntil) {
            seen.addAll(items.map { it.id })
            return
        }
        val words = items.lastOrNull { (it.kind == "assistant" || it.kind == "patter") && !it.private && it.text.isNotBlank() } ?: return
        if (words.id in seen && words.id != saying) return
        if (!words.streaming || words.kind == "patter") seen.add(words.id)
        say(words)
    }

    private fun say(words: Item) {
        main.removeCallbacks(hideSaid)
        ensureOverlay()
        val text = words.text.replace(Regex("[*_`#]+"), "").trim().let { if (it.length > 400) "…" + it.takeLast(400) else it }
        val card = said ?: return
        card.visibility = android.view.View.VISIBLE
        card.text = if (words.kind == "patter") text else "June: $text"
        card.setTypeface(null, if (words.kind == "patter") android.graphics.Typeface.ITALIC else android.graphics.Typeface.NORMAL)
        saying = words.id
        if (!words.streaming) main.postDelayed(hideSaid, (4_000L + text.length * 45L).coerceAtMost(15_000L))
    }

    // The bar that says June is driving. A tap stops her until Jon next opens June.

    private fun windowManager() = getSystemService(WindowManager::class.java)

    private fun showBar() {
        main.removeCallbacks(hideBar)
        ensureOverlay()
        bar?.visibility = android.view.View.VISIBLE
    }

    /** The desktop client column, made on first need: the bar (a tap stops her) and the card of her words (a tap closes it). */
    private fun ensureOverlay() {
        if (overlay != null) return
        val column = android.widget.LinearLayout(this).apply { orientation = android.widget.LinearLayout.VERTICAL }
        val barView = TextView(this).apply {
            text = "June is driving · tap to stop"
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.argb(230, 106, 76, 168))
            gravity = Gravity.CENTER
            textSize = 13f
            setPadding(0, 18, 0, 18)
            visibility = android.view.View.GONE
            setOnClickListener {
                stoppedUntil = Long.MAX_VALUE
                Log.i(TAG, "hands: stopped by the user")
                hideBar.run()
            }
        }
        val card = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 15f
            setPadding(36, 24, 36, 24)
            background = android.graphics.drawable.GradientDrawable().apply { setColor(Color.argb(240, 33, 30, 46)); cornerRadius = 36f; setStroke(3, Color.argb(255, 106, 76, 168)) }
            maxLines = 8
            visibility = android.view.View.GONE
            setOnClickListener { hideSaid.run() }
        }
        column.addView(barView, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.WRAP_CONTENT))
        column.addView(card, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(28, 14, 28, 0) })
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = Gravity.TOP }
        runCatching { windowManager().addView(column, params); overlay = column; bar = barView; said = card }
            .onFailure { Log.w(TAG, "hands: no overlay: $it") }
    }

    /** Remove the desktop client once neither the bar nor her words show, so it never sits over the screen empty. */
    private fun tidy() {
        if (bar?.visibility == android.view.View.VISIBLE || said?.visibility == android.view.View.VISIBLE) return
        overlay?.let { runCatching { windowManager().removeView(it) } }
        overlay = null
        bar = null
        said = null
    }

    companion object {
        private const val LIMIT = 24_000
        /** How long after her last action her words still show in the card: long enough for her reply. */
        private const val DRIVING_MS = 120_000L

        /** Broadcasts within the app, across the hands' process: June's sheet closes; her hands may act again. */
        const val DISMISS = "net.suderman.june.DISMISS"
        const val RESUME = "net.suderman.june.RESUME"

        /** While now is before this, every action is refused: Jon tapped the bar. Opening June clears it. */
        @Volatile var stoppedUntil = 0L

        fun resume(context: android.content.Context) = context.sendBroadcast(Intent(RESUME).setPackage(context.packageName))
    }
}
