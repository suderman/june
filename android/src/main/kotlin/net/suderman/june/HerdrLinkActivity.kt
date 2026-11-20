package net.suderman.june

import android.app.Activity
import android.os.Bundle
import android.widget.Toast

/**
 * Opens a herdr: link handed to June from outside her own words, such as a tap on an agent notice from ntfy
 * (org/bin/herdr-notify). It does what a tap in June's conversation does: Links checks the link's form and opens a
 * Termux session attached to the agent over ssh, so the same Org link works here as on the desktop. It shows nothing
 * of its own.
 */
class HerdrLinkActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent?.dataString
        val why = if (url != null && url.startsWith("herdr:") && Links.opens(url)) Links.open(this, url) else "Not an agent session link"
        if (why != null) Toast.makeText(this, why, Toast.LENGTH_LONG).show()
        finish()
    }
}
