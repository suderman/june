package net.suderman.june

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import org.json.JSONObject

/**
 * The boards' lists as docket stubs: the masthead over its folder tabs, pads of ruled rows, a queue's slips on a
 * spike, and the docket for what needs the user. The boards (Boards.kt) fill them from board.mjs.
 */

/** A worker row opens its task or terminal when it has one. */
internal fun clickOf(w: JSONObject, go: () -> Unit): (() -> Unit)? =
    if (w.optString("task").isNotEmpty() || w.optString("link").let { it.isNotEmpty() && it != "null" }) go else null

/** A start ("tomorrow 04:30", "Thu 18:00", "now") as a day over a time, for a stub's left column. */
internal fun whenLead(at: String): String {
    val m = Regex("""^(.*)\s(\d{1,2}:\d{2})$""").find(at) ?: return if (at.startsWith("waits")) "waits" else at
    return m.groupValues[1] + "\n" + m.groupValues[2]
}

/** A docket for what needs the user: its kind on the band, the clanker and title, its last word, and where it opens. */
@Composable
internal fun NeedDocket(n: JSONObject, colours: Colours, page: () -> Unit, open: (String) -> Unit) {
    val p = LocalPalette.current
    val urgent = n.optInt("level") == 1
    val kind = n.optString("kind")
    Column(Modifier.fillMaxWidth().inked(edge = if (urgent) p.tone("TODO") else if (kind == "asks") p.accent else null, lift = 3.dp, width = if (urgent) 2.5.dp else 2.dp).clickable(onClick = page)) {
        Band(n.optString("label"), "") { Text(n.optString("where"), Modifier.padding(end = 6.dp), style = p.type.number.copy(color = p.surfaceMuted), maxLines = 1) }
        Row(Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Clanker(n.optString("harness"), colours, 38, if (kind == "blocked") "!" else if (kind == "asks") "?" else "", if (kind == "blocked") p.tone("TODO") else p.accent)
            Text(n.optString("title"), Modifier.weight(1f), style = p.type.row.copy(color = p.surfaceInk))
        }
        val line = n.optString("line")
        if (line.isNotEmpty()) Text(
            "“$line”", Modifier.padding(horizontal = 12.dp, vertical = 6.dp), maxLines = 4, overflow = TextOverflow.Ellipsis,
            style = p.type.lettering.copy(color = p.surfaceInk.copy(alpha = 0.9f)),
        )
        val link = n.optString("link")
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(bottom = 6.dp), horizontalArrangement = Arrangement.End) {
            if (link.isNotEmpty() && link != "null") PressTab(n.optString("action"), { open(link) }, kind = if (urgent) Press.Primary else Press.Secondary, small = true)
        }
    }
}

/** A list on ruled paper: one pad, its rows ruled off. */
@Composable
internal fun Pad(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().inked(lift = 2.dp, width = 1.75.dp), content = content)
}

/** A pad with more slips stacked under it, their edges showing below and to the right. */
@Composable
internal fun Spiked(more: Boolean, content: @Composable () -> Unit) {
    val p = LocalPalette.current
    if (!more || p.console) { content(); return }
    Box(Modifier.padding(end = 6.dp, bottom = 6.dp)) {
        Box(Modifier.matchParentSize().offset(6.dp, 6.dp).inked(lift = 0.dp, width = 1.5.dp))
        Box(Modifier.matchParentSize().offset(3.dp, 3.dp).inked(lift = 0.dp, width = 1.5.dp))
        content()
    }
}

/**
 * A docket stub: one ruled line of a pad with its LEAD (a time or day) in a column, its ART (a clanker), title,
 * a quoted last word, its meta, and a state STAMP at the end. Rows without a lead or stamp take no space for one.
 */
@Composable
internal fun StubRow(
    title: String, meta: String = "", lead: String = "", leadWidth: Dp = 0.dp, stamp: String = "", quote: String = "", overdue: Boolean = false,
    first: Boolean = false, art: (@Composable () -> Unit)? = null, onClick: (() -> Unit)?,
) {
    val p = LocalPalette.current
    val t = p.type
    if (!first) Box(Modifier.padding(horizontal = 12.dp).fillMaxWidth().height(1.dp).background(p.rule))
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).padding(horizontal = 12.dp, vertical = 9.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leadWidth > 0.dp) Text(lead, Modifier.width(leadWidth), style = t.number.copy(color = if (overdue) p.accent else p.surfaceMuted))
        art?.invoke()
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = t.row.copy(color = p.surfaceInk), maxLines = 3, overflow = TextOverflow.Ellipsis)
            if (quote.isNotEmpty()) Text("“$quote”", style = t.lettering.copy(color = p.surfaceMuted, fontSize = t.meta.fontSize.times(1.1f)), maxLines = 3, overflow = TextOverflow.Ellipsis)
            if (meta.isNotEmpty()) Text(meta, style = t.meta.copy(color = if (overdue) p.accent else p.surfaceMuted), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (stamp.isNotEmpty()) Stamp(stamp, p.tone(stamp))
    }
}

