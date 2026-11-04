package net.suderman.june

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle

// Stressed words, code, and links in June's Markdown, as the overlay's balloons show them (markup in overlay/strip.mjs):
// **bold** and __bold__, *italic* and _italic_, `code`, [label](url) as its label. Heading and quote markers and code
// fences go; everything else is the text as written.
private val INLINE = Regex("""\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)]\([^)\s]+\)|(?<![\w*])\*([^*\s][^*]*)\*(?!\w)|(?<!\w)_([^_\s][^_]*)_(?!\w)""")

fun markdown(text: String, code: Color): AnnotatedString = buildAnnotatedString {
    val lines = text.lines().filterNot { it.trimStart().startsWith("```") }
    lines.forEachIndexed { index, raw ->
        val line = raw.replace(Regex("""^\s{0,3}(#{1,6}|>)\s+"""), "")
        var at = 0
        for (m in INLINE.findAll(line)) {
            append(line.substring(at, m.range.first))
            val (bold1, bold2, mono, label, italic1, italic2) = List(6) { m.groups[it + 1]?.value }
            when {
                bold1 != null || bold2 != null -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(bold1 ?: bold2!!) }
                mono != null -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = code)) { append(mono) }
                label != null -> append(label)
                else -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(italic1 ?: italic2!!) }
            }
            at = m.range.last + 1
        }
        append(line.substring(at))
        if (index < lines.size - 1) append('\n')
    }
}

private operator fun <T> List<T>.component6(): T = this[5]
