package net.suderman.june

import android.app.Activity
import android.os.Bundle
import android.util.Log

/**
 * Pairing from a computer over ADB, so a token never has to be typed:
 *   adb shell am start -n net.suderman.june/.PairActivity --es url wss://june.kit/ --es token TOKEN
 * It also takes the under-display fingerprint sensor's position, which an app cannot ask Android for but SystemUI
 * reports to ADB: --es fingerprint X,Y,RADIUS in screen pixels (the install app passes it).
 * The manifest lets only callers holding WRITE_SECURE_SETTINGS start it: the ADB shell and the system, never another
 * app, which could otherwise point June at a server of its own. It saves what it is given and closes.
 */
class PairActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        intent.getStringExtra("fingerprint")?.let { spot ->
            getSharedPreferences("device", MODE_PRIVATE).edit().putString("fingerprint", spot).apply()
            Log.i(TAG, "fingerprint sensor at $spot")
        }
        val token = intent.getStringExtra("token")
        if (!token.isNullOrBlank()) {
            val url = intent.getStringExtra("url") ?: Pairing.DEFAULT_URL
            Pairing.save(this, Pairing(url, token))
            Log.i(TAG, "paired from the ADB shell with $url")
        }
        finish()
    }
}
