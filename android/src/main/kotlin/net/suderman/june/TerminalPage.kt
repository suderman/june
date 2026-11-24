package net.suderman.june

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import kotlinx.coroutines.delay
import org.json.JSONObject

/**
 * The phone's settings for terminals, and the last one shown: where agent terminals open (in June, or the external
 * Terminal app and Termux as before) and whether the key row shows. See "Settings and fallbacks" in
 * docs/interfaces.org.
 */
object Terminals {
    private fun prefs(context: Context) = context.getSharedPreferences("terminal", Context.MODE_PRIVATE)

    /** Agent terminals open inside June; otherwise the Terminal app and Termux open them, as before. */
    fun embedded(context: Context): Boolean = prefs(context).getBoolean("embedded", false)
    fun setEmbedded(context: Context, on: Boolean) = prefs(context).edit().putBoolean("embedded", on).apply()

    /** A row of Esc, Ctrl, Alt, Tab and arrows over the keyboard, for keyboards that lack them. */
    fun keyRow(context: Context): Boolean = prefs(context).getBoolean("keyRow", false)
    fun setKeyRow(context: Context, on: Boolean) = prefs(context).edit().putBoolean("keyRow", on).apply()

    fun last(context: Context): TerminalTarget? {
        val p = prefs(context)
        val host = p.getString("host", null) ?: return null
        return TerminalTarget(host, p.getString("terminal", "") ?: "", p.getString("link", "") ?: "")
    }

    fun remember(context: Context, t: TerminalTarget) =
        prefs(context).edit().putString("host", t.host).putString("terminal", t.terminal).putString("link", t.link).apply()
}

/** The agents the board lists, as the switcher offers them. */
private data class Agent(val target: TerminalTarget, val name: String, val detail: String, val status: String, val worker: JSONObject)

private fun agentsOf(link: Link): List<Agent> {
    val workers = link.agents?.optJSONArray("workers") ?: return emptyList()
    return (0 until workers.length()).mapNotNull { i ->
        val w = workers.optJSONObject(i) ?: return@mapNotNull null
        val host = w.optString("host")
        val terminal = w.optString("terminal")
        if (host.isEmpty() || terminal.isEmpty()) return@mapNotNull null
        val herdr = w.optString("herdrLink").takeIf { it.startsWith("herdr:") } ?: ""
        val roster = w.optString("rosterAgent")
        val harness = w.optString("agent")
        Agent(
            TerminalTarget(host, terminal, herdr),
            roster.ifEmpty { harness }.replaceFirstChar { it.uppercase() },
            listOfNotNull(harness.takeIf { roster.isNotEmpty() }, "$host/$terminal").joinToString(" · "),
            w.optString("status"),
            w,
        )
    }.sortedWith(compareBy({ it.target.host }, { it.target.terminal }))
}

/** The first agent the board lists, for the Terminal tab before any terminal was shown. */
fun firstTerminal(link: Link): TerminalTarget? = agentsOf(link).firstOrNull()?.target

/** The board's worker for TARGET: by session link when it has one, else by host and terminal. */
private fun Agent.matches(t: TerminalTarget): Boolean =
    (t.link.isNotEmpty() && (target.link == t.link || (worker.optString("session").isNotEmpty() && t.link.contains(":" + worker.optString("session"))))) ||
        (t.terminal.isNotEmpty() && target.host == t.host && target.terminal == t.terminal)

/**
 * An agent's live terminal over the boards (see "Embedded terminal" in docs/interfaces.org): a line naming it, with
 * a switcher to every agent the board lists, and the terminal itself, drawn by libghostty-vt. Leaving the page, or
 * the app going to the background, only detaches; the agent keeps running.
 */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun TerminalPage(link: Link, target: TerminalTarget, palette: Look.Palette, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var state by remember(target) { mutableStateOf<TerminalStream.State>(TerminalStream.State.Connecting) }
    val view = remember(target) { TerminalView(context) }
    val stream = remember(target) { TerminalStream(context, target, view) { state = it } }
    var grid by remember(target) { mutableIntStateOf(0) }
    DisposableEffect(target) {
        Terminals.remember(context, target)
        view.onGrid = { c, r, _, _ -> grid = c * 10_000 + r }
        onDispose {
            stream.release()
            view.release()
        }
    }
    // One resize once the size settles, not one per frame of the keyboard's animation.
    LaunchedEffect(grid) {
        if (grid == 0) return@LaunchedEffect
        delay(150)
        stream.resize(grid / 10_000, grid % 10_000)
    }
    val lifecycle = (context as? androidx.lifecycle.LifecycleOwner)?.lifecycle
    DisposableEffect(lifecycle, target) {
        if (lifecycle == null) {
            stream.start()
            return@DisposableEffect onDispose {}
        }
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> stream.start()
                Lifecycle.Event.ON_STOP -> stream.stop()
                else -> {}
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val agents = agentsOf(link)
    val here = agents.firstOrNull { it.matches(target) }
    var picking by remember { mutableStateOf(false) }
    // A long press: the terminal's text in a sheet, to select and copy with Android's own handles, or paste.
    var copying by remember(target) { mutableStateOf<String?>(null) }
    LaunchedEffect(view) { view.onLongPress = { copying = view.text() } }
    val ink = Color(0xFFCDD6F4)
    val muted = Color(0xFF9399B2)
    Column(modifier.background(Color(0xFF1E1E2E))) {
        Row(Modifier.fillMaxWidth().background(Color(0xFF181825)).padding(horizontal = 10.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(8.dp).background(statusColour(here?.status ?: "", state), CircleShape))
            Text(
                when {
                    here != null -> "${here.name} · ${here.detail} · ${here.status.ifEmpty { "unknown" }}"
                    state is TerminalStream.State.Attached -> (state as TerminalStream.State.Attached).let { "${it.agent} · ${it.host}/${it.terminal}" }
                    else -> target.key.removePrefix("herdr:")
                },
                Modifier.weight(1f).padding(start = 8.dp), color = ink, fontSize = 13.sp, fontFamily = FontFamily.Monospace,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Box {
                Text("switch ▾", Modifier.clickable { picking = true }.padding(start = 10.dp, top = 4.dp, bottom = 4.dp), color = muted, fontSize = 13.sp)
                DropdownMenu(picking, onDismissRequest = { picking = false }) {
                    if (agents.isEmpty()) DropdownMenuItem(text = { Text("No agents listed yet") }, onClick = { picking = false })
                    for (a in agents) DropdownMenuItem(
                        text = {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(Modifier.size(8.dp).background(statusColour(a.status, null), CircleShape))
                                Column(Modifier.padding(start = 10.dp)) {
                                    Text(a.name + if (a.matches(target)) "  ·  shown" else "", fontSize = 14.sp)
                                    Text("${a.detail} · ${a.status}" + a.worker.optString("title").let { if (it.isNotEmpty()) " · $it" else "" }, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                        },
                        onClick = {
                            picking = false
                            link.openTerminal(a.target)
                        },
                    )
                }
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            AndroidView({ view }, Modifier.fillMaxSize().padding(horizontal = 4.dp))
            val s = state
            if (s !is TerminalStream.State.Attached) Column(
                Modifier.align(Alignment.Center).padding(24.dp).background(Color(0xEE181825), RoundedCornerShape(10.dp)).padding(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    when (s) {
                        is TerminalStream.State.Connecting -> "Attaching…"
                        is TerminalStream.State.Dropped -> "Reconnecting: ${s.reason}"
                        is TerminalStream.State.Closed -> s.reason
                        else -> ""
                    },
                    color = ink, fontSize = 14.sp,
                )
                // When June cannot show it (a session that ended, an old link), Termux can still attach or resume it.
                if (s is TerminalStream.State.Closed && target.link.isNotEmpty()) Text(
                    "open in Termux", Modifier.clickable { Links.termux(context, target.link) }.padding(6.dp), color = Color(0xFF89B4FA), fontSize = 14.sp,
                )
                if (s is TerminalStream.State.Closed) Text("try again", Modifier.clickable { stream.start() }.padding(6.dp), color = Color(0xFF89B4FA), fontSize = 14.sp)
            }
        }
        if (Terminals.keyRow(context) && WindowInsets.isImeVisible) KeyRow(view)
    }
    copying?.let { text -> CopySheet(text, close = { copying = null }, paste = { view.paste(it); copying = null }) }
}

@Composable
private fun CopySheet(text: String, close: () -> Unit, paste: (String) -> Unit) {
    val context = LocalContext.current
    val clipboard = context.getSystemService(android.content.ClipboardManager::class.java)
    val scroll = androidx.compose.foundation.rememberScrollState()
    LaunchedEffect(text) { scroll.scrollTo(scroll.maxValue) }
    androidx.compose.ui.window.Dialog(onDismissRequest = close, properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxSize().padding(12.dp).background(Color(0xFF181825), RoundedCornerShape(10.dp))) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(18.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Select to copy", Modifier.weight(1f), color = Color(0xFF9399B2), fontSize = 13.sp)
                val clip = clipboard?.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()
                if (!clip.isNullOrEmpty()) Text("paste", Modifier.clickable { paste(clip) }.padding(4.dp), color = Color(0xFF89B4FA), fontSize = 14.sp)
                Text("copy all", Modifier.clickable { clipboard?.setPrimaryClip(android.content.ClipData.newPlainText("terminal", text)); close() }.padding(4.dp), color = Color(0xFF89B4FA), fontSize = 14.sp)
                Text("close", Modifier.clickable(onClick = close).padding(4.dp), color = Color(0xFF89B4FA), fontSize = 14.sp)
            }
            androidx.compose.foundation.text.selection.SelectionContainer(Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll).padding(horizontal = 10.dp)) {
                Text(text, color = Color(0xFFCDD6F4), fontSize = 12.sp, fontFamily = FontFamily.Monospace, lineHeight = 15.sp)
            }
        }
    }
}

@Composable
private fun KeyRow(view: TerminalView) {
    var ctrl by remember { mutableStateOf(false) }
    var alt by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { view.onModifiersUsed = { ctrl = false; alt = false } }
    val on = Color(0xFFF9E2AF)
    val off = Color(0xFFCDD6F4)
    Row(Modifier.fillMaxWidth().background(Color(0xFF181825)).heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
        @Composable
        fun key(label: String, lit: Boolean = false, act: () -> Unit) = Text(
            label, Modifier.weight(1f).clickable(onClick = act).padding(vertical = 12.dp), color = if (lit) on else off, fontSize = 14.sp,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        key("esc") { view.press(120, 0) }
        key("ctrl", ctrl) { ctrl = !ctrl; view.ctrl = ctrl }
        key("alt", alt) { alt = !alt; view.alt = alt }
        key("tab") { view.press(64, 0) }
        key("⇧tab") { view.press(64, 1) }
        key("←") { view.press(76, 0) }
        key("↓") { view.press(75, 0) }
        key("↑") { view.press(78, 0) }
        key("→") { view.press(77, 0) }
    }
}

private fun statusColour(status: String, state: TerminalStream.State?): Color = when {
    state is TerminalStream.State.Closed -> Color(0xFF6C7086)
    state is TerminalStream.State.Dropped || state is TerminalStream.State.Connecting -> Color(0xFFF9E2AF)
    status == "working" -> Color(0xFF89B4FA)
    status == "blocked" -> Color(0xFFF38BA8)
    status == "done" -> Color(0xFFA6E3A1)
    status == "idle" -> Color(0xFF9399B2)
    else -> Color(0xFF6C7086)
}
