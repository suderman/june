package net.suderman.june

import android.Manifest
import android.app.role.RoleManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log

/**
 * Keeps June set up as Jon chose: the assistant the gesture and the power-button hold open, with the screen's text and
 * picture, and her hands. Android clears the assistant's settings when it re-checks the assistant (after an app update,
 * and seemingly after a system update) and finds no system speech recognizer, though June keeps the role. So she puts
 * them back after an update, after a boot, and whenever her screens open.
 *
 * It needs WRITE_SECURE_SETTINGS, which only ADB can grant (the install app does) and which survives updates. It acts
 * only while June holds the assistant role, so choosing another assistant is never undone.
 */
object Keep {
    private const val INTERACTION = "net.suderman.june/.JuneInteractionService"
    private const val RECOGNITION = "net.suderman.june/.JuneRecognitionService"
    private const val HANDS = "net.suderman.june/net.suderman.june.Hands"

    /** Put back whatever has been cleared; returns what was restored, for the log. */
    fun restore(context: Context): List<String> {
        if (context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) != PackageManager.PERMISSION_GRANTED) return emptyList()
        if (context.getSystemService(RoleManager::class.java)?.isRoleHeld(RoleManager.ROLE_ASSISTANT) != true) return emptyList()
        val resolver = context.contentResolver
        val restored = mutableListOf<String>()
        fun want(key: String, value: String) {
            if (Settings.Secure.getString(resolver, key) != value && Settings.Secure.putString(resolver, key, value)) restored.add(key)
        }
        want("voice_recognition_service", RECOGNITION)
        want("voice_interaction_service", INTERACTION)
        want("assist_structure_enabled", "1")
        want("assist_screenshot_enabled", "1")
        val enabled = Settings.Secure.getString(resolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
        val names = enabled.split(':').filter { it.isNotEmpty() }
        if (names.none { it == HANDS || it == "net.suderman.june/.Hands" }) {
            Settings.Secure.putString(resolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, (names + HANDS).joinToString(":"))
            Settings.Secure.putString(resolver, Settings.Secure.ACCESSIBILITY_ENABLED, "1")
            restored.add("hands")
        }
        if (restored.isNotEmpty()) Log.i(TAG, "keep: restored ${restored.joinToString()}")
        return restored
    }
}

/**
 * After an app update or a boot. Android clears the assistant a moment after an update, so it looks again a little
 * later as well as at once.
 */
class KeepReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED && intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val app = context.applicationContext
        val pending = goAsync()
        val main = Handler(Looper.getMainLooper())
        Keep.restore(app)
        main.postDelayed({ Keep.restore(app) }, 3_000)
        main.postDelayed({ Keep.restore(app); pending.finish() }, 8_000)
    }
}
