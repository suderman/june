package net.suderman.june

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle

// June writes Org, and the phone shows it as the overlay's balloons do (markup in overlay/strip.mjs): *bold*, /italic/,
// _underline_, +strike+, =verbatim= and ~code~, links as [[url][label]] or [[url]], #+begin_src blocks monospaced, and
// headings without their stars. Org's emphasis needs a space or opening punctuation before its marker and closing
// punctuation after, so /home/alex/ stays a path and snake_case_name a name. Markdown's **bold**, `code` and
// [label](url) still read, since a model slips into them. A link June may open (Links.kt) is underlined and taps
// through; any other shows only its label.
private const val PRE = """(^|[\s('"{])"""
private const val POST = """(?=[\s\-.,:;!?'")}\[]|$)"""
private fun span(marker: String, inner: String) = Regex("$PRE$marker($inner)$marker$POST")
private val EMPHASIS = listOf(
    'b' to span("""\*""", """[^\s*](?:[^*\n]*[^\s*])?"""),
    'i' to span("/", """[^\s/](?:[^/\n]*[^\s/])?"""),
    'u' to span("_", """[^\s_](?:[^_\n]*[^\s_])?"""),
    's' to span("""\+""", """[^\s+](?:[^+\n]*[^\s+])?"""),
)
private val VERBATIM = Regex("""$PRE([=~])((?!\2)[^\s](?:[^\n]*?[^\s])??)\2$POST""")
private val ORG_LINK = Regex("""\[\[([^\]\n]+)](?:\[([^\]\n]+)])?]""")
private val MD_LINK = Regex("""\[([^\]\n]+)]\((file:[^)\n]+|[^)\s]+)\)""")
private val HELD = Regex("""\u0000(\d+)\u0000|\u0001([bius])|\u0002([bius])""")

private sealed interface Held {
    data class Link(val url: String, val label: String) : Held
    data class Code(val body: String) : Held
}

/** `stress` is how *bold* reads (a balloon highlights it, as the desktop's do); `link` colours a link's words. */
fun orgText(text: String, code: Color, stress: SpanStyle = SpanStyle(fontWeight = FontWeight.Bold), link: Color = Look.noteLine): AnnotatedString = buildAnnotatedString {
    val face = mapOf(
        'b' to stress,
        'i' to SpanStyle(fontStyle = FontStyle.Italic),
        'u' to SpanStyle(textDecoration = TextDecoration.Underline),
        's' to SpanStyle(textDecoration = TextDecoration.LineThrough),
    )
    val mono = SpanStyle(fontFamily = FontFamily.Monospace, color = code)
    fun words(line: String) {
        // Links and code wait as numbered marks, so no emphasis pass reshapes an address or a command.
        val held = mutableListOf<Held>()
        fun hold(h: Held): String { held.add(h); return "\u0000${held.size - 1}\u0000" }
        var out = line.replace(Regex("[\u0000-\u0002]"), "")
        out = ORG_LINK.replace(out) { hold(Held.Link(it.groupValues[1], it.groups[2]?.value ?: it.groupValues[1])) }
        out = MD_LINK.replace(out) { hold(Held.Link(it.groupValues[2], it.groupValues[1])) }
        out = VERBATIM.replace(out) { it.groupValues[1] + hold(Held.Code(it.groupValues[3])) }
        out = Regex("`([^`\n]+)`").replace(out) { hold(Held.Code(it.groupValues[1])) }
        out = Regex("""\*\*([^*\n]+)\*\*""").replace(out) { "\u0001b${it.groupValues[1]}\u0002b" }
        for ((f, pattern) in EMPHASIS) out = pattern.replace(out) { "${it.groupValues[1]}\u0001$f${it.groupValues[2]}\u0002$f" }
        var at = 0
        var open = 0
        for (m in HELD.findAll(out)) {
            append(out.substring(at, m.range.first))
            when {
                m.groups[1] != null -> when (val h = held[m.groupValues[1].toInt()]) {
                    is Held.Code -> withStyle(mono) { append(h.body) }
                    is Held.Link -> if (Links.opens(h.url)) withLink(LinkAnnotation.Url(h.url, TextLinkStyles(SpanStyle(color = link, textDecoration = TextDecoration.Underline)))) { append(h.label) } else append(h.label)
                }
                m.groups[2] != null -> { pushStyle(face.getValue(m.groupValues[2][0])); open++ }
                open > 0 -> { pop(); open-- }
            }
            at = m.range.last + 1
        }
        append(out.substring(at))
        repeat(open) { pop() }
    }
    var block = false
    val shown = mutableListOf<() -> Unit>()
    for (raw in text.lines()) {
        when {
            !block && Regex("""^\s*(#\+begin_(src|example)\b|```)""", RegexOption.IGNORE_CASE).containsMatchIn(raw) -> block = true
            block && Regex("""^\s*(#\+end_(src|example)\b|```)""", RegexOption.IGNORE_CASE).containsMatchIn(raw) -> block = false
            block -> shown.add { withStyle(mono) { append(raw) } }
            Regex("""^\s*#\+\w+(:|\s|$)""").containsMatchIn(raw) -> {}
            else -> {
                val heading = Regex("""^(\*+|#{1,6})\s+(.*)$""").find(raw)
                shown.add { if (heading != null) withStyle(face.getValue('b')) { words(heading.groupValues[2]) } else words(raw.replace(Regex("""^\s{0,3}>\s+"""), "")) }
            }
        }
    }
    shown.forEachIndexed { i, line -> line(); if (i < shown.size - 1) append('\n') }
}
