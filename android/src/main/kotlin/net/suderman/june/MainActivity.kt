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
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.asImageBitmap
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
        SwipeSettings()
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
 * The Terminal and Editor apps June opens from her tab bar, agenda widget and header swipes, followed by what each
 * swipe on June's header does (Swipes.kt) in the sheet and the full screen.
 */
@Composable
private fun SwipeSettings() {
    val context = LocalContext.current
    var changed by remember { mutableIntStateOf(0) }
    var choosingSlot by remember { mutableStateOf<Swipes.AppSlot?>(null) }
    var choosingDirection by remember { mutableStateOf<Swipes.Direction?>(null) }
    Text("Apps", style = MaterialTheme.typography.titleMedium)
    for (slot in Swipes.AppSlot.entries) {
        val name = remember(changed) { Swipes.appLabel(context, Swipes.app(context, slot)) }
        Row(Modifier.fillMaxWidth().clickable { choosingSlot = slot }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(slot.settingLabel, Modifier.weight(1f))
            Text(name, color = MaterialTheme.colorScheme.primary)
        }
    }
    // Where agent terminals open: inside June (TerminalPage.kt), or the Terminal app above and Termux for session links.
    val embedded = remember(changed) { Terminals.embedded(context) }
    Row(Modifier.fillMaxWidth().clickable { Terminals.setEmbedded(context, !embedded); changed++ }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("Agent terminals", Modifier.weight(1f))
        Text(if (embedded) "In June" else "Terminal app and Termux", color = MaterialTheme.colorScheme.primary)
    }
    val keyRow = remember(changed) { Terminals.keyRow(context) }
    if (embedded) Row(Modifier.fillMaxWidth().clickable { Terminals.setKeyRow(context, !keyRow); changed++ }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("Terminal key row", Modifier.weight(1f))
        Text(if (keyRow) "Shown with the keyboard" else "Off", color = MaterialTheme.colorScheme.primary)
    }
    Text("Swipes on June's header", style = MaterialTheme.typography.titleMedium)
    for (direction in Swipes.Direction.entries) {
        val name = remember(changed) { Swipes.settingLabel(context, Swipes.get(context, direction)) }
        Row(Modifier.fillMaxWidth().clickable { choosingDirection = direction }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(direction.label, Modifier.weight(1f))
            Text(name, color = MaterialTheme.colorScheme.primary)
        }
    }
    choosingSlot?.let { slot ->
        val apps = remember { Swipes.apps(context) }
        AlertDialog(
            onDismissRequest = { choosingSlot = null },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { choosingSlot = null }) { Text("Cancel") } },
            title = { Text(slot.settingLabel) },
            text = {
                LazyColumn(Modifier.heightIn(max = 480.dp)) {
                    items(apps, key = { it.first }) { (pkg, label) ->
                        Choice(label, pkg) {
                            Swipes.setApp(context, slot, pkg)
                            changed++
                            choosingSlot = null
                        }
                    }
                }
            },
        )
    }
    choosingDirection?.let { direction ->
        val actions = listOf(
            Swipes.Action.None,
            Swipes.Action.Full,
            Swipes.Action.Close,
            Swipes.Action.Slot(Swipes.AppSlot.Terminal),
            Swipes.Action.Slot(Swipes.AppSlot.Editor),
        )
        AlertDialog(
            onDismissRequest = { choosingDirection = null },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { choosingDirection = null }) { Text("Cancel") } },
            title = { Text(direction.label) },
            text = {
                LazyColumn(Modifier.heightIn(max = 480.dp)) {
                    items(actions) { action ->
                        val pkg = (action as? Swipes.Action.Slot)?.let { Swipes.app(context, it.slot) }
                        Choice(Swipes.settingLabel(context, action), pkg) {
                            Swipes.set(context, direction, action)
                            changed++
                            choosingDirection = null
                        }
                    }
                }
            },
        )
    }
}

/** One choice in the swipe picker, with the app's icon when it is an app. */
@Composable
private fun Choice(label: String, pkg: String?, onClick: () -> Unit) {
    val context = LocalContext.current
    val size = with(androidx.compose.ui.platform.LocalDensity.current) { 32.dp.roundToPx() }
    val icon = remember(pkg) {
        pkg?.let { runCatching { context.packageManager.getApplicationIcon(it).toImage(size) }.getOrNull() }
    }
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        if (icon != null) Image(icon, null, Modifier.size(32.dp)) else Spacer(Modifier.size(32.dp))
        Text(label, Modifier.padding(start = 12.dp))
    }
}

private fun android.graphics.drawable.Drawable.toImage(px: Int): androidx.compose.ui.graphics.ImageBitmap {
    val bitmap = android.graphics.Bitmap.createBitmap(px, px, android.graphics.Bitmap.Config.ARGB_8888)
    setBounds(0, 0, px, px)
    draw(android.graphics.Canvas(bitmap))
    return bitmap.asImageBitmap()
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
