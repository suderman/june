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
 * June's agenda on the home screen, in place of Bloom's, from the phone's copy of the agenda (AgendaStore), with how
 * much it holds and how fresh it is. Each widget shows one view, picked by tapping its title (ViewPickerActivity), as
 * Bloom borrowed from Orgzly's saved searches: the agenda (overdue, then 14 days), today, overdue, this week, or a list
 * of open tasks by kind. A row opens its task's page in June; its state pill changes its state; + hands June a TODO;
 * ↻ asks for a fresh copy. It redraws whenever the copy changes.
 */
class AgendaWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        AgendaJob.schedule(context)
        for (id in ids) manager.updateAppWidget(id, render(context, id))
    }

    override fun onDeleted(context: Context, ids: IntArray) {
        val prefs = views(context).edit()
        for (id in ids) prefs.remove(id.toString())
        prefs.apply()
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
            for (id in manager.getAppWidgetIds(ComponentName(context, AgendaWidget::class.java))) {
                val views = render(context, id)
                if (toTop) views.setScrollPosition(R.id.agenda_list, 0)
                manager.updateAppWidget(id, views)
            }
        }

        /** A view a widget can show: its name, what it holds, and, for a list, which open tasks. */
        class View_(val id: String, val name: String, val about: String, val tasks: ((JSONObject) -> Boolean)? = null)

        private fun dated(t: JSONObject) = t.optString("scheduled").isNotEmpty() || t.optString("deadline").isNotEmpty()
        val VIEWS = listOf(
            View_("agenda", "Agenda", "Overdue, then the next 14 days"),
            View_("today", "Today", "What today holds"),
            View_("overdue", "Overdue", "Late deadlines and scheduled tasks"),
            View_("week", "This week", "Today and the next six days"),
            View_("open", "Open tasks", "Everything not DONE, newest-touched projects first") { true },
            View_("unscheduled", "Unscheduled", "Open tasks with no SCHEDULED or DEADLINE") { !dated(it) },
            View_("prog", "In progress", "PROG") { it.optString("state") == "PROG" },
            View_("eval", "In review", "EVAL") { it.optString("state") == "EVAL" },
            View_("hold", "On hold", "HOLD") { it.optString("state") == "HOLD" },
            View_("auto", "Agents", "AUTO: queued for an agent") { it.optString("state") == "AUTO" },
            View_("todo", "To do", "TODO") { it.optString("state") == "TODO" },
        )

        private fun views(context: Context) = context.getSharedPreferences("widget_views", Context.MODE_PRIVATE)
        fun viewOf(context: Context, id: Int): View_ = VIEWS.find { it.id == views(context).getString(id.toString(), "agenda") } ?: VIEWS[0]

        fun setView(context: Context, id: Int, view: String) {
            views(context).edit().putString(id.toString(), view).apply()
            val manager = AppWidgetManager.getInstance(context)
            manager.updateAppWidget(id, render(context, id).also { it.setScrollPosition(R.id.agenda_list, 0) })
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

        private fun render(context: Context, widget: Int): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.agenda_widget)
            val view = viewOf(context, widget)
            views.setTextViewText(R.id.agenda_view_name, "${view.name} ▾")
            views.setOnClickPendingIntent(R.id.agenda_choose, PendingIntent.getActivity(context, 100 + widget,
                Intent(context, ViewPickerActivity::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widget).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            views.setOnClickPendingIntent(R.id.agenda_refresh, PendingIntent.getBroadcast(context, 2, Intent(context, AgendaWidget::class.java).setAction(REFRESH), PendingIntent.FLAG_IMMUTABLE))
            views.setOnClickPendingIntent(R.id.agenda_add, PendingIntent.getActivity(context, 4, Intent(context, QuickAddActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE))
            // Bottom shortcuts matching June's tab bar: Terminal, Agents, Chat, Projects, Editor.
            fun openView(code: Int, host: String) = PendingIntent.getActivity(
                context, code,
                Intent(context, ConversationActivity::class.java).setAction(Intent.ACTION_VIEW)
                    .setData(Uri.parse("june://$host"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            fun openSlot(code: Int, slot: Swipes.AppSlot) = PendingIntent.getActivity(
                context, code,
                Intent(context, WidgetTapActivity::class.java).putExtra("action", "slot").putExtra("slot", slot.key)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            views.setOnClickPendingIntent(R.id.agenda_tab_terminal, openSlot(10, Swipes.AppSlot.Terminal))
            views.setOnClickPendingIntent(R.id.agenda_tab_agents, openView(11, "agents"))
            views.setOnClickPendingIntent(R.id.agenda_tab_chat, openView(12, "chat"))
            views.setOnClickPendingIntent(R.id.agenda_tab_projects, openView(13, "projects"))
            views.setOnClickPendingIntent(R.id.agenda_tab_editor, openSlot(14, Swipes.AppSlot.Editor))
            // Each row fills in its own task's link, and its pill the state picker; WidgetTapActivity takes both.
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
            val listed = view.tasks?.let { keep -> agenda.optJSONArray("open").objects().filter(keep) }
            val summary = buildString {
                append(when {
                    listed != null -> "${listed.size} ${if (listed.size == 1) "task" else "tasks"}"
                    view.id == "overdue" -> "${overdue.size} overdue"
                    view.id == "today" -> "$todayCount today"
                    view.id == "week" -> "$todayCount today · ${days.drop(1).take(6).sumOf { it.optJSONArray("entries")?.length() ?: 0 }} this week"
                    else -> "$todayCount today · $later in ${days.size} days"
                })
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
            fun row(entry: JSONObject, overdueRow: Boolean, time: String = entry.optString("time"), what: String = label(entry)) {
                val key = entry.optString("task")
                val task = tasks.optJSONObject(key)
                val v = RemoteViews(context.packageName, R.layout.agenda_row)
                v.setTextViewText(R.id.agenda_time, time)
                v.setTextViewText(R.id.agenda_title, task?.optString("title") ?: key)
                val meta = listOf(what, task?.optString("project") ?: "").filter { it.isNotEmpty() }.joinToString(" · ")
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
            if (listed != null) {
                // A list of open tasks: each with its dates, if any, in the small print.
                section("${view.name.uppercase()} · ${listed.size}", alert = false)
                for (t in listed.take(150)) {
                    val due = stampDay(t.optString("deadline"))
                    val start = stampDay(t.optString("scheduled"))
                    row(JSONObject().put("task", t.optString("key")), overdueRow = false, time = "",
                        what = listOfNotNull(due?.let { "due $it" }, start?.let { "scheduled $it" }).joinToString(" · "))
                }
                views.setRemoteAdapter(R.id.agenda_list, items.build())
                return views
            }
            if (overdue.isNotEmpty() && view.id in listOf("agenda", "overdue")) {
                section("OVERDUE · ${overdue.size}", alert = true)
                overdue.forEach { row(it, true) }
            }
            val shown = when (view.id) { "overdue" -> emptyList(); "today" -> days.take(1); "week" -> days.take(7); else -> days }
            for ((i, day) in shown.withIndex()) {
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

        /** An Org timestamp's day and time, as the widget names them: today, tomorrow, a weekday, or Nov 27. */
        private fun stampDay(stamp: String): String? {
            val m = Regex("(\\d{4}-\\d{2}-\\d{2})(?: \\S+)?(?: (\\d{1,2}:\\d{2}))?").find(stamp) ?: return null
            val date = runCatching { LocalDate.parse(m.groupValues[1]) }.getOrNull() ?: return null
            val today = LocalDate.now()
            val day = when {
                date == today -> "today"
                date == today.plusDays(1) -> "tomorrow"
                date == today.minusDays(1) -> "yesterday"
                date.isAfter(today) && date.isBefore(today.plusDays(7)) -> date.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.CANADA)
                else -> "${date.month.getDisplayName(TextStyle.SHORT, Locale.CANADA)} ${date.dayOfMonth}"
            }
            return if (m.groupValues[2].isNotEmpty()) "$day ${m.groupValues[2]}" else day
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
