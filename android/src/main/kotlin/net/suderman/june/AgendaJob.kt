package net.suderman.june

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import org.json.JSONObject

/**
 * Keeps the phone's copy of the agenda fresh while June is closed: about every 15 minutes while there is a network,
 * and at once when the widget asks. Unreachable (off the tailnet), it leaves the last copy, which says how old it is.
 */
class AgendaJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        Thread {
            val fresh = refresh(this)
            jobFinished(params, !fresh && params.jobId == NOW)
        }.start()
        return true
    }

    override fun onStopJob(params: JobParameters) = true

    companion object {
        private const val PERIODIC = 4101
        private const val NOW = 4102

        /** The periodic refresh, unless it is already set. */
        fun schedule(context: Context) {
            val jobs = context.getSystemService(JobScheduler::class.java)
            if (jobs.getPendingJob(PERIODIC) != null) return
            jobs.schedule(
                JobInfo.Builder(PERIODIC, ComponentName(context, AgendaJob::class.java))
                    .setPeriodic(15 * 60 * 1000L)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPersisted(true)
                    .build(),
            )
        }

        /** A refresh as soon as there is a network, expedited, so a push's refresh runs within seconds. */
        fun now(context: Context) {
            context.getSystemService(JobScheduler::class.java).schedule(
                JobInfo.Builder(NOW, ComponentName(context, AgendaJob::class.java))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setExpedited(true)
                    .build(),
            )
        }

        /** Ask the daemon for the agenda and keep it; false when it could not be reached. Blocks. */
        fun refresh(context: Context): Boolean {
            val reply = DaemonCall.request(context, JSONObject().put("op", "agenda")) ?: return false
            val agenda = reply.optJSONObject("agenda") ?: return false
            AgendaStore.save(context, agenda, reply.optString("revision"))
            return true
        }
    }
}
