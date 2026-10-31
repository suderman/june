package net.suderman.june

import android.app.Activity
import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

object Report {
    private const val PREFS = "june"

    fun save(context: Context, lines: List<String>) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("last", lines.joinToString("\n")).apply()
    }

    fun last(context: Context): String =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("last", null) ?: "none yet"
}

class MainActivity : Activity() {
    private lateinit var text: TextView
    private var requestResult = "not tried"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (16 * resources.displayMetrics.density).toInt()
        text = TextView(this).apply { textSize = 14f; setTextColor(Color.WHITE) }
        val defaults = Button(this).apply {
            text = "Open Default apps"
            setOnClickListener { startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)) }
        }
        val request = Button(this).apply {
            text = "Request assistant role"
            setOnClickListener {
                val roles = getSystemService(RoleManager::class.java)
                try {
                    startActivityForResult(roles.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT), 1)
                } catch (e: Exception) {
                    requestResult = "failed: $e"
                    refresh()
                }
            }
        }
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad * 3, pad, pad)
            addView(defaults)
            addView(request)
            addView(text)
        }
        setContentView(ScrollView(this).apply { setBackgroundColor(Color.rgb(20, 20, 28)); addView(layout) })
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    @Deprecated("Activity result API is not worth a dependency here")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        requestResult = if (resultCode == RESULT_OK) "granted" else "not granted (result $resultCode)"
        refresh()
    }

    private fun refresh() {
        val held = getSystemService(RoleManager::class.java).isRoleHeld(RoleManager.ROLE_ASSISTANT)
        val info = packageManager.getPackageInfo(packageName, 0)
        val time = { ms: Long -> java.time.Instant.ofEpochMilli(ms).toString() }
        text.text = listOf(
            "Assistant role held: $held",
            "Role request: $requestResult",
            "Installed: ${time(info.firstInstallTime)}",
            "Updated: ${time(info.lastUpdateTime)}",
            "",
            "Last invocation:",
            Report.last(this),
        ).joinToString("\n")
    }
}
