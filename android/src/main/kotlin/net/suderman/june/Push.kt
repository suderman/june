package net.suderman.june

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONObject
import java.util.UUID

/**
 * Pushes from the daemon when the agenda changes (src/push.ts), so the widget and reminders refresh within seconds of
 * an edit made elsewhere, not at the next 15-minute refresh. They come through UnifiedPush with the ntfy app as the
 * distributor: June registers with it, it answers with an address on the ntfy server, June gives the daemon that
 * address, and ntfy hands each push to PushReceiver, even while June is closed. Plain broadcasts; no library.
 */
object Push {
    private const val DISTRIBUTOR = "io.heckel.ntfy"
    private fun prefs(context: Context) = context.getSharedPreferences("push", Context.MODE_PRIVATE)

    /** This install's token with the distributor, made once. */
    fun token(context: Context): String {
        val prefs = prefs(context)
        return prefs.getString("token", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("token", it).apply() }
    }

    /** Ask ntfy for an address; it answers with NEW_ENDPOINT, every time, which goes on to the daemon. */
    fun register(context: Context) {
        val installed = runCatching { context.packageManager.getPackageInfo(DISTRIBUTOR, 0) }.isSuccess
        if (!installed) return
        context.sendBroadcast(
            Intent("org.unifiedpush.android.distributor.REGISTER").setPackage(DISTRIBUTOR)
                .putExtra("token", token(context))
                .putExtra("application", context.packageName)
                .putExtra("message", "June's agenda")
                .putExtra("pi", PendingIntent.getBroadcast(context, 0, Intent("net.suderman.june.PUSH_IDENTITY").setPackage(context.packageName), PendingIntent.FLAG_IMMUTABLE)),
        )
    }

    fun saveEndpoint(context: Context, endpoint: String?) = prefs(context).edit().putString("endpoint", endpoint).apply()

    /** Tell the daemon where to push. Blocks. */
    fun sendEndpoint(context: Context, endpoint: String): Boolean =
        DaemonCall.request(context, JSONObject().put("op", "push").put("endpoint", endpoint))?.optString("type") == "push"

    fun ack(context: Context, id: String) {
        context.sendBroadcast(Intent("org.unifiedpush.android.distributor.MESSAGE_ACK").setPackage(DISTRIBUTOR).putExtra("token", token(context)).putExtra("id", id))
    }
}

/** ntfy's answers and pushes for June (UnifiedPush's connector broadcasts). Anything without June's token is dropped. */
class PushReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.getStringExtra("token") != Push.token(context)) return
        when (intent.action) {
            "org.unifiedpush.android.connector.NEW_ENDPOINT" -> {
                val endpoint = intent.getStringExtra("endpoint") ?: return
                Push.saveEndpoint(context, endpoint)
                val pending = goAsync()
                Thread {
                    try {
                        Push.sendEndpoint(context, endpoint)
                    } finally {
                        pending.finish()
                    }
                }.start()
            }
            // The agenda changed: fetch it at once.
            "org.unifiedpush.android.connector.MESSAGE" -> {
                AgendaJob.now(context)
                intent.getStringExtra("id")?.let { Push.ack(context, it) }
            }
            "org.unifiedpush.android.connector.UNREGISTERED" -> Push.saveEndpoint(context, null)
        }
    }
}
