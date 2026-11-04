package net.suderman.june

import android.content.Context

/** This phone's pairing with June: the listener's address and the device token from `june device add`, kept in the app's private storage. */
data class Pairing(val url: String, val token: String) {
    companion object {
        private const val PREFS = "pairing"
        const val DEFAULT_URL = "wss://june.kit/"

        fun load(context: Context): Pairing? {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val url = prefs.getString("url", null) ?: return null
            val token = prefs.getString("token", null) ?: return null
            return if (url.isBlank() || token.isBlank()) null else Pairing(url, token)
        }

        fun save(context: Context, pairing: Pairing) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("url", pairing.url.trim()).putString("token", pairing.token.trim()).apply()
        }

        fun clear(context: Context) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
        }
    }
}
