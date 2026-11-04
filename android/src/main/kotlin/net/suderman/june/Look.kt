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

    private val tints = listOf(0xFFE6D7EA, 0xFFF6DCCB, 0xFFD7E4F2, 0xFFDFEAD6, 0xFFF2E3C8)
    fun color(hex: String): Color = runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrDefault(Color(tints[0]))
}
