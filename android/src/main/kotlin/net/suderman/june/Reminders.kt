package net.suderman.june

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONObject
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/**
 * Bloom's reminders, from June's agenda: an exact alarm at each timed SCHEDULED and DEADLINE in the phone's copy of
 * the agenda (AgendaStore), and at a timed timestamp on a heading with a state, for headings that are not AUTO, whose
 * starts are the agents', or DONE. That is how June sets a reminder for the user: a TODO with a deadline. A plain
 * event (a timestamp on a heading without a state, as the calendar mirrors write) gets none: the calendar has it. They are set again whenever the agenda changes, after a boot
 * and after an update. A reminder's notification opens the task's page; Done marks it DONE through the daemon,
 * as the boards do, and Snooze brings it back in ten minutes.
 */
object Reminders {
    const val CHANNEL = "reminders"
    private const val MOST = 60
    private const val SNOOZE_MS = 10 * 60 * 1000L

    /** One reminder: the task, what it is for, and when. */
    data class Due(val key: String, val title: String, val what: String, val state: String, val at: Long)

    /** The reminders the stored agenda asks for from now on, soonest first. */
    fun due(context: Context, now: Long = System.currentTimeMillis()): List<Due> {
        val agenda = AgendaStore.load(context)?.agenda ?: return emptyList()
        val tasks = agenda.optJSONObject("tasks") ?: JSONObject()
        val zone = ZoneId.systemDefault()
        val out = mutableListOf<Due>()
        val days = agenda.optJSONArray("days") ?: return emptyList()
        for (i in 0 until days.length()) {
            val day = days.optJSONObject(i) ?: continue
            val date = runCatching { LocalDate.parse(day.optString("date")) }.getOrNull() ?: continue
            val entries = day.optJSONArray("entries") ?: continue
            for (j in 0 until entries.length()) {
                val e = entries.optJSONObject(j) ?: continue
                val type = e.optString("type")
                if (type != "scheduled" && type != "deadline" && type != "timestamp") continue
                val time = runCatching { LocalTime.parse(e.optString("time")) }.getOrNull() ?: continue
                val task = tasks.optJSONObject(e.optString("task")) ?: continue
                val state = task.optString("state")
                if (state == "AUTO" || state == "DONE" || (type == "timestamp" && state.isEmpty())) continue
                val at = date.atTime(time).atZone(zone).toInstant().toEpochMilli()
                if (at <= now) continue
                out += Due(e.optString("task"), task.optString("title"), when (type) { "deadline" -> "due ${e.optString("time")}"; "scheduled" -> "scheduled ${e.optString("time")}"; else -> "at ${e.optString("time")}" }, state, at)
            }
        }
        return out.distinctBy { listOf(it.key, it.what, it.at) }.sortedBy { it.at }.take(MOST)
    }

    /** Set the alarms for the stored agenda, cancelling those it no longer asks for. */
    fun schedule(context: Context) {
        val alarms = context.getSystemService(AlarmManager::class.java)
        val prefs = context.getSharedPreferences("reminders", Context.MODE_PRIVATE)
        for (code in prefs.getStringSet("codes", emptySet())!!) {
            PendingIntent.getBroadcast(context, code.toInt(), Intent(context, ReminderReceiver::class.java).setAction(ReminderReceiver.ALARM), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_NO_CREATE)?.let { alarms.cancel(it); it.cancel() }
        }
        val codes = mutableSetOf<String>()
        for (due in due(context)) {
            val code = listOf(due.key, due.what, due.at).hashCode()
            set(context, code, due, due.at)
            codes += code.toString()
        }
        prefs.edit().putStringSet("codes", codes).apply()
    }

    fun snooze(context: Context, due: Due) = set(context, listOf(due.key, due.what, "snooze").hashCode(), due, System.currentTimeMillis() + SNOOZE_MS)

    private fun set(context: Context, code: Int, due: Due, at: Long) {
        val alarms = context.getSystemService(AlarmManager::class.java)
        val intent = PendingIntent.getBroadcast(context, code, ReminderReceiver.intent(context, ReminderReceiver.ALARM, due), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        if (alarms.canScheduleExactAlarms()) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
        else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
    }

    fun channel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Timed SCHEDULED and DEADLINE entries from your Org agenda"
            })
        }
    }
}

/** A reminder's alarm, and its notification's Done and Snooze. */
class ReminderReceiver : BroadcastReceiver() {
    companion object {
        const val ALARM = "net.suderman.june.REMINDER"
        const val DONE = "net.suderman.june.REMINDER_DONE"
        const val SNOOZE = "net.suderman.june.REMINDER_SNOOZE"

        fun intent(context: Context, action: String, due: Reminders.Due): Intent = Intent(context, ReminderReceiver::class.java).setAction(action)
            .putExtra("key", due.key).putExtra("title", due.title).putExtra("what", due.what).putExtra("state", due.state).putExtra("at", due.at)

        private fun due(intent: Intent) = Reminders.Due(intent.getStringExtra("key") ?: "", intent.getStringExtra("title") ?: "", intent.getStringExtra("what") ?: "", intent.getStringExtra("state") ?: "", intent.getLongExtra("at", 0))
        private fun id(due: Reminders.Due) = listOf(due.key, due.what).hashCode()
    }

    override fun onReceive(context: Context, intent: Intent) {
        val due = due(intent)
        if (due.key.isEmpty()) return
        val manager = context.getSystemService(NotificationManager::class.java)
        when (intent.action) {
            ALARM -> notify(context, due, null)
            SNOOZE -> {
                manager.cancel(id(due))
                Reminders.snooze(context, due)
            }
            DONE -> {
                val pending = goAsync()
                Thread {
                    try {
                        val reply = DaemonCall.request(context, JSONObject().put("op", "task").put("key", due.key).put("edit", JSONObject().put("action", "state").put("state", "DONE")))
                        if (reply?.optString("type") == "task") {
                            manager.cancel(id(due))
                            AgendaJob.now(context)
                        } else notify(context, due, reply?.optString("message")?.takeIf { it.isNotEmpty() } ?: "June couldn't be reached; it is not marked done")
                    } finally {
                        pending.finish()
                    }
                }.start()
            }
        }
    }

    private fun notify(context: Context, due: Reminders.Due, problem: String?) {
        Reminders.channel(context)
        val open = PendingIntent.getActivity(context, id(due), Intent(context, ConversationActivity::class.java).setAction(Intent.ACTION_VIEW)
            .setData(AgendaWidget.taskUri(due.key)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
        fun action(label: String, action: String) = Notification.Action.Builder(null, label,
            PendingIntent.getBroadcast(context, listOf(due.key, action).hashCode(), intent(context, action, due), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)).build()
        val builder = Notification.Builder(context, Reminders.CHANNEL)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(due.title)
            .setContentText(problem ?: due.what)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_REMINDER)
        // Done only for a heading with a state the boards can set; an event has none.
        if (due.state.isNotEmpty()) builder.addAction(action("Done", DONE))
        builder.addAction(action("Snooze 10 min", SNOOZE))
        context.getSystemService(NotificationManager::class.java).notify(id(due), builder.build())
    }
}
