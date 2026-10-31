package net.suderman.june

import android.app.KeyguardManager
import android.app.assist.AssistStructure
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.util.Log
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView

// A placeholder session that records how it was invoked and what the system handed it,
// so the proof of concept can be read off the phone afterwards.
class JuneSession(context: Context) : VoiceInteractionSession(context) {
    private val lines = mutableListOf<String>()
    private var status: TextView? = null
    private var detail: TextView? = null

    override fun onCreateContentView(): View {
        val pad = (16 * context.resources.displayMetrics.density).toInt()
        val title = TextView(context).apply {
            textSize = 24f
            setTextColor(Color.WHITE)
        }
        val body = TextView(context).apply {
            textSize = 13f
            setTextColor(Color.LTGRAY)
            setPadding(0, pad, 0, 0)
        }
        status = title
        detail = body
        return LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.BOTTOM
            setBackgroundColor(Color.argb(235, 20, 20, 28))
            setPadding(pad, pad, pad, pad * 3)
            addView(title)
            addView(body)
            setOnClickListener { hide() }
        }
    }

    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        lines.clear()
        val locked = context.getSystemService(KeyguardManager::class.java).isKeyguardLocked
        status?.text = if (locked) "Unlock to talk to June" else "June is listening (placeholder)"
        record("time: ${java.time.LocalDateTime.now().withNano(0)}")
        record("locked: $locked")
        record("showFlags: ${describeFlags(showFlags)}")
        record("args: ${describe(args)}")
    }

    override fun onHandleAssist(state: AssistState) {
        val structure = state.assistStructure
        val windows = structure?.windowNodeCount ?: 0
        var nodes = 0
        var texts = 0
        if (structure != null) {
            for (i in 0 until windows) {
                val counts = count(structure.getWindowNodeAt(i).rootViewNode)
                nodes += counts.first
                texts += counts.second
            }
        }
        record(
            "assist ${state.index + 1}/${state.count}: app=${structure?.activityComponent?.flattenToShortString()} " +
                "windows=$windows nodes=$nodes withText=$texts content=${state.assistContent != null} " +
                "data=${describe(state.assistData)}"
        )
    }

    override fun onHandleScreenshot(screenshot: Bitmap?) {
        record("screenshot: ${screenshot?.let { "${it.width}x${it.height}" } ?: "null"}")
    }

    override fun onHide() {
        super.onHide()
        Log.i(TAG, "session hidden")
    }

    private fun record(line: String) {
        Log.i(TAG, line)
        lines.add(line)
        detail?.text = lines.joinToString("\n")
        Report.save(context, lines)
    }

    private fun count(node: AssistStructure.ViewNode): Pair<Int, Int> {
        var nodes = 1
        var texts = if (node.text.isNullOrEmpty()) 0 else 1
        for (i in 0 until node.childCount) {
            val child = count(node.getChildAt(i))
            nodes += child.first
            texts += child.second
        }
        return nodes to texts
    }

    private fun describeFlags(flags: Int): String {
        val names = listOf(
            SHOW_WITH_ASSIST to "WITH_ASSIST",
            SHOW_WITH_SCREENSHOT to "WITH_SCREENSHOT",
            SHOW_SOURCE_ASSIST_GESTURE to "SOURCE_ASSIST_GESTURE",
            SHOW_SOURCE_APPLICATION to "SOURCE_APPLICATION",
            SHOW_SOURCE_ACTIVITY to "SOURCE_ACTIVITY",
            SHOW_SOURCE_PUSH_TO_TALK to "SOURCE_PUSH_TO_TALK",
            SHOW_SOURCE_NOTIFICATION to "SOURCE_NOTIFICATION",
            SHOW_SOURCE_AUTOMOTIVE_SYSTEM_UI to "SOURCE_AUTOMOTIVE_SYSTEM_UI",
        ).filter { flags and it.first != 0 }.map { it.second }
        return "$flags ${names.joinToString("|")}"
    }

    // The system's args include invocation_type (1 gesture, 5 home long press, 6 power long press, 7 handle long press).
    private fun describe(bundle: Bundle?): String =
        bundle?.keySet()?.sorted()?.joinToString(", ", "{", "}") { "$it=${bundle.get(it)}" } ?: "null"
}
