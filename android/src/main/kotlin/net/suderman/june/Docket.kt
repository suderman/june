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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
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
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.json.JSONObject

/**
 * One task as a work-order docket (board.mjs taskDetail): the slip with its project, number, title and state stamp;
 * then what the task asks and its Dialog, the reply on a memo pad, and last the slip's fields to change. See
 * "Restyle the phone boards as task dockets" in the June project notes for why the question comes first.
 */

/** A handoff the user has yet to confirm: who, where, and when it starts ("" for now or its schedule). */
internal data class Handoff(val agent: String, val host: String, val start: String)

/** What the docket can do: edit the task (with the change that puts it back), take back the last edit, open a link. */
internal class DocketActions(val edit: (String, JSONObject, JSONObject?) -> Unit, val undo: () -> Unit, val open: (String) -> Unit)

/** The back link at the top of a page, a 48 dp target. */
@Composable
internal fun BackLink(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val p = LocalPalette.current
    Box(modifier.heightIn(min = 48.dp).semantics { role = Role.Button }.clickable(onClick = onClick).padding(end = 16.dp), contentAlignment = Alignment.CenterStart) {
        Text(if (p.console) "< $text" else "‹  $text", style = p.type.button.copy(color = p.pageInk))
    }
}

/** A small link on a docket's band, such as Emacs or Herdr: its glyph in a square tab, its name read aloud. */
@Composable
private fun BandLink(glyph: String, name: String, onClick: () -> Unit) {
    val p = LocalPalette.current
    Box(Modifier.size(44.dp).semantics { role = Role.Button; contentDescription = "Open in $name" }.clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Text(
            if (p.console) "[$glyph]" else glyph, style = p.type.number.copy(color = p.surfaceInk),
            modifier = if (p.console) Modifier else Modifier.inked(p.corner(4.dp), lift = 1.5.dp, width = 1.5.dp).padding(horizontal = 6.dp, vertical = 3.dp),
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun TaskDocket(
    d: JSONObject?, gone: Boolean, colours: Colours, back: String, onBack: () -> Unit,
    agents: List<String>, hosts: List<String>, defaultHost: String, notice: String, canUndo: Boolean,
    actions: DocketActions, modifier: Modifier = Modifier,
) {
    val p = LocalPalette.current
    val t = p.type
    val key = d?.optString("key") ?: ""
    var handoff by remember(key) { mutableStateOf<Handoff?>(null) }
    // Which date is being picked: schedule, deadline, handoff, or "".
    var picking by remember(key) { mutableStateOf("") }
    var renaming by remember(key) { mutableStateOf(false) }
    var title by remember(key) { mutableStateOf("") }
    var reply by remember(key) { mutableStateOf("") }
    if (picking.isNotEmpty() && d != null) {
        val field = if (picking == "deadline") "deadline" else "scheduled"
        WhenDialogs(
            title = when (picking) { "deadline" -> "Deadline"; "handoff" -> "Start at"; else -> if (d.optBoolean("repeats")) "Scheduled, keeping its repeat" else "Scheduled" },
            start = d.optJSONObject(field) ?: JSONObject(),
            canClear = picking != "handoff" && d.optBoolean(if (picking == "deadline") "hasDeadline" else "hasScheduled"),
            onPicked = { at ->
                if (picking == "handoff") handoff = handoff?.copy(start = at) else actions.edit(key, JSONObject().put("action", picking).put("when", at), null)
                picking = ""
            },
            onClear = { actions.edit(key, JSONObject().put("action", picking).put("when", "none"), null); picking = "" },
            onDismiss = { picking = "" },
        )
    }
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { BackLink(back, onBack) }
        if (d == null && gone) item { Text("That task is no longer on the boards.", style = t.lettering.copy(color = p.muted)) }
        if (d == null) return@LazyColumn
        val state = d.optString("state")
        val locked = d.optBoolean("protected")
        val next = d.optJSONArray("next").strings()
        val assignable = !locked && "AUTO" in next
        val editable = !locked && state.isNotEmpty()
        val renamable = !locked && state in listOf("", "TODO", "EVAL", "HOLD")
        val busy = d.optBoolean("busy")

        // The slip: band, title and stamp, then its stub of who and when below the tear.
        item {
            Column(Modifier.fillMaxWidth().inked(lift = 3.dp)) {
                Band(d.optString("project").ifEmpty { "Task" }, d.optString("docket")) {
                    val emacs = d.optString("emacs")
                    val herdr = d.optString("herdr")
                    if (emacs.isNotEmpty() && emacs != "null") BandLink("E", "Emacs") { actions.open(emacs) }
                    if (herdr.isNotEmpty() && herdr != "null") BandLink(">_", "Herdr") { actions.open(herdr) }
                }
                Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 10.dp, top = 12.dp, bottom = 4.dp), verticalAlignment = Alignment.Top) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        val path = d.optString("path")
                        if (path.isNotEmpty()) Text(path, style = t.meta.copy(color = p.surfaceMuted), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            d.optString("title") + if (renamable && !renaming) "  ✎" else "", style = t.title.copy(color = p.surfaceInk),
                            modifier = if (renamable) Modifier.semantics { role = Role.Button }.clickable { renaming = !renaming; title = d.optString("title") } else Modifier,
                        )
                    }
                    if (state.isNotEmpty()) Stamp(state, p.tone(state), Modifier.padding(start = 8.dp, top = 2.dp), tilt = -2.5f, big = true)
                }
                if (renaming) Column(Modifier.padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    val save = { if (title.isNotBlank() && title.trim() != d.optString("title")) actions.edit(key, JSONObject().put("action", "title").put("title", title.trim()), null); renaming = false }
                    RuledField(title, { title = it }, "New title", onDone = save)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PressTab("Rename", save, kind = Press.Primary, small = true)
                        PressTab("Cancel", { renaming = false }, kind = Press.Quiet, small = true)
                    }
                }
                val headline = d.optString("headline")
                if (headline.isNotEmpty()) Text("“$headline”", Modifier.padding(horizontal = 14.dp, vertical = 4.dp), style = t.lettering.copy(color = p.surfaceInk.copy(alpha = 0.85f)))
                Perforation(Modifier.padding(top = 6.dp))
                Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = 2.dp, bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    val agent = d.optString("agent")
                    for ((label, value) in listOf(
                        "Assigned" to (if (agent.isEmpty()) "—" else if (d.optString("host").isNotEmpty()) "$agent · ${d.optString("host")}" else agent),
                        "Scheduled" to d.optString("scheduledLabel").ifEmpty { "—" },
                        "Due" to d.optString("deadlineLabel").ifEmpty { "—" },
                    )) Column(Modifier.weight(1f)) {
                        Text(if (p.console) label.lowercase() else label.uppercase(), style = t.label.copy(color = p.surfaceMuted))
                        Text(value, style = t.meta.copy(color = p.surfaceInk, fontWeight = FontWeight.Bold), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        // What else holds the task, as the facts line has it, less what the stub shows.
        val extra = d.optString("facts").split(" · ").filter { f -> f.startsWith("waits on") || f.endsWith("review") }
        if (extra.isNotEmpty()) item { Text(extra.joinToString(" · "), style = t.meta.copy(color = p.muted)) }
        if (busy || notice.isNotEmpty()) item {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                val text = if (busy) "saving…" else notice
                Text(text, Modifier.weight(1f, fill = false), style = t.meta.copy(color = if (busy || text == "saved") p.muted else p.accent, fontWeight = FontWeight.Bold))
                if (!busy && text == "saved" && canUndo) Text("undo", style = t.button.copy(color = p.pageInk, textDecoration = TextDecoration.Underline), modifier = Modifier.heightIn(min = 48.dp).clickable(onClick = actions.undo).padding(horizontal = 8.dp, vertical = 14.dp))
            }
        }

        // The question first, when the task asks the user; then the rest of the Dialog, oldest first.
        val dialog = d.optJSONArray("dialog").objects()
        val ask = d.optString("ask")
        val asked = dialog.firstOrNull { it.optString("key") == ask && ask.isNotEmpty() }
        if (asked != null) {
            item { SectionRule("ASKS YOU", alert = true) }
            item(key = "ask|$ask") { DialogNote(asked, d.optString("harness"), colours, lead = true) }
        }
        val rest = dialog.filter { it !== asked }
        item { SectionRule(if (asked != null) "EARLIER IN DIALOG · ${rest.size}" else "DIALOG") }
        if (dialog.isEmpty()) item { Text("No Dialog yet.", style = t.lettering.copy(color = p.muted)) }
        for (e in rest) item(key = "dialog|" + e.optString("key")) { DialogNote(e, d.optString("harness"), colours) }
        // A reply in the user's name; with resume, the task goes back to its clanker with it.
        if (editable) item {
            Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                MemoField(reply, { reply = it }, if (asked != null) "Answer in Dialog" else "Reply in Dialog")
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    val send = { resume: Boolean ->
                        if (reply.isNotBlank()) {
                            val change = JSONObject().put("action", "reply").put("text", reply)
                            if (resume) change.put("resume", true)
                            actions.edit(key, change, null)
                            reply = ""
                        }
                    }
                    if (assignable) {
                        PressTab("Reply and resume", { send(true) }, kind = Press.Primary)
                        PressTab("Reply", { send(false) })
                    } else PressTab("Reply", { send(false) }, kind = Press.Primary)
                }
            }
        }

        // The slip's fields, to change: where its state can go, who to hand it to, and its dates.
        if (state.isNotEmpty()) {
            item { SectionRule("CHANGE") }
            item {
                val held = handoff
                Column(Modifier.fillMaxWidth().inked(lift = 2.dp)) {
                    val moves = if (locked) next else next.filter { it != "AUTO" }
                    FieldRow("Move to", last = !editable && !assignable) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            // A state change shows at once and can be put back while "saved" shows.
                            for (s in moves) Stamp(s, p.tone(s), on = false, tilt = 0f) {
                                actions.edit(key, JSONObject().put("action", "state").put("state", s), if (state == "AUTO") null else JSONObject().put("action", "state").put("state", state).put("undo", true))
                            }
                        }
                    }
                    if (locked) Text("${d.optString("file")} is rebuilt by another program, so only TODO and DONE are set here; DONE may sync back.", Modifier.padding(12.dp), style = t.meta.copy(color = p.surfaceMuted))
                    if (assignable && held == null) FieldRow("Hand to") {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            for (a in agents) Stamp(a, p.tone("AUTO"), on = false, tilt = 0f) { handoff = Handoff(a, d.optString("host").ifEmpty { defaultHost }, "") }
                        }
                    }
                    // Nothing is queued until the user confirms who, where and when.
                    if (assignable && held != null) Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        val starts = d.optString("starts")
                        val start = if (held.start.isNotEmpty()) held.start.replace("T", " ") else if (starts == "now") "now" else "at its schedule, $starts"
                        Text("Hand to ${held.agent}, starting $start.", style = t.row.copy(color = p.surfaceInk))
                        if (hosts.size > 1) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.Center) {
                            Text("on", Modifier.padding(top = 14.dp, end = 4.dp), style = t.label.copy(color = p.surfaceMuted))
                            for (h in hosts) Stamp(h, p.line, on = h == held.host, tilt = 0f) { handoff = held.copy(host = h) }
                        }
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            PressTab(if (held.start.isEmpty() && starts == "now") "Hand off now" else "Hand off", {
                                val change = JSONObject().put("action", "assign").put("agent", held.agent)
                                if (held.host.isNotEmpty()) change.put("host", held.host)
                                if (held.start.isNotEmpty()) change.put("when", held.start)
                                handoff = null
                                actions.edit(key, change, null)
                            }, kind = Press.Primary)
                            PressTab(if (held.start.isNotEmpty()) "Change start" else "Start later…", { picking = "handoff" })
                            PressTab("Cancel", { handoff = null }, kind = Press.Quiet)
                        }
                    }
                    // SCHEDULED and DEADLINE, each picked on a calendar and a clock.
                    if (editable && held == null) {
                        FieldRow("Scheduled", onClick = { picking = "schedule" }) { FieldValue(d.optString("scheduledLabel").ifEmpty { "not scheduled" }, muted = !d.optBoolean("hasScheduled")) }
                        FieldRow("Due", last = true, onClick = { picking = "deadline" }) { FieldValue(d.optString("deadlineLabel").ifEmpty { "no deadline" }, muted = !d.optBoolean("hasDeadline")) }
                    }
                }
            }
        }
        item { Spacer(Modifier.height(16.dp)) }
    }
}

/** A paper clip over a note's top edge. */
@Composable
private fun Clip(modifier: Modifier) {
    val p = LocalPalette.current
    val metal = if (p.neon) p.surfaceMuted else Color(0xFF8B8892)
    Canvas(modifier.size(12.dp, 30.dp)) {
        val w = 1.8.dp.toPx()
        drawRoundRect(metal, Offset(w / 2, w / 2), Size(size.width - w, size.height - w), CornerRadius(size.width / 2), style = Stroke(w))
        val i = 3.dp.toPx()
        drawRoundRect(metal, Offset(i, i + 4.dp.toPx()), Size(size.width - 2 * i, size.height - 2 * i - 6.dp.toPx()), CornerRadius((size.width - 2 * i) / 2), style = Stroke(w))
    }
}

/** An entry's blocks: paragraphs, and its numbered or bulleted points as a list. */
@Composable
private fun EntryText(e: JSONObject, style: androidx.compose.ui.text.TextStyle) {
    val blocks = e.optJSONArray("blocks").objects()
    if (blocks.isEmpty()) { Text(e.optString("text"), style = style); return }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (b in blocks) if (b.optString("kind") == "item") Row {
            Text(b.optString("mark"), Modifier.width(22.dp), style = style.copy(fontWeight = FontWeight.Bold))
            Text(b.optString("text"), Modifier.weight(1f), style = style)
        } else Text(b.optString("text"), style = style)
    }
}

/**
 * A Dialog entry: the user's as a blue note on the right, an agent's as a note clipped beside its clanker (LEAD,
 * the question the page leads with, edged in the accent), June's as a printed balloon, the dispatcher's as a caption.
 * Long entries are set in the reading face rather than lettering.
 */
@Composable
private fun DialogNote(e: JSONObject, harness: String, colours: Colours, lead: Boolean = false) {
    val p = LocalPalette.current
    val t = p.type
    val kind = e.optString("kind")
    val who = e.optString("who").lowercase() + e.optString("at").let { if (it.isEmpty()) "" else " · $it" }
    if (kind == "dispatcher") {
        Text("${if (p.console) "#" else "▸"} $who — ${e.optString("text")}", style = t.meta.copy(color = p.muted))
        return
    }
    val long = e.optString("text").length > 280
    val user = kind == "user"
    val ink = if (user && !p.neon && !p.console) Look.noteInk else p.surfaceInk
    val style = (if (long || user) t.body else t.lettering).copy(color = ink)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (user) Arrangement.End else Arrangement.Start, verticalAlignment = Alignment.Bottom) {
        if (kind == "agent" && !p.console) { Clanker(harness, colours, 30, claws = false); Spacer(Modifier.width(8.dp)) }
        Box(if (user) Modifier.fillMaxWidth(0.86f) else Modifier.weight(1f, fill = false)) {
            Column(
                Modifier.padding(top = if (kind == "agent" && !p.console) 8.dp else 0.dp)
                    .inked(
                        p.corner(if (kind == "june") 16.dp else 4.dp),
                        edge = if (lead) p.accent else if (user) (if (p.neon) p.user else if (p.console) p.line else Look.noteLine) else null,
                        fill = if (user && !p.neon && !p.console) Look.noteFill else p.surface,
                        lift = if (lead) 3.dp else 2.dp, width = if (lead) 2.5.dp else 2.dp,
                    )
                    .padding(horizontal = 12.dp, vertical = 9.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Text(if (p.console) "$who:" else who, style = t.label.copy(color = if (user && !p.neon && !p.console) Look.noteInk else p.surfaceMuted, letterSpacing = t.number.letterSpacing))
                EntryText(e, style)
            }
            if (kind == "agent" && !p.console) Clip(Modifier.align(Alignment.TopEnd).offset(x = (-22).dp))
        }
    }
}

/** A date, then a time (or none), for a task's SCHEDULED, DEADLINE or a handoff's start: "YYYY-MM-DD" or
 * "YYYY-MM-DD HH:MM", which org-edit reads. START is board.mjs pickerStart's { date, time }. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WhenDialogs(title: String, start: JSONObject, canClear: Boolean, onPicked: (String) -> Unit, onClear: () -> Unit, onDismiss: () -> Unit) {
    val first = runCatching { java.time.LocalDate.parse(start.optString("date")) }.getOrElse { java.time.LocalDate.now() }
    val dateState = rememberDatePickerState(initialSelectedDateMillis = first.atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli())
    var date by remember { mutableStateOf<String?>(null) }
    val chosen = date
    if (chosen == null) {
        DatePickerDialog(
            onDismissRequest = onDismiss,
            confirmButton = { TextButton({ dateState.selectedDateMillis?.let { date = java.time.Instant.ofEpochMilli(it).atZone(java.time.ZoneOffset.UTC).toLocalDate().toString() } }) { Text("Next") } },
            dismissButton = {
                Row {
                    if (canClear) TextButton(onClear) { Text("Clear") }
                    TextButton(onDismiss) { Text("Cancel") }
                }
            },
        ) { DatePicker(dateState, title = { Text(title, Modifier.padding(start = 24.dp, top = 16.dp)) }) }
    } else {
        val time = start.optString("time").split(":")
        val timeState = rememberTimePickerState(initialHour = time.getOrNull(0)?.toIntOrNull() ?: 9, initialMinute = time.getOrNull(1)?.toIntOrNull() ?: 0, is24Hour = false)
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text("$title, $chosen") },
            text = { TimePicker(timeState) },
            confirmButton = { TextButton({ onPicked("$chosen ${"%02d".format(timeState.hour)}:${"%02d".format(timeState.minute)}") }) { Text("Set") } },
            dismissButton = {
                Row {
                    TextButton({ onPicked(chosen) }) { Text("No time") }
                    TextButton(onDismiss) { Text("Cancel") }
                }
            },
        )
    }
}
