package net.suderman.june

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject

/**
 * The agents and projects boards in the full-screen app, as the desktop's window draws them: the daemon's boards
 * (Link.agenda, Link.agents) shaped by the decisions the phone shares with the desktop (board.mjs agentsView and
 * agendaView), each row opening where it can. See "Agents and projects" in docs/interfaces.org.
 */

/**
 * The bar of icons along the bottom, as Muse has it: Herdr's terminal, the agents, the chat (the strip), the projects
 * and Emacs, left to right. The three middle ones are the pager's pages, in the same order; the outer two open the
 * apps where the work is watched and edited. Agents counts what needs the user.
 */
private enum class Tab(val label: String, val page: Int?, val slot: Swipes.AppSlot?) {
    Terminal("terminal", null, Swipes.AppSlot.Terminal),
    Agents("agents", 0, null),
    Chat("chat", 1, null),
    Projects("projects", 2, null),
    Editor("editor", null, Swipes.AppSlot.Editor),
}

/** Height of the bottom tab bar, shared with Sheet so content rests above it until the keyboard rises past it. */
val TabsHeight = 58.dp

@Composable
fun Tabs(page: Int, needs: Int, palette: Look.Palette, onPage: (Int) -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    Row(Modifier.fillMaxWidth().height(TabsHeight).padding(top = 2.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        for (tab in Tab.entries) {
            val on = tab.page == page
            Box(
                Modifier.weight(1f).height(52.dp)
                    .clickable(
                        interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() },
                        indication = androidx.compose.material3.ripple(bounded = false, radius = 26.dp),
                    ) {
                        tab.page?.let(onPage)
                        tab.slot?.let { slot -> Swipes.openSlot(context, slot)?.let { android.widget.Toast.makeText(context, it, android.widget.Toast.LENGTH_LONG).show() } }
                    }
                    .semantics {
                        contentDescription = tab.label
                        role = if (tab.page != null) Role.Tab else Role.Button
                        if (tab.page != null) selected = on
                    },
                contentAlignment = Alignment.Center,
            ) {
                val ink = if (on) palette.pageInk else palette.muted
                Canvas(Modifier.size(26.dp)) { scale(size.width / 24f, pivot = Offset.Zero) { tabIcon(tab, on, ink, palette.page) } }
                if (tab == Tab.Agents && needs > 0) Text(
                    "$needs", fontSize = 10.sp, fontWeight = FontWeight.Bold, color = palette.page,
                    modifier = Modifier.padding(start = 26.dp, bottom = 22.dp)
                        .background(palette.accent, androidx.compose.foundation.shape.CircleShape).padding(horizontal = 5.dp),
                )
            }
        }
    }
}

/** One tab's icon on a 24-unit grid: outlined, or filled where it is the page showing. */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.tabIcon(tab: Tab, on: Boolean, ink: Color, page: Color) {
    val line = Stroke(1.8f, cap = StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round)
    fun box(l: Float, t: Float, r: Float, b: Float, radius: Float, color: Color, fill: Boolean) =
        drawRoundRect(color, Offset(l, t), Size(r - l, b - t), androidx.compose.ui.geometry.CornerRadius(radius), style = if (fill) androidx.compose.ui.graphics.drawscope.Fill else line)
    fun stroke(color: Color, vararg xy: Float) = drawPath(Path().apply { moveTo(xy[0], xy[1]); for (i in 2 until xy.size step 2) lineTo(xy[i], xy[i + 1]) }, color, style = line)
    when (tab) {
        // A command prompt: a window with a chevron and a cursor.
        Tab.Terminal -> {
            box(2.5f, 4.5f, 21.5f, 19.5f, 2.5f, ink, false)
            stroke(ink, 6.5f, 9f, 9.5f, 12f, 6.5f, 15f)
            stroke(ink, 11.5f, 15f, 16.5f, 15f)
        }
        // A robot's head: antenna, ears, two eyes and a mouth.
        Tab.Agents -> {
            stroke(ink, 12f, 6f, 12f, 4f)
            drawCircle(ink, 1.3f, Offset(12f, 2.9f))
            stroke(ink, 2.4f, 10.5f, 2.4f, 14.5f)
            stroke(ink, 21.6f, 10.5f, 21.6f, 14.5f)
            box(4.5f, 6f, 19.5f, 19.5f, 3.5f, ink, on)
            val face = if (on) page else ink
            drawCircle(face, 1.5f, Offset(9f, 11.6f))
            drawCircle(face, 1.5f, Offset(15f, 11.6f))
            stroke(face, 9.5f, 15.6f, 14.5f, 15.6f)
        }
        // Muse's speech bubble: an oval with its tail at the lower left.
        Tab.Chat -> {
            val bubble = Path().apply {
                op(
                    Path().apply { addOval(androidx.compose.ui.geometry.Rect(3f, 3.5f, 21f, 17.5f)) },
                    Path().apply { moveTo(6.5f, 14.5f); lineTo(4f, 20.5f); lineTo(11f, 17f); close() },
                    androidx.compose.ui.graphics.PathOperation.Union,
                )
            }
            if (on) drawPath(bubble, ink) else drawPath(bubble, ink, style = line)
        }
        // Muse's checkbox: a rounded square with a tick.
        Tab.Projects -> {
            box(4f, 4f, 20f, 20f, 4f, ink, on)
            stroke(if (on) page else ink, 8f, 12.3f, 10.9f, 15.2f, 16.2f, 9.2f)
        }
        // A pen over a square sheet of paper, matching the boxy weight of the other four icons.
        Tab.Editor -> {
            box(3.5f, 4.5f, 19f, 20f, 3.5f, ink, false)
            stroke(ink, 6.8f, 8.8f, 11.2f, 8.8f)
            stroke(ink, 6.8f, 12.4f, 9.5f, 12.4f)
            stroke(ink, 6.8f, 16f, 15.7f, 16f)
            val pen = Path().apply {
                moveTo(19.14f, 4.04f); lineTo(21.26f, 6.16f)
                lineTo(15.46f, 11.96f); lineTo(12.3f, 13f); lineTo(13.34f, 9.84f); close()
            }
            drawPath(pen, page)
            drawPath(pen, page, style = Stroke(3.6f, cap = StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round))
            drawPath(pen, ink, style = line)
            stroke(ink, 17.94f, 5.24f, 20.06f, 7.36f)
        }
    }
}

/** The chip and clanker colours, read once from board.mjs. */
private class Colours(json: JSONObject) {
    private val chips = json.optJSONObject("chips") ?: JSONObject()
    private val harness = json.optJSONObject("harness") ?: JSONObject()
    val harnesses: List<String> = json.optJSONArray("harnesses")?.let { a -> (0 until a.length()).map { a.optString(it) } }?.ifEmpty { null }
        ?: listOf("claude", "codex", "pi", "opencode", "agy")
    val efforts: List<String> = json.optJSONArray("efforts")?.let { a -> (0 until a.length()).map { a.optString(it) } }?.ifEmpty { null }
        ?: listOf("", "low", "medium", "high", "xhigh", "max")
    fun chip(state: String): Pair<Color, Color>? = chips.optJSONObject(state)?.let { Look.color(it.optString("fill")) to Look.color(it.optString("ink")) }
    fun clanker(name: String): Pair<Color, Color> = (harness.optJSONObject(name) ?: harness.optJSONObject("other"))
        ?.let { Look.color(it.optString("eye")) to Look.color(it.optString("band")) } ?: (Color(0xFFE0B419) to Color(0xFFB8911A))
}

@Composable
private fun rememberColours(decisions: Decisions): Colours? {
    val colours by produceState<Colours?>(null, decisions) { value = runCatching { Colours(JSONObject(decisions.call("board.colours"))) }.getOrNull() }
    return colours
}

/** Epoch ms now, moving each minute, so "3 min ago" keeps up. */
@Composable
private fun minute(): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(60_000); now = System.currentTimeMillis() } }
    return now
}

private fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).map { getJSONObject(it) }

/** A task by key from either board, for its page. */
private fun Link.task(key: String): JSONObject? =
    agents?.optJSONObject("tasks")?.optJSONObject(key) ?: agenda?.optJSONObject("tasks")?.optJSONObject(key) ?: movedTask(key)

/** The same heading under a new key, as board.mjs findTask: the dispatcher gives a task an ID when it claims it. */
private fun Link.movedTask(key: String): JSONObject? {
    val tasks = agenda?.optJSONObject("tasks") ?: return null
    for (k in tasks.keys()) {
        val t = tasks.optJSONObject(k) ?: continue
        val path = t.optJSONArray("path").let { a -> (0 until (a?.length() ?: 0)).map { a!!.optString(it) } } + t.optString("title")
        if ("${t.optString("file")}::*${path.joinToString("/")}" == key) return t
    }
    return null
}

/** One task's page (board.mjs taskDetail), in place of the board until its back link. */
@Composable
private fun TaskPage(link: Link, decisions: Decisions, colours: Colours, palette: Look.Palette, key: String, back: String, close: () -> Unit, modifier: Modifier) {
    val detail by produceState<JSONObject?>(null, key, link.agents, link.agenda, link.pending) {
        val task = link.task(key)
        val held = task?.let { link.pending.optJSONObject(it.optString("key")) } ?: link.pending.optJSONObject(key)
        value = if (task == null) null else runCatching {
            JSONObject(decisions.call("board.taskDetail", task, link.agents?.optString("user") ?: "", link.agenda?.optString("today") ?: "", System.currentTimeMillis(), held))
        }.getOrNull()
    }
    val open = LocalUriHandler.current
    val d = detail
    // Who a task can be handed to, and where by default; a handoff waits here for the user to confirm it.
    val dispatch = link.agents?.optJSONObject("dispatch")
    var handoff by remember(key) { mutableStateOf<Handoff?>(null) }
    // Which date is being picked: schedule, deadline, handoff, or "".
    var picking by remember(key) { mutableStateOf("") }
    // An edit on its way: the page shows it as made; taps meanwhile queue behind it (Link.editTask).
    val busy = d?.optBoolean("busy") == true
    if (picking.isNotEmpty() && d != null) {
        val field = if (picking == "deadline") "deadline" else "scheduled"
        WhenDialogs(
            title = when (picking) { "deadline" -> "Deadline"; "handoff" -> "Start at"; else -> if (d.optBoolean("repeats")) "Scheduled, keeping its repeat" else "Scheduled" },
            start = d.optJSONObject(field) ?: JSONObject(),
            canClear = picking != "handoff" && d.optBoolean(if (picking == "deadline") "hasDeadline" else "hasScheduled"),
            onPicked = { when_ ->
                val k = d.optString("key").ifEmpty { key }
                if (picking == "handoff") handoff = handoff?.copy(start = when_)
                else link.editTask(k, JSONObject().put("action", picking).put("when", when_))
                picking = ""
            },
            onClear = { link.editTask(d.optString("key").ifEmpty { key }, JSONObject().put("action", picking).put("when", "none")); picking = "" },
            onDismiss = { picking = "" },
        )
    }
    run {
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Text("‹ $back", fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 14.sp, color = palette.pageInk, modifier = Modifier.clickable(onClick = close).padding(vertical = 8.dp)) }
        if (d == null && link.task(key) == null) item { Text("That task is no longer on the boards.", fontFamily = Look.lettering, fontSize = 14.sp, color = palette.muted) }
        if (d != null) {
            // Edits go to the task's key now, which the dispatcher may have changed since the page opened.
            val k = d.optString("key").ifEmpty { key }
            // A file another program rebuilds (org.protected): only TODO or DONE, which the mirror may sync back.
            val locked = d.optBoolean("protected")
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (d.optString("state").isNotEmpty()) StateChip(d.optString("state"), colours, big = true)
                    if (d.optBoolean("asked")) Text("asks you", fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 13.sp, color = palette.accent)
                }
            }
            item { Text(d.optString("title"), fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 19.sp, color = palette.pageInk) }
            val facts = listOf(d.optString("project"), d.optString("path"), d.optString("facts")).filter { it.isNotEmpty() }.joinToString(" · ")
            if (facts.isNotEmpty()) item { Text(facts, fontFamily = Look.caption, fontSize = 13.sp, color = palette.muted) }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for ((label, target) in listOf("Emacs" to d.optString("emacs"), "Herdr" to d.optString("herdr"))) if (target.isNotEmpty() && target != "null") Text(
                        label, fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 14.sp, color = palette.pageInk,
                        modifier = Modifier.border(2.dp, palette.pageInk, RoundedCornerShape(50)).clickable { open.openUri(target) }.padding(horizontal = 16.dp, vertical = 9.dp),
                    )
                }
            }
            val headline = d.optString("headline")
            if (headline.isNotEmpty()) item {
                Text(headline, fontFamily = Look.lettering, fontSize = 14.sp, color = Look.ink,
                    modifier = Modifier.fillMaxWidth().background(Look.balloon, RoundedCornerShape(12.dp)).border(2.dp, Look.ink, RoundedCornerShape(12.dp)).padding(horizontal = 10.dp, vertical = 7.dp))
            }
            val state = d.optString("state")
            val next = d.optJSONArray("next")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
            val assignable = !locked && "AUTO" in next
            val editable = !locked && state.isNotEmpty()
            if (state.isNotEmpty()) {
                item { SectionTitle("STATE", palette) }
                item {
                    @OptIn(ExperimentalLayoutApi::class)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        // A state change shows at once and can be put back while "saved" shows.
                        // The state, then where it flows (board.mjs FLOW); AUTO is the hand-to row below.
                        for (s in listOf(state) + next.filter { it != "AUTO" }) Choice(s, s == state, palette) {
                            if (s != state) link.editTask(k, JSONObject().put("action", "state").put("state", s), if (state == "AUTO") null else JSONObject().put("action", "state").put("state", state).put("undo", true))
                        }
                    }
                }
                if (locked) item { Text("${d.optString("file")} is rebuilt by another program, so only TODO and DONE are set here; DONE may sync back.", fontFamily = Look.caption, fontSize = 13.sp, color = palette.muted) }
                val agents = dispatch?.optJSONArray("agents")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: listOf("pi", "claude")
                val hosts = dispatch?.optJSONArray("hosts")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
                val held = handoff
                if (assignable && held == null) item {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("hand to", fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 13.sp, color = palette.muted)
                        for (agent in agents) Choice(agent, false, palette) { handoff = Handoff(agent, d.optString("host").ifEmpty { dispatch?.optString("host") ?: "" }, "") }
                    }
                }
                // Nothing is queued until the user confirms who, where and when.
                if (assignable && held != null) item {
                    val starts = d.optString("starts")
                    Column(
                        Modifier.fillMaxWidth().background(Look.balloon, RoundedCornerShape(12.dp)).border(2.dp, palette.pageInk, RoundedCornerShape(12.dp)).padding(10.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        val start = if (held.start.isNotEmpty()) held.start.replace("T", " ") else if (starts == "now") "now" else "at its schedule, $starts"
                        Text("Hand to ${held.agent}, starting $start.", fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 13.sp, color = palette.pageInk)
                        if (hosts.size > 1) Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("on", fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 13.sp, color = palette.muted)
                            for (h in hosts) Choice(h, h == held.host, palette) { handoff = held.copy(host = h) }
                        }
                        Choice(if (held.start.isNotEmpty()) "change the start" else "start later…", false, palette) { picking = "handoff" }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Choice(if (held.start.isEmpty() && starts == "now") "Hand off now" else "Hand off", true, palette) {
                                val change = JSONObject().put("action", "assign").put("agent", held.agent)
                                if (held.host.isNotEmpty()) change.put("host", held.host)
                                if (held.start.isNotEmpty()) change.put("when", held.start)
                                handoff = null
                                link.editTask(k, change)
                            }
                            Choice("Cancel", false, palette) { handoff = null }
                        }
                    }
                }
                // SCHEDULED and DEADLINE, each picked on a calendar and a clock.
                if (editable && held == null) item {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Choice(if (d.optBoolean("hasScheduled")) "scheduled ${d.optString("scheduledLabel")}" else "schedule…", false, palette) { picking = "schedule" }
                        Choice(if (d.optBoolean("hasDeadline")) "due ${d.optString("deadlineLabel")}" else "deadline…", false, palette) { picking = "deadline" }
                    }
                }
            }
            if (!locked && state in listOf("", "TODO", "EVAL", "HOLD")) item {
                var title by remember(key) { mutableStateOf("") }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(title, { title = it }, Modifier.weight(1f), singleLine = true, placeholder = { Text("new title", fontSize = 13.sp) })
                    Choice("rename", false, palette) { if (title.isNotBlank()) { link.editTask(k, JSONObject().put("action", "title").put("title", title.trim())); title = "" } }
                }
            }
            val (noticeKey, noticeText) = link.taskNotice
            if (busy || ((noticeKey == key || noticeKey == k) && noticeText.isNotEmpty())) item {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    val text = if (busy) "saving…" else noticeText
                    Text(text, Modifier.weight(1f, fill = false), fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 13.sp, color = if (busy || text == "saved") palette.muted else palette.accent)
                    val undo = link.taskUndo
                    if (!busy && text == "saved" && undo != null) Text("undo", fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 13.sp, color = palette.pageInk,
                        textDecoration = androidx.compose.ui.text.style.TextDecoration.Underline, modifier = Modifier.clickable { link.editTask(k, undo) }.padding(8.dp))
                }
            }
            item { SectionTitle("DIALOG", palette) }
            val dialog = d.optJSONArray("dialog").objects()
            if (dialog.isEmpty()) item { Text("No Dialog yet.", fontFamily = Look.lettering, fontSize = 14.sp, color = palette.muted) }
            for (e in dialog) item(key = "dialog|" + e.optString("key")) { DialogEntry(e, d.optString("harness"), colours, palette) }
            // A reply in the user's name; with resume, the task goes back to its clanker with it.
            if (editable) item {
                var reply by remember(key) { mutableStateOf("") }
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(reply, { reply = it }, Modifier.fillMaxWidth(), minLines = 2, placeholder = { Text("Reply in Dialog", fontSize = 14.sp) })
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Choice("Reply", false, palette) { if (reply.isNotBlank()) { link.editTask(k, JSONObject().put("action", "reply").put("text", reply)); reply = "" } }
                        if (assignable) Choice("Reply and resume", true, palette) { if (reply.isNotBlank()) { link.editTask(k, JSONObject().put("action", "reply").put("text", reply).put("resume", true)); reply = "" } }
                    }
                }
            }
        }
        item { Spacer(Modifier.height(16.dp)) }
    }
    }
}

/** A handoff the user has yet to confirm: who, where, and when it starts ("" for now or its schedule). */
private data class Handoff(val agent: String, val host: String, val start: String)

/** A date, then a time (or none), for a task's SCHEDULED, DEADLINE or a handoff's start: "YYYY-MM-DD" or
 * "YYYY-MM-DD HH:MM", which org-edit reads. START is board.mjs pickerStart's { date, time }. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WhenDialogs(title: String, start: JSONObject, canClear: Boolean, onPicked: (String) -> Unit, onClear: () -> Unit, onDismiss: () -> Unit) {
    val first = runCatching { java.time.LocalDate.parse(start.optString("date")) }.getOrElse { java.time.LocalDate.now() }
    val dateState = rememberDatePickerState(initialSelectedDateMillis = first.atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli())
    var date by remember { mutableStateOf<String?>(null) }
    val chosen = date
    if (chosen == null) {
        DatePickerDialog(
            onDismissRequest = onDismiss,
            confirmButton = { TextButton({ dateState.selectedDateMillis?.let { date = java.time.Instant.ofEpochMilli(it).atZone(java.time.ZoneOffset.UTC).toLocalDate().toString() } }) { Text("Next") } },
            dismissButton = {
                Row {
                    if (canClear) TextButton(onClear) { Text("Clear") }
                    TextButton(onDismiss) { Text("Cancel") }
                }
            },
        ) { DatePicker(dateState, title = { Text(title, Modifier.padding(start = 24.dp, top = 16.dp)) }) }
    } else {
        val time = start.optString("time").split(":")
        val timeState = rememberTimePickerState(initialHour = time.getOrNull(0)?.toIntOrNull() ?: 9, initialMinute = time.getOrNull(1)?.toIntOrNull() ?: 0, is24Hour = false)
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text("$title, $chosen") },
            text = { TimePicker(timeState) },
            confirmButton = { TextButton({ onPicked("$chosen ${"%02d".format(timeState.hour)}:${"%02d".format(timeState.minute)}") }) { Text("Set") } },
            dismissButton = {
                Row {
                    TextButton({ onPicked(chosen) }) { Text("No time") }
                    TextButton(onDismiss) { Text("Cancel") }
                }
            },
        )
    }
}

/** A Dialog entry: the user's as a blue note on the right, an agent's beside its clanker, June's in her balloon, the dispatcher's as a caption. */
@Composable
private fun DialogEntry(e: JSONObject, harness: String, colours: Colours, palette: Look.Palette) {
    val kind = e.optString("kind")
    val who = e.optString("who").lowercase() + e.optString("at").let { if (it.isEmpty()) "" else " · $it" }
    val shape = RoundedCornerShape(if (kind == "dispatcher") 2.dp else 16.dp)
    val fill = when (kind) { "user" -> Look.noteFill; "dispatcher" -> Color(0xFFFFF3C4); else -> Look.balloon }
    val line = if (kind == "user") Look.noteLine else Look.ink
    val ink = if (kind == "user") Look.noteInk else Look.ink
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (kind == "user") Arrangement.End else Arrangement.Start, verticalAlignment = Alignment.Bottom) {
        if (kind == "agent") { Clanker(harness, colours, 30, claws = false); Spacer(Modifier.width(8.dp)) }
        Column(
            Modifier.let { if (kind == "user") it.fillMaxWidth(0.86f) else it.weight(1f, fill = false) }
                .background(fill, shape).border(2.dp, line, shape).padding(horizontal = 11.dp, vertical = 7.dp),
        ) {
            Text(who, fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 11.sp, color = if (kind == "user") Look.noteInk else Color(0xFF6D6A73))
            Text(e.optString("text"), fontFamily = if (kind == "user" || kind == "dispatcher") Look.caption else Look.lettering, fontSize = 14.sp, color = ink)
        }
    }
}

@Composable
fun AgentsBoard(link: Link, decisions: Decisions, palette: Look.Palette, modifier: Modifier = Modifier) {
    LaunchedEffect(Unit) { link.wantBoards() }
    val now = minute()
    val colours = rememberColours(decisions)
    val view by produceState<JSONObject?>(null, link.agents, link.agenda, now, link.pending) {
        val agents = link.agents
        value = if (agents == null) null else runCatching {
            JSONObject(decisions.call("board.agentsView", agents, now, link.agenda?.optString("today") ?: "", agents.optString("user"), link.pending))
        }.getOrNull()
    }
    val open = LocalUriHandler.current
    var mode by rememberSaveable { mutableStateOf("activity") }
    var rosterSort by rememberSaveable { mutableStateOf("roster") }
    var idleOpen by rememberSaveable { mutableStateOf(false) }
    var page by rememberSaveable { mutableStateOf("") }
    var rosterSlug by rememberSaveable { mutableStateOf("") }
    var rosterCreating by rememberSaveable { mutableStateOf(false) }
    var rosterEditing by rememberSaveable { mutableStateOf(false) }
    var seenRosterDone by remember { mutableStateOf(link.rosterDone.first) }
    LaunchedEffect(link.rosterDone) {
        val (seq, slug) = link.rosterDone
        if (seq != seenRosterDone) {
            seenRosterDone = seq
            rosterCreating = false
            rosterEditing = false
            rosterSlug = slug
        }
    }
    // A row with a task opens its page; one without opens where it can.
    val show: (String, String) -> Unit = { task, target ->
        if (task.isNotEmpty() && link.task(task) != null) {
            page = task
            // Opening a page counts as seeing a task's review or question, on every device.
            if (view?.optJSONArray("needs").objects().any { it.optString("task") == task && it.optString("kind") != "blocked" }) link.markSeen(task)
        } else if (target.isNotEmpty() && target != "null") open.openUri(target)
    }
    // A rename moves a task without an ID to a new key; its page follows.
    LaunchedEffect(link.taskMoved) { if (link.taskMoved.first == page && page.isNotEmpty()) page = link.taskMoved.second }
    if (page.isNotEmpty() && colours != null) { TaskPage(link, decisions, colours, palette, page, "agents", { page = "" }, modifier); return }
    val v = view
    val roster = v?.optJSONArray("roster").objects()
    val rosterHosts = v?.optJSONArray("rosterHosts")?.let { a -> (0 until a.length()).map { a.optString(it) } }?.ifEmpty { null } ?: listOf("kit", "cog")
    if ((rosterCreating || rosterSlug.isNotEmpty()) && colours != null) {
        val activeCard = if (rosterCreating) null else roster.firstOrNull { it.optString("slug") == rosterSlug }
        RosterDetailPage(
            link = link,
            card = activeCard,
            hosts = rosterHosts,
            creating = rosterCreating,
            editing = rosterEditing,
            colours = colours,
            palette = palette,
            onEditing = { rosterEditing = it },
            onBack = { rosterCreating = false; rosterEditing = false; rosterSlug = "" },
            modifier = modifier,
        )
        return
    }
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Heading("agents", v?.optString("summary") ?: "asking hc…", palette) }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Segment("activity", mode == "activity", palette) { mode = "activity" }
                Segment("roster" + if (roster.isNotEmpty()) " · ${roster.size}" else "", mode == "roster", palette) { mode = "roster" }
            }
        }
        if (v != null && colours != null && mode == "roster") {
            val hasStats = v.optBoolean("rosterHasStats")
            val shownRoster = if (rosterSort == "leaderboard" && hasStats) v.optJSONArray("rosterLeaderboard").objects() else roster
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    SectionTitle((if (rosterSort == "leaderboard" && hasStats) "LEADERBOARD" else "AGENTS") + " · ${roster.size}", palette)
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (hasStats) Segment("ranked", rosterSort == "leaderboard", palette) {
                            rosterSort = if (rosterSort == "leaderboard") "roster" else "leaderboard"
                        }
                        Segment("+ new", false, palette) { rosterSlug = ""; rosterCreating = true; rosterEditing = true }
                    }
                }
            }
            if (shownRoster.isEmpty()) item { Text("No agents in ROSTER.org yet.", fontFamily = Look.lettering, fontSize = 15.sp, color = palette.muted) }
            for (card in shownRoster) item(key = "roster|" + card.optString("slug")) {
                RosterCard(card, colours) { rosterCreating = false; rosterEditing = false; rosterSlug = card.optString("slug") }
            }
        } else if (v != null && colours != null) {
            val needs = v.optJSONArray("needs").objects()
            if (needs.isNotEmpty()) item { SectionTitle("NEEDS YOU · ${needs.size}", palette, alert = true) }
            else item { Text("Nothing needs you.", fontFamily = Look.lettering, fontSize = 15.sp, color = palette.muted) }
            for (n in needs) item(key = "need|" + n.optString("key")) { NeedCard(n, colours, { show(n.optString("task"), "") }) { url -> open.openUri(url) } }
            val working = v.optJSONArray("working").objects()
            if (working.isNotEmpty()) item { SectionTitle("WORKING · ${working.size}", palette) }
            for (w in working) item(key = "work|" + w.optString("key")) { WorkerRow(w, colours, palette, small = false) { show(w.optString("task"), w.optString("link")) } }
            val queued = v.optJSONArray("queued").objects()
            if (queued.isNotEmpty()) item { SectionTitle("QUEUED · ${queued.size}", palette) }
            for (q in queued) item(key = "queue|" + q.optString("key")) { TaskRow("AUTO", q.optString("title"), "", q.optString("who") + " · " + q.optString("when"), q.optString("link"), colours, palette) { show(q.optString("task"), q.optString("link")) } }
            val reviewing = v.optJSONArray("reviewing").objects()
            if (reviewing.isNotEmpty()) item { SectionTitle("IN AGENT REVIEW · ${reviewing.size}", palette) }
            for (r in reviewing) item(key = "rev|" + r.optString("key")) { TaskRow("EVAL", r.optString("title"), "", r.optString("who"), r.optString("link"), colours, palette) { show(r.optString("task"), r.optString("link")) } }
            val idle = v.optJSONArray("idle").objects()
            if (idle.isNotEmpty()) item { SectionTitle("IDLE · ${idle.size}  " + if (idleOpen) "▾" else "▸", palette, onClick = { idleOpen = !idleOpen }) }
            if (idleOpen) for (w in idle) item(key = "idle|" + w.optString("key")) { WorkerRow(w, colours, palette, small = true) { show(w.optString("task"), w.optString("link")) } }
            val recent = v.optJSONArray("recent").objects()
            if (recent.isNotEmpty()) item { SectionTitle("REPORTED TODAY · ${recent.size}", palette) }
            for (r in recent.take(6)) item(key = "recent|" + r.optString("key")) {
                TaskRow(r.optString("state"), r.optString("title"), r.optString("line"), r.optString("when").let { if (it.isEmpty()) "" else "$it ago" }, r.optString("link"), colours, palette) { show(r.optString("task"), r.optString("link")) }
            }
            val down = v.optJSONArray("down")
            if (down != null && down.length() > 0) item { Text("Out of reach: " + (0 until down.length()).joinToString(", ") { down.getString(it) }, fontFamily = Look.caption, fontSize = 12.sp, color = palette.muted) }
        }
        item { Spacer(Modifier.height(16.dp)) }
    }
}

/** One Pokemon-style roster card: harness accent stripe, Clanker, status badge, spec line, and battery gauge. */
@Composable
private fun RosterCard(card: JSONObject, colours: Colours, onClick: () -> Unit) {
    val (_, band) = colours.clanker(card.optString("clanker"))
    val shape = RoundedCornerShape(14.dp)
    val busy = card.optBoolean("busy")
    val status = card.optString("status")
    val badgeFill = if (busy) Color(0xFFD7E4F2) else if (status == "idle") Color(0xFFDFEAD6) else Color(0xFFFFD6CF)
    val badgeInk = if (busy) Color(0xFF1C3A66) else if (status == "idle") Color(0xFF2F5A22) else Color(0xFF8A1F12)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(Look.balloon, shape).border(2.dp, Look.ink, shape).clickable(onClick = onClick),
    ) {
        Box(Modifier.fillMaxWidth().height(6.dp).background(band))
        Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Clanker(card.optString("clanker"), colours, 42)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(card.optString("name"), Modifier.weight(1f), fontFamily = Look.display, fontSize = 16.sp, color = Look.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            card.optString("statusLabel"), fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 10.sp, color = badgeInk,
                            modifier = Modifier.background(badgeFill, RoundedCornerShape(50)).border(1.5.dp, badgeInk, RoundedCornerShape(50)).padding(horizontal = 7.dp, vertical = 2.dp),
                        )
                    }
                    Text(card.optString("specLine"), fontFamily = Look.caption, fontSize = 12.sp, color = Color(0xFF6D6A73), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            val batText = card.optString("batteryText")
            if (batText.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                BatteryMeter(card.optInt("batteryLevel", -1), card.optString("batteryTone", "unknown"))
                Text(batText, fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 12.sp, color = Look.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            val statsLine = card.optString("statsLine")
            if (statsLine.isNotEmpty()) Text(statsLine, fontFamily = Look.caption, fontSize = 12.sp, color = Color(0xFF6D6A73), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Drawn battery gauge filled to `level` (0..100, or -1 for unknown). */
@Composable
private fun BatteryMeter(level: Int, tone: String) {
    val fill = when (tone) {
        "high" -> Color(0xFF2F8A4E)
        "mid" -> Color(0xFFC88A12)
        "low" -> Color(0xFFB3311F)
        else -> Color(0xFF8B8892)
    }
    Canvas(Modifier.size(34.dp, 15.dp)) {
        val sx = size.width / 34f
        val sy = size.height / 15f
        val stroke = Stroke(2f * sx)
        drawRoundRect(Look.ink, Offset(1f * sx, 1f * sy), Size(28f * sx, 13f * sy), CornerRadius(3.5f * sx), style = stroke)
        if (level >= 0) {
            val innerW = 24f * sx
            val w = if (level > 0) maxOf(3f * sx, innerW * level / 100f) else 0f
            if (w > 0f) drawRoundRect(fill, Offset(3f * sx, 3f * sy), Size(w, 9f * sy), CornerRadius(1.5f * sx))
        }
        drawRoundRect(Look.ink, Offset(30.5f * sx, 4f * sy), Size(3.5f * sx, 7f * sy), CornerRadius(1.5f * sx))
    }
}

/** Inspect, edit, create or remove one ROSTER.org card. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RosterDetailPage(
    link: Link,
    card: JSONObject?,
    hosts: List<String>,
    creating: Boolean,
    editing: Boolean,
    colours: Colours,
    palette: Look.Palette,
    onEditing: (Boolean) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier,
) {
    val cardKey = if (creating) "__new__" else (card?.optString("slug") ?: "")
    var fName by remember(cardKey, editing) { mutableStateOf(card?.optString("name") ?: "") }
    var fHost by remember(cardKey, editing) { mutableStateOf(card?.optString("host")?.ifEmpty { null } ?: hosts.firstOrNull() ?: "kit") }
    var fHarness by remember(cardKey, editing) {
        val h = card?.optString("harness") ?: ""
        mutableStateOf(if (h in colours.harnesses) h else "claude")
    }
    var fModel by remember(cardKey, editing) { mutableStateOf(card?.optString("model") ?: "") }
    var fEffort by remember(cardKey, editing) { mutableStateOf(card?.optString("effort") ?: if (creating) "high" else "") }
    var fAvatar by remember(cardKey, editing) { mutableStateOf(card?.optString("avatar") ?: "") }
    var fInstructions by remember(cardKey, editing) { mutableStateOf(card?.optString("instructions") ?: "") }
    var confirmingDelete by remember(cardKey, editing) { mutableStateOf(false) }

    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (editing && !creating) "‹ card" else "‹ roster",
                    fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 14.sp, color = palette.pageInk,
                    modifier = Modifier.clickable {
                        if (editing && !creating) { confirmingDelete = false; onEditing(false) } else onBack()
                    }.padding(vertical = 8.dp),
                )
                if (!editing && card != null) Choice("edit", false, palette) { onEditing(true) }
            }
        }
        if (!editing && card == null) {
            item { Text("That agent is no longer in ROSTER.org.", fontFamily = Look.lettering, fontSize = 14.sp, color = palette.muted) }
        } else if (!editing && card != null) {
            val (_, band) = colours.clanker(card.optString("clanker"))
            val busy = card.optBoolean("busy")
            val status = card.optString("status")
            val badgeFill = if (busy) Color(0xFFD7E4F2) else if (status == "idle") Color(0xFFDFEAD6) else Color(0xFFFFD6CF)
            val badgeInk = if (busy) Color(0xFF1C3A66) else if (status == "idle") Color(0xFF2F5A22) else Color(0xFF8A1F12)
            val shape = RoundedCornerShape(14.dp)
            item {
                Column(Modifier.fillMaxWidth().clip(shape).background(Look.balloon, shape).border(2.5.dp, Look.ink, shape)) {
                    Box(Modifier.fillMaxWidth().height(8.dp).background(band))
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Clanker(card.optString("clanker"), colours, 52)
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(card.optString("name"), fontFamily = Look.display, fontSize = 20.sp, color = Look.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        card.optString("statusLabel"), fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 11.sp, color = badgeInk,
                                        modifier = Modifier.background(badgeFill, RoundedCornerShape(50)).border(1.5.dp, badgeInk, RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 2.dp),
                                    )
                                    val term = card.optString("terminal")
                                    if (term.isNotEmpty()) Text(term, fontFamily = Look.caption, fontSize = 12.sp, color = Color(0xFF6D6A73))
                                }
                            }
                        }
                        val batText = card.optString("batteryText")
                        val batAccount = card.optString("batteryAccount")
                        if (batText.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            BatteryMeter(card.optInt("batteryLevel", -1), card.optString("batteryTone", "unknown"))
                            Text(
                                batText + if (batAccount.isNotEmpty()) " · $batAccount" else "",
                                fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 13.sp, color = Look.ink, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Box(Modifier.fillMaxWidth().height(1.5.dp).background(Look.ink.copy(alpha = 0.15f)))
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            SpecCell("HOST", card.optString("host").ifEmpty { "—" }, Modifier.weight(1f))
                            SpecCell("HARNESS", card.optString("harness").ifEmpty { "—" }, Modifier.weight(1f))
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            SpecCell("MODEL", card.optString("model").ifEmpty { "default" }, Modifier.weight(1f))
                            SpecCell("EFFORT", card.optString("effort").ifEmpty { "default" }, Modifier.weight(1f))
                        }
                        val avatar = card.optString("avatar")
                        if (avatar.isNotEmpty()) SpecCell("AVATAR", avatar, Modifier.fillMaxWidth())
                        val problems = card.optJSONArray("problems")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
                        if (problems.isNotEmpty()) Text(problems.joinToString("; "), fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 12.sp, color = palette.accent)
                    }
                }
            }
            item { SectionTitle("INSTRUCTIONS", palette) }
            val instr = card.optString("instructions")
            item {
                Text(
                    instr.ifEmpty { "No extra instructions." },
                    fontFamily = Look.lettering, fontSize = 14.sp, color = if (instr.isNotEmpty()) Look.ink else palette.muted,
                    modifier = Modifier.fillMaxWidth().background(Look.balloon, RoundedCornerShape(12.dp)).border(2.dp, Look.ink, RoundedCornerShape(12.dp)).padding(horizontal = 10.dp, vertical = 8.dp),
                )
            }
            val runCount = card.optInt("runs", 0)
            if (runCount > 0) {
                item { SectionTitle("HISTORY", palette) }
                item {
                    val handoffs = card.optInt("handoffs", 0)
                    val parked = card.optInt("parked", 0)
                    val summary = buildString {
                        append(card.optString("statsLine"))
                        if (handoffs > 0) append(" · $handoffs handoff")
                        if (parked > 0) append(" · $parked parked")
                    }
                    val recentRuns = card.optJSONArray("recentRuns").objects()
                    Column(
                        Modifier.fillMaxWidth().background(Look.balloon, RoundedCornerShape(12.dp)).border(2.dp, Look.ink, RoundedCornerShape(12.dp)).padding(horizontal = 10.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text(summary, fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 13.sp, color = Look.ink)
                        for (r in recentRuns) {
                            val outcome = r.optString("outcome")
                            val oColor = when (outcome) {
                                "done", "eval" -> Color(0xFF2F5A22)
                                "handoff", "parked" -> Color(0xFF8A1F12)
                                else -> Color(0xFF6D6A73)
                            }
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(outcome.uppercase(), Modifier.width(54.dp), fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 10.sp, color = oColor)
                                Text(r.optString("taskTitle"), Modifier.weight(1f), fontFamily = Look.caption, fontSize = 12.sp, color = Look.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(r.optString("duration"), fontFamily = Look.caption, fontSize = 11.sp, color = Color(0xFF6D6A73))
                            }
                        }
                    }
                }
            }
        } else {
            // Live card preview header while editing or creating.
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Clanker(fHarness, colours, 42)
                    Column(Modifier.weight(1f)) {
                        Text(fName.trim().ifEmpty { if (creating) "New agent" else (card?.optString("name") ?: "") }, fontFamily = Look.display, fontSize = 18.sp, color = palette.pageInk, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(listOf(fHost.trim(), fHarness, fModel.trim(), fEffort).filter { it.isNotEmpty() }.joinToString(" · "), fontFamily = Look.caption, fontSize = 12.sp, color = palette.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            item { SectionTitle("NAME", palette) }
            item { OutlinedTextField(fName, { fName = it }, Modifier.fillMaxWidth(), singleLine = true, placeholder = { Text("e.g. Bolt", fontSize = 14.sp) }) }
            item { SectionTitle("HOST", palette) }
            item {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (h in hosts) Choice(h, fHost == h, palette) { fHost = h }
                }
            }
            item { OutlinedTextField(fHost, { fHost = it }, Modifier.fillMaxWidth(), singleLine = true, placeholder = { Text("host name (kit, cog, …)", fontSize = 14.sp) }) }
            item { SectionTitle("HARNESS", palette) }
            item {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (h in colours.harnesses) Choice(h, fHarness == h, palette) { fHarness = h }
                }
            }
            item { SectionTitle("MODEL", palette) }
            item { OutlinedTextField(fModel, { fModel = it }, Modifier.fillMaxWidth(), singleLine = true, placeholder = { Text("harness default", fontSize = 14.sp) }) }
            item { SectionTitle("EFFORT", palette) }
            item {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (e in colours.efforts) Choice(e.ifEmpty { "default" }, fEffort == e, palette) { fEffort = e }
                }
            }
            item { SectionTitle("AVATAR", palette) }
            item { OutlinedTextField(fAvatar, { fAvatar = it }, Modifier.fillMaxWidth(), singleLine = true, placeholder = { Text("optional path beside ROSTER.org", fontSize = 14.sp) }) }
            item { SectionTitle("INSTRUCTIONS", palette) }
            item { OutlinedTextField(fInstructions, { fInstructions = it }, Modifier.fillMaxWidth(), minLines = 3, placeholder = { Text("Role, skills, voice…", fontSize = 14.sp) }) }
            if (link.rosterBusy || link.rosterNotice.isNotEmpty()) item {
                val text = if (link.rosterBusy) "saving…" else link.rosterNotice
                Text(text, fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 13.sp, color = if (link.rosterBusy || text == "saved") palette.muted else palette.accent)
            }
            item {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Choice(if (creating) "Add agent" else "Save", true, palette, enabled = !link.rosterBusy) {
                        val payload = JSONObject()
                            .put("action", "save")
                            .put("name", fName)
                            .put("host", fHost)
                            .put("harness", fHarness)
                            .put("model", fModel)
                            .put("effort", fEffort)
                            .put("avatar", fAvatar)
                            .put("instructions", fInstructions)
                        if (!creating && card != null) payload.put("original", card.optString("slug"))
                        link.editRoster(payload)
                    }
                    if (!creating && card != null && !confirmingDelete) Choice("Remove", false, palette, danger = true, enabled = !link.rosterBusy) {
                        confirmingDelete = true
                    }
                    if (confirmingDelete && card != null) {
                        Choice("Confirm remove", true, palette, danger = true, enabled = !link.rosterBusy) {
                            link.editRoster(JSONObject().put("action", "delete").put("slug", card.optString("slug")))
                        }
                        Choice("Keep", false, palette) { confirmingDelete = false }
                    }
                }
            }
        }
        item { Spacer(Modifier.height(16.dp)) }
    }
}

@Composable
private fun SpecCell(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(label, fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 0.8.sp, color = Color(0xFF6D6A73))
        Text(value, fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 13.sp, color = Look.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ProjectsBoard(link: Link, decisions: Decisions, palette: Look.Palette, modifier: Modifier = Modifier) {
    LaunchedEffect(Unit) { link.wantBoards() }
    val colours = rememberColours(decisions)
    // agenda, projects, or one state's tasks.
    var mode by rememberSaveable { mutableStateOf("agenda") }
    var drill by rememberSaveable { mutableStateOf("") }
    val user = link.agents?.optString("user") ?: ""
    val view by produceState<JSONObject?>(null, link.agenda, link.pending) {
        val agenda = link.agenda
        value = if (agenda == null) null else runCatching { JSONObject(decisions.call("board.agendaView", agenda, link.pending, user)) }.getOrNull()
    }
    val rows by produceState<List<JSONObject>>(emptyList(), link.agenda, drill, link.pending) {
        val agenda = link.agenda
        value = if (agenda == null || drill.isEmpty()) emptyList() else runCatching { JSONArray(decisions.call("board.stateRows", agenda, drill, link.pending, user)).objects() }.getOrDefault(emptyList())
    }
    val open = LocalUriHandler.current
    var page by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(link.taskMoved) { if (link.taskMoved.first == page && page.isNotEmpty()) page = link.taskMoved.second }
    // The agenda widget or a reminder asked for this task's page, or for the agenda.
    LaunchedEffect(link.requested) {
        link.requested?.takeIf { it.first == "projects" }?.let { (_, key) ->
            if (key.isNotEmpty()) page = key else { page = ""; mode = "agenda"; drill = "" }
            link.requested = null
        }
    }
    if (page.isNotEmpty() && colours != null) { TaskPage(link, decisions, colours, palette, page, if (mode == "state") listTitle(drill).lowercase() else mode, { page = "" }, modifier); return }
    val show: (JSONObject) -> Unit = { e -> val task = e.optString("task"); if (task.isNotEmpty() && link.task(task) != null) page = task else e.optString("link").takeIf { it.isNotEmpty() && it != "null" }?.let { open.openUri(it) } }
    val v = view
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(9.dp)) {
        item {
            val counts = v?.optJSONArray("counts").objects()
            val projects = v?.optJSONArray("projects").objects()
            Heading("projects", if (v == null) "asking Emacs…" else "${counts.sumOf { it.optInt("n") }} open in ${projects.size} projects", palette)
        }
        // What's dated, every open task by state, or the projects.
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Segment("agenda", mode == "agenda", palette) { mode = "agenda"; drill = "" }
                Segment("tasks", mode == "tasks" || mode == "state", palette) { mode = "tasks"; drill = "" }
                Segment("projects", mode == "projects", palette) { mode = "projects" }
            }
        }
        if (v != null && colours != null) when (mode) {
            "agenda" -> {
                for (section in v.optJSONArray("sections").objects()) {
                    item(key = "s|" + section.optString("id")) { SectionTitle(section.optString("title"), palette, alert = section.optBoolean("alert"), ink = true) }
                    val entries = section.optJSONArray("rows").objects()
                    if (entries.isEmpty()) item { Text("Nothing on the agenda.", fontFamily = Look.lettering, fontSize = 14.sp, color = palette.muted) }
                    for (e in entries) item(key = section.optString("id") + "|" + e.optString("key")) { AgendaRow(e, colours, palette) { show(e) } }
                }
            }
            // Every open task by state, dated or not: a few rows each, the rest a tap away.
            "tasks" -> {
                for (l in v.optJSONArray("lists").objects()) {
                    val state = l.optString("state")
                    item(key = "l|$state") { SectionTitle("${l.optString("title")} · ${l.optInt("n")}", palette, ink = true, onClick = { drill = state; mode = "state" }) }
                    for (e in l.optJSONArray("rows").objects()) item(key = "l|$state|" + e.optString("key")) { AgendaRow(e, colours, palette) { show(e) } }
                    if (l.optInt("more") > 0) item(key = "l|$state|more") {
                        Text("all ${l.optInt("n")} ›", fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 14.sp, color = palette.pageInk, modifier = Modifier.clickable { drill = state; mode = "state" }.padding(vertical = 8.dp))
                    }
                }
                if (v.optInt("queued") > 0) item { Text("${v.optInt("queued")} queued for agents, on the agents board", fontFamily = Look.caption, fontSize = 13.sp, color = palette.muted) }
            }
            "state" -> {
                item { Text("‹ tasks", fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 14.sp, color = palette.pageInk, modifier = Modifier.clickable { mode = "tasks"; drill = "" }.padding(vertical = 6.dp)) }
                item { SectionTitle("${listTitle(drill)} · ${rows.size}", palette, ink = true) }
                for (e in rows) item(key = "d|" + e.optString("key")) { AgendaRow(e, colours, palette) { show(e) } }
            }
            else -> for (p in v.optJSONArray("projects").objects()) item(key = "p|" + p.optString("file")) {
                Column(Modifier.fillMaxWidth().clickable { open.openUri(p.optString("link")) }.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(p.optString("title"), fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 15.sp, color = palette.pageInk)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) { for (c in p.optJSONArray("counts").objects()) StateChip(c.optString("state"), colours, count = c.optInt("n")) }
                }
            }
        }
        item { Spacer(Modifier.height(16.dp)) }
    }
}

/** A state's list title, as board.mjs LISTS names it. */
private fun listTitle(state: String) = when (state) { "PROG" -> "IN PROGRESS"; "EVAL" -> "IN REVIEW"; "HOLD" -> "ON HOLD"; "TODO" -> "TO DO"; else -> state }

@Composable
private fun Heading(title: String, summary: String, palette: Look.Palette, trailing: @Composable () -> Unit = {}) {
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(title, fontFamily = Look.display, fontSize = 24.sp, color = palette.pageInk, modifier = Modifier.weight(1f))
            Row(horizontalArrangement = Arrangement.spacedBy(0.dp)) { trailing() }
        }
        Text(summary, fontFamily = Look.caption, fontSize = 13.sp, color = palette.muted)
        Spacer(Modifier.height(6.dp))
        Box(Modifier.fillMaxWidth().height(2.5.dp).background(palette.pageInk))
    }
}

/** A button on a task's or roster card's page, filled when it is the current choice; at least 44 dp tall to tap. */
@Composable
private fun Choice(text: String, on: Boolean, palette: Look.Palette, danger: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    val edge = if (danger) Color(0xFFB3311F) else palette.pageInk
    Text(
        text, fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 14.sp,
        color = if (on) palette.page else edge,
        modifier = Modifier.alpha(if (enabled) 1f else 0.5f)
            .background(if (on) edge else Color.Transparent, RoundedCornerShape(50))
            .border(2.dp, edge, RoundedCornerShape(50))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 11.dp),
    )
}

@Composable
private fun Segment(text: String, on: Boolean, palette: Look.Palette, onClick: () -> Unit) {
    Text(
        text, fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 13.sp,
        color = if (on) palette.page else palette.pageInk,
        modifier = Modifier.background(if (on) palette.pageInk else Color.Transparent, RoundedCornerShape(50))
            .border(2.dp, palette.pageInk, RoundedCornerShape(50)).clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 6.dp),
    )
}

@Composable
private fun SectionTitle(text: String, palette: Look.Palette, alert: Boolean = false, ink: Boolean = false, onClick: (() -> Unit)? = null) {
    Text(
        text, fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 12.sp, letterSpacing = 1.sp,
        color = if (alert) palette.accent else if (ink) palette.pageInk else palette.muted,
        modifier = Modifier.padding(top = 6.dp).let { if (onClick != null) it.clickable(onClick = onClick).padding(vertical = 4.dp) else it },
    )
}

@Composable
private fun StateChip(state: String, colours: Colours, count: Int = -1, big: Boolean = false, onClick: (() -> Unit)? = null) {
    val c = colours.chip(state)
    val shape = RoundedCornerShape(6.dp)
    Box(
        Modifier.widthIn(min = if (count >= 0) 0.dp else 44.dp)
            .let { if (c != null) it.background(c.first, shape).border(1.5.dp, c.second, shape) else it }
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .padding(horizontal = if (big) 10.dp else 5.dp, vertical = if (big) 5.dp else 1.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (c != null) Text(if (count >= 0) "$state $count" else state, fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = if (big) 13.sp else 11.sp, color = c.second)
    }
}

/** A placeholder clanker: round body, one large eye in its harness's colour, claws, antenna, hover glow. */
@Composable
private fun Clanker(harness: String, colours: Colours, size: Int = 40, mark: String = "", markColour: Color = Color(0xFFB3311F), claws: Boolean = true) {
    val (eye, band) = colours.clanker(harness)
    Box(Modifier.size(size.dp)) {
        Canvas(Modifier.size(size.dp)) {
            scale(this.size.width / 64f, this.size.height / 64f, pivot = Offset.Zero) {
                val ink = Look.ink
                val line = Stroke(2.5f, cap = StrokeCap.Round)
                drawOval(eye.copy(alpha = 0.4f), Offset(17f, 56f), Size(30f, 6f))
                drawLine(ink, Offset(32f, 11f), Offset(32f, 5f), 2.5f, StrokeCap.Round)
                drawCircle(eye, 3f, Offset(32f, 5f)); drawCircle(ink, 3f, Offset(32f, 5f), style = line)
                if (claws) {
                    drawPath(Path().apply { moveTo(13f, 30f); quadraticTo(6f, 35f, 9f, 44f) }, ink, style = line)
                    drawPath(Path().apply { moveTo(51f, 30f); quadraticTo(58f, 35f, 55f, 44f) }, ink, style = line)
                }
                drawCircle(Color(0xFFF3E3D3), 20f, Offset(32f, 31f)); drawCircle(ink, 20f, Offset(32f, 31f), style = line)
                drawOval(band, Offset(17f, 40.5f), Size(30f, 9f)); drawOval(ink, Offset(17f, 40.5f), Size(30f, 9f), style = line)
                drawCircle(ink, 10f, Offset(34f, 28f)); drawCircle(eye, 7f, Offset(34f, 28f)); drawCircle(Look.balloon, 2.2f, Offset(31f, 25f))
            }
        }
        if (mark.isNotEmpty()) Text(
            mark, fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 11.sp, color = Look.balloon,
            modifier = Modifier.align(Alignment.TopEnd).padding(0.dp).background(markColour, RoundedCornerShape(50)).padding(horizontal = 5.dp),
        )
    }
}

@Composable
private fun NeedCard(n: JSONObject, colours: Colours, page: () -> Unit, open: (String) -> Unit) {
    val urgent = n.optInt("level") == 1
    val kind = n.optString("kind")
    val shape = RoundedCornerShape(14.dp)
    Column(
        Modifier.fillMaxWidth().background(if (urgent) Color(0xFFFFF0EC) else Look.balloon, shape)
            .border(if (urgent) 3.dp else 2.dp, if (urgent) Color(0xFFB3311F) else Look.ink, shape).clickable(onClick = page).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Clanker(n.optString("harness"), colours, 42, if (kind == "blocked") "!" else if (kind == "asks") "?" else "new",
                if (kind == "blocked") Color(0xFFB3311F) else if (kind == "asks") Look.ink else Color(0xFF3D3466))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(n.optString("label"), fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 11.sp, letterSpacing = 0.5.sp, color = if (urgent) Color(0xFFB3311F) else if (kind == "review") Color(0xFF3D3466) else Look.ink)
                Text(n.optString("title"), fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 15.sp, color = Look.ink)
                Text(n.optString("where"), fontFamily = Look.caption, fontSize = 12.sp, color = Color(0xFF6D6A73), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        val line = n.optString("line")
        if (line.isNotEmpty()) Text(
            line, fontFamily = Look.lettering, fontSize = 14.sp, color = Look.ink, maxLines = 4, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth().background(Look.balloon, RoundedCornerShape(12.dp)).border(2.dp, Look.ink, RoundedCornerShape(12.dp)).padding(horizontal = 10.dp, vertical = 7.dp),
        )
        val link = n.optString("link")
        if (link.isNotEmpty() && link != "null") Text(
            n.optString("action"), fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 14.sp, color = Look.paper,
            modifier = Modifier.align(Alignment.End).background(Look.ink, RoundedCornerShape(50)).clickable { open(link) }.padding(horizontal = 16.dp, vertical = 10.dp),
        )
    }
}

@Composable
private fun WorkerRow(w: JSONObject, colours: Colours, palette: Look.Palette, small: Boolean, open: () -> Unit) {
    val opens = w.optString("link").let { it.isNotEmpty() && it != "null" } || w.optString("task").isNotEmpty()
    Row(
        Modifier.fillMaxWidth().let { if (opens) it.clickable(onClick = open) else it }.padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Clanker(w.optString("harness"), colours, if (small) 26 else 34, claws = !small)
        Column(Modifier.weight(1f)) {
            Text(w.optString("title"), fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = if (small) 13.sp else 14.sp, color = palette.pageInk, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(w.optString("where") + if (small) " · " + w.optString("status") else "", fontFamily = Look.caption, fontSize = 12.sp, color = palette.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun TaskRow(state: String, title: String, quote: String, meta: String, link: String, colours: Colours, palette: Look.Palette, open: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = open), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        StateChip(state, colours)
        Column(Modifier.weight(1f)) {
            Text(title, fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 14.sp, color = palette.pageInk)
            if (quote.isNotEmpty()) Text("“$quote”", fontFamily = Look.lettering, fontSize = 13.sp, color = palette.muted, maxLines = 3, overflow = TextOverflow.Ellipsis)
            if (meta.isNotEmpty()) Text(meta, fontFamily = Look.caption, fontSize = 12.sp, color = palette.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun AgendaRow(e: JSONObject, colours: Colours, palette: Look.Palette, open: () -> Unit) {
    val day = e.optString("day")
    val time = e.optString("time")
    // A list row has no day or time column, nor a chip: its list names the state.
    val plain = e.optBoolean("plain")
    Row(Modifier.fillMaxWidth().clickable(onClick = open).padding(vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (!plain) Text(if (day.isNotEmpty()) day else time, fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 12.sp, color = palette.muted, modifier = Modifier.width(40.dp).padding(top = 2.dp))
        if (!plain) StateChip(e.optString("state"), colours)
        Column(Modifier.weight(1f)) {
            Text((if (day.isNotEmpty() && time.isNotEmpty()) "$time  " else "") + e.optString("title"), fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 14.sp, color = palette.pageInk)
            val meta = e.optString("meta")
            if (meta.isNotEmpty()) Text(meta, fontFamily = Look.caption, fontSize = 12.sp, color = if (e.optBoolean("overdue")) palette.accent else palette.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
