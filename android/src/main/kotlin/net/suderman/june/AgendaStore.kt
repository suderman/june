package net.suderman.june

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * The last agenda the daemon sent (src/board.ts Agenda), kept on the phone for the home-screen widget and the
 * reminders, which run while June is closed or offline. Only what they draw is kept: overdue, the days and their
 * entries, and the tasks those name, with their title, state and project. Saving redraws the widget and sets the
 * reminders again.
 */
object AgendaStore {
    data class Stored(val agenda: JSONObject, val fetchedAt: Long, val revision: String)

    private val writer = Executors.newSingleThreadExecutor()
    private fun file(context: Context) = File(context.filesDir, "agenda.json")

    /** Keep AGENDA, off the main thread; the widget and reminders follow. */
    fun save(context: Context, agenda: JSONObject, revision: String) {
        val app = context.applicationContext
        writer.execute {
            val old = load(app)
            val record = JSONObject().put("fetchedAt", System.currentTimeMillis()).put("revision", revision).put("agenda", trim(agenda))
            val tmp = File(app.filesDir, "agenda.json.tmp")
            tmp.writeText(record.toString())
            tmp.renameTo(file(app))
            val changed = old?.revision != revision
            AgendaWidget.updateAll(app, toTop = changed)
            if (changed) Reminders.schedule(app)
        }
    }

    fun load(context: Context): Stored? = runCatching {
        val record = JSONObject(file(context.applicationContext).readText())
        Stored(record.getJSONObject("agenda"), record.optLong("fetchedAt"), record.optString("revision"))
    }.getOrNull()

    /** The widget's and reminders' part of the agenda. */
    private fun trim(agenda: JSONObject): JSONObject {
        val tasks = agenda.optJSONObject("tasks") ?: JSONObject()
        val named = JSONObject()
        fun keep(entries: JSONArray?) {
            for (i in 0 until (entries?.length() ?: 0)) {
                val key = entries!!.optJSONObject(i)?.optString("task") ?: continue
                val t = tasks.optJSONObject(key) ?: continue
                if (named.has(key)) continue
                named.put(key, JSONObject().put("title", t.optString("title")).put("state", t.optString("state"))
                    .put("project", t.optString("project")).put("protected", t.optBoolean("protected")))
            }
        }
        keep(agenda.optJSONArray("overdue"))
        val days = agenda.optJSONArray("days") ?: JSONArray()
        for (i in 0 until days.length()) keep(days.optJSONObject(i)?.optJSONArray("entries"))
        return JSONObject().put("today", agenda.optString("today")).put("generatedAt", agenda.optLong("generatedAt"))
            .put("overdue", agenda.optJSONArray("overdue") ?: JSONArray()).put("days", days).put("tasks", named)
            .put("reminders", agenda.optJSONObject("reminders") ?: JSONObject().put("dateOnly", "09:00"))
    }
}
