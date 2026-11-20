package net.suderman.june

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

// Browsing June's history by day on the phone, as the desktop's masthead and Browse.qml do: the date under the status
// line steps between days with conversation and opens a calendar with them marked, and a search whose hits update as
// Jon types. Inline in the sheet rather than a dialog, which the assistant session cannot show. See "Browse June's
// history by day" in docs/interfaces.org.

private val LABEL = DateTimeFormatter.ofPattern("EEEE, MMMM d", Locale.CANADA)
private val LABEL_YEAR = DateTimeFormatter.ofPattern("EEEE, MMMM d, yyyy", Locale.CANADA)

/** A day's name for the header, "Tuesday, November 17", with the year when it is not `today`'s (strip.mjs dayLabel). */
fun dayLabel(date: String, today: String): String = runCatching {
    val day = LocalDate.parse(date)
    day.format(if (today.take(4) == date.take(4)) LABEL else LABEL_YEAR)
}.getOrDefault(date)

/** The day with conversation before (-1) or after (1) `date`, today counting as after every day (strip.mjs stepDay). */
fun stepDay(days: List<String>, date: String, direction: Int, today: String): String? {
    val dates = (days.filter { it != today } + listOf(today).filter { it.isNotEmpty() }).sorted()
    return if (direction < 0) dates.lastOrNull { it < date } else dates.firstOrNull { it > date }
}

/** The day on show and the ways to move: ‹ and › between days with conversation, the date to browse, and back to today. */
@Composable
fun DayBar(link: Link, palette: Look.Palette, browsing: Boolean, toggle: () -> Unit) {
    val past = link.past
    val current = past?.date ?: link.today
    val days = link.days.map { it.first }
    val before = if (current.isEmpty()) null else stepDay(days, current, -1, link.today)
    val after = if (past == null) null else stepDay(days, current, 1, link.today) ?: link.today
    Row(Modifier.fillMaxWidth().padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("‹", fontSize = 20.sp, color = if (before != null) palette.pageInk else palette.muted.copy(alpha = 0.3f), modifier = Modifier.clickable(enabled = before != null) { before?.let(link::openDay) }.padding(horizontal = 6.dp))
        Text(
            (if (past != null) dayLabel(current, link.today) else "today") + if (browsing) " ▴" else " ▾",
            fontSize = 14.sp, fontWeight = FontWeight.Bold, color = if (past != null) palette.accent else palette.muted,
            modifier = Modifier.clickable(onClick = toggle).padding(vertical = 4.dp),
        )
        if (after != null) Text("›", fontSize = 20.sp, color = palette.pageInk, modifier = Modifier.clickable { link.openDay(after) }.padding(horizontal = 6.dp))
        if (past != null) Text("back to today", fontSize = 14.sp, color = palette.muted, modifier = Modifier.clickable { link.backToToday() }.padding(vertical = 4.dp))
    }
}

/** The calendar and the search, in place of the strip while open; choosing a day or a hit opens it and closes this. */
@Composable
fun Browse(link: Link, palette: Look.Palette, close: () -> Unit, modifier: Modifier = Modifier) {
    var words by remember { mutableStateOf("") }
    val shownDate = link.past?.date ?: link.today
    var month by remember { mutableStateOf(runCatching { YearMonth.from(LocalDate.parse(shownDate)) }.getOrDefault(YearMonth.now())) }
    LaunchedEffect(Unit) { link.listDays() }
    // Search a moment after the last key, so each letter does not send a request of its own.
    LaunchedEffect(words) {
        if (words.isNotBlank()) kotlinx.coroutines.delay(250)
        link.search(words)
    }
    val counts = link.days.toMap()
    Column(modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedTextField(words, { words = it }, Modifier.fillMaxWidth(), placeholder = { Text("search what you and June said") }, singleLine = true)
        if (words.isBlank()) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("‹", fontSize = 22.sp, color = palette.pageInk, modifier = Modifier.clickable { month = month.minusMonths(1) }.padding(horizontal = 12.dp))
                Text(month.format(DateTimeFormatter.ofPattern("MMMM yyyy", Locale.CANADA)), fontWeight = FontWeight.Bold, color = palette.pageInk, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
                Text("›", fontSize = 22.sp, color = palette.pageInk, modifier = Modifier.clickable { month = month.plusMonths(1) }.padding(horizontal = 12.dp))
            }
            Row(Modifier.fillMaxWidth()) {
                for (name in listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")) Text(name, fontSize = 11.sp, color = palette.muted, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
            }
            // Six weeks from the Sunday on or before the first of the month.
            val first = month.atDay(1)
            val start = first.minusDays((first.dayOfWeek.value % 7).toLong())
            for (week in 0 until 6) Row(Modifier.fillMaxWidth()) {
                for (d in 0 until 7) {
                    val day = start.plusDays((week * 7 + d).toLong())
                    val key = day.toString()
                    val said = counts.containsKey(key) || key == link.today
                    Box(
                        Modifier.weight(1f).height(40.dp)
                            .background(if (key == shownDate) palette.field else androidx.compose.ui.graphics.Color.Transparent, RoundedCornerShape(6.dp))
                            .clickable(enabled = said) { close(); link.openDay(key) },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            day.dayOfMonth.toString(), fontSize = 14.sp,
                            fontWeight = if (said) FontWeight.Bold else null,
                            color = (if (said) palette.pageInk else palette.muted).copy(alpha = if (day.month == first.month) 1f else 0.35f),
                        )
                        // A dot under a day with conversation.
                        if (counts.containsKey(key)) Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 4.dp).size(5.dp).background(palette.busy, CircleShape))
                    }
                }
            }
        } else {
            val time = DateTimeFormatter.ofPattern("HH:mm", Locale.CANADA)
            LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(link.hits, key = { it.id }) { hit ->
                    Column(Modifier.fillMaxWidth().clickable { close(); link.openMoment(hit.id) }.padding(vertical = 2.dp)) {
                        val clock = Instant.ofEpochMilli(hit.at).atZone(ZoneId.systemDefault()).format(time)
                        Text(dayLabel(hit.date, link.today) + " · " + clock + " · " + (if (hit.kind == "user") "you" else "June"), fontSize = 12.sp, color = palette.june)
                        Text(hit.text, fontSize = 14.sp, color = palette.pageInk, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    }
                }
                item {
                    val note = when {
                        link.hits.isEmpty() -> if (link.searchDone) "nothing found" else "searching…"
                        link.hitsMore -> "older hits left out; add words to narrow it"
                        else -> ""
                    }
                    if (note.isNotEmpty()) Text(note, fontSize = 12.sp, color = palette.muted)
                }
            }
        }
    }
}
