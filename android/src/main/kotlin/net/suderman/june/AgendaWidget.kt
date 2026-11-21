package net.suderman.june

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

/**
 * June's agenda on the home screen, in place of Bloom's: overdue, today and the next 13 days from the phone's copy of
 * the agenda (AgendaStore), with how many are due and how fresh it is. A row opens its task's page in June; the header
 * opens the projects board; ↻ asks for a fresh copy. It redraws whenever the copy changes.
 */
class AgendaWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        AgendaJob.schedule(context)
        for (id in ids) manager.updateAppWidget(id, render(context))
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == REFRESH) {
            AgendaJob.now(context)
            return
        }
        super.onReceive(context, intent)
    }

    companion object {
        private const val REFRESH = "net.suderman.june.AGENDA_REFRESH"
        /** Past this, the header says when the copy was last fresh. */
        private const val STALE_MS = 45 * 60 * 1000L

        /** Redraw every June agenda widget; TO_TOP, when the agenda's contents changed, shows its first rows again,
         * since a list keeps its place by position and rows added above would push overdue and today out of sight. */
        fun updateAll(context: Context, toTop: Boolean = false) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, AgendaWidget::class.java))
            if (ids.isEmpty()) return
            val views = render(context)
            if (toTop) views.setScrollPosition(R.id.agenda_list, 0)
            for (id in ids) manager.updateAppWidget(id, views)
        }

        /** Each state's pill: its background and its ink, desktop/board.mjs CHIPS. */
        private val PILLS = mapOf(
            "TODO" to (R.drawable.agenda_pill_todo to R.color.agenda_pill_todo_ink),
            "PROG" to (R.drawable.agenda_pill_prog to R.color.agenda_pill_prog_ink),
            "EVAL" to (R.drawable.agenda_pill_eval to R.color.agenda_pill_eval_ink),
            "HOLD" to (R.drawable.agenda_pill_hold to R.color.agenda_pill_hold_ink),
            "AUTO" to (R.drawable.agenda_pill_auto to R.color.agenda_pill_auto_ink),
            "DONE" to (R.drawable.agenda_pill_done to R.color.agenda_pill_done_ink),
        )

        private fun marks(context: Context) = context.getSharedPreferences("widget_states", Context.MODE_PRIVATE)

        /** States picked on the widget in the last two minutes, while they are on their way: key to state. */
        private fun ticked(context: Context): Map<String, String> {
            val cutoff = System.currentTimeMillis() - 120_000
            return marks(context).all.mapNotNull { (key, value) ->
                (value as? String)?.split("|", limit = 2)?.takeIf { it.size == 2 && (it[1].toLongOrNull() ?: 0L) > cutoff }?.let { key to it[0] }
            }.toMap()
        }

        fun markState(context: Context, key: String, state: String) {
            marks(context).edit().putString(key, "$state|${System.currentTimeMillis()}").apply()
            updateAll(context)
        }

        fun unmarkState(context: Context, key: String) {
            marks(context).edit().remove(key).apply()
            updateAll(context)
        }

        /** The page a widget row or a reminder opens: june://task?key=KEY, handled by ConversationActivity. */
        fun taskUri(key: String): Uri = Uri.Builder().scheme("june").authority("task").appendQueryParameter("key", key).build()

        private fun render(context: Context): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.agenda_widget)
            val open = Intent(context, ConversationActivity::class.java).setAction(Intent.ACTION_VIEW)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            views.setOnClickPendingIntent(R.id.agenda_header, PendingIntent.getActivity(context, 1, Intent(open).setData(Uri.parse("june://projects")), PendingIntent.FLAG_IMMUTABLE))
            views.setOnClickPendingIntent(R.id.agenda_refresh, PendingIntent.getBroadcast(context, 2, Intent(context, AgendaWidget::class.java).setAction(REFRESH), PendingIntent.FLAG_IMMUTABLE))
            views.setOnClickPendingIntent(R.id.agenda_add, PendingIntent.getActivity(context, 4, Intent(context, QuickAddActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE))
            // Each row fills in its own task's link, and its ○ the DONE; WidgetTapActivity takes both.
            views.setPendingIntentTemplate(R.id.agenda_list, PendingIntent.getActivity(context, 3,
                Intent(context, WidgetTapActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            val ticked = ticked(context)

            val stored = AgendaStore.load(context)
            if (stored == null) {
                views.setTextViewText(R.id.agenda_summary, "not fetched yet")
                views.setViewVisibility(R.id.agenda_list, View.GONE)
                views.setViewVisibility(R.id.agenda_empty, View.VISIBLE)
                return views
            }
            views.setViewVisibility(R.id.agenda_list, View.VISIBLE)
            views.setViewVisibility(R.id.agenda_empty, View.GONE)
            val agenda = stored.agenda
            val tasks = agenda.optJSONObject("tasks") ?: JSONObject()
            val days = agenda.optJSONArray("days").objects()
            val overdue = agenda.optJSONArray("overdue").objects()
            val todayCount = days.firstOrNull()?.optJSONArray("entries")?.length() ?: 0
            val later = days.drop(1).sumOf { it.optJSONArray("entries")?.length() ?: 0 }
            val clock = DateTimeFormatter.ofPattern("H:mm")
            val fetched = Instant.ofEpochMilli(stored.fetchedAt).atZone(ZoneId.systemDefault())
            val stale = System.currentTimeMillis() - stored.fetchedAt > STALE_MS
            val summary = buildString {
                append("$todayCount today · $later in ${days.size} days")
                append(if (stale) " · last fresh ${dayWord(fetched.toLocalDate())} ${fetched.format(clock)}" else " · ${fetched.format(clock)}")
            }
            views.setTextViewText(R.id.agenda_summary, summary)
            views.setColorStateList(R.id.agenda_summary, "setTextColor", if (stale) R.color.agenda_accent else R.color.agenda_muted)

            val items = RemoteViews.RemoteCollectionItems.Builder().setViewTypeCount(2)
            var n = 0L
            fun section(text: String, alert: Boolean) {
                val v = RemoteViews(context.packageName, R.layout.agenda_section)
                v.setTextViewText(R.id.agenda_section, text)
                v.setColorStateList(R.id.agenda_section, "setTextColor", if (alert) R.color.agenda_accent else R.color.agenda_ink)
                items.addItem(n++, v)
            }
            fun row(entry: JSONObject, overdueRow: Boolean) {
                val key = entry.optString("task")
                val task = tasks.optJSONObject(key)
                val v = RemoteViews(context.packageName, R.layout.agenda_row)
                v.setTextViewText(R.id.agenda_time, entry.optString("time"))
                v.setTextViewText(R.id.agenda_title, task?.optString("title") ?: key)
                val meta = listOf(label(entry), task?.optString("project") ?: "").filter { it.isNotEmpty() }.joinToString(" · ")
                v.setTextViewText(R.id.agenda_meta, meta)
                v.setColorStateList(R.id.agenda_meta, "setTextColor", if (overdueRow) R.color.agenda_accent else R.color.agenda_muted)
                if (key.isNotEmpty()) v.setOnClickFillInIntent(R.id.agenda_row, Intent().setData(taskUri(key)).putExtra("action", "open"))
                // A task's state as a pill in its colours, which opens the state picker; a state just picked shows at
                // once, until the daemon's agenda has it or refuses. An event has none.
                val state = ticked[key] ?: task?.optString("state") ?: ""
                val pill = PILLS[state]
                if (pill != null) {
                    v.setViewVisibility(R.id.agenda_state, View.VISIBLE)
                    v.setTextViewText(R.id.agenda_state, state)
                    v.setInt(R.id.agenda_state, "setBackgroundResource", pill.first)
                    v.setColorStateList(R.id.agenda_state, "setTextColor", pill.second)
                    if (state == "DONE") v.setColorStateList(R.id.agenda_title, "setTextColor", R.color.agenda_muted)
                    v.setOnClickFillInIntent(R.id.agenda_state, Intent().setData(taskUri(key)).putExtra("action", "state")
                        .putExtra("state", state).putExtra("title", task?.optString("title") ?: "").putExtra("protected", task?.optBoolean("protected") == true))
                } else v.setViewVisibility(R.id.agenda_state, View.GONE)
                items.addItem(n++, v)
            }
            if (overdue.isNotEmpty()) {
                section("OVERDUE · ${overdue.size}", alert = true)
                overdue.forEach { row(it, true) }
            }
            for ((i, day) in days.withIndex()) {
                val entries = day.optJSONArray("entries").objects()
                if (entries.isEmpty() && i > 0) continue
                val date = runCatching { LocalDate.parse(day.optString("date")) }.getOrNull()
                val heading = date?.let { "${it.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.CANADA)} ${it.month.getDisplayName(TextStyle.SHORT, Locale.CANADA)} ${it.dayOfMonth}".uppercase() } ?: day.optString("date")
                section(if (i == 0) "TODAY · $heading" else heading, alert = false)
                entries.forEach { row(it, false) }
                if (n > 160) break
            }
            views.setRemoteAdapter(R.id.agenda_list, items.build())
            return views
        }

        /** What an entry is, as board.mjs entryMeta says it: due, scheduled, how late, or which day of several. */
        private fun label(e: JSONObject): String {
            val extra = e.optString("extra").trim()
            val n = Regex("(\\d+)").find(extra)?.value
            return when (e.optString("type")) {
                "deadline" -> if (extra.contains("ago") && n != null) "due $n ${if (n == "1") "day" else "days"} ago" else "due"
                "upcoming-deadline" -> if (n != null) "due in $n ${if (n == "1") "day" else "days"}" else "due soon"
                "scheduled" -> "scheduled"
                "past-scheduled" -> if (n != null) "scheduled $n ${if (n == "1") "day" else "days"} ago" else "scheduled earlier"
                "block" -> Regex("\\((\\d+)/(\\d+)\\)").find(extra)?.let { "day ${it.groupValues[1]} of ${it.groupValues[2]}" } ?: ""
                else -> ""
            }
        }

        private fun dayWord(date: LocalDate): String {
            val today = LocalDate.now()
            return when (date) {
                today -> "today"
                today.minusDays(1) -> "yesterday"
                else -> "${date.month.getDisplayName(TextStyle.SHORT, Locale.CANADA)} ${date.dayOfMonth}"
            }
        }

        private fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
    }
}
