package net.suderman.june

import android.app.KeyguardManager
import android.app.assist.AssistStructure
import android.content.Context
import android.graphics.Bitmap
import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.util.Log
import android.view.View
import android.view.WindowManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ComposeView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner

/**
 * June's assistant session: the conversation over whatever is on screen, connected while it shows. Over the lock
 * screen it shows only a prompt to unlock and does not connect. Each invocation is still recorded (how it was opened,
 * what screen context arrived) to logcat under the tag June and for the launcher activity.
 */
class JuneSession(context: Context) : VoiceInteractionSession(context), LifecycleOwner, SavedStateRegistryOwner {
    private val lifecycleRegistry = LifecycleRegistry(this)
    private val savedState = SavedStateRegistryController.create(this)
    override val lifecycle: Lifecycle get() = lifecycleRegistry
    override val savedStateRegistry: SavedStateRegistry get() = savedState.savedStateRegistry

    private val link = Link(context)
    private var locked by mutableStateOf(false)
    private val lines = mutableListOf<String>()

    override fun onCreate() {
        super.onCreate()
        savedState.performRestore(null)
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE)
        // The sheet moves up with the keyboard rather than hiding under it.
        window.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    }

    // Compose needs a lifecycle and saved state, which a session does not have; it is its own owner of both.
    override fun onCreateContentView(): View = ComposeView(context).apply {
        setViewTreeLifecycleOwner(this@JuneSession)
        setViewTreeSavedStateRegistryOwner(this@JuneSession)
        setContent { Conversation(link, locked) { hide() } }
    }

    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
        lines.clear()
        locked = context.getSystemService(KeyguardManager::class.java).isKeyguardLocked
        if (!locked) link.open()
        record("time: ${java.time.LocalDateTime.now().withNano(0)}")
        record("locked: $locked")
        record("showFlags: ${describeFlags(showFlags)}")
        record("args: ${describe(args)}")
    }

    override fun onHide() {
        super.onHide()
        link.close()
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
        Log.i(TAG, "session hidden")
    }

    override fun onDestroy() {
        link.close()
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_DESTROY)
        super.onDestroy()
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

    private fun record(line: String) {
        Log.i(TAG, line)
        lines.add(line)
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
