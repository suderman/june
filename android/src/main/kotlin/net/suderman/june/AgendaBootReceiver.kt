package net.suderman.june

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** After a boot or an update, the agenda's refresh, reminders and widget come back from the phone's copy. */
class AgendaBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val pending = goAsync()
        Thread {
            try {
                AgendaJob.schedule(context)
                Push.register(context)
                Reminders.schedule(context)
                AgendaWidget.updateAll(context)
                AgendaJob.now(context)
            } finally {
                pending.finish()
            }
        }.start()
    }
}
