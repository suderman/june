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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
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
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
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
import androidx.compose.ui.unit.Dp
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
 * and Emacs, left to right. The three middle ones are the pager's pages, in the same order: the agents take three
 * (hosts, clankers, activity; AgentsSections), and their tab goes to activity, beside the strip. The outer two open
 * the apps where the work is watched and edited. Agents counts what needs the user.
 */
private enum class Tab(val label: String, val page: Int?, val slot: Swipes.AppSlot?) {
    Terminal("terminal", null, Swipes.AppSlot.Terminal),
    Agents("agents", AgentsSections.size - 1, null),
    Chat("chat", AgentsSections.size, null),
    Projects("projects", AgentsSections.size + 1, null),
    Editor("editor", null, Swipes.AppSlot.Editor),
}

/** Height of the bottom tab bar, shared with Sheet so content rests above it until the keyboard rises past it. */
val TabsHeight = 58.dp

@Composable
fun Tabs(page: Int, needs: Int, palette: Look.Palette, terminal: Boolean = false, onTerminal: (() -> Unit)? = null, onPage: (Int) -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    Row(Modifier.fillMaxWidth().height(TabsHeight).padding(top = 2.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        for (tab in Tab.entries) {
            val on = if (terminal) tab == Tab.Terminal else tab.page == page || (tab == Tab.Agents && page in AgentsSections.indices) ||
                (tab == Tab.Projects && page in Tab.Projects.page!! until Tab.Projects.page + ProjectsSections.size)
            Box(
                Modifier.weight(1f).height(52.dp)
                    .clickable(
                        interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() },
                        indication = androidx.compose.material3.ripple(bounded = false, radius = 26.dp),
                    ) {
                        tab.page?.let(onPage)
                        // Terminal opens June's own terminal page when terminals open in June (Terminals.embedded), else its app.
                        if (tab == Tab.Terminal && onTerminal != null && Terminals.embedded(context)) onTerminal()
                        else tab.slot?.let { slot -> Swipes.openSlot(context, slot)?.let { android.widget.Toast.makeText(context, it, android.widget.Toast.LENGTH_LONG).show() } }
                    }
                    .semantics {
                        contentDescription = tab.label
                        role = if (tab.page != null || tab == Tab.Terminal) Role.Tab else Role.Button
                        if (tab.page != null || tab == Tab.Terminal) selected = on
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
        Tab.Terminal -> glyph(Glyph.Terminal, ink, page)
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
        Tab.Editor -> glyph(Glyph.Editor, ink, page)
    }
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

/** The roster's clankers a task can be handed to: valid cards on a host the dispatcher launches on (HOSTS, or any). */
private fun recruits(agents: JSONObject?, hosts: List<String>): List<Recruit> =
    agents?.optJSONArray("roster").objects().mapNotNull { e ->
        val c = e.optJSONObject("card") ?: return@mapNotNull null
        val host = c.optString("host")
        val ok = (c.optJSONArray("problems")?.length() ?: 0) == 0 && host.isNotEmpty() && (hosts.isEmpty() || host in hosts)
        if (ok) Recruit(c.optString("slug"), c.optString("name").ifEmpty { c.optString("slug") }, host, c.optString("harness")) else null
    }

/** One task's page (board.mjs taskDetail) as a docket, in the sheet risen over its board. */
@Composable
private fun TaskPage(link: Link, decisions: Decisions, colours: Colours, key: String, modifier: Modifier) {
    val detail by produceState<JSONObject?>(null, key, link.agents, link.agenda, link.pending) {
        val task = link.task(key)
        val held = task?.let { link.pending.optJSONObject(it.optString("key")) } ?: link.pending.optJSONObject(key)
        value = if (task == null) null else runCatching {
            JSONObject(decisions.call("board.taskDetail", task, link.agents?.optString("user") ?: "", link.agenda?.optString("today") ?: "", System.currentTimeMillis(), held))
        }.getOrNull()
    }
    val open = LocalUriHandler.current
    val d = detail
    val dispatch = link.agents?.optJSONObject("dispatch")
    // Edits go to the task's key now, which the dispatcher may have changed since the page opened.
    val k = d?.optString("key")?.ifEmpty { key } ?: key
    val (noticeKey, noticeText) = link.taskNotice
    TaskDocket(
        d = d, gone = link.task(key) == null, colours = colours,
        agents = dispatch?.optJSONArray("agents").strings().ifEmpty { listOf("pi", "claude") },
        clankers = recruits(link.agents, dispatch?.optJSONArray("hosts").strings() ?: emptyList()),
        hosts = dispatch?.optJSONArray("hosts").strings(), defaultHost = dispatch?.optString("host") ?: "",
        notice = if (noticeKey == key || noticeKey == k) noticeText else "", canUndo = link.taskUndo != null,
        actions = DocketActions(
            edit = { _, change, undo -> link.editTask(k, change, undo) },
            undo = { link.taskUndo?.let { link.editTask(k, it) } },
            open = { open.openUri(it) },
        ),
        modifier = modifier,
    )
}

/** The boards' side margins inside their pages; a sheet spans the page, edge to edge. */
val BoardMargin = 16.dp

/** The projects board's sections, left to right, each a page of the pager right of the strip; agenda, beside it, is the default. */
val ProjectsSections = listOf("agenda", "tasks", "projects")
val ProjectsLabels = listOf("agenda", "tasks", "by project")

/** The agents section's tabs, left to right, each a page of the pager (Conversation.kt); activity, beside the strip, is the default. */
val AgentsSections = listOf("hosts", "clankers", "activity")

@Composable
fun AgentsBoard(link: Link, decisions: Decisions, palette: Look.Palette, section: String, modifier: Modifier = Modifier, reset: Int = 0) {
    CompositionLocalProvider(LocalPalette provides palette) {
        when (section) {
            "hosts" -> HostsPage(link, decisions, modifier, reset)
            "clankers" -> ClankersPage(link, decisions, modifier, reset)
            else -> ActivityPage(link, decisions, modifier, reset)
        }
    }
}

/** The agents board as board.mjs agentsView shapes it, moving with the minute. */
@Composable
private fun rememberAgentsView(link: Link, decisions: Decisions): JSONObject? {
    LaunchedEffect(Unit) { link.wantBoards() }
    val now = minute()
    val view by produceState<JSONObject?>(null, link.agents, link.agenda, now, link.pending) {
        val agents = link.agents
        value = if (agents == null) null else runCatching {
            JSONObject(decisions.call("board.agentsView", agents, now, link.agenda?.optString("today") ?: "", agents.optString("user"), link.pending))
        }.getOrNull()
    }
    return view
}

/** The top of an agents page: nothing once the board has come, the sections being named in the bar below. */
@Composable
private fun AgentsWaiting(v: JSONObject?) {
    val p = LocalPalette.current
    if (v == null) Text("asking hc…", Modifier.padding(top = 6.dp), style = p.type.meta.copy(color = p.muted))
}

/** RESET changing (the Agents tab tapped again) runs ACTION, which puts away what the page has open. */
@Composable
private fun OnReset(reset: Int, action: () -> Unit) {
    var seen by remember { mutableStateOf(reset) }
    LaunchedEffect(reset) { if (reset != seen) { seen = reset; action() } }
}

/** What a sheet shows: KEY while it is open, else the last one, so the sheet keeps its page while it slides away. */
@Composable
private fun keptWhileClosing(key: String): String {
    var last by remember { mutableStateOf(key) }
    SideEffect { if (key.isNotEmpty()) last = key }
    return key.ifEmpty { last }
}

@Composable
private fun ActivityPage(link: Link, decisions: Decisions, modifier: Modifier, reset: Int) {
    val p = LocalPalette.current
    val v = rememberAgentsView(link, decisions)
    val colours = rememberColours(decisions)
    val open = LocalUriHandler.current
    var idleOpen by rememberSaveable { mutableStateOf(false) }
    var queueOpen by rememberSaveable { mutableStateOf(false) }
    var page by rememberSaveable { mutableStateOf("") }
    OnReset(reset) { page = "" }
    // A rename moves a task without an ID to a new key; its page follows.
    LaunchedEffect(link.taskMoved) { if (link.taskMoved.first == page && page.isNotEmpty()) page = link.taskMoved.second }
    // A row with a task opens its page; one without opens where it can.
    val show: (String, String) -> Unit = { task, target ->
        if (task.isNotEmpty() && link.task(task) != null) {
            page = task
            // Opening a page counts as seeing a task's review or question, on every device.
            if (v?.optJSONArray("needs").objects().any { it.optString("task") == task && it.optString("kind") != "blocked" }) link.markSeen(task)
        } else if (target.isNotEmpty() && target != "null") open.openUri(target)
    }
    val shown = keptWhileClosing(page)
    Box(modifier.clipToBounds()) {
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = BoardMargin), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { AgentsWaiting(v) }
            if (v != null && colours != null) {
            val needs = v.optJSONArray("needs").objects()
            if (needs.isNotEmpty()) item { SectionRule("NEEDS YOU · ${needs.size}", alert = true) }
            else item { Text("Nothing needs you.", Modifier.padding(top = 6.dp), style = p.type.lettering.copy(color = p.muted)) }
            for (n in needs) item(key = "need|" + n.optString("key")) { NeedDocket(n, colours, { show(n.optString("task"), "") }) { url -> open.openUri(url) } }
            val working = v.optJSONArray("working").objects()
            if (working.isNotEmpty()) item { SectionRule("WORKING · ${working.size}") }
            if (working.isNotEmpty()) item(key = "working") {
                Pad {
                    working.forEachIndexed { i, w ->
                        StubRow(w.optString("title"), w.optString("where"), first = i == 0, art = { Clanker(w.optString("harness"), colours, 32) }, onClick = clickOf(w) { show(w.optString("task"), w.optString("link")) })
                    }
                }
            }
            val queued = v.optJSONArray("queued").objects()
            if (queued.isNotEmpty()) item { SectionRule("QUEUED · ${queued.size}") }
            if (queued.isNotEmpty()) item(key = "queued") {
                val shown = if (queueOpen) queued else queued.take(3)
                Column(horizontalAlignment = Alignment.End) {
                    // Slips on a spike: the queue's next few on top, the rest stacked under them.
                    Spiked(queued.size > shown.size) {
                        Pad {
                            shown.forEachIndexed { i, q ->
                                StubRow(q.optString("title"), q.optString("who"), lead = whenLead(q.optString("when")), leadWidth = 68.dp, first = i == 0) { show(q.optString("task"), q.optString("link")) }
                            }
                        }
                    }
                    if (queued.size > 3) PressTab(if (queueOpen) "fewer" else "all ${queued.size} ›", { queueOpen = !queueOpen }, kind = Press.Quiet, small = true)
                }
            }
            val reviewing = v.optJSONArray("reviewing").objects()
            if (reviewing.isNotEmpty()) item { SectionRule("IN AGENT REVIEW · ${reviewing.size}") }
            if (reviewing.isNotEmpty()) item(key = "reviewing") {
                Pad { reviewing.forEachIndexed { i, r -> StubRow(r.optString("title"), r.optString("who"), stamp = "EVAL", first = i == 0) { show(r.optString("task"), r.optString("link")) } } }
            }
            val idle = v.optJSONArray("idle").objects()
            if (idle.isNotEmpty()) item { SectionRule("IDLE · ${idle.size}" + if (idleOpen) "  ▾" else "", onClick = { idleOpen = !idleOpen }) }
            if (idleOpen && idle.isNotEmpty()) item(key = "idle") {
                Pad {
                    idle.forEachIndexed { i, w ->
                        StubRow(w.optString("title"), w.optString("where") + " · " + w.optString("status"), first = i == 0, art = { Clanker(w.optString("harness"), colours, 26, claws = false) }, onClick = clickOf(w) { show(w.optString("task"), w.optString("link")) })
                    }
                }
            }
            val recent = v.optJSONArray("recent").objects()
            if (recent.isNotEmpty()) item { SectionRule("REPORTED TODAY · ${recent.size}") }
            if (recent.isNotEmpty()) item(key = "recent") {
                Pad {
                    recent.take(6).forEachIndexed { i, r ->
                        StubRow(r.optString("title"), r.optString("when").let { if (it.isEmpty()) "" else "$it ago" }, stamp = r.optString("state"), quote = r.optString("line"), first = i == 0) { show(r.optString("task"), r.optString("link")) }
                    }
                }
            }
            val down = v.optJSONArray("down").strings()
            if (down.isNotEmpty()) item { Text("Out of reach: " + down.joinToString(", "), style = p.type.meta.copy(color = p.muted)) }
            }
            item { Spacer(Modifier.height(16.dp)) }
        }
        if (colours != null) DetailSheet(page.isNotEmpty(), { page = "" }) {
            if (shown.isNotEmpty()) TaskPage(link, decisions, colours, shown, Modifier.fillMaxSize())
        }
    }
}

@Composable
private fun ClankersPage(link: Link, decisions: Decisions, modifier: Modifier, reset: Int) {
    val p = LocalPalette.current
    val v = rememberAgentsView(link, decisions)
    val colours = rememberColours(decisions)
    var ranked by rememberSaveable { mutableStateOf(false) }
    var rosterSlug by rememberSaveable { mutableStateOf("") }
    var rosterCreating by rememberSaveable { mutableStateOf(false) }
    var rosterEditing by rememberSaveable { mutableStateOf(false) }
    val close = { rosterCreating = false; rosterEditing = false; rosterSlug = "" }
    OnReset(reset, close)
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
    val roster = v?.optJSONArray("roster").objects()
    val rosterHosts = v?.optJSONArray("rosterHosts").strings().ifEmpty { listOf("kit", "cog") }
    val opened = rosterCreating || rosterSlug.isNotEmpty()
    // The sheet keeps the card it showed while it slides away: "+" while creating, else its slug.
    val shown = keptWhileClosing(if (rosterCreating) "+" else rosterSlug)
    Box(modifier.clipToBounds()) {
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = BoardMargin), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { AgentsWaiting(v) }
            if (v != null && colours != null) {
                val canRank = v.optBoolean("rosterHasStats")
                val cards = if (ranked && canRank) v.optJSONArray("rosterLeaderboard").objects() else roster
                item {
                    SquadList(cards, ranked && canRank, canRank, colours, onRank = { ranked = !ranked },
                        onEnlist = { rosterSlug = ""; rosterCreating = true; rosterEditing = true },
                        onOpen = { c -> rosterCreating = false; rosterEditing = false; rosterSlug = c.optString("slug") })
                }
            }
            item { Spacer(Modifier.height(16.dp)) }
        }
        if (colours != null) DetailSheet(opened, close) {
            val creating = shown == "+"
            val card = if (creating) null else roster.firstOrNull { it.optString("slug") == shown }
            val amend = rosterEditing && !creating
            // While editing a card, Back returns to the card; otherwise it puts the sheet away.
            androidx.activity.compose.BackHandler(enabled = opened && amend) { rosterEditing = false }
            LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (amend || (!rosterEditing && card != null)) item {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        if (amend) BackLink("card", { rosterEditing = false }, Modifier.weight(1f)) else Spacer(Modifier.weight(1f))
                        if (!rosterEditing && card != null) PressTab("edit card", { rosterEditing = true }, small = true)
                    }
                }
                item {
                    if (rosterEditing) EnlistForm(
                        card, rosterHosts, colours, link.rosterBusy, link.rosterNotice,
                        onSave = { e ->
                            val payload = JSONObject().put("action", "save").put("name", e.name).put("host", e.host).put("harness", e.harness)
                                .put("model", e.model).put("effort", e.effort).put("instructions", e.instructions)
                            if (card != null) payload.put("original", card.optString("slug"))
                            link.editRoster(payload)
                        },
                        onDischarge = { card?.let { link.editRoster(JSONObject().put("action", "delete").put("slug", it.optString("slug"))) } },
                    ) else if (card == null) Text("That clanker is gone.", style = p.type.lettering.copy(color = p.muted))
                    else EnlistmentCard(card, colours)
                }
                item { Spacer(Modifier.height(16.dp)) }
            }
        }
    }
}

/** The hosts work goes to (board.mjs agentsView hosts): reachable or not, their sessions, the clankers that work there. */
@Composable
private fun HostsPage(link: Link, decisions: Decisions, modifier: Modifier, reset: Int) {
    val p = LocalPalette.current
    val v = rememberAgentsView(link, decisions)
    val colours = rememberColours(decisions)
    val open = LocalUriHandler.current
    var hostKey by rememberSaveable { mutableStateOf("") }
    OnReset(reset) { hostKey = "" }
    val hosts = v?.optJSONArray("hosts").objects()
    val shown = keptWhileClosing(hostKey)
    Box(modifier.clipToBounds()) {
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = BoardMargin), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { AgentsWaiting(v) }
            if (v != null && colours != null) {
                item { SectionRule("HOSTS · ${hosts.size}") }
                if (hosts.isEmpty()) item { Text("No hosts reported yet.", style = p.type.lettering.copy(color = p.muted)) }
                else item(key = "hosts") {
                    Pad {
                        hosts.forEachIndexed { i, h ->
                            StubRow(h.optString("host"), h.optString("meta"), stamp = if (h.optBoolean("ok")) "" else "OFFLINE", first = i == 0) { hostKey = h.optString("host") }
                        }
                    }
                }
            }
            item { Spacer(Modifier.height(16.dp)) }
        }
        if (colours != null) DetailSheet(hostKey.isNotEmpty(), { hostKey = "" }) {
            val h = hosts.firstOrNull { it.optString("host") == shown }
            if (h == null) Text("That host is no longer on the board.", style = p.type.lettering.copy(color = p.muted))
            else HostDetail(h, colours) { url -> open.openUri(url) }
        }
    }
}

/** One host's page in its sheet: whether it answers and its load, its harnesses with the quota each would spend, its
 * sessions (each opens where it runs), and its clankers. */
@Composable
private fun HostDetail(h: JSONObject, colours: Colours, open: (String) -> Unit) {
    val p = LocalPalette.current
    val ok = h.optBoolean("ok")
    val sessions = h.optJSONArray("sessions").objects()
    val clankers = h.optJSONArray("clankers").strings()
    LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Column {
                Text(h.optString("host"), style = p.type.masthead.copy(color = p.pageInk))
                Text(if (ok) "online · ${h.optInt("working")} working" else "offline", style = p.type.meta.copy(color = if (ok) p.muted else p.tone("TODO")))
                val load = h.optString("loadText")
                if (load.isNotEmpty()) Text(load, style = p.type.number.copy(color = p.pageInk))
                val error = h.optString("error")
                if (error.isNotEmpty()) Text(error, style = p.type.meta.copy(color = p.muted), maxLines = 4, overflow = TextOverflow.Ellipsis)
            }
        }
        val harnesses = h.optJSONArray("harnesses").objects()
        if (harnesses.isNotEmpty()) {
            item { SectionRule("HARNESSES · ${harnesses.size}") }
            item(key = "harnesses") {
                Pad {
                    harnesses.forEachIndexed { i, x ->
                        if (i > 0) Box(Modifier.padding(horizontal = 12.dp).fillMaxWidth().height(1.dp).background(p.rule))
                        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Clanker(x.optString("clanker"), colours, 26, claws = false)
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text(x.optString("harness"), style = p.type.row.copy(color = p.surfaceInk))
                                EnergyGauge(x.optInt("batteryLevel", -1), x.optString("batteryTone", "unknown"), x.optString("gauge"))
                                val account = x.optString("batteryAccount")
                                Text(x.optString("energyText").ifEmpty { "unknown" } + if (account.isNotEmpty()) " · $account" else "", style = p.type.meta.copy(color = p.surfaceMuted), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
            }
        }
        item { SectionRule("SESSIONS · ${sessions.size}") }
        if (sessions.isEmpty()) item { Text(if (ok) "No sessions." else "Out of reach.", style = p.type.lettering.copy(color = p.muted)) }
        else item(key = "sessions") {
            Pad {
                sessions.forEachIndexed { i, w ->
                    StubRow(w.optString("title"), w.optString("where") + " · " + w.optString("status"), first = i == 0,
                        art = { Clanker(w.optString("harness"), colours, 26, claws = w.optString("status") == "working") },
                        onClick = w.optString("link").takeIf { it.isNotEmpty() && it != "null" }?.let { l -> { open(l) } })
                }
            }
        }
        item { SectionRule("CLANKERS · ${clankers.size}") }
        item { Text(clankers.joinToString(", ").ifEmpty { "None work here." }, style = p.type.lettering.copy(color = if (clankers.isEmpty()) p.muted else p.pageInk)) }
        item { Spacer(Modifier.height(16.dp)) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ProjectsBoard(link: Link, decisions: Decisions, palette: Look.Palette, section: String, modifier: Modifier = Modifier, reset: Int = 0) {
    CompositionLocalProvider(LocalPalette provides palette) { ProjectsBoardPage(link, decisions, section, modifier, reset) }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ProjectsBoardPage(link: Link, decisions: Decisions, section: String, modifier: Modifier, reset: Int = 0) {
    val p = LocalPalette.current
    LaunchedEffect(Unit) { link.wantBoards() }
    val colours = rememberColours(decisions)
    // The tasks page drills into one state's tasks; the page shows agenda, tasks, that state, or by project.
    var drill by rememberSaveable { mutableStateOf("") }
    val mode = if (section == "tasks" && drill.isNotEmpty()) "state" else section
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
    var seenReset by remember { mutableStateOf(reset) }
    LaunchedEffect(reset) {
        if (reset != seenReset) {
            seenReset = reset
            drill = ""
            page = ""
        }
    }
    LaunchedEffect(link.taskMoved) { if (link.taskMoved.first == page && page.isNotEmpty()) page = link.taskMoved.second }
    // The agenda widget or a reminder asked for this task's page, or for the agenda: the agenda page answers.
    if (section == "agenda") LaunchedEffect(link.requested) {
        link.requested?.takeIf { it.first == "projects" }?.let { (_, key) ->
            page = key
            link.requested = null
        }
    }
    androidx.activity.compose.BackHandler(enabled = mode == "state") { drill = "" }
    val show: (JSONObject) -> Unit = { e -> val task = e.optString("task"); if (task.isNotEmpty() && link.task(task) != null) page = task else e.optString("link").takeIf { it.isNotEmpty() && it != "null" }?.let { open.openUri(it) } }
    val v = view
    val shown = keptWhileClosing(page)
    Box(modifier.clipToBounds()) {
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = BoardMargin), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        // The sections are named in the bar below; only the wait for the board shows up here.
        if (v == null) item { Text("asking Emacs…", Modifier.padding(top = 6.dp), style = p.type.meta.copy(color = p.muted)) }
        if (v != null && colours != null) when (mode) {
            "agenda" -> {
                for (section in v.optJSONArray("sections").objects()) {
                    val id = section.optString("id")
                    item(key = "s|$id") { SectionRule(section.optString("title"), alert = section.optBoolean("alert")) }
                    val entries = section.optJSONArray("rows").objects()
                    if (entries.isEmpty()) item(key = "e|$id") { Text("Nothing on the agenda.", style = p.type.lettering.copy(color = p.muted)) }
                    else item(key = "r|$id") {
                        Pad {
                            entries.forEachIndexed { i, e ->
                                val lead = if (e.optBoolean("allDay")) "all day" else e.optString("time")
                                StubRow(e.optString("title"), e.optString("meta"), lead = lead, leadWidth = 56.dp, stamp = e.optString("state"), overdue = e.optBoolean("overdue"), first = i == 0) { show(e) }
                            }
                        }
                    }
                }
            }
            // Every open task by state, dated or not: a few rows each, the rest a tap away.
            "tasks" -> {
                for (l in v.optJSONArray("lists").objects()) {
                    val state = l.optString("state")
                    item(key = "l|$state") { SectionRule("${l.optString("title")} · ${l.optInt("n")}", onClick = { drill = state }) }
                    item(key = "l|$state|rows") {
                        Column(horizontalAlignment = Alignment.End) {
                            Pad { l.optJSONArray("rows").objects().forEachIndexed { i, e -> StubRow(e.optString("title"), e.optString("meta"), overdue = e.optBoolean("overdue"), first = i == 0) { show(e) } } }
                            if (l.optInt("more") > 0) PressTab("all ${l.optInt("n")} ›", { drill = state }, kind = Press.Quiet, small = true)
                        }
                    }
                }
                if (v.optInt("queued") > 0) item { Text("${v.optInt("queued")} queued for agents, on the agents board", style = p.type.meta.copy(color = p.muted)) }
            }
            "state" -> {
                item { BackLink("tasks", { drill = "" }) }
                item { SectionRule("${listTitle(drill)} · ${rows.size}") }
                if (rows.isNotEmpty()) item(key = "d|rows") { Pad { rows.forEachIndexed { i, e -> StubRow(e.optString("title"), e.optString("meta"), overdue = e.optBoolean("overdue"), first = i == 0) { show(e) } } } }
            }
            // Each project a binder divider: its title, where it lives when two share a name, its counts as stamps;
            // it opens in Emacs (↗), where the project file is.
            else -> item(key = "projects") {
                Pad {
                    v.optJSONArray("projects").objects().forEachIndexed { i, pr ->
                        if (i > 0) Box(Modifier.padding(horizontal = 12.dp).fillMaxWidth().height(1.dp).background(p.rule))
                        Column(
                            Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable { open.openUri(pr.optString("link")) }.padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(pr.optString("title"), Modifier.weight(1f), style = p.type.row.copy(color = p.surfaceInk))
                                Text("↗", style = p.type.row.copy(color = p.surfaceMuted))
                            }
                            val where = pr.optString("where")
                            if (where.isNotEmpty()) Text(where, style = p.type.number.copy(color = p.surfaceMuted))
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                for (c in pr.optJSONArray("counts").objects()) Stamp("${c.optString("state")} ${c.optInt("n")}", p.tone(c.optString("state")), tilt = 0f)
                            }
                        }
                    }
                }
            }
        }
        item { Spacer(Modifier.height(16.dp)) }
    }
    if (colours != null) DetailSheet(page.isNotEmpty(), { page = "" }) {
        if (shown.isNotEmpty()) TaskPage(link, decisions, colours, shown, Modifier.fillMaxSize())
    }
    }
}

/** A state's list title, as board.mjs LISTS names it. */
private fun listTitle(state: String) = when (state) { "PROG" -> "IN PROGRESS"; "EVAL" -> "IN REVIEW"; "HOLD" -> "ON HOLD"; "TODO" -> "TO DO"; else -> state }
