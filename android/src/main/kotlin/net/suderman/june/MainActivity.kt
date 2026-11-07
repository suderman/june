package net.suderman.june

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import java.time.Instant

object Report {
    private const val PREFS = "june"

    fun save(context: Context, lines: List<String>) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("last", lines.joinToString("\n")).apply()
    }

    fun last(context: Context): String =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("last", null) ?: "none yet"
}

/** The launcher entry: whether June holds the assistant role, a way into Default apps, and the last invocation's report. */
class MainActivity : ComponentActivity() {
    // Bumped on every resume, so the status reads the role and report afresh after a trip to Settings.
    private var resumed by mutableIntStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Surface(Modifier.fillMaxSize()) { Status(resumed) }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        Keep.restore(this)
        resumed++
    }
}

@Composable
private fun Status(resumed: Int) {
    val context = LocalContext.current
    var requestResult by remember { mutableStateOf("not tried") }
    val request = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        requestResult = if (result.resultCode == android.app.Activity.RESULT_OK) "granted" else "not granted (result ${result.resultCode})"
    }
    val roles = context.getSystemService(RoleManager::class.java)
    val info = context.packageManager.getPackageInfo(context.packageName, 0)
    val held = remember(resumed, requestResult) { roles.isRoleHeld(RoleManager.ROLE_ASSISTANT) }
    val report = remember(resumed) { Report.last(context) }

    Column(
        Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 48.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        PairingForm()
        Button(onClick = { context.startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)) }) { Text("Open Default apps") }
        Button(onClick = {
            try {
                request.launch(roles.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT))
            } catch (e: Exception) {
                requestResult = "failed: $e"
            }
        }) { Text("Request assistant role") }
        Text(
            listOf(
                "Assistant role held: $held",
                "Role request: $requestResult",
                "Installed: ${Instant.ofEpochMilli(info.firstInstallTime)}",
                "Updated: ${Instant.ofEpochMilli(info.lastUpdateTime)}",
            ).joinToString("\n"),
        )
        Text("Last invocation:", style = MaterialTheme.typography.titleSmall)
        Text(report, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
    }
}

/**
 * Pairing: June's address and this phone's token from `june device add apk` (or any name) on the daemon's host. The
 * token is shown only as whether one is saved; pasting a new one replaces it.
 */
@Composable
private fun PairingForm() {
    val context = LocalContext.current
    val saved = remember { Pairing.load(context) }
    var url by remember { mutableStateOf(saved?.url ?: Pairing.DEFAULT_URL) }
    var token by remember { mutableStateOf("") }
    var paired by remember { mutableStateOf(saved != null) }
    Text("Pairing", style = MaterialTheme.typography.titleMedium)
    Text(if (paired) "This phone has a token saved." else "Not paired yet: paste the token from `june device add NAME`.")
    OutlinedTextField(url, { url = it }, Modifier.fillMaxWidth(), label = { Text("June's address") }, singleLine = true)
    OutlinedTextField(
        token, { token = it }, Modifier.fillMaxWidth(), label = { Text(if (paired) "New token" else "Token") }, singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { Pairing.save(context, Pairing(url, token)); token = ""; paired = true }, enabled = url.isNotBlank() && token.isNotBlank()) { Text("Save") }
        OutlinedButton(onClick = { Pairing.clear(context); paired = false }, enabled = paired) { Text("Forget") }
    }
}
