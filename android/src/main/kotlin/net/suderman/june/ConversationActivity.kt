package net.suderman.june

import android.app.KeyguardManager
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color

/**
 * June's conversation full screen, connected while it is in front. Opened from the session's lock-screen prompt, it
 * covers the lock screen and asks Android to unlock (fingerprint, face, or PIN), since only an opaque activity covering
 * the lock screen may ask; once unlocked the conversation shows, and a cancelled unlock closes it.
 */
class ConversationActivity : ComponentActivity() {
    private lateinit var link: Link
    private var locked by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        link = Link(this)
        setContent {
            val palette = pagePalette()
            // Dark status bar icons on a light page, light ones on a dark page.
            androidx.compose.runtime.SideEffect {
                androidx.core.view.WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = !palette.dark
            }
            MaterialTheme(colorScheme = if (palette.dark) darkColorScheme() else androidx.compose.material3.lightColorScheme()) {
                Surface(Modifier.fillMaxSize(), color = palette.page, contentColor = palette.pageInk) {
                    Box(Modifier.statusBarsPadding()) {
                        if (locked) {
                            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("Unlock to talk to June", style = MaterialTheme.typography.headlineSmall) }
                        } else {
                            Sheet(link, settings = { startActivity(android.content.Intent(this@ConversationActivity, MainActivity::class.java)) })
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
