package net.suderman.june

import android.app.KeyguardManager
import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged

/**
 * June's conversation full screen, connected while it is in front. Opened from the session's lock-screen prompt, it
 * covers the lock screen and asks Android to unlock (fingerprint, face, or PIN), since only an opaque activity covering
 * the lock screen may ask; once unlocked the conversation shows, and a cancelled unlock closes it.
 */
class ConversationActivity : ComponentActivity() {
    companion object {
        /** Bumped when Jon summons June while this screen is in front (JuneSession): its text field takes focus. */
        var summoned by mutableIntStateOf(0)
    }

    private lateinit var link: Link
    private var locked by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        link = Link(this)
        // Opened for a moment in June's history (june://at/ID): its day shows once the link is up.
        intent?.dataString?.let(::momentOf)?.let(link::openMoment)
        openBoard(intent)
        // The agenda widget and reminders (AgendaWidget.kt, Reminders.kt) work from here on, and remind with notices.
        AgendaJob.schedule(this)
        Push.register(this)
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 7)
        }
        setContent {
            val palette = pagePalette()
            // Dark status bar icons on a light page, light ones on a dark page.
            androidx.compose.runtime.SideEffect {
                androidx.core.view.WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = !palette.dark
            }
            // Swipes on the header (Swipes.kt): close sends June to the back, staying in recents, and an app opens over
            // her. June full screen does nothing here.
            val swipe = remember { Swipe() }
            val allowed: (Swipes.Direction) -> Boolean = { Swipes.does(Swipes.get(this, it), fullScreen = true) }
            val act: (Swipes.Direction) -> Unit = { d ->
                when (val action = Swipes.get(this, d)) {
                    Swipes.Action.Close -> moveTaskToBack(true)
                    is Swipes.Action.App -> Swipes.open(this, action.pkg)?.let { Toast.makeText(this, it, Toast.LENGTH_LONG).show() }
                    Swipes.Action.Full, Swipes.Action.None -> {}
                }
            }
            MaterialTheme(colorScheme = if (palette.dark) darkColorScheme() else androidx.compose.material3.lightColorScheme()) {
                Surface(Modifier.fillMaxSize(), color = palette.page, contentColor = palette.pageInk) {
                    Box(Modifier.fillMaxSize()) {
                        SwipeHints(swipe, palette) { d -> Swipes.get(this@ConversationActivity, d).takeIf { Swipes.does(it, fullScreen = true) }?.let { Swipes.label(this@ConversationActivity, it) } }
                        // The page moves with a swipe over the hints, so it is painted: they show only where it uncovers.
                        Box(
                            Modifier.fillMaxSize().onSizeChanged { swipe.size = it }
                                .graphicsLayer {
                                    translationX = swipe.offset.value.x
                                    translationY = swipe.offset.value.y
                                }
                                .background(palette.page).statusBarsPadding(),
                        ) {
                            if (locked) {
                                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("Unlock to talk to June", style = MaterialTheme.typography.headlineSmall) }
                            } else {
                                Sheet(
                                    link, settings = { startActivity(android.content.Intent(this@ConversationActivity, MainActivity::class.java)) },
                                    header = Modifier.swipeHandle(swipe, allowed, act),
                                    summoned = summoned,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    private var asked = false

    // Asked only once this screen has focus over the lock screen: a request made earlier is cancelled when Android
    // marks the lock screen as covered by it.
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || !locked || asked) return
        asked = true
        getSystemService(KeyguardManager::class.java).requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() {
                    Log.i(TAG, "unlocked into the conversation")
                    locked = false
                    link.open()
                }

                override fun onDismissCancelled() {
                    Log.i(TAG, "unlock cancelled")
                    finish()
                }

                override fun onDismissError() {
                    Log.w(TAG, "unlock failed")
                    finish()
                }
            })
    }

    // Checked every time the screen comes to the front, not only when it is made: Android brings back an existing one
    // over the lock screen, and one made while the phone was unlocked would otherwise show the conversation there.
    // isDeviceLocked, not isKeyguardLocked: the phone wants the user's credentials, whatever shows on screen.
    // The widget or a reminder opened June over herself: june://task?key=KEY or june://projects.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.dataString?.let(::momentOf)?.let(link::openMoment)
        openBoard(intent)
    }

    private fun openBoard(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "june") return
        when (data.host) {
            "task" -> data.getQueryParameter("key")?.takeIf { it.isNotEmpty() }?.let(link::openTask)
            "projects" -> { link.requested = "projects" to ""; link.wantBoards() }
        }
    }

    override fun onStart() {
        super.onStart()
        Keep.restore(this)
        locked = getSystemService(KeyguardManager::class.java).isDeviceLocked
        if (locked) {
            asked = false
            link.close()
        } else {
            link.open()
            Hands.resume(this)
        }
    }

    override fun onStop() {
        link.close()
        super.onStop()
    }
}
