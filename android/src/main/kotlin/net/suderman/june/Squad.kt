package net.suderman.june

import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.background
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject

/**
 * The squad: the roster's enlisted clankers, each on an enlistment card (board.mjs rosterView). The list shows a
 * compact landscape card, the clanker's own page the full portrait one, and enlisting or editing fills in a blank.
 */

internal fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).map { getJSONObject(it) }
internal fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).map { optString(it) }

/** The chip and clanker colours, read once from board.mjs. */
internal class Colours(json: JSONObject) {
    private val chips = json.optJSONObject("chips") ?: JSONObject()
    private val harness = json.optJSONObject("harness") ?: JSONObject()
    val harnesses: List<String> = json.optJSONArray("harnesses").strings().ifEmpty { listOf("claude", "codex", "pi", "opencode", "agy") }
    val efforts: List<String> = json.optJSONArray("efforts").strings().ifEmpty { listOf("", "low", "medium", "high", "xhigh", "max") }
    fun chip(state: String): Pair<Color, Color>? = chips.optJSONObject(state)?.let { Look.color(it.optString("fill")) to Look.color(it.optString("ink")) }
    fun clanker(name: String): Pair<Color, Color> = (harness.optJSONObject(name) ?: harness.optJSONObject("other"))
        ?.let { Look.color(it.optString("eye")) to Look.color(it.optString("band")) } ?: (Color(0xFFE0B419) to Color(0xFFB8911A))
}

/**
 * A placeholder clanker: round body, one large eye in its harness's colour, claws, antenna, hover glow. In neon it
 * is drawn in light lines on a dark body; the console has no art, only a glyph.
 */
@Composable
internal fun Clanker(harness: String, colours: Colours, size: Int = 40, mark: String = "", markColour: Color = Color(0xFFB3311F), claws: Boolean = true) {
    val p = LocalPalette.current
    if (p.console) {
        Text("(o)", style = p.type.number.copy(color = p.muted), modifier = Modifier.width(size.dp))
        return
    }
    val (eye, band) = colours.clanker(harness)
    val ink = if (p.neon) p.harness(harness) else Look.ink
    val body = if (p.neon) Color(0xFF2A2347) else Color(0xFFF3E3D3)
    Box(Modifier.size(size.dp)) {
        Canvas(Modifier.size(size.dp)) {
            scale(this.size.width / 64f, this.size.height / 64f, pivot = Offset.Zero) {
                val line = Stroke(2.5f, cap = StrokeCap.Round)
                drawOval(eye.copy(alpha = if (p.neon) 0.55f else 0.4f), Offset(17f, 56f), Size(30f, 6f))
                drawLine(ink, Offset(32f, 11f), Offset(32f, 5f), 2.5f, StrokeCap.Round)
                drawCircle(eye, 3f, Offset(32f, 5f)); drawCircle(ink, 3f, Offset(32f, 5f), style = line)
                if (claws) {
                    drawPath(Path().apply { moveTo(13f, 30f); quadraticTo(6f, 35f, 9f, 44f) }, ink, style = line)
                    drawPath(Path().apply { moveTo(51f, 30f); quadraticTo(58f, 35f, 55f, 44f) }, ink, style = line)
                }
                if (p.neon) drawCircle(ink.copy(alpha = 0.18f), 23f, Offset(32f, 31f), style = Stroke(5f))
                drawCircle(body, 20f, Offset(32f, 31f)); drawCircle(ink, 20f, Offset(32f, 31f), style = line)
                drawOval(band, Offset(17f, 40.5f), Size(30f, 9f)); drawOval(ink, Offset(17f, 40.5f), Size(30f, 9f), style = line)
                drawCircle(if (p.neon) Color(0xFF0E0B18) else ink, 10f, Offset(34f, 28f)); drawCircle(eye, 7f, Offset(34f, 28f)); drawCircle(Look.balloon, 2.2f, Offset(31f, 25f))
            }
        }
        if (mark.isNotEmpty()) Text(
            mark, style = p.type.label.copy(color = Look.balloon, letterSpacing = p.type.number.letterSpacing),
            modifier = Modifier.align(Alignment.TopEnd).background(markColour, androidx.compose.foundation.shape.RoundedCornerShape(50)).padding(horizontal = 5.dp),
        )
    }
}

/** A status stamp's colour: on duty in the in-progress colour, an invalid card in the alarm's, the rest muted. */
private fun Look.Palette.statusTone(stamp: String) = when (stamp) { "ON DUTY" -> tone("PROG"); "INVALID" -> tone("TODO"); else -> muted }

/**
 * The clanker's portrait window: a frame in its harness colour over a screentone wash of the same, the clanker in
 * it, and its status stamped across it when it is not idle. The console shows a framed glyph.
 */
@Composable
internal fun Portrait(harness: String, colours: Colours, stamp: String, modifier: Modifier, art: Int) {
    val p = LocalPalette.current
    val frame = p.harness(harness)
    val shape = p.corner(4.dp)
    Box(
        modifier.inked(shape, frame, frame.copy(alpha = if (p.neon) 0.10f else 0.10f).compositeOver(p.surface), lift = 0.dp, width = 2.5.dp)
            .screentone(shape, if (p.neon) 0.22f else 0.20f, frame),
        contentAlignment = Alignment.Center,
    ) {
        Clanker(harness, colours, art)
        if (stamp.isNotEmpty()) Stamp(stamp, p.statusTone(stamp), Modifier.align(Alignment.BottomCenter).padding(bottom = 6.dp), tilt = -3f)
    }
}

/**
 * Energy (quota) as a gauge of ten cells, filled in its tone: high, mid, low or unknown. The console prints
 * GAUGE, "[######----]".
 */
@Composable
internal fun EnergyGauge(level: Int, tone: String, gauge: String, cell: Dp = 7.dp) {
    val p = LocalPalette.current
    val colour = when (tone) { "high" -> p.tone("DONE"); "mid" -> p.tone("HOLD"); "low" -> p.tone("TODO"); else -> p.surfaceMuted }
    if (p.console) {
        Text(gauge.ifEmpty { "[??????????]" }, style = p.type.number.copy(color = colour))
        return
    }
    val cells = if (level < 0) 0 else Math.round(level / 10f).coerceIn(if (level > 0) 1 else 0, 10)
    Canvas(Modifier.size(width = cell * 10 + 2.dp * 9 + 8.dp, height = cell * 2)) {
        val c = cell.toPx()
        val gap = 2.dp.toPx()
        val pad = 3.dp.toPx()
        val w = (if (p.neon) 1.25f else 2f).dp.toPx()
        drawRoundRect(p.surfaceInk.copy(alpha = if (p.neon) 0.45f else 1f), Offset(w / 2, w / 2), Size(size.width - w - 3.dp.toPx(), size.height - w), CornerRadius(3.dp.toPx()), style = Stroke(w))
        drawRoundRect(p.surfaceInk.copy(alpha = if (p.neon) 0.45f else 1f), Offset(size.width - 3.dp.toPx(), size.height * 0.3f), Size(3.dp.toPx(), size.height * 0.4f), CornerRadius(1.dp.toPx()))
        val h = size.height - 2 * pad
        for (i in 0 until 10) {
            val x = pad + i * (c + gap) - 0.5.dp.toPx()
            val on = i < cells
            if (on && p.neon) drawRoundRect(colour.copy(alpha = 0.25f), Offset(x - 1.5f, pad - 1.5f), Size(c + 3f, h + 3f), CornerRadius(2.dp.toPx()))
            drawRoundRect(if (on) colour else p.rule, Offset(x, pad), Size(c, h), CornerRadius(1.dp.toPx()))
        }
    }
}

/** The class (harness) in its colour, then the loadout, on one line. */
@Composable
private fun ClassLine(card: JSONObject, modifier: Modifier = Modifier) {
    val p = LocalPalette.current
    val harness = card.optString("harness")
    val loadout = card.optString("loadout")
    Text(
        buildAnnotatedString {
            withStyle(SpanStyle(color = if (p.console) p.surfaceInk else p.harness(card.optString("clanker")), fontWeight = FontWeight.Bold, letterSpacing = p.type.label.letterSpacing)) {
                append(harness.ifEmpty { "no class" }.uppercase())
            }
            if (loadout.isNotEmpty()) append("  ·  $loadout")
        },
        style = p.type.meta.copy(color = p.surfaceMuted), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = modifier,
    )
}

/** One enlisted clanker in the squad list: portrait, name and service number, class and loadout, energy. */
@Composable
internal fun EnlistCard(card: JSONObject, colours: Colours, onClick: () -> Unit) {
    val p = LocalPalette.current
    Row(
        Modifier.fillMaxWidth().inked(lift = 3.dp).semantics { role = Role.Button }.clickable(onClick = onClick).padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        if (p.console) Text("(o)", style = p.type.number.copy(color = p.muted))
        else Portrait(card.optString("clanker"), colours, "", Modifier.size(64.dp), 50)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(card.optString("name"), Modifier.weight(1f), style = p.type.name.copy(color = p.surfaceInk), maxLines = 1, overflow = TextOverflow.Ellipsis)
                val stamp = card.optString("stamp")
                if (stamp.isNotEmpty()) Stamp(stamp, p.statusTone(stamp), Modifier.padding(end = 6.dp))
                Text(card.optString("serviceNo"), style = p.type.number.copy(color = p.surfaceMuted))
            }
            ClassLine(card)
            val energy = card.optString("energyText")
            if (energy.isNotEmpty()) Row(Modifier.padding(top = 3.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                EnergyGauge(card.optInt("batteryLevel", -1), card.optString("batteryTone", "unknown"), card.optString("gauge"), cell = 6.dp)
                Text(energy, style = p.type.meta.copy(color = p.surfaceInk, fontWeight = FontWeight.Bold), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            val stats = card.optString("statsLine")
            if (stats.isNotEmpty()) Text(stats, style = p.type.meta.copy(color = p.surfaceMuted), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** A docket's or card's header band: a small-caps LABEL on screentone, and a number at the right. */
@Composable
internal fun Band(label: String, number: String, modifier: Modifier = Modifier, trailing: @Composable () -> Unit = {}) {
    val p = LocalPalette.current
    val top = if (p.console) androidx.compose.ui.graphics.RectangleShape else androidx.compose.foundation.shape.RoundedCornerShape(topStart = 6.dp, topEnd = 6.dp)
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().screentone(top, 0.13f).padding(start = 12.dp, end = 6.dp).heightIn(min = 36.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(if (p.console) "┌─ ${label.lowercase()}" else label.uppercase(), Modifier.weight(1f), style = p.type.label.copy(color = p.surfaceInk.copy(alpha = 0.85f)), maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (number.isNotEmpty()) Text(if (p.console) number else "№ $number", Modifier.padding(end = 6.dp), style = p.type.number.copy(color = p.surfaceMuted))
            trailing()
        }
        Box(Modifier.fillMaxWidth().height(if (p.neon || p.console) 1.dp else 1.5.dp).background(if (p.neon) p.line.copy(alpha = 0.6f) else p.line))
    }
}

/** One printed row of a card or docket: a LABEL column, then its value or controls, ruled off below. */
@Composable
internal fun FieldRow(label: String, modifier: Modifier = Modifier, last: Boolean = false, onClick: (() -> Unit)? = null, content: @Composable () -> Unit) {
    val p = LocalPalette.current
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp)
                .then(if (onClick != null) Modifier.semantics { role = Role.Button }.clickable(onClick = onClick) else Modifier)
                .padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(if (p.console) label.lowercase() else label.uppercase(), Modifier.width(88.dp), style = p.type.label.copy(color = p.surfaceMuted))
            Box(Modifier.weight(1f)) { content() }
            if (onClick != null) Text("›", style = p.type.row.copy(color = p.surfaceMuted), modifier = Modifier.padding(start = 6.dp))
        }
        if (!last) Box(Modifier.padding(horizontal = 12.dp).fillMaxWidth().height(1.dp).background(p.rule))
    }
}

/** A value in a field row. */
@Composable
internal fun FieldValue(text: String, muted: Boolean = false, mono: Boolean = false) {
    val p = LocalPalette.current
    Text(text, style = (if (mono) p.type.number else p.type.value).copy(color = if (muted) p.surfaceMuted else p.surfaceInk), maxLines = 2, overflow = TextOverflow.Ellipsis)
}

/** The clanker's full enlistment card: portrait, name, class, unit, loadout, energy, standing orders, service record. */
@Composable
internal fun EnlistmentCard(card: JSONObject, colours: Colours) {
    val p = LocalPalette.current
    Column(Modifier.fillMaxWidth().inked(lift = 4.dp)) {
        Band("Enlistment card", card.optString("serviceNo"))
        Column(Modifier.padding(12.dp)) {
            if (p.console) Text("(o)  ${card.optString("stamp").ifEmpty { "idle" }.lowercase()}", style = p.type.number.copy(color = p.muted))
            else Portrait(card.optString("clanker"), colours, card.optString("stamp"), Modifier.fillMaxWidth().height(172.dp), 116)
            Spacer(Modifier.height(10.dp))
            Text(card.optString("name"), style = p.type.masthead.copy(color = p.surfaceInk), maxLines = 1, overflow = TextOverflow.Ellipsis)
            ClassLine(card)
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(p.rule))
        FieldRow("Unit") { FieldValue(card.optString("unit").ifEmpty { "reserve" }, muted = card.optString("unit").isEmpty()) }
        FieldRow("Class") { FieldValue(card.optString("harness").ifEmpty { "none" }) }
        FieldRow("Loadout") { FieldValue(listOf(card.optString("model").ifEmpty { "harness default" }, card.optString("effort").ifEmpty { "default effort" }).joinToString(" · ")) }
        val energy = card.optString("energyText")
        FieldRow("Energy", last = card.optString("terminal").isEmpty() && card.optString("avatar").isEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (card.optInt("batteryLevel", -1) >= 0) EnergyGauge(card.optInt("batteryLevel", -1), card.optString("batteryTone", "unknown"), card.optString("gauge"))
                val account = card.optString("batteryAccount")
                FieldValue(energy.ifEmpty { "unknown" } + if (account.isNotEmpty()) " · $account" else "", muted = energy.isEmpty())
            }
        }
        val term = card.optString("terminal")
        if (term.isNotEmpty()) FieldRow("Post", last = card.optString("avatar").isEmpty()) { FieldValue(term, mono = true) }
        val avatar = card.optString("avatar")
        if (avatar.isNotEmpty()) FieldRow("Avatar", last = true) { FieldValue(avatar, mono = true) }
        val problems = card.optJSONArray("problems").strings()
        if (problems.isNotEmpty()) Text(problems.joinToString("; "), Modifier.padding(12.dp), style = p.type.meta.copy(color = p.tone("TODO"), fontWeight = FontWeight.Bold))
    }
    Spacer(Modifier.height(4.dp))
    SectionRule("STANDING ORDERS")
    val orders = card.optString("instructions")
    Text(
        orders.ifEmpty { "No standing orders." },
        Modifier.fillMaxWidth().inked(lift = 2.dp).padding(horizontal = 12.dp, vertical = 10.dp),
        style = (if (orders.length > 280) p.type.body else p.type.lettering).copy(color = if (orders.isEmpty()) p.surfaceMuted else p.surfaceInk),
    )
    if (card.optInt("runs", 0) > 0) {
        SectionRule("SERVICE RECORD")
        Column(Modifier.fillMaxWidth().inked(lift = 2.dp).padding(vertical = 4.dp)) {
            val parts = listOf(card.optString("statsLine")) +
                listOfNotNull(card.optInt("handoffs", 0).takeIf { it > 0 }?.let { "$it handed off" }, card.optInt("parked", 0).takeIf { it > 0 }?.let { "$it parked" })
            Text(parts.joinToString(" · "), Modifier.padding(horizontal = 12.dp, vertical = 8.dp), style = p.type.meta.copy(color = p.surfaceInk, fontWeight = FontWeight.Bold))
            for (r in card.optJSONArray("recentRuns").objects()) {
                val outcome = r.optString("outcome")
                val tone = when (outcome) { "done" -> p.tone("DONE"); "eval" -> p.tone("EVAL"); "handoff", "parked" -> p.tone("TODO"); "running" -> p.tone("PROG"); else -> p.surfaceMuted }
                Row(Modifier.fillMaxWidth().heightIn(min = 36.dp).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Stamp(outcome.ifEmpty { "run" }, tone, Modifier.width(70.dp), tilt = 0f)
                    Text(r.optString("taskTitle"), Modifier.weight(1f), style = p.type.meta.copy(color = p.surfaceInk), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(r.optString("duration"), style = p.type.number.copy(color = p.surfaceMuted))
                }
            }
        }
    }
}

/** What the enlistment form sends: the roster card's fields, as Link.editRoster's "save" takes them. */
internal data class Enlistment(val name: String, val host: String, val harness: String, val model: String, val effort: String, val avatar: String, val instructions: String)

/**
 * A blank enlistment card to fill in, or a clanker's card to amend: name, unit, class and effort as stamp rows,
 * loadout, avatar and standing orders. Discharging asks once more before it removes the card.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun EnlistForm(card: JSONObject?, hosts: List<String>, colours: Colours, busy: Boolean, notice: String, onSave: (Enlistment) -> Unit, onDischarge: () -> Unit) {
    val p = LocalPalette.current
    val key = card?.optString("slug") ?: "__new__"
    var name by remember(key) { mutableStateOf(card?.optString("name") ?: "") }
    var host by remember(key) { mutableStateOf(card?.optString("host")?.ifEmpty { null } ?: hosts.firstOrNull() ?: "kit") }
    var harness by remember(key) { mutableStateOf(card?.optString("harness")?.takeIf { it in colours.harnesses } ?: "claude") }
    var model by remember(key) { mutableStateOf(card?.optString("model") ?: "") }
    var effort by remember(key) { mutableStateOf(card?.optString("effort") ?: if (card == null) "high" else "") }
    var avatar by remember(key) { mutableStateOf(card?.optString("avatar") ?: "") }
    var orders by remember(key) { mutableStateOf(card?.optString("instructions") ?: "") }
    var discharging by remember(key) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().inked(lift = 4.dp)) {
        Band(if (card == null) "Enlistment card · blank" else "Enlistment card · amend", card?.optString("serviceNo") ?: "")
        Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            if (!p.console) Portrait(harness, colours, "", Modifier.size(64.dp), 50)
            Column(Modifier.weight(1f)) {
                RuledField(name, { name = it }, "Name", placeholder = "e.g. Bolt")
            }
        }
        FieldRow("Unit") {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) { for (h in hosts) Stamp(h, p.line, on = host == h, tilt = 0f) { host = h } }
        }
        if (host !in hosts) Box(Modifier.padding(horizontal = 12.dp)) { RuledField(host, { host = it }, "Other unit", placeholder = "host name", mono = true) }
        FieldRow("Class") {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) { for (h in colours.harnesses) Stamp(h, p.harness(h), on = harness == h, tilt = 0f) { harness = h } }
        }
        Box(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) { RuledField(model, { model = it }, "Loadout · model", placeholder = "harness default", mono = true) }
        FieldRow("Effort") {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) { for (e in colours.efforts) Stamp(e.ifEmpty { "default" }, p.line, on = effort == e, tilt = 0f) { effort = e } }
        }
        Box(Modifier.padding(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 12.dp)) { RuledField(avatar, { avatar = it }, "Avatar", placeholder = "optional path beside ROSTER.org", mono = true) }
    }
    SectionRule("STANDING ORDERS")
    MemoField(orders, { orders = it }, "Role, skills, voice…", lines = 4)
    if (busy || notice.isNotEmpty()) Text(
        if (busy) "saving…" else notice, Modifier.padding(top = 8.dp),
        style = p.type.meta.copy(color = if (busy || notice == "saved") p.muted else p.accent, fontWeight = FontWeight.Bold),
    )
    FlowRow(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        PressTab(if (card == null) "Enlist" else "Save card", { onSave(Enlistment(name, host, harness, model, effort, avatar, orders)) }, kind = Press.Primary, enabled = !busy)
        if (card != null && !discharging) PressTab("Discharge", { discharging = true }, kind = Press.Danger, enabled = !busy)
        if (card != null && discharging) {
            PressTab("Confirm discharge", onDischarge, kind = Press.Danger, enabled = !busy)
            PressTab("Keep", { discharging = false }, kind = Press.Quiet)
        }
    }
}

/** The squad list itself: the count of enlisted clankers, enlist, the service record order, and each card. */
@Composable
internal fun SquadList(cards: List<JSONObject>, ranked: Boolean, canRank: Boolean, colours: Colours, onRank: () -> Unit, onEnlist: () -> Unit, onOpen: (JSONObject) -> Unit) {
    val p = LocalPalette.current
    SectionRule((if (ranked) "SERVICE RECORD" else "SQUAD") + " · ${cards.size}") {
        // The console's brackets make the words wider, so its labels are shorter.
        if (canRank) PressTab(if (ranked) (if (p.console) "order" else "squad order") else (if (p.console) "record" else "service record"), onRank, kind = Press.Quiet, small = true)
        PressTab("+ enlist", onEnlist, small = true)
    }
    if (cards.isEmpty()) Text("No clankers enlisted in ROSTER.org yet.", style = p.type.lettering.copy(color = p.muted))
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) { for (c in cards) EnlistCard(c, colours) { onOpen(c) } }
}
