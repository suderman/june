package net.suderman.june

import android.app.KeyguardManager
import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
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
    }

    // Compose needs a lifecycle and saved state, which a session does not have; it is its own owner of both.
    override fun onCreateContentView(): View = ComposeView(context).apply {
        setViewTreeLifecycleOwner(this@JuneSession)
        setViewTreeSavedStateRegistryOwner(this@JuneSession)
        setContent { Conversation(link, locked, dismiss = { hide() }, unlock = ::unlock) }
    }

    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        // The window neither pans nor resizes for the keyboard; the sheet pads itself above it, keeping the status line
        // in view. Set before the window is up, Android puts it back to pan, which pushed the status line off the top.
        window.window?.decorView?.post { window.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING) }
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
        // Opening June lets her hands act again after Jon stopped them.
        Hands.resume()
        showing = this
        lines.clear()
        // Whether the phone wants the user's credentials, not merely whether the lock screen shows.
        locked = context.getSystemService(KeyguardManager::class.java).isDeviceLocked
        if (locked) watchUnlock() else link.open()
        record("time: ${java.time.LocalDateTime.now().withNano(0)}")
        record("locked: $locked")
        record("showFlags: ${describeFlags(showFlags)}")
        record("args: ${describe(args)}")
    }

    /**
     * Over the lock screen, a tap on the prompt opens June's full conversation screen, which covers the lock screen and
     * asks for the fingerprint or PIN itself; once unlocked, the conversation is there. A session cannot ask: Android
     * honours an unlock request only from an opaque activity that covers the lock screen.
     */
    private fun unlock() {
        context.startActivity(Intent(context, ConversationActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        hide()
    }

    // Unlocked with the fingerprint sensor while the prompt shows (the phone's own reader stays live under the session),
    // she shows the conversation at once rather than the prompt a second time.
    private var unlockWatch: android.content.BroadcastReceiver? = null

    private fun watchUnlock() {
        if (unlockWatch != null) return
        val watch = object : android.content.BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) {
                if (context.getSystemService(KeyguardManager::class.java).isDeviceLocked) return
                Log.i(TAG, "unlocked under the session")
                stopWatchingUnlock()
                locked = false
                link.open()
            }
        }
        context.registerReceiver(watch, android.content.IntentFilter(Intent.ACTION_USER_PRESENT), Context.RECEIVER_EXPORTED)
        unlockWatch = watch
    }

    private fun stopWatchingUnlock() {
        unlockWatch?.let { runCatching { context.unregisterReceiver(it) } }
        unlockWatch = null
    }

    override fun onHide() {
        super.onHide()
        if (showing === this) showing = null
        stopWatchingUnlock()
        link.close()
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
        Log.i(TAG, "session hidden")
    }

    override fun onDestroy() {
        stopWatchingUnlock()
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

    companion object {
        /** The session on screen, which June's hands close before acting: it sits above the apps and even the power menu. */
        private var showing: JuneSession? = null

        /** Close the session if it shows; whether it did. */
        fun dismiss(): Boolean = showing?.let { it.hide(); true } ?: false
    }

    // The system's args include invocation_type (1 gesture, 5 home long press, 6 power long press, 7 handle long press).
    private fun describe(bundle: Bundle?): String =
        bundle?.keySet()?.sorted()?.joinToString(", ", "{", "}") { "$it=${bundle.get(it)}" } ?: "null"
}
