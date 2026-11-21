package net.suderman.june

import android.app.Activity
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.PersistableBundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.unit.dp
import org.json.JSONObject

/**
 * A tap on the agenda widget's list (AgendaWidget.kt). A widget list sends every tap through one intent, so this
 * invisible screen takes them all: a row opens its task's page in June; its ○ marks the task DONE in the background
 * (TaskEditJob), showing it ticked at once, and the screen closes without being seen.
 */
class WidgetTapActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val data = intent?.data
        val key = data?.getQueryParameter("key")
        when {
            key != null && intent.getStringExtra("action") == "done" -> {
                AgendaWidget.markDone(this, key)
                TaskEditJob.done(this, key)
            }
            data != null -> startActivity(Intent(this, ConversationActivity::class.java).setAction(Intent.ACTION_VIEW).setData(data)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        }
        finish()
    }
}

/** The widget's DONE for a task, sent to the daemon as the boards send it, as soon as there is a network. */
class TaskEditJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        val key = params.extras.getString("key") ?: return false
        Thread {
            val reply = DaemonCall.request(this, JSONObject().put("op", "task").put("key", key).put("edit", JSONObject().put("action", "state").put("state", "DONE")))
            val done = reply?.optString("type") == "task"
            if (done) AgendaJob.refresh(this)
            else {
                // Refused or out of reach: the widget shows the task as the daemon has it again.
                AgendaWidget.unmarkDone(this, key)
                android.os.Handler(mainLooper).post { Toast.makeText(this, reply?.optString("message")?.takeIf { it.isNotEmpty() } ?: "June couldn't be reached; not marked done", Toast.LENGTH_LONG).show() }
            }
            jobFinished(params, false)
        }.start()
        return true
    }

    override fun onStopJob(params: JobParameters) = true

    companion object {
        fun done(context: Context, key: String) {
            context.getSystemService(JobScheduler::class.java).schedule(
                JobInfo.Builder(key.hashCode() and 0x0fffffff or 0x10000000, ComponentName(context, TaskEditJob::class.java))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setExpedited(true)
                    .setExtras(PersistableBundle().apply { putString("key", key) })
                    .build(),
            )
        }
    }
}

/**
 * The widget's +: a line for June, who adds it as a TODO where it belongs, as she does when asked in the
 * conversation, and answers through ntfy.
 */
class QuickAddActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            var text by remember { mutableStateOf("") }
            val focus = remember { FocusRequester() }
            LaunchedEffect(Unit) { focus.requestFocus() }
            MaterialTheme {
                Surface {
                    Column(Modifier.padding(20.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("Add a TODO", style = MaterialTheme.typography.titleMedium)
                        OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth().focusRequester(focus), minLines = 2,
                            placeholder = { Text("What, and by when if it has a time") })
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                            TextButton({ finish() }) { Text("Cancel") }
                            Button({ if (text.isNotBlank()) send(text.trim()) }) { Text("Add") }
                        }
                    }
                }
            }
        }
    }

    private fun send(text: String) {
        val app = applicationContext
        Thread {
            val reply = DaemonCall.request(app, JSONObject().put("op", "submit").put("text", "Add a TODO for me: $text").put("source", "apk").put("whenBusy", "followUp"))
            val sent = reply?.optString("type") == "accepted"
            android.os.Handler(app.mainLooper).post {
                Toast.makeText(app, if (sent) "Sent to June" else reply?.optString("message")?.takeIf { it.isNotEmpty() } ?: "June couldn't be reached", Toast.LENGTH_LONG).show()
            }
        }.start()
        finish()
    }
}
