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
import androidx.compose.foundation.clickable
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
 * invisible screen takes them all: a row opens its task's page in June; its state pill opens the state picker
 * (StatePickerActivity). It closes without being seen.
 */
class WidgetTapActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val data = intent?.data
        val key = data?.getQueryParameter("key")
        when {
            intent.getStringExtra("action") == "slot" -> {
                val slot = Swipes.AppSlot.entries.find { it.key == intent.getStringExtra("slot") }
                if (slot != null) Swipes.openSlot(this, slot)?.let { Toast.makeText(this, it, Toast.LENGTH_LONG).show() }
            }
            key != null && intent.getStringExtra("action") == "state" -> startActivity(Intent(this, StatePickerActivity::class.java)
                .putExtra("key", key).putExtra("state", intent.getStringExtra("state")).putExtra("title", intent.getStringExtra("title"))
                .putExtra("protected", intent.getBooleanExtra("protected", false)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            data != null -> startActivity(Intent(this, ConversationActivity::class.java).setAction(Intent.ACTION_VIEW).setData(data)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        }
        finish()
    }
}

/** A state picked on the widget, sent to the daemon as the boards send it, as soon as there is a network. */
class TaskEditJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        val key = params.extras.getString("key") ?: return false
        val state = params.extras.getString("state") ?: return false
        Thread {
            val reply = DaemonCall.request(this, JSONObject().put("op", "task").put("key", key).put("edit", JSONObject().put("action", "state").put("state", state)))
            if (reply?.optString("type") == "task") AgendaJob.refresh(this)
            else {
                // Refused or out of reach: the widget shows the task as the daemon has it again.
                AgendaWidget.unmarkState(this, key)
                android.os.Handler(mainLooper).post { Toast.makeText(this, reply?.optString("message")?.takeIf { it.isNotEmpty() } ?: "June couldn't be reached; not changed", Toast.LENGTH_LONG).show() }
            }
            jobFinished(params, false)
        }.start()
        return true
    }

    override fun onStopJob(params: JobParameters) = true

    companion object {
        fun state(context: Context, key: String, state: String) {
            context.getSystemService(JobScheduler::class.java).schedule(
                JobInfo.Builder(key.hashCode() and 0x0fffffff or 0x10000000, ComponentName(context, TaskEditJob::class.java))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setExpedited(true)
                    .setExtras(PersistableBundle().apply { putString("key", key); putString("state", state) })
                    .build(),
            )
        }
    }
}

/** desktop/board.mjs FLOW: where each state may go. */
val FLOW = mapOf(
    "TODO" to listOf("AUTO", "PROG", "HOLD", "DONE"),
    "PROG" to listOf("TODO", "EVAL", "HOLD", "DONE"),
    "EVAL" to listOf("TODO", "PROG", "AUTO", "HOLD", "DONE"),
    "AUTO" to listOf("TODO", "HOLD", "DONE"),
    "HOLD" to listOf("TODO", "PROG", "AUTO", "DONE"),
    "DONE" to listOf("TODO"),
)

/**
 * The widget's state picker: where the task's state can go (FLOW; only TODO and DONE in a protected file). A state
 * shows on the widget at once and goes to the daemon in the background; AUTO opens the task's page, where the handoff
 * names its agent, host and start.
 */
class StatePickerActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val key = intent.getStringExtra("key") ?: return finish()
        val state = intent.getStringExtra("state") ?: ""
        val locked = intent.getBooleanExtra("protected", false)
        val next = if (locked) (if (state == "TODO") listOf("DONE") else if (state == "DONE") listOf("TODO") else emptyList()) else FLOW[state] ?: emptyList()
        setContent {
            MaterialTheme {
                Surface {
                    Column(Modifier.padding(20.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(intent.getStringExtra("title") ?: "", style = MaterialTheme.typography.titleMedium)
                        Text("$state, then:", style = MaterialTheme.typography.bodySmall)
                        for (to in next) Button({ pick(key, to) }, Modifier.fillMaxWidth()) { Text(if (to == "AUTO") "AUTO: hand to an agent…" else to) }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                            TextButton({ open(key) }) { Text("Open in June") }
                            TextButton({ finish() }) { Text("Cancel") }
                        }
                    }
                }
            }
        }
    }

    private fun pick(key: String, to: String) {
        if (to == "AUTO") return open(key)
        AgendaWidget.markState(this, key, to)
        TaskEditJob.state(this, key, to)
        finish()
    }

    private fun open(key: String) {
        startActivity(Intent(this, ConversationActivity::class.java).setAction(Intent.ACTION_VIEW).setData(AgendaWidget.taskUri(key))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
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

/** The widget's views (AgendaWidget.VIEWS), picked by tapping its title, one for each widget. */
class ViewPickerActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val widget = intent.getIntExtra(android.appwidget.AppWidgetManager.EXTRA_APPWIDGET_ID, -1)
        if (widget < 0) return finish()
        val current = AgendaWidget.viewOf(this, widget).id
        setContent {
            MaterialTheme {
                Surface {
                    androidx.compose.foundation.lazy.LazyColumn(Modifier.padding(vertical = 12.dp).fillMaxWidth()) {
                        item { Text("Show in widget", Modifier.padding(horizontal = 20.dp, vertical = 8.dp), style = MaterialTheme.typography.labelLarge) }
                        for (view in AgendaWidget.VIEWS) item {
                            Row(
                                Modifier.fillMaxWidth().clickable { AgendaWidget.setView(this@ViewPickerActivity, widget, view.id); finish() }
                                    .padding(horizontal = 20.dp, vertical = 10.dp),
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(view.name, style = MaterialTheme.typography.titleMedium)
                                    Text(view.about, style = MaterialTheme.typography.bodySmall)
                                }
                                if (view.id == current) Text("✓", style = MaterialTheme.typography.titleMedium)
                            }
                        }
                        item {
                            TextButton({
                                startActivity(Intent(this@ViewPickerActivity, ConversationActivity::class.java).setAction(Intent.ACTION_VIEW)
                                    .setData(android.net.Uri.parse("june://projects")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
                                finish()
                            }, Modifier.padding(horizontal = 8.dp)) { Text("Open the projects board") }
                        }
                    }
                }
            }
        }
    }
}
