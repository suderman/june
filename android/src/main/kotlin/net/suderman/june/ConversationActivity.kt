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
        locked = getSystemService(KeyguardManager::class.java).isKeyguardLocked
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Surface(Modifier.fillMaxSize(), color = Color(0xFF141418), contentColor = Color(0xFFECE6DA)) {
                    Box(Modifier.statusBarsPadding()) {
                        if (locked) {
                            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("Unlock to talk to June", style = MaterialTheme.typography.headlineSmall) }
                        } else {
                            Sheet(link)
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

    override fun onStart() {
        super.onStart()
        if (!locked) link.open()
    }

    override fun onStop() {
        link.close()
        super.onStop()
    }
}
