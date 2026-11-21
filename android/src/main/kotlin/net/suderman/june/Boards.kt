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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.platform.LocalUriHandler
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

/** The strip, agents and projects tabs under the day bar; agents counts what needs the user. */
@Composable
fun BoardTabs(tab: String, needs: Int, palette: Look.Palette, onTab: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (name in listOf("strip", "agents", "projects")) {
            val on = tab == name
            Text(
                if (name == "agents" && needs > 0) "agents · $needs" else name,
                fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 14.sp,
                color = if (on) palette.page else palette.pageInk,
                modifier = Modifier.weight(1f).background(if (on) palette.pageInk else Color.Transparent, RoundedCornerShape(50))
                    .border(2.dp, palette.pageInk, RoundedCornerShape(50)).clickable { onTab(name) }
                    .padding(vertical = 10.dp),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
        }
    }
}

/** The chip and clanker colours, read once from board.mjs. */
private class Colours(json: JSONObject) {
    private val chips = json.optJSONObject("chips") ?: JSONObject()
    private val harness = json.optJSONObject("harness") ?: JSONObject()
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
private fun Link.task(key: String): JSONObject? = agents?.optJSONObject("tasks")?.optJSONObject(key) ?: agenda?.optJSONObject("tasks")?.optJSONObject(key)

/** One task's page (board.mjs taskDetail), in place of the board until its back link. */
@Composable
private fun TaskPage(link: Link, decisions: Decisions, colours: Colours, palette: Look.Palette, key: String, back: String, close: () -> Unit, modifier: Modifier) {
    val detail by produceState<JSONObject?>(null, key, link.agents, link.agenda) {
        val task = link.task(key)
        value = if (task == null) null else runCatching {
            JSONObject(decisions.call("board.taskDetail", task, link.agents?.optString("user") ?: "", link.agenda?.optString("today") ?: ""))
        }.getOrNull()
    }
    val open = LocalUriHandler.current
    val d = detail
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Text("‹ $back", fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 14.sp, color = palette.pageInk, modifier = Modifier.clickable(onClick = close).padding(vertical = 8.dp)) }
        if (d != null) {
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
            val assignable = state in listOf("TODO", "EVAL", "HOLD")
            if (state.isNotEmpty()) {
                item { SectionTitle("STATE", palette) }
                item {
                    @OptIn(ExperimentalLayoutApi::class)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (s in listOf("TODO", "PROG", "EVAL", "HOLD", "DONE")) Choice(s, s == state, palette) { if (s != state) link.editTask(key, JSONObject().put("action", "state").put("state", s)) }
                    }
                }
                if (assignable) item {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("assign", fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 13.sp, color = palette.muted)
                        for (agent in listOf("pi", "claude")) Choice(agent, false, palette) { link.editTask(key, JSONObject().put("action", "assign").put("agent", agent)) }
                    }
                }
                item {
                    var whenText by remember(key) { mutableStateOf("") }
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(whenText, { whenText = it }, Modifier.weight(1f), singleLine = true, placeholder = { Text("fri 9:00, +2d, none", fontSize = 13.sp) })
                        Choice("schedule", false, palette) { if (whenText.isNotBlank()) link.editTask(key, JSONObject().put("action", "schedule").put("when", whenText.trim())) }
                        Choice("deadline", false, palette) { if (whenText.isNotBlank()) link.editTask(key, JSONObject().put("action", "deadline").put("when", whenText.trim())) }
                    }
                }
            }
            val (noticeKey, noticeText) = link.taskNotice
            if (noticeKey == key && noticeText.isNotEmpty()) item {
                Text(noticeText, fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 13.sp, color = if (noticeText == "saved" || noticeText == "saving…") palette.muted else palette.accent)
            }
            item { SectionTitle("DIALOG", palette) }
            val dialog = d.optJSONArray("dialog").objects()
            if (dialog.isEmpty()) item { Text("No Dialog yet.", fontFamily = Look.lettering, fontSize = 14.sp, color = palette.muted) }
            for (e in dialog) item(key = "dialog|" + e.optString("key")) { DialogEntry(e, d.optString("harness"), colours, palette) }
            // A reply in the user's name; with resume, the task goes back to its clanker with it.
            if (state.isNotEmpty()) item {
                var reply by remember(key) { mutableStateOf("") }
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(reply, { reply = it }, Modifier.fillMaxWidth(), minLines = 2, placeholder = { Text("Reply in Dialog", fontSize = 14.sp) })
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Choice("Reply", false, palette) { if (reply.isNotBlank()) { link.editTask(key, JSONObject().put("action", "reply").put("text", reply)); reply = "" } }
                        if (assignable) Choice("Reply and resume", true, palette) { if (reply.isNotBlank()) { link.editTask(key, JSONObject().put("action", "reply").put("text", reply).put("resume", true)); reply = "" } }
                    }
                }
            }
        }
        item { Spacer(Modifier.height(16.dp)) }
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
    val view by produceState<JSONObject?>(null, link.agents, link.agenda, now) {
        val agents = link.agents
        value = if (agents == null) null else runCatching {
            JSONObject(decisions.call("board.agentsView", agents, now, link.agenda?.optString("today") ?: "", agents.optString("user")))
        }.getOrNull()
    }
    val open = LocalUriHandler.current
    var idleOpen by remember { mutableStateOf(false) }
    var page by remember { mutableStateOf("") }
    // A row with a task opens its page; one without opens where it can.
    val show: (String, String) -> Unit = { task, target ->
        if (task.isNotEmpty() && link.task(task) != null) {
            page = task
            // Opening a page counts as seeing a task's review or question, on every device.
            if (view?.optJSONArray("needs").objects().any { it.optString("task") == task && it.optString("kind") != "blocked" }) link.markSeen(task)
        } else if (target.isNotEmpty() && target != "null") open.openUri(target)
    }
    if (page.isNotEmpty() && colours != null) { TaskPage(link, decisions, colours, palette, page, "agents", { page = "" }, modifier); return }
    val v = view
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Heading("agents", v?.optString("summary") ?: "asking hc…", palette) }
        if (v != null && colours != null) {
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

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ProjectsBoard(link: Link, decisions: Decisions, palette: Look.Palette, modifier: Modifier = Modifier) {
    LaunchedEffect(Unit) { link.wantBoards() }
    val colours = rememberColours(decisions)
    // agenda, projects, or one state's tasks.
    var mode by remember { mutableStateOf("agenda") }
    var drill by remember { mutableStateOf("") }
    val view by produceState<JSONObject?>(null, link.agenda) {
        val agenda = link.agenda
        value = if (agenda == null) null else runCatching { JSONObject(decisions.call("board.agendaView", agenda)) }.getOrNull()
    }
    val rows by produceState<List<JSONObject>>(emptyList(), link.agenda, drill) {
        val agenda = link.agenda
        value = if (agenda == null || drill.isEmpty()) emptyList() else runCatching { JSONArray(decisions.call("board.stateRows", agenda, drill)).objects() }.getOrDefault(emptyList())
    }
    val open = LocalUriHandler.current
    var page by remember { mutableStateOf("") }
    if (page.isNotEmpty() && colours != null) { TaskPage(link, decisions, colours, palette, page, if (mode == "state") drill else "agenda", { page = "" }, modifier); return }
    val show: (JSONObject) -> Unit = { e -> val task = e.optString("task"); if (task.isNotEmpty() && link.task(task) != null) page = task else e.optString("link").takeIf { it.isNotEmpty() && it != "null" }?.let { open.openUri(it) } }
    val v = view
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(9.dp)) {
        item {
            val counts = v?.optJSONArray("counts").objects()
            val projects = v?.optJSONArray("projects").objects()
            Heading("projects", if (v == null) "asking Emacs…" else "${counts.sumOf { it.optInt("n") }} open in ${projects.size} projects", palette) {
                Segment("agenda", mode != "projects", palette) { mode = "agenda"; drill = "" }
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
                val counts = v.optJSONArray("counts").objects()
                if (counts.isNotEmpty()) {
                    item { SectionTitle("BY STATE", palette, ink = true) }
                    item {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            for (c in counts) StateChip(c.optString("state"), colours, count = c.optInt("n"), big = true) { drill = c.optString("state"); mode = "state" }
                        }
                    }
                }
            }
            "state" -> {
                item { Text("‹ agenda", fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 14.sp, color = palette.pageInk, modifier = Modifier.clickable { mode = "agenda"; drill = "" }.padding(vertical = 6.dp)) }
                item { SectionTitle("$drill · ${rows.size}", palette, ink = true) }
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

/** A button on a task's page, filled when it is the current choice; at least 44 dp tall to tap. */
@Composable
private fun Choice(text: String, on: Boolean, palette: Look.Palette, onClick: () -> Unit) {
    Text(
        text, fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 14.sp,
        color = if (on) palette.page else palette.pageInk,
        modifier = Modifier.background(if (on) palette.pageInk else Color.Transparent, RoundedCornerShape(50))
            .border(2.dp, palette.pageInk, RoundedCornerShape(50)).clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 11.dp),
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
    Row(Modifier.fillMaxWidth().clickable(onClick = open).padding(vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(if (day.isNotEmpty()) day else time, fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 12.sp, color = palette.muted, modifier = Modifier.width(40.dp).padding(top = 2.dp))
        StateChip(e.optString("state"), colours)
        Column(Modifier.weight(1f)) {
            Text((if (day.isNotEmpty() && time.isNotEmpty()) "$time  " else "") + e.optString("title"), fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 14.sp, color = palette.pageInk)
            val meta = e.optString("meta")
            if (meta.isNotEmpty()) Text(meta, fontFamily = Look.caption, fontSize = 12.sp, color = if (e.optBoolean("overdue")) palette.accent else palette.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
