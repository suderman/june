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
import android.view.ViewTreeObserver
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
    // What was on screen at the summon, offered with the next message; the app is named from the show's arguments.
    private var screen by mutableStateOf<Screen?>(null)
    private var app: String? = null
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
        setContent { Conversation(link, locked, screen, dismiss = { hide() }, unlock = ::unlock) }
    }

    // Summoned over June's own full screen: no sheet over her, the full screen takes the words instead.
    private var overJune = false

    override fun onPrepareShow(args: Bundle?, showFlags: Int) {
        super.onPrepareShow(args, showFlags)
        val front = foreground(args)
        overJune = front?.packageName == context.packageName && front.className == ConversationActivity::class.java.name &&
            !context.getSystemService(KeyguardManager::class.java).isDeviceLocked
        // Off before the window would be added, so the sheet never shows; on again for the next summon.
        setUiEnabled(!overJune)
    }

    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        if (overJune) {
            Log.i(TAG, "summoned over the full screen: its text field takes focus")
            ConversationActivity.summoned++
            hide()
            return
        }
        keepStill()
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
        // Opening June lets her hands act again after Jon stopped them; while she shows, her hands may close her.
        Hands.resume(context)
        Keep.restore(context)
        if (dismissal == null) dismissal = object : android.content.BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) = hide()
        }.also { context.registerReceiver(it, android.content.IntentFilter(Hands.DISMISS), Context.RECEIVER_NOT_EXPORTED) }
        lines.clear()
        screen = null
        app = runCatching {
            foreground(args)?.let { context.packageManager.getApplicationLabel(context.packageManager.getApplicationInfo(it.packageName, 0)).toString() }
        }.getOrNull()
        // Whether the phone wants the user's credentials, not merely whether the lock screen shows.
        locked = context.getSystemService(KeyguardManager::class.java).isDeviceLocked
        if (locked) watchUnlock() else link.open()
        record("time: ${java.time.LocalDateTime.now().withNano(0)}")
        record("locked: $locked")
        record("showFlags: ${describeFlags(showFlags)}")
        record("args: ${describe(args)}")
    }

    /**
     * The window neither pans nor resizes for the keyboard; the sheet pads itself above it, keeping the status line in
     * view. The session adds its window before June can set this, so Android keeps "unspecified" as the window's own
     * choice and works the mode out again whenever the window goes from hidden to shown, picking pan: the status line
     * then went off the top. Set once that first frame is laid out, it holds until the next show.
     */
    private fun keepStill() {
        val decor = window.window?.decorView ?: return
        decor.viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
            override fun onPreDraw(): Boolean {
                decor.viewTreeObserver.removeOnPreDrawListener(this)
                window.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)
                return true
            }
        })
    }

    /** The activity in front when June was summoned, from the show's arguments. */
    private fun foreground(args: Bundle?): android.content.ComponentName? = runCatching {
        @Suppress("DEPRECATION")
        args?.getParcelableArrayList<android.content.ComponentName>("android.service.voice.FOREGROUND_ACTIVITIES")?.firstOrNull()
    }.getOrNull()

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
        dismissal?.let { runCatching { context.unregisterReceiver(it) } }
        dismissal = null
        stopWatchingUnlock()
        link.close()
        // Stopped, not just paused: Compose pauses its frame clock only on stop, and the hidden sheet's badge animation
        // otherwise kept the main thread busy around the clock. The next show resumes through start.
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
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
        // Never over the lock screen: only a prompt shows there.
        if (screenshot != null && !locked) screen = Screen(screenshot, app ?: "the screen")
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

    // June's hands (in their own process) ask the session to close before they act: it sits above the apps and even
    // the power menu.
    private var dismissal: android.content.BroadcastReceiver? = null

    // The system's args include invocation_type (1 gesture, 5 home long press, 6 power long press, 7 handle long press).
    private fun describe(bundle: Bundle?): String =
        bundle?.keySet()?.sorted()?.joinToString(", ", "{", "}") { "$it=${bundle.get(it)}" } ?: "null"
}
