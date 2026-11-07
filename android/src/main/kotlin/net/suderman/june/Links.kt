package net.suderman.june

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.widget.Toast
import androidx.compose.ui.platform.UriHandler

/**
 * The links in June's words that a tap opens: web pages in the browser, and `herdr:` links to an agent's session, which
 * Termux attaches to over ssh as Jon's Emacs does (suderman/org-herdr-follow-android). Links come from the model, so
 * nothing here runs what a link says: a herdr link must have the form herdr-link stamps, and only opens or focuses.
 */
object Links {
    /** HOST/AGENT:SESSION[@PANE], as org/bin/herdr-link stamps it and src/tools/org.ts reads it. */
    private val HERDR = Regex("""^herdr:([a-z0-9-]+)/([a-z]+):([0-9a-f-]{36})(?:@([A-Za-z0-9:]+))?$""")

    fun opens(url: String): Boolean = url.startsWith("https://") || url.startsWith("http://") || HERDR.matches(url)

    /** Open `url`; returns why it could not be, or null. */
    fun open(context: Context, url: String): String? = when {
        HERDR.matches(url) -> herdr(context, url.removePrefix("herdr:"))
        url.startsWith("https://") || url.startsWith("http://") -> runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.exceptionOrNull()?.let { "No app on this phone opens it" }
        else -> "June cannot open that kind of link"
    }

    /**
     * A new Termux session, shown, attached to the agent's pane on its host: ssh-unlock unlocks the ssh key with a
     * fingerprint, then herdr-link attach finds the pane or resumes the session. Needs Termux's RUN_COMMAND, which
     * the install app grants, and allow-external-apps in ~/.termux/termux.properties.
     */
    private fun herdr(context: Context, path: String): String? {
        val host = path.substringBefore('/')
        val intent = Intent("com.termux.RUN_COMMAND").setClassName("com.termux", "com.termux.app.RunCommandService")
            .putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/home/bin/ssh-unlock")
            .putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("ssh", "-t", host, "herdr-link", "attach", path))
            .putExtra("com.termux.RUN_COMMAND_BACKGROUND", false)
            // 0 switches to the new session and shows Termux.
            .putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", "0")
        return runCatching { context.startService(intent) }.fold(
            { if (it == null) "Termux is not installed" else null },
            { Log.w(TAG, "herdr link: $it"); "Termux refused it: ${it.message}" },
        )
    }

    /** What a tap on a link in June's words does, in place of Compose's default; `leave` hides the assistant sheet. */
    class Handler(private val context: Context, private val leave: () -> Unit) : UriHandler {
        override fun openUri(uri: String) {
            val why = open(context, uri)
            if (why == null) leave() else Toast.makeText(context, why, Toast.LENGTH_LONG).show()
        }
    }
}
