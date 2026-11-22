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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
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
              is Swipes.Action.App -> Swipes.open(context, action.pkg)?.let { android.widget.Toast.makeText(context, it, android.widget.Toast.LENGTH_LONG).show() } ?: dismiss()
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
    // The full screen's pages, side by side: the agents board on the left, the strip in the middle, the projects board
    // on the right (Boards.kt). A swipe moves the strip aside to show one; the assistant sheet keeps the strip alone.
    // The pager keeps its page across Android remaking the screen, and each board its place.
    val pager = androidx.compose.foundation.pager.rememberPagerState(initialPage = 1) { 3 }
    val pages = androidx.compose.runtime.rememberCoroutineScope()
    // A link asked for a board (the agenda widget, a reminder): show it; the board opens the task.
    LaunchedEffect(link.requested) { link.requested?.let { pager.scrollToPage(if (it.first == "agents") 0 else 2) } }
    // Summoned again while this shows: back to the chat, whose field then takes focus. Only a change since this
    // screen opened counts, and each only once.
    var answered by remember { androidx.compose.runtime.mutableIntStateOf(summoned) }
    LaunchedEffect(summoned) { if (summoned != answered) pager.scrollToPage(1) }
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
                Tabs(pager.currentPage, needs, palette) { page -> pages.launch { pager.animateScrollToPage(page) } }
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
                color = if (needsYou) palette.accent else palette.muted, fontSize = 13.sp, fontFamily = if (LookChoice.console) FontFamily.Monospace else null,
                maxLines = 2, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).clickable(enabled = detail != null && detail.length() > 0) { showFollows = !showFollows },
            )
            // The look, toggled as the desktop's window toggles it: outlined when off, filled when on.
            val on = LookChoice.console
            Text(
                "console", fontSize = 12.sp, color = if (on) palette.page else palette.pageInk,
                modifier = Modifier.padding(start = 12.dp).background(if (on) palette.pageInk else Color.Transparent, RoundedCornerShape(50))
                    .border(1.5.dp, palette.pageInk, RoundedCornerShape(50)).clickable { LookChoice.set(context, !on) }.padding(horizontal = 10.dp, vertical = 3.dp),
            )
            if (settings != null) Text("settings", color = palette.muted, fontSize = 13.sp, modifier = Modifier.clickable(onClick = settings).padding(start = 12.dp))
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
        // The strip, with its day picker above it, which is the strip's alone.
        val stripPage: @Composable (Modifier) -> Unit = { modifier ->
            Column(modifier) {
                if (link.status is LinkStatus.Linked) DayBar(link, palette, browsing) { browsing = !browsing }
                if (browsing) {
                    Browse(link, palette, close = { browsing = false }, modifier = Modifier.weight(1f).fillMaxWidth())
                } else if (ready != null && LookChoice.console) {
                    ConsoleStrip(link, ready, palette, Modifier.weight(1f).fillMaxWidth())
                } else if (ready != null && avatar != null) {
                    Strip(link, ready, avatar, Modifier.weight(1f).fillMaxWidth())
                } else {
                    LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(shown, key = { it.id }) { ItemRow(it) }
                    }
                }
            }
        }
        // The words to send belong to the chat alone. Leaving it, or putting the keyboard away, lets go of the field.
        val chat = !boards || pager.currentPage == 1
        val focus = androidx.compose.ui.platform.LocalFocusManager.current
        val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
        val typing = androidx.compose.foundation.layout.WindowInsets.isImeVisible
        LaunchedEffect(typing) { if (!typing) focus.clearFocus() }
        LaunchedEffect(chat) { if (!chat) { focus.clearFocus(); keyboard?.hide() } }
        if (boards) {
            LaunchedEffect(Unit) { link.wantBoards() }
            androidx.compose.foundation.pager.HorizontalPager(pager, Modifier.weight(1f).fillMaxWidth(), beyondViewportPageCount = 1, pageSpacing = 16.dp) { page ->
                when (page) {
                    0 -> AgentsBoard(link, ready!!, palette, Modifier.fillMaxSize())
                    2 -> ProjectsBoard(link, ready!!, palette, Modifier.fillMaxSize())
                    else -> stripPage(Modifier.fillMaxSize())
                }
            }
        } else stripPage(Modifier.weight(1f).fillMaxWidth())
        if (link.notice.isNotEmpty()) Text(link.notice, color = Color(0xFFFFD36B), fontSize = 13.sp, modifier = Modifier.padding(vertical = 4.dp))
        if (chat) {
        // The screen she was summoned over, offered for the next message: off until Jon adds it, since most messages do
        // not need the picture's tokens; gone once sent.
        var attach by remember(screen) { mutableStateOf(false) }
        var used by remember(screen) { mutableStateOf(false) }
        val offered = screen?.takeUnless { used }
        val showing = offered?.takeIf { attach }
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
        // Pictures and files waiting for the next message, each removable.
        val waiting = Outbox.items
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
        // One rounded field, as Muse has it: the attach button inside on the left, and no send button, since return
        // sends; alt+return starts a new line.
        Row(Modifier.fillMaxWidth().padding(top = 10.dp, bottom = if (boards) 4.dp else 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            var choosing by remember { mutableStateOf(false) }
            val send = {
                val anything = Outbox.draft.isNotBlank() || showing != null || waiting.isNotEmpty()
                if (link.status is LinkStatus.Linked && anything && link.submit(Outbox.draft, images = Outbox.pictures.map { it.data } + listOfNotNull(showing?.jpeg()), files = Outbox.files)) {
                    Outbox.clear()
                    if (showing != null) used = true
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
            androidx.compose.material3.TextField(
                field, { field = it; Outbox.draft = it.text },
                Modifier.weight(1f).focusRequester(words).onPreviewKeyEvent { e ->
                    if (e.key != Key.Enter && e.key != Key.NumPadEnter) return@onPreviewKeyEvent false
                    if (e.type == KeyEventType.KeyDown) {
                        if (e.isAltPressed || e.isShiftPressed) {
                            val at = field.selection
                            val text = field.text.replaceRange(at.min, at.max, "\n")
                            field = androidx.compose.ui.text.input.TextFieldValue(text, androidx.compose.ui.text.TextRange(at.min + 1))
                            Outbox.draft = text
                        } else send()
                    }
                    true
                },
                placeholder = { Text(if (showing != null) "about this screen…" else "to june…") },
                leadingIcon = {
                    Box {
                        Text("+", fontSize = 24.sp, color = palette.pageInk, modifier = Modifier.clickable { choosing = true }.padding(horizontal = 10.dp, vertical = 2.dp))
                        androidx.compose.material3.DropdownMenu(choosing, { choosing = false }) {
                            for ((source, label) in listOf("camera" to "camera", "photos" to "photos", "files" to "files")) androidx.compose.material3.DropdownMenuItem(
                                text = { Text(label) },
                                onClick = {
                                    choosing = false
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
                },
                maxLines = 5,
                shape = RoundedCornerShape(24.dp),
                colors = androidx.compose.material3.TextFieldDefaults.colors(
                    focusedContainerColor = palette.field, unfocusedContainerColor = palette.field,
                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
                    focusedTextColor = palette.pageInk, unfocusedTextColor = palette.pageInk,
                    focusedPlaceholderColor = palette.muted, unfocusedPlaceholderColor = palette.muted,
                ),
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Send),
                keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSend = { send() }),
            )
            if (link.state.running || link.state.compacting) OutlinedButton(onClick = link::stop) { Text("Stop") }
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
