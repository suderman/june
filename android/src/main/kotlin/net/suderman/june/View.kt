package net.suderman.june

import org.json.JSONArray
import org.json.JSONObject

/**
 * One item of the folded view, as the daemon sends it (see "Attaching to the folded view" in docs/architecture.org).
 * Fields a kind does not have are empty; unknown kinds are kept and shown plainly, so a newer daemon breaks nothing.
 */
data class Item(
    val kind: String,
    val id: String,
    val text: String = "",
    val streaming: Boolean = false,
    val source: String = "",
    val error: String = "",
    val name: String = "",
    val summary: String = "",
    val status: String = "",
    val expression: String = "",
    val private: Boolean = false,
    /** The item as the daemon sent it, for the shared decisions (Decisions.kt). */
    val raw: JSONObject = JSONObject(),
) {
    companion object {
        fun from(json: JSONObject) = Item(
            kind = json.optString("kind"),
            id = json.optString("id"),
            text = json.optString("text"),
            streaming = json.optBoolean("streaming"),
            source = json.optString("source"),
            error = json.optString("error"),
            name = json.optString("name"),
            summary = json.optString("summary"),
            status = json.optString("status"),
            expression = json.optString("expression"),
            private = json.optBoolean("private"),
            raw = json,
        )
    }
}

/** What the daemon says June is doing; the fields a client needs from the view's state. */
data class ViewState(
    val running: Boolean = false,
    val compacting: Boolean = false,
    val background: Int = 0,
    val following: Int = 0,
    val activity: String = "",
    /** The state as the daemon sent it, for the shared decisions. */
    val raw: JSONObject = JSONObject(),
) {
    companion object {
        fun from(json: JSONObject) = ViewState(
            running = json.optBoolean("running"),
            compacting = json.optBoolean("compacting"),
            background = json.optInt("background"),
            following = json.optInt("following"),
            activity = json.optString("activity"),
            raw = json,
        )
    }
}

/**
 * Apply a view reply's changes, as applyChanges in src/transcript.ts does: each change removes the item with its id;
 * a put then places the item after `after`, at the start when `after` is null, at the end when `after` is not there.
 */
fun applyChanges(items: List<Item>, changes: JSONArray): List<Item> {
    var next = items
    for (i in 0 until changes.length()) {
        val change = changes.getJSONObject(i)
        val put = change.optString("op") == "put"
        val id = if (put) change.getJSONObject("item").optString("id") else change.optString("id")
        next = next.filter { it.id != id }
        if (!put) continue
        val item = Item.from(change.getJSONObject("item"))
        val after = if (change.isNull("after")) null else change.optString("after")
        val at = if (after == null) 0 else next.indexOfFirst { it.id == after }.let { if (it < 0) next.size else it + 1 }
        next = next.toMutableList().apply { add(at, item) }
    }
    return next
}

fun parseItems(array: JSONArray): List<Item> = (0 until array.length()).map { Item.from(array.getJSONObject(it)) }
