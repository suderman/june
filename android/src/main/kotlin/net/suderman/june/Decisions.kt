package net.suderman.june

import android.content.Context
import com.dokar.quickjs.QuickJs
import kotlinx.coroutines.Dispatchers
import org.json.JSONArray
import org.json.JSONObject

/**
 * The decisions the phone shares with the desktop overlay: the overlay's .mjs modules bundled as assets/june.js (a global `June`)
 * and run in QuickJS. Calls pass JSON in and take JSON back, so the JavaScript sees the same plain objects it does in
 * QML. One engine per screen; close it with the screen.
 */
class Decisions private constructor(private val js: QuickJs) {
    /** Call `June.<path>` (such as "strip.panels") with `args`, and return its result as JSON text. */
    suspend fun call(path: String, vararg args: Any?): String {
        val list = JSONArray()
        for (arg in args) list.put(arg ?: JSONObject.NULL)
        return js.evaluate<String>("JSON.stringify(June.$path(...JSON.parse(${JSONObject.quote(list.toString())})))")
    }

    /** The strip's panels for the view's items (strip.mjs `panels`). */
    suspend fun panels(items: List<Item>): JSONArray = JSONArray(call("strip.panels", JSONArray(items.map { it.raw })))

    fun close() = js.close()

    companion object {
        suspend fun load(context: Context): Decisions {
            val js = QuickJs.create(Dispatchers.Default)
            val script = context.assets.open("june.js").bufferedReader().use { it.readText() }
            js.evaluate<Any?>("$script;\nglobalThis.June = June;")
            return Decisions(js)
        }
    }
}
