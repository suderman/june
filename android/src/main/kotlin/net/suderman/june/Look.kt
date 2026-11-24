package net.suderman.june

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/** The strip's colours and faces, as desktop/Theme.qml has them for the comic look in light. */
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

    /** The three ways the boards draw from one layout: printed paper and ink, late night neon, a text-only terminal. */
    enum class Kind { Paper, Neon, Console }

    /**
     * The page around the strip and the console's colours, by look and scheme, as Theme.qml's pick() has them: the
     * comic's light (paper) and dark (neon; the strip's panels stay printed in either), the console's dark and light.
     * SURFACE is a docket's or card's stock and SURFACEINK and SURFACEMUTED the text on it; LINE draws its edge, RULE
     * its ruled lines, SHADOW its hard offset shadow (paper) or glow (neon). TONES gives each state its meaning colour,
     * HARNESSES each clanker's frame; both pass 4.5:1 on SURFACE.
     */
    data class Palette(
        val page: Color, val pageInk: Color, val muted: Color, val field: Color, val ink: Color, val accent: Color,
        val june: Color, val user: Color, val ok: Color, val fail: Color, val busy: Color, val highlight: Color, val dark: Boolean,
        val kind: Kind = Kind.Paper,
        val surface: Color = field, val surfaceInk: Color = pageInk, val surfaceMuted: Color = muted,
        val line: Color = pageInk, val rule: Color = muted, val shadow: Color = pageInk,
        val tones: Map<String, Color> = emptyMap(), val harnesses: Map<String, Color> = emptyMap(),
    ) {
        val console get() = kind == Kind.Console
        val neon get() = kind == Kind.Neon
        /** A state's colour (TODO, PROG, …), or the line for one without. */
        fun tone(state: String): Color = tones[state] ?: line
        /** A harness's colour; the console has none, so its frames use the line. */
        fun harness(name: String): Color = harnesses[name] ?: harnesses["other"] ?: line
        /** The text styles for this look: the console sets everything in its monospace face. */
        val type: Type by lazy { Type(console) }
    }

    fun palette(console: Boolean, dark: Boolean): Palette = when {
        console && dark -> Palette(
            Color(0xFF121418), Color(0xFFD7DBE3), Color(0xFF8A93A5), Color(0xFF1A1D23), Color(0xFFD7DBE3), Color(0xFFFF8F80),
            Color(0xFFE9C46A), Color(0xFF8FB4FF), Color(0xFF86E08F), Color(0xFFFF8F80), Color(0xFFFFD36B), Color(0xFF3A4150), true,
            kind = Kind.Console, surface = Color(0xFF121418), surfaceInk = Color(0xFFD7DBE3), surfaceMuted = Color(0xFF8A93A5),
            line = Color(0xFF5C6577), rule = Color(0xFF2A2F38), shadow = Color.Transparent,
            tones = mapOf("TODO" to Color(0xFFFF8F80), "PROG" to Color(0xFF8FB4FF), "EVAL" to Color(0xFFC9A8FF), "HOLD" to Color(0xFFFFD36B), "AUTO" to Color(0xFF6FD6C8), "DONE" to Color(0xFF86E08F)),
        )
        console -> Palette(
            Color(0xFFF6F7F9), Color(0xFF24292F), Color(0xFF636C76), Color(0xFFFFFFFF), Color(0xFF24292F), Color(0xFFCF222E),
            Color(0xFF9A6700), Color(0xFF0550AE), Color(0xFF1A7F37), Color(0xFFCF222E), Color(0xFF9A6700), Color(0xFFDDE3EA), false,
            kind = Kind.Console, surface = Color(0xFFF6F7F9), surfaceInk = Color(0xFF24292F), surfaceMuted = Color(0xFF636C76),
            line = Color(0xFF818B95), rule = Color(0xFFD0D7DE), shadow = Color.Transparent,
            tones = mapOf("TODO" to Color(0xFFCF222E), "PROG" to Color(0xFF0550AE), "EVAL" to Color(0xFF8250DF), "HOLD" to Color(0xFF9A6700), "AUTO" to Color(0xFF1B7C83), "DONE" to Color(0xFF1A7F37)),
        )
        // Late night neon: an indigo-black page with violet haze, dark panels edged in thin neon strokes.
        dark -> Palette(
            Color(0xFF12101C), Color(0xFFF4EEFF), Color(0xFFA8A0C8), Color(0xFF1C1830), Color(0xFF1B1A1F), Color(0xFFFF4FA3),
            Color(0xFFFFC247), Color(0xFF59D8FF), Color(0xFFA8F05A), Color(0xFFFF5C7A), Color(0xFFFFC247), Color(0xFFFF4FA3), true,
            kind = Kind.Neon, surface = Color(0xFF1C1830), surfaceInk = Color(0xFFF4EEFF), surfaceMuted = Color(0xFFADA5CC),
            line = Color(0xFF9D7BFF), rule = Color(0xFF3A3258), shadow = Color(0xFFFF4FA3),
            tones = mapOf("TODO" to Color(0xFFFF5C7A), "PROG" to Color(0xFF3FE0F0), "EVAL" to Color(0xFFB48CFF), "HOLD" to Color(0xFFFFC247), "AUTO" to Color(0xFF4FF0C8), "DONE" to Color(0xFFA8F05A)),
            harnesses = mapOf("pi" to Color(0xFF2EE6D2), "claude" to Color(0xFFFF9A4D), "codex" to Color(0xFF6FA8FF), "agy" to Color(0xFFB48CFF), "opencode" to Color(0xFF7CE38B), "other" to Color(0xFFFFD84D)),
        )
        else -> Palette(
            Color(0xFFF6F1E7), Color(0xFF1B1A1F), Color(0xFF66636C), Color(0xFFFFFCF5), Color(0xFF1B1A1F), Color(0xFFBF3A27),
            Color(0xFF9A6700), Color(0xFF0550AE), Color(0xFF1A7F37), Color(0xFFCF222E), Color(0xFF9A6700), Color(0xFFFFE27A), false,
            kind = Kind.Paper, surface = balloon, surfaceInk = ink, surfaceMuted = Color(0xFF66636C),
            line = ink, rule = Color(0x261B1A1F), shadow = ink,
            tones = mapOf("TODO" to Color(0xFFB3311F), "PROG" to Color(0xFF1C4F8F), "EVAL" to Color(0xFF5A3FA0), "HOLD" to Color(0xFF7A5900), "AUTO" to Color(0xFF0F6B5E), "DONE" to Color(0xFF2F6B22)),
            harnesses = mapOf("pi" to Color(0xFF1F7F75), "claude" to Color(0xFFB4531C), "codex" to Color(0xFF355FA3), "agy" to Color(0xFF6A45B3), "opencode" to Color(0xFF367842), "other" to Color(0xFF8A6D10)),
        )
    }

    /**
     * The boards' text styles, one scale for every view, each with its line height set: Zen Kaku Gothic New's own is
     * nearly a line tall, so a wrapped title would read as two rows. The console sets them all in its monospace face.
     */
    class Type(console: Boolean) {
        private val mono = androidx.compose.ui.text.font.FontFamily.Monospace
        private val trim = androidx.compose.ui.text.style.LineHeightStyle(
            androidx.compose.ui.text.style.LineHeightStyle.Alignment.Center, androidx.compose.ui.text.style.LineHeightStyle.Trim.None,
        )
        private fun style(family: FontFamily, size: Float, line: Float, weight: FontWeight = FontWeight.Medium, spacing: Float = 0f) =
            androidx.compose.ui.text.TextStyle(
                fontFamily = family, fontWeight = weight, fontSize = size.sp, lineHeight = line.sp,
                letterSpacing = spacing.sp, lineHeightStyle = trim,
            )
        private val cap = if (console) mono else caption
        /** The board's name over its rule. */
        val masthead = if (console) style(mono, 20f, 26f, FontWeight.Bold) else style(display, 26f, 32f, FontWeight.Normal)
        /** A docket's title, a card's name on its own page. */
        val title = style(cap, if (console) 17f else 20f, if (console) 23f else 26f, FontWeight.Bold)
        /** A clanker's name on its card. */
        val name = if (console) style(mono, 16f, 21f, FontWeight.Bold) else style(display, 18f, 23f, FontWeight.Normal)
        /** A row's title in a list. */
        val row = style(cap, if (console) 14f else 15f, 20f, FontWeight.Bold)
        /** The line of facts under a row. */
        val meta = style(cap, 12.5f, 17f)
        /** A printed field label or small-caps band, as on a form. */
        val label = style(cap, 10.5f, 14f, FontWeight.Bold, 1.2f)
        /** A section's rule title. */
        val section = style(cap, 12f, 16f, FontWeight.Bold, 1.4f)
        /** A button's or tab's text. */
        val button = style(cap, 14f, 18f, FontWeight.Bold)
        /** A filled-in value on a form. */
        val value = style(cap, 15f, 20f, FontWeight.Medium)
        /** Plain reading text, for long Dialog entries and notes. */
        val body = style(cap, 14f, 20f)
        /** June's and the agents' hand lettering. */
        val lettering = if (console) style(mono, 14f, 20f) else style(Look.lettering, 15f, 20.5f)
        /** Docket and service numbers. */
        val number = style(mono, 12f, 16f, FontWeight.Bold, 0.5f)
    }

    private val tints = listOf(0xFFE6D7EA, 0xFFF6DCCB, 0xFFD7E4F2, 0xFFDFEAD6, 0xFFF2E3C8)
    fun color(hex: String): Color = runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrDefault(Color(tints[0]))
}
