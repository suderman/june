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
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** A past day on show, fixed: its date, its folded items, and the id of the item for a moment opened, or "". */
data class PastDay(val date: String, val items: List<Item>, val at: String)

/** A search hit: the entry it is in, when, the day that belongs to, who said it ("user" or "june"), and a line around it. */
data class SearchHit(val id: Long, val at: Long, val date: String, val kind: String, val text: String)

/** A moment link, june:at/ID in June's words or june://at/ID from another app, as its entry id; null for anything else. */
fun momentOf(url: String): Long? = Regex("^june:(?://)?at/([1-9]\\d{0,15})$").find(url)?.groupValues?.get(1)?.toLongOrNull()

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

    // Browsing June's history (see "Browse June's history by day" in docs/interfaces.org): the days with conversation and
    // the day it is now, from the daemon; the past day on show, or null for today, live; and the latest search's hits.
    var days: List<Pair<String, Int>> by mutableStateOf(emptyList())
        private set
    var today: String by mutableStateOf("")
        private set
    var past: PastDay? by mutableStateOf(null)
        private set
    var hits: List<SearchHit> by mutableStateOf(emptyList())
        private set
    var hitsMore: Boolean by mutableStateOf(false)
        private set
    var searchDone: Boolean by mutableStateOf(true)
        private set
    /** Bumped each time a day opens or today returns, so the strip lands once on its newest panel or the moment. */
    var landing: Int by mutableStateOf(0)
        private set
    private var searchId = ""
    /** A moment asked for before the link was up, such as june://at/ID from another app, opened once it is. */
    private var pendingMoment: Long? = null

    // The agenda and agents boards (src/board.ts), as the daemon sends them; fetched once a board shows, again whenever
    // a revision in the view state moves, and after a reconnect (see "Agents and projects" in docs/interfaces.org).
    var agenda: JSONObject? by mutableStateOf(null)
        private set
    var agents: JSONObject? by mutableStateOf(null)
        private set
    private var boardsWanted = false
    private var agendaRevision = ""
    private var agentsRevision = ""

    /** What the last edit from a task's page said, for that task: "saved", or why it was refused. */
    var taskNotice: Pair<String, String> by mutableStateOf("" to "")
        private set
    /** The edit that puts back the last saved state change, while "saved" shows. */
    var taskUndo: JSONObject? by mutableStateOf(null)
        private set
    private var noticeAt = 0L
    /** A rename that moved a task without an ID to a new key: (old key, new key), so its page follows. */
    var taskMoved: Pair<String, String> by mutableStateOf("" to "")
        private set

    /**
     * Each task's outbox, as shell.qml pendingEdits: { key: { applied, change, queue, id, done, at, undo } } and seen,
     * the reviews opened since the last agents board. board.mjs draws it all as made. One edit goes at a time and taps
     * meanwhile queue behind it, the same kind settling on the last (board.mjs enqueue); a refusal, a dropped link or
     * no answer drops the chain and the board's state shows again; a saved edit stops overlaying once the boards that
     * carry it arrive.
     */
    var pending: JSONObject by mutableStateOf(JSONObject())
        private set
    private var agentsFetching = false

    private fun changePending(change: (JSONObject) -> Unit) {
        val next = JSONObject(pending.toString())
        change(next)
        pending = next
        if (next.length() > 0 && !ticking) {
            ticking = true
            main.postDelayed(::tick, 1_000)
        }
    }
    private var ticking = false
    private fun tick() {
        tickPending()
        if (pending.length() > 0 || taskNotice.second == "saved") main.postDelayed(::tick, 1_000) else ticking = false
    }

    private fun pendingById(id: String): String =
        pending.keys().asSequence().firstOrNull { it != "seen" && pending.optJSONObject(it)?.optString("id") == id } ?: ""

    private fun editKeys() = pending.keys().asSequence().filter { it != "seen" }.toList()

    private fun notice(key: String, text: String, undo: JSONObject? = null) {
        taskNotice = key to text
        taskUndo = undo
        noticeAt = System.currentTimeMillis()
        // "saved" fades on the same tick.
        if (text == "saved" && !ticking) {
            ticking = true
            main.postDelayed(::tick, 1_000)
        }
    }

    /** The user's edit of a task (src/board-edit.ts TaskEdit), by its key; UNDO is the edit that would put it back. */
    fun editTask(key: String, edit: JSONObject, undo: JSONObject? = null) {
        val held = pending.optJSONObject(key)
        if (held != null && !held.optBoolean("done")) {
            changePending { it.put(key, JSONObject(held.toString()).put("queue", enqueue(held.optJSONArray("queue"), edit))) }
            return
        }
        // A saved edit the board has yet to show stays drawn under the new one.
        val applied = JSONArray(held?.optJSONArray("applied")?.toString() ?: "[]")
        held?.optJSONObject("change")?.let { applied.put(it) }
        sendEdit(key, edit, applied, JSONArray(), undo)
    }

    private fun sendEdit(key: String, edit: JSONObject, applied: JSONArray, queue: JSONArray, undo: JSONObject?) {
        val id = requestId()
        if (!send(JSONObject().put("op", "task").put("key", key).put("edit", edit), id)) {
            changePending { it.remove(key) }
            return notice(key, "not connected")
        }
        changePending { it.put(key, JSONObject().put("applied", applied).put("change", edit).put("queue", queue).put("id", id).put("done", false).put("at", System.currentTimeMillis()).put("undo", undo ?: JSONObject.NULL)) }
        notice(key, "")
    }

    /** board.mjs enqueue: the same kind of change replaces the last queued one; replies all go. */
    private fun enqueue(queue: JSONArray?, edit: JSONObject): JSONArray {
        val q = JSONArray(queue?.toString() ?: "[]")
        val last = if (q.length() > 0) q.optJSONObject(q.length() - 1) else null
        if (last != null && last.optString("action") == edit.optString("action") && edit.optString("action") != "reply") q.put(q.length() - 1, edit) else q.put(edit)
        return q
    }

    /** board.mjs nextQueued: the queue after CHANGE lands, without state changes to where the task already is. */
    private fun nextQueued(change: JSONObject?, queue: JSONArray?): List<JSONObject> {
        var state: String? = if (change?.optString("action") == "state") change.optString("state") else null
        val rest = mutableListOf<JSONObject>()
        for (i in 0 until (queue?.length() ?: 0)) {
            val c = queue!!.optJSONObject(i) ?: continue
            if (c.optString("action") == "state" && c.optString("state") == state && rest.isEmpty()) continue
            rest.add(c)
            if (c.optString("action") == "state") state = c.optString("state")
        }
        return rest
    }

    /** Once a second while edits are on their way: give up on one unanswered for 30 s, settle a save after 6 s, and
     * let "saved" fade after 5. */
    private fun tickPending(now: Long = System.currentTimeMillis()) {
        val lost = editKeys().filter { pending.optJSONObject(it)?.let { e -> !e.optBoolean("done") && now - e.optLong("at") > 30_000 } == true }
        val settled = editKeys().filter { pending.optJSONObject(it)?.let { e -> e.optBoolean("done") && now - e.optLong("at") > 6_000 } == true }
        if (lost.isNotEmpty()) notice(lost.first(), "June didn't answer; this is what the board says")
        if (lost.isNotEmpty() || settled.isNotEmpty()) changePending { p -> (lost + settled).forEach { p.remove(it) } }
        if (taskNotice.second == "saved" && now - noticeAt > 5_000) notice(taskNotice.first, "")
    }

    private fun settlePending() {
        if (agentsFetching || editKeys().isEmpty()) return
        changePending { p ->
            for (k in editKeys()) {
                val e = pending.optJSONObject(k) ?: continue
                if (e.optBoolean("done")) p.remove(k) else p.put(k, JSONObject(e.toString()).put("applied", JSONArray()))
            }
        }
    }

    /** A review or question the user opened is seen on every device at once; the daemon answers with the agents board. */
    fun markSeen(key: String) {
        changePending { it.put("seen", (it.optJSONArray("seen") ?: org.json.JSONArray()).put(key)) }
        send(JSONObject().put("op", "seen").put("keys", org.json.JSONArray().put(key)))
    }

    fun wantBoards() {
        if (boardsWanted) return
        boardsWanted = true
        fetchBoards(agenda = true, agents = true)
    }

    private fun fetchBoards(agenda: Boolean, agents: Boolean) {
        if (agenda) send(JSONObject().put("op", "agenda"))
        if (agents && send(JSONObject().put("op", "agents"))) agentsFetching = true
    }

    /** The state's board revisions: ask for a board whose revision moved, once per revision. */
    private fun boardsMoved(state: JSONObject?) {
        val revisions = state?.optJSONObject("boards") ?: return
        if (!boardsWanted) return
        val a = revisions.optString("agenda")
        val g = revisions.optString("agents")
        val moveAgenda = a.isNotEmpty() && a != agendaRevision
        val moveAgents = g.isNotEmpty() && g != agentsRevision
        if (moveAgenda) agendaRevision = a
        if (moveAgents) agentsRevision = g
        fetchBoards(moveAgenda, moveAgents)
    }

    /** What the strip shows: the past day's items, or today's. */
    val shownItems: List<Item> get() = past?.items ?: items
    /** A past day is fixed: nothing runs in it. */
    val shownState: ViewState get() = if (past != null) ViewState() else state

    fun listDays() = send(JSONObject().put("op", "days"))

    fun openDay(date: String) {
        if (date == today) backToToday() else send(JSONObject().put("op", "day").put("date", date))
    }

    fun openMoment(id: Long) {
        if (!send(JSONObject().put("op", "day").put("at", id))) pendingMoment = id
    }

    fun backToToday() {
        if (past == null) return
        past = null
        landing++
    }

    fun search(words: String) {
        searchId = requestId()
        hits = emptyList()
        hitsMore = false
        searchDone = words.isBlank()
        if (!searchDone) send(JSONObject().put("op", "search").put("query", words).put("limit", 50), searchId)
    }

    private fun send(request: JSONObject, id: String = requestId()): Boolean {
        val ws = socket ?: return false
        if (status !is LinkStatus.Linked) return false
        return ws.send(request.put("requestId", id).toString())
    }

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
        if (!ws.send(request.toString())) return false
        // Sent from a past day, the message joins today's conversation, so the strip follows it there.
        backToToday()
        return true
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
                            // As the app's own view, so a reply shown here is not also pushed to this phone (src/ntfy.ts).
                            webSocket.send(JSONObject().put("op", "attach").put("requestId", requestId()).put("client", "apk").toString())
                            pendingMoment?.let { pendingMoment = null; openMoment(it) }
                            // A new connection must ask again to keep the boards fresh; an edit sent on the old one may never be answered.
                            val unanswered = editKeys().filter { pending.optJSONObject(it)?.optBoolean("done") == false }
                            if (unanswered.isNotEmpty()) {
                                notice(unanswered.first(), "The connection dropped; this is what the board says")
                                changePending { p -> unanswered.forEach { p.remove(it) } }
                            }
                            agentsFetching = false
                            if (boardsWanted) fetchBoards(agenda = true, agents = true)
                        }
                        "view" -> {
                            items = if (reply.optBoolean("reset")) parseItems(reply.getJSONArray("items")) else applyChanges(items, reply.optJSONArray("changes") ?: org.json.JSONArray())
                            reply.optJSONObject("state")?.let { state = ViewState.from(it); boardsMoved(it) }
                            // A fresh view, on attach or at the day's start: the days may have moved on.
                            if (reply.optBoolean("reset")) listDays()
                        }
                        "days" -> {
                            val list = reply.optJSONArray("days") ?: org.json.JSONArray()
                            days = (0 until list.length()).map { list.getJSONObject(it).let { d -> d.optString("date") to d.optInt("count") } }
                            today = reply.optString("today")
                        }
                        "day" -> if (reply.optBoolean("today") && !reply.has("at")) backToToday() else {
                            past = PastDay(reply.optString("date"), parseItems(reply.optJSONArray("items") ?: org.json.JSONArray()), reply.optString("at"))
                            landing++
                        }
                        "search" -> if (reply.optString("requestId") == searchId) {
                            val list = reply.optJSONArray("hits") ?: org.json.JSONArray()
                            hits = (0 until list.length()).map { list.getJSONObject(it).let { h -> SearchHit(h.optLong("id"), h.optLong("at"), h.optString("date"), h.optString("kind"), h.optString("text")) } }
                            hitsMore = reply.optBoolean("more")
                            searchDone = true
                        }
                        "task" -> pendingById(reply.optString("requestId")).takeIf { it.isNotEmpty() }?.let { key ->
                            val held = pending.optJSONObject(key)!!
                            val now = reply.optString("key")
                            reply.optString("from").takeIf { it.isNotEmpty() }?.let { taskMoved = it to now }
                            val rest = nextQueued(held.optJSONObject("change"), held.optJSONArray("queue"))
                            changePending { it.remove(key) }
                            // What was tapped meanwhile goes next, against what this one wrote.
                            if (rest.isNotEmpty()) {
                                val applied = JSONArray(held.optJSONArray("applied")?.toString() ?: "[]").put(held.optJSONObject("change"))
                                sendEdit(now, rest.first(), applied, JSONArray(rest.drop(1)), held.optJSONObject("undo"))
                            } else {
                                changePending { p -> p.put(now, JSONObject(held.toString()).put("queue", JSONArray()).put("done", true).put("at", System.currentTimeMillis())) }
                                notice(now, "saved", held.optJSONObject("undo"))
                            }
                        }
                        "agenda" -> {
                            agenda = reply.optJSONObject("agenda")
                            agendaRevision = reply.optString("revision")
                            settlePending()
                        }
                        "agents" -> {
                            agents = reply.optJSONObject("agents")
                            agentsRevision = reply.optString("revision")
                            agentsFetching = false
                            if (pending.has("seen")) changePending { it.remove("seen") }
                            settlePending()
                        }
                        "reply" -> notice = reply.optString("text")
                        "error" -> pendingById(reply.optString("requestId")).let { key ->
                            if (reply.optString("requestId").isNotEmpty() && key.isNotEmpty()) {
                                changePending { it.remove(key) }
                                notice(key, reply.optString("message"))
                            } else notice = reply.optString("message")
                        }
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
