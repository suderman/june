package net.suderman.june

import android.app.Activity
import android.os.Bundle
import android.util.Log

/**
 * Pairing from a computer over ADB, so a token never has to be typed:
 *   adb shell am start -n net.suderman.june/.PairActivity --es url wss://june.kit/ --es token TOKEN
 * The manifest lets only callers holding WRITE_SECURE_SETTINGS start it: the ADB shell and the system, never another
 * app, which could otherwise point June at a server of its own. It saves the pairing and closes.
 */
class PairActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val token = intent.getStringExtra("token")
        if (token.isNullOrBlank()) {
            Log.w(TAG, "pairing: no token given")
        } else {
            val url = intent.getStringExtra("url") ?: Pairing.DEFAULT_URL
            Pairing.save(this, Pairing(url, token))
            Log.i(TAG, "paired from the ADB shell with $url")
        }
        finish()
    }
}
