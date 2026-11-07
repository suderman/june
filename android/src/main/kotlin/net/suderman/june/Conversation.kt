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
import androidx.compose.foundation.layout.imePadding
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
import androidx.compose.material3.Button
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
import android.util.Log
import androidx.compose.foundation.Canvas
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionOnScreen
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.produceState
import androidx.compose.ui.platform.LocalContext
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
 * The phone's comic strip comes later, from the overlay's shared decisions; see "What the phone shares with the
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
      Box(Modifier.fillMaxSize().onGloballyPositioned { origin = it.positionOnScreen() }) {
        Column(Modifier.fillMaxSize()) {
            Spacer(
                Modifier.weight(0.25f).fillMaxWidth()
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = dismiss),
            )
            Surface(
                Modifier.weight(0.75f).fillMaxWidth(),
                shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
                color = palette.page,
                contentColor = palette.pageInk,
            ) {
                // A file opened from the strip goes to another app, which this sheet would cover: it hides once that app opens.
                if (locked) Prompt("Unlock to talk to June", unlock) else androidx.compose.runtime.CompositionLocalProvider(LocalLeave provides dismiss) { Sheet(link, screen = screen, fromSheet = true) }
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
private fun Prompt(text: String, onClick: () -> Unit) {
    Box(Modifier.fillMaxSize().clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Text(text, style = MaterialTheme.typography.headlineSmall)
    }
}

/**
 * The conversation itself: the status line, the items newest last, and the words to send; `settings` opens June's
 * settings. It pads itself above the keyboard: neither the app's window (Android 15 and later) nor the session's (set
 * still in JuneSession) moves or shrinks for one.
 */
@Composable
fun Sheet(link: Link, settings: (() -> Unit)? = null, screen: Screen? = null, fromSheet: Boolean = false) {
    val list = rememberLazyListState()
    val shown = link.items.filter { !it.private }
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
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp).navigationBarsPadding().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
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
        val ready = decisions
        if (ready != null && LookChoice.console) {
            ConsoleStrip(link, ready, palette, Modifier.weight(1f).fillMaxWidth())
        } else if (ready != null && avatar != null) {
            Strip(link, ready, avatar, Modifier.weight(1f).fillMaxWidth())
        } else {
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(shown, key = { it.id }) { ItemRow(it) }
            }
        }
        if (link.notice.isNotEmpty()) Text(link.notice, color = Color(0xFFFFD36B), fontSize = 13.sp, modifier = Modifier.padding(vertical = 4.dp))
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
        Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            var choosing by remember { mutableStateOf(false) }
            Box {
                OutlinedButton(onClick = { choosing = true }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp)) { Text("+") }
                androidx.compose.material3.DropdownMenu(choosing, { choosing = false }) {
                    for ((source, label) in listOf("photos" to "photos", "files" to "file", "camera" to "camera")) androidx.compose.material3.DropdownMenuItem(
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
            OutlinedTextField(Outbox.draft, { Outbox.draft = it }, Modifier.weight(1f), placeholder = { Text(if (showing != null) "about this screen…" else "to june…") }, maxLines = 5)
            if (link.state.running || link.state.compacting) OutlinedButton(onClick = link::stop) { Text("Stop") }
            val anything = Outbox.draft.isNotBlank() || showing != null || waiting.isNotEmpty()
            Button(
                onClick = {
                    if (link.submit(Outbox.draft, images = Outbox.pictures.map { it.data } + listOfNotNull(showing?.jpeg()), files = Outbox.files)) {
                        Outbox.clear()
                        if (showing != null) used = true
                    }
                },
                enabled = link.status is LinkStatus.Linked && anything,
            ) { Text("Send") }
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
            markdown(item.text + if (item.streaming) " ▍" else "", code = Color(0xFFE9C46A)),
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
