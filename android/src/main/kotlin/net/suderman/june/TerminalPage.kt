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
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
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
    /** Bumped when a setting changes so open screens recompose without restarting June. */
    var version by mutableIntStateOf(0)
        private set

    /** Agent terminals open inside June by default; otherwise the Terminal app and Termux open them. */
    fun embedded(context: Context): Boolean {
        version
        return prefs(context).getBoolean("embedded", true)
    }
    fun setEmbedded(context: Context, on: Boolean) {
        prefs(context).edit().putBoolean("embedded", on).apply()
        version++
    }

    /** A row of Esc, Ctrl, Alt, Tab and arrows over the keyboard, for keyboards that lack them. */
    fun keyRow(context: Context): Boolean {
        version
        return prefs(context).getBoolean("keyRow", false)
    }
    fun setKeyRow(context: Context, on: Boolean) {
        prefs(context).edit().putBoolean("keyRow", on).apply()
        version++
    }

    /** Terminal font size in sp, adjusted by pinch-to-zoom. */
    fun fontSize(context: Context): Float = prefs(context).getFloat("fontSp", TerminalView.DEFAULT_SP).coerceIn(TerminalView.MIN_SP, TerminalView.MAX_SP)
    fun setFontSize(context: Context, sp: Float) = prefs(context).edit().putFloat("fontSp", sp.coerceIn(TerminalView.MIN_SP, TerminalView.MAX_SP)).apply()

    /** What is written in each terminal's compose box and not yet sent, while the app runs. */
    val drafts = HashMap<String, String>()

    fun last(context: Context): TerminalTarget? {
        val p = prefs(context)
        val host = p.getString("host", null) ?: return null
        return TerminalTarget(host, p.getString("terminal", "") ?: "", p.getString("link", "") ?: "")
    }

    fun remember(context: Context, t: TerminalTarget) =
        prefs(context).edit().putString("host", t.host).putString("terminal", t.terminal).putString("link", t.link).apply()

    fun clearLast(context: Context) =
        prefs(context).edit().remove("host").remove("terminal").remove("link").apply()
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
fun TerminalPage(link: Link, target: TerminalTarget, palette: Look.Palette, active: Boolean, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var state by remember(target) { mutableStateOf<TerminalStream.State>(TerminalStream.State.Connecting) }
    val view = remember(target) { TerminalView(context, Terminals.fontSize(context)) }
    val stream = remember(target) { TerminalStream(context, target, view) { state = it } }
    var grid by remember(target) { mutableIntStateOf(0) }
    var zoomingSp by remember(target) { mutableStateOf<Float?>(null) }
    DisposableEffect(target) {
        Terminals.remember(context, target)
        view.onGrid = { c, r, _, _ -> grid = c * 10_000 + r }
        view.onFontSize = { sp -> Terminals.setFontSize(context, sp) }
        view.onZooming = { sp -> zoomingSp = sp }
        onDispose {
            stream.release()
            view.release()
        }
    }
    // One resize once the size settles, and only while this page is active: never resize the terminal from off-tab.
    LaunchedEffect(grid, active) {
        if (!active || grid == 0) return@LaunchedEffect
        delay(150)
        stream.resize(grid / 10_000, grid % 10_000)
    }
    val lifecycle = (context as? androidx.lifecycle.LifecycleOwner)?.lifecycle
    // Attached only while the page is the one on show and the app is started: a page drawn beside the agents board
    // during a swipe must not take the terminal's size from the desktop. Leaving for another board releases focus at
    // once and waits a few seconds before detaching, so peeking at a board and swiping back keeps the live stream.
    val shown by androidx.compose.runtime.rememberUpdatedState(active)
    LaunchedEffect(active) {
        if (active) {
            if (lifecycle == null || lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                stream.start()
                stream.focus(true)
            }
        } else {
            stream.focus(false)
            view.hideKeyboard()
            view.clearFocus()
            delay(5_000)
            stream.stop()
        }
    }
    DisposableEffect(lifecycle, target) {
        if (lifecycle == null) return@DisposableEffect onDispose {}
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> if (shown) { stream.start(); stream.focus(true) }
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
    // The keyboard goes first, so the sheet has the whole screen for the history.
    LaunchedEffect(view) { view.onLongPress = { view.hideKeyboard(); copying = view.text().trimEnd() } }
    // Files for the agent (see "Files and screenshots" under "Embedded terminal" in docs/interfaces.org): each goes
    // beside its terminal once attached, and its path is pasted where the cursor is, as dropping a file on a desktop
    // terminal pastes it. Picked while the picker had June stopped, they wait for the stream to attach again.
    val queue = remember(target) { androidx.compose.runtime.mutableStateListOf<Drop>() }
    var note by remember(target) { mutableStateOf("") }
    var sending by remember(target) { mutableIntStateOf(0) }
    fun take(read: () -> Pair<List<Drop>, List<String>>) = Thread {
        val (drops, refused) = read()
        view.post {
            queue.addAll(drops)
            if (refused.isNotEmpty()) note = refused.joinToString("; ")
        }
    }.start()
    val photos = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia(10)) { uris ->
        if (uris.isNotEmpty()) take { Drops.read(context, uris) }
    }
    val files = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) take { Drops.read(context, uris) }
    }
    LaunchedEffect(view) {
        view.onImage = { info, flags ->
            take {
                if (flags and android.view.inputmethod.InputConnection.INPUT_CONTENT_GRANT_READ_URI_PERMISSION != 0) runCatching { info.requestPermission() }
                try {
                    Drops.read(context, listOf(info.contentUri), info.description.getMimeType(0))
                } finally {
                    runCatching { info.releasePermission() }
                }
            }
        }
    }
    val attached = state is TerminalStream.State.Attached
    LaunchedEffect(attached, queue.size) {
        if (!attached || queue.isEmpty()) return@LaunchedEffect
        val batch = queue.toList()
        queue.clear()
        for (drop in batch) {
            sending++
            note = "sending ${drop.name}…"
            stream.put(drop) { path, error ->
                sending--
                if (path != null) {
                    view.pastePath(path)
                    if (sending == 0) note = ""
                } else note = "${drop.name}: $error"
            }
        }
    }
    val ink = Color(0xFFCDD6F4)
    val muted = Color(0xFF9399B2)
    val action = Color(0xFF89B4FA)
    var attaching by remember { mutableStateOf(false) }
    var confirmClose by remember(target) { mutableStateOf(false) }
    var closing by remember(target) { mutableStateOf(false) }
    // Whether the compose box has the keyboard; a tap on the terminal takes it back.
    var composing by remember { mutableStateOf(false) }
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    LaunchedEffect(view) { view.onTap = { focus.clearFocus(true); stream.focus(true) } }
    // A pointer target over its whole area, so no tap falls through to the board beneath.
    Box(modifier) {
    Column(Modifier.fillMaxSize().background(Color(0xFF1E1E2E)).pointerInput(Unit) { awaitPointerEventScope { while (true) awaitPointerEvent() } }) {
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
            if (attached) Text(
                "✕",
                Modifier.clickable(enabled = !closing) { confirmClose = true }.padding(start = 12.dp, end = 2.dp, top = 4.dp, bottom = 4.dp),
                color = muted,
                fontSize = 13.sp,
            )
        }
        // Files another app shared, waiting for Jon to send them here or switch first; and how sending is going.
        val shared = Drops.shared
        if (shared.isNotEmpty() || Drops.notice.isNotEmpty() || note.isNotEmpty()) Column(
            Modifier.fillMaxWidth().background(Color(0xFF181825)).padding(horizontal = 10.dp, vertical = 4.dp),
        ) {
            if (shared.isNotEmpty()) Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "shared: " + shared.joinToString(", ") { it.name }, Modifier.weight(1f), color = ink, fontSize = 13.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text("send here", Modifier.clickable { queue.addAll(shared); shared.clear() }.padding(6.dp), color = action, fontSize = 13.sp)
                Text("✕", Modifier.clickable { shared.clear() }.padding(6.dp), color = muted, fontSize = 13.sp)
            }
            val said = listOf(Drops.notice, note).filter { it.isNotEmpty() }.joinToString("; ")
            if (said.isNotEmpty()) Text(said, Modifier.clickable { Drops.notice = ""; note = "" }.padding(vertical = 2.dp), color = muted, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        // Keep the terminal sized for a one-line compose bar: when a long message wraps to 2..6 lines, the compose
        // bar expands upward over the bottom of the terminal instead of resizing the grid and forcing the agent to redraw.
        var oneLineBarPx by remember { mutableIntStateOf(0) }
        val oneLineBarDp = with(androidx.compose.ui.platform.LocalDensity.current) { oneLineBarPx.toDp() }
        var draft by remember(target) { mutableStateOf(Terminals.drafts[target.key] ?: "") }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            Box(Modifier.fillMaxSize().padding(bottom = oneLineBarDp)) {
                AndroidView({ view }, Modifier.fillMaxSize().clipToBounds())
                zoomingSp?.let { sp ->
                    Text(
                        "%.1f sp".format(sp),
                        Modifier.align(Alignment.TopCenter).padding(top = 12.dp)
                            .background(Color(0xDD181825), RoundedCornerShape(8.dp))
                            .padding(horizontal = 10.dp, vertical = 4.dp),
                        color = ink, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
                    )
                }
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
            Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth()) {
                if (Terminals.keyRow(context) && WindowInsets.isImeVisible && !composing) KeyRow(view)
                // Subtle top hairline so an expanded multi-line compose bar separates cleanly from the terminal behind it.
                Box(Modifier.fillMaxWidth().heightIn(min = 1.dp, max = 1.dp).background(Color(0xFF313244)))
                // The compose bar, by the keyboard: + attaches, and the box writes a message with the keyboard's full help
                // (autocorrect, moving the cursor, selecting), sent as one paste and then Enter. Tapping the terminal types
                // into it directly, for keys and shortcuts.
                Row(
                    Modifier.fillMaxWidth().background(Color(0xFF181825)).onSizeChanged { size ->
                        if (draft.isEmpty() || oneLineBarPx == 0 || size.height < oneLineBarPx) oneLineBarPx = size.height
                    }.padding(horizontal = 4.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    Box {
                        Box(
                            Modifier.padding(start = 2.dp, end = 6.dp, bottom = 4.dp).size(40.dp).background(Color(0xFF313244), CircleShape)
                                .clickable { attaching = true },
                            contentAlignment = Alignment.Center,
                        ) { androidx.compose.material3.Icon(AttachIcon, "Attach", Modifier.size(20.dp), tint = ink) }
                        DropdownMenu(attaching, onDismissRequest = { attaching = false }) {
                            DropdownMenuItem(text = { Text("Photos and screenshots") }, onClick = {
                                attaching = false
                                photos.launch(androidx.activity.result.PickVisualMediaRequest(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageOnly))
                            })
                            DropdownMenuItem(text = { Text("Files") }, onClick = { attaching = false; files.launch(arrayOf("*/*")) })
                        }
                    }
                    val fieldStyle = androidx.compose.ui.text.TextStyle(color = ink, fontSize = 15.sp, lineHeight = 20.sp)
                    androidx.compose.foundation.text.BasicTextField(
                        draft, { draft = it; Terminals.drafts[target.key] = it },
                        Modifier.weight(1f).padding(vertical = 4.dp).background(Color(0xFF1E1E2E), RoundedCornerShape(18.dp))
                            .padding(horizontal = 14.dp, vertical = 9.dp).onFocusChanged { composing = it.isFocused },
                        textStyle = fieldStyle,
                        cursorBrush = androidx.compose.ui.graphics.SolidColor(ink),
                        maxLines = 6,
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Sentences),
                        // The hint in the field's own style: a taller one would change the bar's height, and so the terminal's
                        // rows, with the first letter typed or the last one deleted, making the program redraw.
                        decorationBox = { field -> Box { if (draft.isEmpty()) androidx.compose.foundation.text.BasicText("Message the agent", style = fieldStyle.copy(color = muted)); field() } },
                    )
                    val ready = draft.isNotBlank() && attached
                    Box(
                        Modifier.padding(start = 6.dp, end = 2.dp, bottom = 4.dp).size(40.dp)
                            .background(if (ready) action else Color(0xFF313244), CircleShape)
                            .clickable(enabled = ready) {
                                view.send(draft.trimEnd())
                                draft = ""
                                Terminals.drafts.remove(target.key)
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        androidx.compose.material3.Icon(SendIcon, "Send", Modifier.size(20.dp), tint = if (ready) Color(0xFF1E1E2E) else muted)
                    }
                }
            }
        }
    }
    if (confirmClose) {
        val busy = here?.status == "working" || here?.worker?.optString("task")?.isNotEmpty() == true
        val label = here?.let { "${it.name} (${it.detail})" } ?: target.key.removePrefix("herdr:")
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmClose = false },
            title = { Text("Close pane?") },
            text = {
                Text(
                    if (busy) "$label is ${if (here?.status == "working") "currently working" else "linked to a task"}. Closing kills its terminal and removes the pane without changing Org task state."
                    else "End the terminal program and remove $label from Herdr?",
                )
            },
            dismissButton = { androidx.compose.material3.TextButton(onClick = { confirmClose = false }) { Text("Cancel") } },
            confirmButton = {
                androidx.compose.material3.TextButton(
                    onClick = {
                        confirmClose = false
                        closing = true
                        note = "closing pane…"
                        val next = agents.firstOrNull { !it.matches(target) }?.target
                        stream.kill { err ->
                            closing = false
                            if (err != null) {
                                note = "close failed: $err"
                            } else {
                                Terminals.drafts.remove(target.key)
                                if (next != null) link.openTerminal(next)
                                else {
                                    Terminals.clearLast(context)
                                    link.terminal = null
                                    link.wantBoards()
                                }
                            }
                        }
                    },
                ) { Text("Close pane", color = Color(0xFFF38BA8)) }
            },
        )
    }
    // Over the page itself rather than in a window of its own, so it grows with the page as the keyboard goes down.
    copying?.let { text ->
        androidx.activity.compose.BackHandler { copying = null }
        CopySheet(
            text, view, Modifier.matchParentSize(), close = { copying = null }, paste = { view.paste(it); copying = null },
            pasteFile = { uri -> take { Drops.read(context, listOf(uri)) }; copying = null },
            resetZoom = { view.setFontSize(TerminalView.DEFAULT_SP); copying = null },
        )
    }
    }
}

/**
 * The terminal's text with its history, to select with Android's own handles: over the whole page, in the terminal's face at
 * its size, cell width and line height, so each line sits as it did on the terminal.
 */
@Composable
private fun CopySheet(text: String, view: TerminalView, modifier: Modifier, close: () -> Unit, paste: (String) -> Unit, pasteFile: (android.net.Uri) -> Unit, resetZoom: () -> Unit) {
    val context = LocalContext.current
    val density = androidx.compose.ui.platform.LocalDensity.current
    val clipboard = context.getSystemService(android.content.ClipboardManager::class.java)
    val scroll = androidx.compose.foundation.rememberScrollState()
    val style = remember(view, view.textSize) {
        val advance = android.graphics.Paint().apply { typeface = view.face; textSize = view.textSize }.measureText("M")
        with(density) {
            androidx.compose.ui.text.TextStyle(
                color = Color(0xFFCDD6F4),
                fontFamily = FontFamily(androidx.compose.ui.text.font.Typeface(view.face)),
                fontSize = view.textSize.toSp(),
                lineHeight = view.cellHeight.toFloat().toSp(),
                letterSpacing = (view.cellWidth - advance).toSp(),
                lineHeightStyle = androidx.compose.ui.text.style.LineHeightStyle(
                    androidx.compose.ui.text.style.LineHeightStyle.Alignment.Center, androidx.compose.ui.text.style.LineHeightStyle.Trim.None,
                ),
            )
        }
    }
    // Half a cell spare, so rounding never wraps a line that filled the terminal.
    val width = with(density) { (view.cols.coerceAtLeast(1) * view.cellWidth + view.cellWidth / 2).toDp() }
    run {
        Column(modifier.background(Color(0xFF1E1E2E)).pointerInput(Unit) { awaitPointerEventScope { while (true) awaitPointerEvent() } }) {
            Row(Modifier.fillMaxWidth().background(Color(0xFF181825)).padding(horizontal = 10.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Select to copy", Modifier.weight(1f), color = Color(0xFF9399B2), fontSize = 13.sp)
                val item = clipboard?.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)
                // A copied image or file goes to the agent as a file; anything else pastes as text.
                val uri = item?.uri?.takeIf { it.scheme == "content" }
                val clip = if (uri == null) item?.coerceToText(context)?.toString() else null
                if (uri != null) Text("paste file", Modifier.clickable { pasteFile(uri) }.padding(6.dp), color = Color(0xFF89B4FA), fontSize = 14.sp)
                else if (!clip.isNullOrEmpty()) Text("paste", Modifier.clickable { paste(clip) }.padding(6.dp), color = Color(0xFF89B4FA), fontSize = 14.sp)
                if (kotlin.math.abs(view.fontSp - TerminalView.DEFAULT_SP) > 0.3f) Text("reset zoom", Modifier.clickable(onClick = resetZoom).padding(6.dp), color = Color(0xFF89B4FA), fontSize = 14.sp)
                Text("copy all", Modifier.clickable { clipboard?.setPrimaryClip(android.content.ClipData.newPlainText("terminal", text)); close() }.padding(6.dp), color = Color(0xFF89B4FA), fontSize = 14.sp)
                Text("close", Modifier.clickable(onClick = close).padding(6.dp), color = Color(0xFF89B4FA), fontSize = 14.sp)
            }
            // Scrolled from the bottom, so the latest lines stay in view whatever the sheet's height.
            Box(Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll, reverseScrolling = true), contentAlignment = Alignment.TopCenter) {
                androidx.compose.foundation.text.selection.SelectionContainer {
                    Text(text, Modifier.width(width), style = style)
                }
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

/** A paperclip, as Material's Attach File icon draws it. */
private val AttachIcon: androidx.compose.ui.graphics.vector.ImageVector by lazy {
    androidx.compose.ui.graphics.vector.ImageVector.Builder("Attach", 24.dp, 24.dp, 24f, 24f)
        .addPath(
            androidx.compose.ui.graphics.vector.PathParser().parsePathString(
                "M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z",
            ).toNodes(),
            fill = androidx.compose.ui.graphics.SolidColor(Color.White),
        ).build()
}

/** A paper plane, as Material's Send icon draws it. */
private val SendIcon: androidx.compose.ui.graphics.vector.ImageVector by lazy {
    androidx.compose.ui.graphics.vector.ImageVector.Builder("Send", 24.dp, 24.dp, 24f, 24f)
        .addPath(
            androidx.compose.ui.graphics.vector.PathParser().parsePathString("M2.01 21L23 12 2.01 3 2 10l15 2-15 2z").toNodes(),
            fill = androidx.compose.ui.graphics.SolidColor(Color.White),
        ).build()
}
