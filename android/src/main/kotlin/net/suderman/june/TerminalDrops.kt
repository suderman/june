package net.suderman.june

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.io.ByteArrayOutputStream

/** A file for an agent terminal: herdr-core's terminal.put puts it beside the terminal, and the agent gets its path. */
class Drop(val name: String, val bytes: ByteArray)

/**
 * Files on their way to agent terminals (see "Files and screenshots" under "Embedded terminal" in docs/interfaces.org).
 * Files shared from another app wait in [shared] until Jon sends them from the terminal he chooses, so nothing another
 * app shares reaches an agent without his tap.
 */
object Drops {
    /** terminal.put takes at most 8 MB. */
    const val MAX = 8_000_000

    val shared = mutableStateListOf<Drop>()
    /** Why a shared file was refused, shown on the next terminal page. */
    var notice by mutableStateOf("")

    /** Read URIS, off the main thread: the files, and why any were refused. TYPE names the type when the URI cannot. */
    fun read(context: Context, uris: List<Uri>, type: String? = null): Pair<List<Drop>, List<String>> {
        val drops = mutableListOf<Drop>()
        val refused = mutableListOf<String>()
        for (uri in uris) {
            val name = nameOf(context, uri, type)
            val bytes = runCatching {
                context.contentResolver.openInputStream(uri)?.use { input ->
                    val out = ByteArrayOutputStream()
                    val buffer = ByteArray(64 * 1024)
                    while (out.size() <= MAX) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        out.write(buffer, 0, n)
                    }
                    out.toByteArray()
                }
            }.getOrNull()
            when {
                bytes == null -> refused += "$name could not be read"
                bytes.size > MAX -> refused += "$name is over 8 MB"
                else -> drops += Drop(name, bytes)
            }
        }
        return drops to refused
    }

    /** The file's own name, with an extension for its type when it has none, so a screenshot stays a .png. */
    private fun nameOf(context: Context, uri: Uri, type: String?): String {
        val shown = runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        }.getOrNull() ?: uri.lastPathSegment?.substringAfterLast('/')
        val base = shown?.takeIf { it.isNotBlank() } ?: "file"
        if ('.' in base) return base
        val mime = runCatching { context.contentResolver.getType(uri) }.getOrNull() ?: type
        val ext = mime?.let { MimeTypeMap.getSingleton().getExtensionFromMimeType(it) }
        return if (ext != null) "$base.$ext" else base
    }
}

/**
 * The share sheet's "Agent terminal": what another app shares waits in [Drops.shared], and June opens on the last
 * terminal, where Jon sends it there or switches first.
 */
class TerminalShareActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return finish()
        val uris = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java))
            Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else -> emptyList()
        }
        if (uris.isEmpty()) return finish()
        // Read while this activity holds the sender's grant; the files then wait in memory.
        Thread {
            val (drops, refused) = Drops.read(this, uris, intent.type)
            runOnUiThread {
                Drops.shared.addAll(drops)
                Drops.notice = refused.joinToString("; ")
                startActivity(
                    Intent(Intent.ACTION_VIEW, Uri.parse("june://terminal")).setClass(this, ConversationActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                )
                finish()
            }
        }.start()
    }
}
