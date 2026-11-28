package net.suderman.june

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.border
import androidx.compose.runtime.Composable
import kotlinx.coroutines.launch
import android.util.Log
import androidx.compose.foundation.Canvas
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.focus.focusRequester
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import kotlin.math.roundToInt
import androidx.compose.ui.layout.positionOnScreen
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.produceState
import androidx.compose.ui.platform.LocalContext
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The conversation in the assistant session: a plain first pass, the newest at the bottom, the words to send below.
 * The phone's comic strip comes later, from the desktop client's shared decisions; see "What the phone shares with the
 * desktop" in docs/interfaces.org. A tap above the sheet puts June away.
 */
/**
 * This phone's look: the comic strip or the console, as the desktop's window toggles it per device. Kept in the app's
 * preferences, so the session and the full screen agree and the choice outlasts them.
 */
object LookChoice {
    var console by mutableStateOf(false)
        private set
    private var loaded = false

    fun load(context: android.content.Context) {
        if (loaded) return
        loaded = true
        console = context.getSharedPreferences("look", android.content.Context.MODE_PRIVATE).getBoolean("console", false)
    }

    fun set(context: android.content.Context, on: Boolean) {
        console = on
        context.getSharedPreferences("look", android.content.Context.MODE_PRIVATE).edit().putBoolean("console", on).apply()
    }
}

/** The page's palette for this phone's look and Android's dark mode. */
@Composable
fun pagePalette(): Look.Palette {
    val context = LocalContext.current
    remember { LookChoice.load(context) }
    return Look.palette(LookChoice.console, isSystemInDarkTheme())
}

@Composable
fun Conversation(link: Link, locked: Boolean, screen: Screen?, dismiss: () -> Unit, unlock: () -> Unit) {
    val context = LocalContext.current
    val sensor = remember { fingerprintSensor(context) }
    var origin by remember { mutableStateOf(androidx.compose.ui.geometry.Offset.Zero) }
    val palette = pagePalette()
    MaterialTheme(colorScheme = if (palette.dark) darkColorScheme() else lightColorScheme()) {
      // Swipes on the header (Swipes.kt): June full screen opens as the lock-screen prompt does, close puts the sheet
      // away, and an app opens with the sheet stepping aside. While locked only up (unlock) and down (close) work,
      // whatever is set, since no other app opens over the lock screen.
      val swipe = remember { Swipe() }
      val allowed: (Swipes.Direction) -> Boolean = { d ->
          if (locked) d == Swipes.Direction.UP || d == Swipes.Direction.DOWN else Swipes.does(Swipes.get(context, d), fullScreen = false)
      }
      val act: (Swipes.Direction) -> Unit = { d ->
          if (locked) {
              if (d == Swipes.Direction.UP) unlock() else dismiss()
          } else when (val action = Swipes.get(context, d)) {
              Swipes.Action.Full -> unlock()
              Swipes.Action.Close -> dismiss()
              is Swipes.Action.Slot -> Swipes.openSlot(context, action.slot)?.let { android.widget.Toast.makeText(context, it, android.widget.Toast.LENGTH_LONG).show() } ?: dismiss()
              Swipes.Action.None -> {}
          }
      }
      Box(Modifier.fillMaxSize().onGloballyPositioned { origin = it.positionOnScreen() }) {
        SwipeHints(swipe, palette) { d -> if (locked) null else Swipes.get(context, d).takeIf { Swipes.does(it, fullScreen = false) }?.let { Swipes.label(context, it) } }
        Column(Modifier.fillMaxSize()) {
            // Above the sheet a tap puts June away; it gives way as the sheet is swiped up toward full screen.
            Spacer(
                Modifier.fillMaxWidth()
                    .layout { measurable, constraints ->
                        val rise = (-swipe.offset.value.y).coerceAtLeast(0f)
                        val height = (constraints.maxHeight * 0.25f - rise).roundToInt().coerceAtLeast(0)
                        val placeable = measurable.measure(constraints.copy(minHeight = height, maxHeight = height))
                        layout(placeable.width, height) { placeable.place(0, 0) }
                    }
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = dismiss),
            )
            Surface(
                Modifier.weight(1f).fillMaxWidth()
                    .onSizeChanged { swipe.size = it }
                    .graphicsLayer {
                        translationX = swipe.offset.value.x
                        translationY = swipe.offset.value.y.coerceAtLeast(0f)
                    },
                shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
                color = palette.page,
                contentColor = palette.pageInk,
            ) {
                val handle = Modifier.swipeHandle(swipe, allowed, act)
                // A file opened from the strip goes to another app, which this sheet would cover: it hides once that app opens.
                if (locked) Prompt("Unlock to talk to June", unlock, handle) else androidx.compose.runtime.CompositionLocalProvider(LocalLeave provides dismiss) { Sheet(link, screen = screen, fromSheet = true, header = handle) }
            }
        }
        // Where the fingerprint is read: the phone's own reader stays live under the session, and unlocking there
        // shows the conversation at once.
        if (locked && sensor != null) Canvas(Modifier.fillMaxSize()) {
            val centre = androidx.compose.ui.geometry.Offset(sensor[0] - origin.x, sensor[1] - origin.y)
            val r = sensor[2]
            val line = palette.pageInk
            drawCircle(line.copy(alpha = 0.12f), r, centre)
            drawCircle(line.copy(alpha = 0.7f), r, centre, style = Stroke(r * 0.04f))
            for (i in 1..3) {
                val a = r * (0.2f + i * 0.15f)
                drawArc(line.copy(alpha = 0.8f), 200f - i * 8, 140f + i * 16, false, topLeft = centre - androidx.compose.ui.geometry.Offset(a, a), size = androidx.compose.ui.geometry.Size(a * 2, a * 2), style = Stroke(r * 0.05f, cap = StrokeCap.Round))
            }
        }
      }
    }
}

/**
 * The under-display fingerprint sensor's centre and radius in screen pixels: from the framework resource
 * config_udfps_sensor_props (x, y, radius) where a phone sets it, else as the install app read it from SystemUI over
 * ADB (PairActivity); null when neither knows.
 */
private fun fingerprintSensor(context: android.content.Context): FloatArray? = runCatching {
    val system = android.content.res.Resources.getSystem()
    val id = system.getIdentifier("config_udfps_sensor_props", "array", "android")
    val props = if (id != 0) system.getIntArray(id).map { it.toFloat() } else emptyList()
    val known = props.takeIf { it.size >= 3 && it[2] > 0 }
        ?: context.getSharedPreferences("device", android.content.Context.MODE_PRIVATE).getString("fingerprint", null)?.split(",")?.mapNotNull { it.trim().toFloatOrNull() }?.takeIf { it.size == 3 && it[2] > 0 }
    known?.let { floatArrayOf(it[0], it[1], it[2]) }
}.getOrNull()

@Composable
private fun Prompt(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Text(text, style = MaterialTheme.typography.headlineSmall)
    }
}

/**
 * The conversation itself: the status line, the items newest last, and the words to send; `settings` opens June's
 * settings, and `header`, when given, makes the status line a swipe handle (Swipes.kt) with a grab bar above it. A
 * change in `summoned` puts the text field in focus with the keyboard up. It
 * pads itself above the keyboard: neither the app's window (Android 15 and later) nor the session's (set still in
 * JuneSession) moves or shrinks for one.
 */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun Sheet(link: Link, settings: (() -> Unit)? = null, screen: Screen? = null, fromSheet: Boolean = false, header: Modifier? = null, summoned: Int = 0) {
    val list = rememberLazyListState()
    val shown = link.shownItems.filter { !it.private }
    // Stay on the newest item as the conversation grows.
    LaunchedEffect(shown.size, shown.lastOrNull()?.text?.length) { if (shown.isNotEmpty()) list.scrollToItem(shown.size - 1) }
    // The comic strip, from the decisions the phone shares with the desktop; the plain list until they load, or if
    // they cannot.
    val context = LocalContext.current
    val decisions by produceState<Decisions?>(null) {
        value = runCatching { Decisions.load(context) }.onFailure { Log.w(TAG, "decisions did not load: $it") }.getOrNull()
        awaitDispose { value?.close() }
    }
    val avatar = remember { runCatching { Avatar(context) }.onFailure { Log.w(TAG, "avatar set did not load: $it") }.getOrNull() }

    val palette = pagePalette()
    val leave = LocalLeave.current
    var showFollows by remember { mutableStateOf(false) }
    // Tasks Jon dismissed at the signal they had, kept on the phone: calm until the signal changes.
    val prefs = remember { context.getSharedPreferences("status", android.content.Context.MODE_PRIVATE) }
    var seen by remember { mutableStateOf(prefs.getStringSet("seen", emptySet())!!.toSet()) }
    // What she is doing in plain words (strip.mjs status), the tasks she follows a tap away.
    val said by produceState<org.json.JSONObject?>(null, decisions, link.state, link.status, seen) {
        val d = decisions
        value = if (d != null && link.status is LinkStatus.Linked) runCatching { org.json.JSONObject(d.call("strip.status", link.state.raw, link.host, org.json.JSONArray(seen.toList()))) }.getOrNull() else null
    }
    val detail = said?.optJSONArray("detail")
    // A tap on a link in June's words opens it as Links.kt allows, the sheet stepping aside for what opens.
    val links = remember(leave, link) { Links.Handler(context, leave, link::openMoment) }
    // The calendar and search, in place of the strip while open (Browse.kt).
    var browsing by remember { mutableStateOf(false) }
    // The full screen's pages, side by side: the agents board's three pages on the left (hosts, clankers, then activity
    // beside the strip), the strip in the middle, the projects board on the right (Boards.kt). A swipe moves the strip
    // aside to show one; the assistant sheet keeps the strip alone. When agent terminals open in June, the Terminal page
    // comes first, left of hosts, as its tab does (see "Navigation" under "Embedded terminal" in docs/interfaces.org);
    // FIRST is the hosts page. The pager keeps its page across Android remaking the screen, and each board its place.
    val first = if (Terminals.embedded(context)) 1 else 0
    val sections = AgentsSections.size
    val chatPage = sections
    // The projects board's pages follow the strip: agenda, tasks, by project.
    val projectPages = (chatPage + 1) until (chatPage + 1 + ProjectsSections.size)
    val pager = androidx.compose.foundation.pager.rememberPagerState(initialPage = first + chatPage) { first + sections + 1 + ProjectsSections.size }
    var prevFirst by remember { androidx.compose.runtime.mutableIntStateOf(first) }
    LaunchedEffect(first) {
        val delta = first - prevFirst
        prevFirst = first
        if (delta != 0) pager.scrollToPage((pager.currentPage + delta).coerceIn(0, first + sections + ProjectsSections.size))
    }
    val board = pager.currentPage - first
    // The board Back returns to from the Terminal page: the last one settled on.
    var lastBoard by remember { androidx.compose.runtime.mutableIntStateOf(first) }
    LaunchedEffect(pager.settledPage) { if (pager.settledPage >= first) lastBoard = pager.settledPage }
    LaunchedEffect(link.terminalWanted) {
        if (!link.terminalWanted) return@LaunchedEffect
        link.terminalWanted = false
        if (first == 1) pager.scrollToPage(0)
    }
    val pages = androidx.compose.runtime.rememberCoroutineScope()
    // A link asked for a view (the agenda widget, a reminder): jump there; a plain tab jump clears itself so tapping it again works.
    LaunchedEffect(link.requested) {
        val r = link.requested ?: return@LaunchedEffect
        pager.scrollToPage(first + when (r.first) { "agents" -> chatPage - 1; "chat" -> chatPage; else -> chatPage + 1 })
        if (r.second.isEmpty()) link.requested = null
    }
    // Summoned again while this shows: back to the chat, whose field then takes focus. Only a change since this
    // screen opened counts, and each only once.
    var answered by remember { androidx.compose.runtime.mutableIntStateOf(summoned) }
    LaunchedEffect(summoned) { if (summoned != answered) pager.scrollToPage(first + chatPage) }
    // Bumped when the user taps an already-open tab in the bottom bar to jump back to its default subsection.
    var agentsReset by remember { androidx.compose.runtime.mutableIntStateOf(0) }
    var projectsReset by remember { androidx.compose.runtime.mutableIntStateOf(0) }
    // Settling on another section of the same board puts away the sheet the last one had open, as the desktop does.
    var lastSection by remember { androidx.compose.runtime.mutableIntStateOf(pager.settledPage) }
    LaunchedEffect(pager.settledPage) {
        val was = lastSection - first
        val now = pager.settledPage - first
        lastSection = pager.settledPage
        if (was != now && was in AgentsSections.indices && now in AgentsSections.indices) agentsReset++
        if (was != now && was in projectPages && now in projectPages) projectsReset++
    }
    val ready = decisions
    // The boards stay while the link comes back after June was in the background, so their place is kept.
    val boards = !fromSheet && ready != null && (link.status is LinkStatus.Linked || link.agenda != null || link.agents != null)
    val ime = androidx.compose.foundation.layout.WindowInsets.ime
    val nav = androidx.compose.foundation.layout.WindowInsets.navigationBars
    androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalUriHandler provides links) {
    Box(Modifier.fillMaxSize().padding(horizontal = 16.dp).navigationBarsPadding()) {
        // The tab bar stays anchored at the bottom so the keyboard slides over it going up and reveals it going down.
        if (boards) {
            val needs = link.agents?.optJSONArray("needs")?.length() ?: 0
            Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth()) {
                Tabs(
                    board, needs, palette, terminal = board < 0,
                    // The Terminal tab, when terminals open in June: its page, left of the agents board.
                    onTerminal = { if (first == 1) pages.launch { pager.animateScrollToPage(0) } },
                ) { page ->
                    if (board == page) {
                        when (page) {
                            chatPage - 1 -> agentsReset++
                            chatPage -> { browsing = false; link.backToToday() }
                            chatPage + 1 -> projectsReset++
                        }
                    } else pages.launch { pager.animateScrollToPage(first + page) }
                }
            }
        }
        Column(
            Modifier.fillMaxWidth().layout { measurable, constraints ->
                val pad = maxOf(if (boards) TabsHeight.roundToPx() else 0, (ime.getBottom(this) - nav.getBottom(this)).coerceAtLeast(0))
                val h = (constraints.maxHeight - pad).coerceAtLeast(0)
                val placeable = measurable.measure(constraints.copy(minHeight = h, maxHeight = h))
                layout(placeable.width, placeable.height) { placeable.place(0, 0) }
            },
        ) {
        // The status line and follow drawer: pinned across Agents, Chat and Projects, sliding out with the Agents
        // board when the Terminal page comes in so the Terminal page never changes height or forces a resize.
        val statusHeader: @Composable (Modifier) -> Unit = { mod ->
            Column(mod.fillMaxWidth()) {
                Column(Modifier.fillMaxWidth().then(header ?: Modifier)) {
                    if (header != null) Box(
                        Modifier.align(Alignment.CenterHorizontally).padding(top = 8.dp).size(width = 36.dp, height = 4.dp)
                            .background(palette.muted.copy(alpha = 0.5f), RoundedCornerShape(50)),
                    )
                    Row(Modifier.fillMaxWidth().padding(top = if (header != null) 8.dp else 14.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        val ready = decisions
                        if (ready != null && avatar != null) {
                            LiveBadge(link, ready, avatar)
                            Spacer(Modifier.width(8.dp))
                        }
                        val needsYou = detail != null && (0 until detail.length()).any { detail.getJSONObject(it).optBoolean("needsYou") }
                        Text(
                            (said?.optString("text") ?: statusLine(link)).let { if (detail != null && detail.length() > 0) it + if (showFollows) "  ▴" else "  ▾" else it },
                            style = palette.type.meta.copy(color = if (needsYou) palette.accent else palette.muted),
                            maxLines = 2, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f).clickable(enabled = detail != null && detail.length() > 0) { showFollows = !showFollows },
                        )
                        // The look, toggled as the desktop's window toggles it: a quiet word beside settings, checked when on.
                        val on = LookChoice.console
                        Text(
                            if (on) "✓ console" else "console", style = palette.type.meta.copy(color = if (on) palette.pageInk else palette.muted),
                            modifier = Modifier.heightIn(min = 40.dp).clickable { LookChoice.set(context, !on) }.padding(start = 12.dp, top = 11.dp, bottom = 11.dp),
                        )
                        if (settings != null) Text("settings", style = palette.type.meta.copy(color = palette.muted), modifier = Modifier.heightIn(min = 40.dp).clickable(onClick = settings).padding(start = 14.dp, top = 11.dp, bottom = 11.dp))
                    }
                }
                // The tasks she follows, each with where it stands, under the status line while it is open.
                val followed = detail
                if (showFollows && followed != null && followed.length() > 0) {
                    Column(Modifier.fillMaxWidth().padding(bottom = 8.dp).background(palette.field, RoundedCornerShape(8.dp)).padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        for (i in 0 until followed.length()) {
                            val f = followed.getJSONObject(i)
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(f.optString("title") + "  ·  " + f.optString("state"), fontSize = 13.sp, color = if (f.optBoolean("needsYou")) palette.accent else palette.pageInk, fontWeight = if (f.optBoolean("needsYou")) androidx.compose.ui.text.font.FontWeight.Bold else null, modifier = Modifier.weight(1f))
                                if (f.optBoolean("needsYou")) Text(
                                    "dismiss", fontSize = 12.sp, color = palette.muted,
                                    modifier = Modifier.clickable {
                                        // Keep only keys of tasks still followed, so the set never grows past what shows.
                                        val live = (0 until followed.length()).map { followed.getJSONObject(it).optString("key") }.toSet()
                                        seen = (seen.intersect(live) + f.optString("key"))
                                        prefs.edit().putStringSet("seen", seen).apply()
                                    }.padding(start = 10.dp, top = 4.dp, bottom = 4.dp),
                                )
                            }
                        }
                    }
                }
            }
        }
        if (!boards) statusHeader(Modifier)
        // The strip, with its day picker above it, which is the strip's alone.
        val stripPage: @Composable (Modifier) -> Unit = { modifier ->
            Column(modifier) {
                if (link.status is LinkStatus.Linked) DayBar(link, palette, browsing) { browsing = !browsing }
                if (browsing) {
                    Browse(link, palette, close = { browsing = false }, modifier = Modifier.weight(1f).fillMaxWidth())
                } else if (ready != null && LookChoice.console) {
                    ConsoleStrip(link, ready, palette, Modifier.weight(1f).fillMaxWidth())
                } else if (ready != null && avatar != null) {
                    Strip(link, ready, avatar, palette, Modifier.weight(1f).fillMaxWidth())
                } else {
                    LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(shown, key = { it.id }) { ItemRow(it) }
                    }
                }
            }
        }
        // The words to send belong to the chat alone. Leaving it, or putting the keyboard away, lets go of the field.
        val chat = !boards || board == chatPage
        val focus = androidx.compose.ui.platform.LocalFocusManager.current
        val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
        val typing = androidx.compose.foundation.layout.WindowInsets.isImeVisible
        LaunchedEffect(typing) { if (!typing) focus.clearFocus() }
        LaunchedEffect(chat) { if (!chat) { focus.clearFocus(); keyboard?.hide() } }

        // Chat composer state lives above the pager's bottom-bar morph so swiping away and back keeps draft/cursor/attachments.
        var attach by remember(screen) { mutableStateOf(false) }
        var used by remember(screen) { mutableStateOf(false) }
        val offered = screen?.takeUnless { used }
        val showing = offered?.takeIf { attach }
        val waiting = Outbox.items
        val anything = Outbox.draft.isNotBlank() || showing != null || waiting.isNotEmpty()
        val canSend = link.status is LinkStatus.Linked && anything
        val send = {
            if (canSend && link.submit(Outbox.draft, images = Outbox.pictures.map { it.data } + listOfNotNull(showing?.jpeg()), files = Outbox.files)) {
                Outbox.clear()
                if (showing != null) used = true
            }
        }
        // Track in-flight recent-image IDs so rapid taps step cleanly through 1st, 2nd, 3rd newest screenshots.
        val pendingRecent = remember { mutableSetOf<Long>() }
        val addRecent = {
            val already = Outbox.items.mapNotNull { it.mediaId }.toSet() + pendingRecent
            val next = RecentGallery.nextImage(context, already)
            if (next == null) {
                Outbox.notice = "no more recent images"
            } else if (Outbox.pictures.size >= Outbox.MAX_PICTURES) {
                Outbox.notice = "at most ${Outbox.MAX_PICTURES} pictures a message"
            } else {
                pendingRecent.add(next.id)
                val base64 = Outbox.base64()
                Thread {
                    val item = runCatching { Outbox.picture(context, next.uri, "recent-${next.id}.jpg", mediaId = next.id) }.getOrNull()
                    android.os.Handler(android.os.Looper.getMainLooper()).post {
                        pendingRecent.remove(next.id)
                        when {
                            item == null -> Outbox.notice = "recent image could not be read"
                            base64 + item.data.length > Outbox.MAX_BASE64 -> Outbox.notice = "one message carries at most 30 MiB of attachments"
                            else -> { Outbox.notice = ""; Outbox.add(item) }
                        }
                    }
                }.start()
            }
        }
        // The field keeps its cursor; the outbox keeps the words, so they outlast the chat page and the screen.
        var field by remember { mutableStateOf(androidx.compose.ui.text.input.TextFieldValue(Outbox.draft, androidx.compose.ui.text.TextRange(Outbox.draft.length))) }
        LaunchedEffect(Outbox.draft) { if (field.text != Outbox.draft) field = androidx.compose.ui.text.input.TextFieldValue(Outbox.draft, androidx.compose.ui.text.TextRange(Outbox.draft.length)) }
        // Summoned again while this shows: ready to type. Only a change since this screen opened counts, once.
        val words = remember { androidx.compose.ui.focus.FocusRequester() }
        LaunchedEffect(summoned) {
            if (summoned != answered) {
                answered = summoned
                words.requestFocus()
                keyboard?.show()
            }
        }
        val chatAttachments: @Composable () -> Unit = {
            Column(Modifier.fillMaxWidth()) {
                if (offered != null) Row(
                    Modifier.padding(top = 8.dp)
                        .then(if (attach) Modifier.background(palette.field, RoundedCornerShape(8.dp)) else Modifier.border(1.dp, palette.muted, RoundedCornerShape(8.dp)))
                        .clickable { attach = !attach }.padding(6.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (attach) {
                        val thumb = remember(offered) { offered.picture.asImageBitmap() }
                        androidx.compose.foundation.Image(thumb, null, Modifier.size(width = 22.dp, height = 44.dp).clip(RoundedCornerShape(3.dp)))
                        Text("screen from ${offered.app}", fontSize = 13.sp, color = palette.pageInk)
                        Text("✕", fontSize = 15.sp, color = palette.muted, modifier = Modifier.padding(horizontal = 8.dp))
                    } else Text("+ add screen from ${offered.app}", fontSize = 13.sp, color = palette.muted, modifier = Modifier.padding(horizontal = 4.dp))
                }
                if (waiting.isNotEmpty()) Row(
                    Modifier.fillMaxWidth().padding(top = 8.dp).horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    for (item in waiting) Row(
                        Modifier.background(palette.field, RoundedCornerShape(8.dp)).clickable { Outbox.remove(item) }.padding(6.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        val thumb = item.thumb
                        if (thumb != null) {
                            val image = remember(item) { thumb.asImageBitmap() }
                            androidx.compose.foundation.Image(image, null, Modifier.size(44.dp).clip(RoundedCornerShape(3.dp)))
                        } else Text(item.name, fontSize = 13.sp, color = palette.pageInk, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 160.dp))
                        Text("✕", fontSize = 15.sp, color = palette.muted)
                    }
                }
                if (Outbox.notice.isNotEmpty()) Text("not attached: ${Outbox.notice}", color = palette.accent, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
            }
        }
        val chatComposeBar: @Composable (Modifier, Boolean) -> Unit = { mod, framed ->
            ComposeBar(
                value = field,
                onValueChange = { field = it; Outbox.draft = it.text },
                placeholder = if (showing != null) "about this screen..." else "to june...",
                palette = palette,
                canSend = canSend,
                onSend = send,
                onRecentImage = addRecent,
                modifier = mod,
                fieldModifier = Modifier.focusRequester(words),
                framed = framed,
            ) { dismiss ->
                for ((source, label) in listOf("camera" to "camera", "photos" to "photos", "files" to "files")) androidx.compose.material3.DropdownMenuItem(
                    text = { Text(label) },
                    onClick = {
                        dismiss()
                        // The screen goes with the rest if Jon added it: the sheet forgets it once it hides.
                        if (showing != null) {
                            Outbox.add(Outbox.picture(showing.picture, "screen from ${showing.app}"))
                            used = true
                        }
                        AttachActivity.open(context, source, fromSheet)
                        if (fromSheet) leave()
                    },
                )
            }
        }

        if (boards) {
            LaunchedEffect(Unit) { link.wantBoards() }
            // The pager spans the screen's full width, so the Terminal page has every column; the boards keep the
            // conversation's margins and status-header / bottom-bar room inside their pages.
            val edgeToEdge = Modifier.layout { measurable, constraints ->
                val margin = 16.dp.roundToPx()
                val w = constraints.maxWidth + 2 * margin
                val placeable = measurable.measure(constraints.copy(minWidth = w, maxWidth = w))
                layout(constraints.maxWidth, placeable.height) { placeable.place(-margin, 0) }
            }
            val density = androidx.compose.ui.platform.LocalDensity.current
            var headerPx by remember { androidx.compose.runtime.mutableIntStateOf(0) }
            val headerDp = with(density) { headerPx.toDp() }
            var bottomBarPx by remember { androidx.compose.runtime.mutableIntStateOf(with(density) { 60.dp.roundToPx() }) }
            val pos = pager.currentPage + pager.currentPageOffsetFraction - first
            val agentsEnd = (AgentsSections.size - 1).toFloat()
            val chatPos = chatPage.toFloat()
            val projectsStart = projectPages.first.toFloat()
            val headerReveal = if (first == 1) (pos + 1f).coerceIn(0f, 1f) else 1f
            val agentsWeight = if (pos <= chatPos) (1f - (pos - agentsEnd).coerceAtLeast(0f)).coerceIn(0f, 1f) else 0f
            val chatWeight = (1f - kotlin.math.abs(pos - chatPos)).coerceIn(0f, 1f)
            val projectsWeight = if (pos >= chatPos) (1f - (projectsStart - pos).coerceAtLeast(0f)).coerceIn(0f, 1f) else 0f
            val showBottomBar = headerReveal > 0.001f && (!typing || chatWeight > 0.001f)
            val barDp = if (showBottomBar) with(density) { bottomBarPx.toDp() } else 0.dp
            androidx.activity.compose.BackHandler(enabled = board < 0) { pages.launch { pager.animateScrollToPage(lastBoard) } }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                androidx.compose.foundation.pager.HorizontalPager(pager, Modifier.fillMaxSize().then(edgeToEdge), beyondViewportPageCount = 1) { page ->
                    val inset = Modifier.fillMaxSize().padding(top = headerDp, bottom = barDp, start = 16.dp, end = 16.dp)
                    // The boards span their page, keeping the margins inside, so a sheet over them reaches both edges.
                    val boardArea = Modifier.fillMaxSize().padding(top = headerDp, bottom = barDp)
                    when (page - first) {
                        -1 -> {
                            // The terminal asked for, else the last one shown, else the first agent the board lists.
                            val target = link.terminal ?: Terminals.last(context) ?: firstTerminal(link)
                            // One page per terminal: its view and stream belong to that target.
                            if (target != null) androidx.compose.runtime.key(target) {
                                TerminalPage(link, target, palette, active = pager.settledPage == 0, modifier = Modifier.fillMaxSize())
                            } else Box(Modifier.fillMaxSize().background(palette.page), contentAlignment = Alignment.Center) {
                                Text("No agent terminals listed yet", color = palette.muted, fontSize = 14.sp)
                            }
                        }
                        in AgentsSections.indices -> AgentsBoard(link, ready!!, palette, AgentsSections[page - first], boardArea, reset = agentsReset)
                        in projectPages -> ProjectsBoard(link, ready!!, palette, ProjectsSections[page - first - projectPages.first], boardArea, reset = projectsReset)
                        else -> stripPage(inset)
                    }
                }
                if (headerReveal > 0.001f) statusHeader(
                    Modifier.align(Alignment.TopStart)
                        .onSizeChanged { headerPx = it.height }
                        .graphicsLayer { translationX = (1f - headerReveal) * (size.width + 32.dp.toPx()) },
                )
                // Continuous bottom bar: one shared capsule morphing smoothly between Agents sub-nav, Chat compose bar,
                // and Projects sub-nav in 1:1 lockstep with the pager (and sliding in from the right past Terminal).
                if (showBottomBar) {
                    val capsuleShape = if (palette.console) androidx.compose.ui.graphics.RectangleShape else RoundedCornerShape(23.dp)
                    val minBarPx = with(density) { 46.dp.roundToPx() }
                    val showStop = (link.state.running || link.state.compacting) && chatWeight > 0.001f
                    Column(
                        Modifier.align(Alignment.BottomCenter)
                            .fillMaxWidth()
                            .onSizeChanged { bottomBarPx = it.height }
                            .graphicsLayer { translationX = (1f - headerReveal) * (size.width + 32.dp.toPx()) }
                            .background(palette.page),
                    ) {
                        if (chatWeight > 0.001f && (offered != null || waiting.isNotEmpty() || Outbox.notice.isNotEmpty())) {
                            Box(
                                Modifier.fillMaxWidth()
                                    .clipToBounds()
                                    .layout { measurable, constraints ->
                                        val placeable = measurable.measure(constraints)
                                        val h = (placeable.height * chatWeight).roundToInt()
                                        layout(placeable.width, h) { placeable.place(0, 0) }
                                    }
                                    .graphicsLayer {
                                        alpha = kotlin.math.sqrt(chatWeight)
                                        translationX = (chatPos - pos) * (size.width + 16.dp.toPx())
                                    },
                            ) { chatAttachments() }
                        }
                        Row(
                            Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 4.dp),
                            verticalAlignment = Alignment.Bottom,
                        ) {
                            Box(
                                Modifier.weight(1f)
                                    .heightIn(min = 46.dp)
                                    .clip(capsuleShape)
                                    .background(palette.field, capsuleShape)
                                    .border(1.dp, palette.rule, capsuleShape),
                                contentAlignment = Alignment.BottomCenter,
                            ) {
                                if (agentsWeight > 0.001f) {
                                    val clankers = link.agents?.optJSONArray("roster")?.length() ?: 0
                                    val needs = link.agents?.optJSONArray("needs")?.length() ?: 0
                                    SectionBar(
                                        listOf("hosts", if (clankers > 0) "clankers $clankers" else "clankers", "activity"),
                                        pos.coerceIn(0f, agentsEnd),
                                        palette,
                                        badges = mapOf(AgentsSections.indexOf("activity") to needs),
                                        modifier = Modifier.graphicsLayer {
                                            translationX = (agentsEnd - pos).coerceAtMost(0f) * (size.width + 16.dp.toPx())
                                            alpha = kotlin.math.sqrt(agentsWeight)
                                        },
                                        framed = false,
                                    ) { i ->
                                        if (agentsWeight > 0.5f) {
                                            if (board == i) agentsReset++ else pages.launch { pager.animateScrollToPage(first + i) }
                                        }
                                    }
                                }
                                if (chatWeight > 0.001f) {
                                    chatComposeBar(
                                        Modifier
                                            .layout { measurable, constraints ->
                                                val placeable = measurable.measure(constraints)
                                                val h = (minBarPx + (placeable.height - minBarPx) * chatWeight).roundToInt().coerceAtLeast(minBarPx)
                                                layout(placeable.width, h) { placeable.place(0, h - placeable.height) }
                                            }
                                            .graphicsLayer {
                                                translationX = (chatPos - pos) * (size.width + 16.dp.toPx())
                                                alpha = kotlin.math.sqrt(chatWeight)
                                            },
                                        false,
                                    )
                                }
                                if (projectsWeight > 0.001f) {
                                    SectionBar(
                                        ProjectsLabels,
                                        (pos - projectsStart).coerceIn(0f, (ProjectsSections.size - 1).toFloat()),
                                        palette,
                                        modifier = Modifier.graphicsLayer {
                                            translationX = (projectsStart - pos).coerceAtLeast(0f) * (size.width + 16.dp.toPx())
                                            alpha = kotlin.math.sqrt(projectsWeight)
                                        },
                                        framed = false,
                                    ) { i ->
                                        if (projectsWeight > 0.5f) {
                                            if (board == projectPages.first + i) projectsReset++ else pages.launch { pager.animateScrollToPage(first + projectPages.first + i) }
                                        }
                                    }
                                }
                            }
                            if (showStop) Box(
                                Modifier
                                    .layout { measurable, constraints ->
                                        val placeable = measurable.measure(constraints)
                                        val gap = (8.dp.toPx() * chatWeight).roundToInt()
                                        val w = (placeable.width * chatWeight).roundToInt()
                                        layout(gap + w, placeable.height) { placeable.place(gap, 0) }
                                    }
                                    .graphicsLayer {
                                        alpha = kotlin.math.sqrt(chatWeight)
                                        val s = 0.7f + 0.3f * chatWeight
                                        scaleX = s; scaleY = s
                                    }
                                    .padding(bottom = 5.dp).size(36.dp)
                                    .background(palette.accent, androidx.compose.foundation.shape.CircleShape)
                                    .clickable(enabled = chatWeight > 0.5f, onClick = link::stop),
                                contentAlignment = Alignment.Center,
                            ) { androidx.compose.material3.Icon(StopSquareIcon, "Stop", Modifier.size(18.dp), tint = if (palette.dark) palette.page else Color.White) }
                        }
                    }
                }
            }
        } else stripPage(Modifier.weight(1f).fillMaxWidth())
        if (link.notice.isNotEmpty()) Text(link.notice, color = Color(0xFFFFD36B), fontSize = 13.sp, modifier = Modifier.padding(vertical = 4.dp))
        if (!boards) {
            chatAttachments()
            Row(Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 10.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                chatComposeBar(Modifier.weight(1f), true)
                if (link.state.running || link.state.compacting) Box(
                    Modifier.padding(bottom = 5.dp).size(36.dp).background(palette.accent, androidx.compose.foundation.shape.CircleShape).clickable(onClick = link::stop),
                    contentAlignment = Alignment.Center,
                ) { androidx.compose.material3.Icon(StopSquareIcon, "Stop", Modifier.size(18.dp), tint = if (palette.dark) palette.page else Color.White) }
            }
        }
    }
    }
    }
}

private fun statusLine(link: Link): String = when (val s = link.status) {
    LinkStatus.Unpaired -> "not paired: open June's settings to pair this phone"
    LinkStatus.Connecting -> "connecting…"
    LinkStatus.Refused -> "pairing needed: this phone's token was refused"
    is LinkStatus.Offline -> "offline, retrying: ${s.reason}"
    is LinkStatus.Linked -> "june · " + (link.state.activity.ifEmpty { "on ${link.host}" }) +
        if (link.state.following > 0) " · following ${link.state.following}" else ""
}

@Composable
private fun ItemRow(item: Item) {
    when (item.kind) {
        "user" -> Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
            Text(
                item.text,
                Modifier.widthIn(max = 300.dp).background(Color(0xFF263A66), RoundedCornerShape(16.dp)).padding(horizontal = 14.dp, vertical = 10.dp),
            )
        }
        "assistant" -> if (item.error.isNotEmpty()) Text("(${item.error})", color = Color(0xFFFF8F80)) else Text(
            orgText(item.text + if (item.streaming) " ▍" else "", code = Color(0xFFE9C46A)),
            color = Color(0xFFECE6DA),
        )
        "tool" -> Text(
            (if (item.status == "error") "✗ " else if (item.status == "running") "… " else "✓ ") + item.name + if (item.summary.isNotEmpty()) " · ${item.summary}" else "",
            color = Color(0xFF7D8697), fontFamily = FontFamily.Monospace, fontSize = 12.sp, maxLines = 1,
        )
        "patter" -> Text(item.text, color = Color(0xFF7D8697), fontStyle = FontStyle.Italic, fontSize = 13.sp)
        else -> Text(item.text, color = Color(0xFF9AA0AE), fontSize = 13.sp)
    }
}
