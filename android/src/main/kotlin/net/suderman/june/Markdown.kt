package net.suderman.june

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.style.TextDecoration

// Stressed words, code, and links in June's Markdown, as the overlay's balloons show them (markup in overlay/strip.mjs):
// **bold** and __bold__, *italic* and _italic_, `code`, and links, as [label](url) or Org's [[url][label]]. A link June
// may open (Links.kt) is underlined and taps through; any other shows only its label. Heading and quote markers and
// code fences go; everything else is the text as written.
private val INLINE = Regex("""\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)]\(([^)\s]+)\)|\[\[([^\]]+)]\[([^\]]+)]]|(?<![\w*])\*([^*\s][^*]*)\*(?!\w)|(?<!\w)_([^_\s][^_]*)_(?!\w)""")

fun markdown(text: String, code: Color): AnnotatedString = buildAnnotatedString {
    val lines = text.lines().filterNot { it.trimStart().startsWith("```") }
    lines.forEachIndexed { index, raw ->
        val line = raw.replace(Regex("""^\s{0,3}(#{1,6}|>)\s+"""), "")
        var at = 0
        for (m in INLINE.findAll(line)) {
            append(line.substring(at, m.range.first))
            val g = { n: Int -> m.groups[n]?.value }
            val label = g(4) ?: g(7)
            val url = g(5) ?: g(6)
            when {
                g(1) != null || g(2) != null -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(g(1) ?: g(2)!!) }
                g(3) != null -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = code)) { append(g(3)!!) }
                label != null && url != null && Links.opens(url) ->
                    withLink(LinkAnnotation.Url(url, TextLinkStyles(SpanStyle(textDecoration = TextDecoration.Underline)))) { append(label) }
                label != null -> append(label)
                else -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(g(8) ?: g(9)!!) }
            }
            at = m.range.last + 1
        }
        append(line.substring(at))
        if (index < lines.size - 1) append('\n')
    }
}

