package net.suderman.june

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight

/** The strip's colours and faces, as overlay/Theme.qml has them for the comic look in light. */
object Look {
    val ink = Color(0xFF1B1A1F)
    val paper = Color(0xFFF6F1E7)
    val balloon = Color(0xFFFFFCF5)
    val highlight = Color(0xFFFFE27A)
    val noteFill = Color(0xFFDBE7FF)
    val noteLine = Color(0xFF5470B8)
    val noteInk = Color(0xFF1C2A52)
    val chipFill = Color(0xFFEBE5FF)
    val chipInk = Color(0xFF3D3466)
    val cardFill = Color(0xFF1F2433)
    val cardLine = Color(0xFF5B6683)
    val cardInk = Color(0xFFE4E8F2)
    val cardOk = Color(0xFF86E08F)
    val cardFail = Color(0xFFFF8F80)
    val cardBusy = Color(0xFFFFD36B)
    val burstFill = Color(0xFFFFD6CF)
    val accent = Color(0xFFD8432F)
    val thoughtInk = Color(0xFF4A4750)

    @OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)
    private fun shantell(weight: Int) = Font(R.font.shantell_sans, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))

    /** Shantell Sans: June's lettering in balloons, thoughts, and bursts. */
    val lettering = FontFamily(shantell(500), shantell(700), shantell(800))
    /** Zen Kaku Gothic New: notes, chips, and captions. */
    val caption = FontFamily(Font(R.font.zen_kaku_gothic_new_medium, FontWeight.Medium), Font(R.font.zen_kaku_gothic_new_bold, FontWeight.Bold))
    /** Dela Gothic One: the masthead. */
    val display = FontFamily(Font(R.font.dela_gothic_one))

    /**
     * The page around the strip and the console's colours, by look and scheme, as Theme.qml's pick() has them: the
     * comic's light and dark (its panels stay printed in either), the console's dark and light.
     */
    data class Palette(
        val page: Color, val pageInk: Color, val muted: Color, val field: Color, val ink: Color, val accent: Color,
        val june: Color, val user: Color, val ok: Color, val fail: Color, val busy: Color, val highlight: Color, val dark: Boolean,
    )

    fun palette(console: Boolean, dark: Boolean): Palette = when {
        console && dark -> Palette(Color(0xFF121418), Color(0xFFD7DBE3), Color(0xFF7D8697), Color(0xFF1A1D23), Color(0xFFD7DBE3), Color(0xFFFF8F80), Color(0xFFE9C46A), Color(0xFF8FB4FF), Color(0xFF86E08F), Color(0xFFFF8F80), Color(0xFFFFD36B), Color(0xFF3A4150), true)
        console -> Palette(Color(0xFFF6F7F9), Color(0xFF24292F), Color(0xFF6E7781), Color(0xFFFFFFFF), Color(0xFF24292F), Color(0xFFCF222E), Color(0xFF9A6700), Color(0xFF0550AE), Color(0xFF1A7F37), Color(0xFFCF222E), Color(0xFF9A6700), Color(0xFFDDE3EA), false)
        dark -> Palette(Color(0xFF1C1B21), Color(0xFFECE6DA), Color(0xFFA39FAB), Color(0xFF26252C), Color(0xFF1B1A1F), Color(0xFFFF7A66), Color(0xFFE9C46A), Color(0xFF8FB4FF), Color(0xFF86E08F), Color(0xFFFF8F80), Color(0xFFFFD36B), Color(0xFFFFE27A), true)
        else -> Palette(Color(0xFFF6F1E7), Color(0xFF1B1A1F), Color(0xFF6D6A73), Color(0xFFFFFCF5), Color(0xFF1B1A1F), Color(0xFFD8432F), Color(0xFF9A6700), Color(0xFF0550AE), Color(0xFF1A7F37), Color(0xFFCF222E), Color(0xFF9A6700), Color(0xFFFFE27A), false)
    }

    private val tints = listOf(0xFFE6D7EA, 0xFFF6DCCB, 0xFFD7E4F2, 0xFFDFEAD6, 0xFFF2E3C8)
    fun color(hex: String): Color = runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrDefault(Color(tints[0]))
}
