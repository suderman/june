package net.suderman.june

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.ImageShader
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The boards' printed kit: panels, screentone, a ticket's perforation, rubber stamps, ruled fields, a memo pad,
 * press tabs and folder tabs. Each piece draws itself in the look LocalPalette names (paper and ink, late night neon,
 * or a text-only terminal) from the palette's tokens, so callers never branch on the look.
 */
val LocalPalette = staticCompositionLocalOf { Look.palette(console = false, dark = false) }

/** The small radius every docket, card and button shares; the console's frames are square. */
fun Look.Palette.corner(radius: Dp = 6.dp): Shape = if (console) RectangleShape else RoundedCornerShape(radius)

/**
 * A printed panel's stock, edge and shadow: on paper, FILL with a WIDTH ink edge over a hard, unblurred shadow LIFT
 * down and right; in neon, a dark panel with a thin stroke in EDGE (its meaning colour) and a soft glow LIFT out; in
 * the console, a square one-pixel frame. FILL null leaves the page showing.
 */
@Composable
fun Modifier.inked(shape: Shape = LocalPalette.current.corner(), edge: Color? = null, fill: Color? = LocalPalette.current.surface, lift: Dp = 3.dp, width: Dp = 2.dp): Modifier {
    val p = LocalPalette.current
    return drawBehind {
        val outline = (if (p.console) RectangleShape else shape).createOutline(size, layoutDirection, this)
        val line = edge ?: p.line
        when (p.kind) {
            Look.Kind.Paper -> {
                if (lift > 0.dp) translate(lift.toPx(), lift.toPx()) { drawOutline(outline, p.shadow) }
                if (fill != null) drawOutline(outline, fill)
                drawOutline(outline, line, style = Stroke(width.toPx()))
            }
            Look.Kind.Neon -> {
                if (lift > 0.dp) {
                    val shift = lift.toPx() * 0.6f
                    translate(shift, shift) {
                        for ((w, a) in listOf(lift * 3.4f to 0.07f, lift * 2f to 0.13f, lift to 0.24f)) drawOutline(outline, line.copy(alpha = a), style = Stroke(w.toPx()))
                    }
                }
                if (fill != null) drawOutline(outline, fill)
                drawOutline(outline, line, style = Stroke((width * 0.7f).toPx()))
            }
            Look.Kind.Console -> {
                if (fill != null) drawOutline(outline, fill)
                drawOutline(outline, line, style = Stroke(1.dp.toPx()))
            }
        }
    }
}

/** One tile of halftone, two dots offset like a 45° screen, made once for each colour and pitch. */
private fun toneTile(color: Color, pitch: Float, radius: Float): ImageBitmap {
    val side = (pitch * 2).toInt().coerceAtLeast(2)
    val bitmap = ImageBitmap(side, side)
    val canvas = androidx.compose.ui.graphics.Canvas(bitmap)
    val paint = Paint().apply { this.color = color; isAntiAlias = true }
    val h = side / 2f
    for ((x, y) in listOf(h / 2 to h / 2, h * 1.5f to h * 1.5f)) canvas.drawCircle(Offset(x, y), radius, paint)
    return bitmap
}

/**
 * Screentone behind the content, clipped to SHAPE: a fine dot in ink on paper, a faint tinted dot in neon (TINT, or
 * the accent), nothing in the console. DENSITY is the dots' opacity; keep it low behind text.
 */
@Composable
fun Modifier.screentone(shape: Shape = RectangleShape, density: Float = 0.16f, tint: Color? = null, pitch: Dp = 3.5.dp): Modifier {
    val p = LocalPalette.current
    if (p.console) return this
    val color = (if (p.neon) tint ?: p.accent else tint ?: p.line).copy(alpha = density)
    val px = with(LocalDensity.current) { pitch.toPx() }
    val brush = remember(color, px) { ShaderBrush(ImageShader(toneTile(color, px, px * 0.3f), TileMode.Repeated, TileMode.Repeated)) }
    return drawBehind { drawOutline(shape.createOutline(size, layoutDirection, this), brush) }
}

/**
 * A ticket's tear line across a docket: a dashed rule with a punched notch at each edge, as wide as its parent so
 * the notches bite the panel's edge. The console draws a plain dashed rule.
 */
@Composable
fun Perforation(modifier: Modifier = Modifier, notch: Dp = 7.dp) {
    val p = LocalPalette.current
    Box(
        modifier.fillMaxWidth().height(notch * 2).drawBehind {
            val y = size.height / 2
            val r = notch.toPx()
            val dash = PathEffect.dashPathEffect(floatArrayOf(5.dp.toPx(), 4.dp.toPx()))
            val inset = if (p.console) 0f else r + 4.dp.toPx()
            drawLine(if (p.console) p.line else p.line.copy(alpha = if (p.neon) 0.7f else 0.55f), Offset(inset, y), Offset(size.width - inset, y), 1.5.dp.toPx(), pathEffect = dash)
            if (!p.console) for (x in listOf(0f, size.width)) {
                drawCircle(p.page, r, Offset(x, y))
                drawCircle(p.line, r, Offset(x, y), style = Stroke((if (p.neon) 1.4f else 2f).dp.toPx()))
            }
        },
    )
}

/** A stamp's slight, steady tilt from its text, within about two degrees either way. */
fun tiltOf(text: String): Float = (Math.floorMod(text.hashCode(), 5) - 2) * 0.9f

/**
 * A state or status as a rubber stamp: TONE ink in a double border, tilted a little (paper); a small neon sign
 * (neon); a bracketed tag (console). An OFF stamp, a choice not taken, has a faint dashed edge and no fill, its
 * text still at full strength to read; with ONCLICK it is a button at least 48 dp to tap.
 */
@Composable
fun Stamp(text: String, tone: Color, modifier: Modifier = Modifier, on: Boolean = true, tilt: Float = tiltOf(text), big: Boolean = false, onClick: (() -> Unit)? = null) {
    val p = LocalPalette.current
    val t = p.type
    val label = text.uppercase()
    val ink = if (on || !p.console) tone else p.muted
    val style = (if (big) t.button else t.label).copy(color = ink, letterSpacing = t.label.letterSpacing)
    val tap = if (onClick != null) Modifier.heightIn(min = 48.dp).semantics { role = Role.Button; selected = on }.clickable(onClick = onClick) else Modifier
    Box(modifier.then(tap), contentAlignment = Alignment.Center) {
        if (p.console) {
            Text(
                "[$label]", style = style.copy(color = if (on && onClick != null) p.page else ink),
                modifier = if (on && onClick != null) Modifier.background(tone).padding(horizontal = 2.dp) else Modifier,
            )
        } else {
            val pad = if (big) Modifier.padding(horizontal = 10.dp, vertical = 5.dp) else Modifier.padding(horizontal = 7.dp, vertical = 3.dp)
            Text(
                label, style = style, maxLines = 1,
                modifier = Modifier.rotate(tilt).drawBehind {
                    val r = CornerRadius(3.dp.toPx())
                    val w = (if (p.neon) 1.5f else 2f).dp.toPx()
                    if (p.neon && on) for ((gw, a) in listOf(7f to 0.10f, 4f to 0.22f)) drawRoundRect(tone.copy(alpha = a), cornerRadius = r, style = Stroke(gw.dp.toPx()))
                    if (on) drawRoundRect(tone.copy(alpha = if (p.neon) 0.14f else 0.07f), cornerRadius = r)
                    if (on) drawRoundRect(ink, cornerRadius = r, style = Stroke(w))
                    else drawRoundRect(ink.copy(alpha = 0.45f), cornerRadius = r, style = Stroke(w * 0.75f, pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))))
                    // A rubber stamp's inner line, a little uneven where the ink ran thin.
                    if (!p.neon && on) {
                        val i = 3.dp.toPx()
                        drawRoundRect(ink.copy(alpha = 0.55f), Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i), CornerRadius(1.5.dp.toPx()), style = Stroke(0.8.dp.toPx()))
                    }
                }.then(pad),
            )
        }
    }
}

/** What a press tab does: the one primary action of a view, the others, one that removes, or a quiet link. */
enum class Press { Primary, Secondary, Danger, Quiet }

/**
 * A button as a pressed tab: a chunky ink edge, a small radius and a hard shadow that collapses when pressed, so it
 * sinks into the page. Neon makes it a glowing key, the console a bracketed command (the primary inverted). At least
 * 48 dp to tap.
 */
@Composable
fun PressTab(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, kind: Press = Press.Secondary, enabled: Boolean = true, small: Boolean = false) {
    val p = LocalPalette.current
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val danger = p.tone("TODO").let { if (p.console) p.fail else it }
    // Paper's primary is ink on ink shadow, so a cream edge keeps the key apart from its shadow.
    val edge = when (kind) { Press.Danger -> danger; Press.Primary -> if (p.neon) p.accent else if (p.console) p.line else p.surface; else -> p.line }
    val fill = when {
        kind == Press.Quiet -> null
        kind == Press.Primary -> if (p.neon) p.accent else if (p.console) p.pageInk else p.line
        else -> if (p.console) null else p.surface
    }
    val ink = when {
        kind == Press.Primary -> if (p.neon) p.page else if (p.console) p.page else p.surface
        kind == Press.Danger -> danger
        else -> if (p.console || kind == Press.Quiet) p.pageInk else p.surfaceInk
    }
    val lift = if (pressed || !enabled || kind == Press.Quiet || p.console) 0.dp else if (small) 2.dp else 3.dp
    val sink = with(LocalDensity.current) { (if (pressed && !p.console) (if (small) 2.dp else 3.dp) else 0.dp).toPx() }
    Box(
        modifier.heightIn(min = 48.dp).semantics { role = Role.Button }
            .clickable(interactionSource = source, indication = null, enabled = enabled, onClick = onClick)
            .graphicsLayer { alpha = if (enabled) 1f else 0.45f },
        contentAlignment = Alignment.CenterStart,
    ) {
        val label = if (p.console) "[ $text ]" else text
        Text(
            label, style = p.type.button.copy(color = ink), maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.graphicsLayer { translationX = sink; translationY = sink }
                .then(if (kind == Press.Quiet) Modifier else Modifier.inked(p.corner(6.dp), edge, fill, lift, if (small) 1.75.dp else 2.dp))
                .then(if (p.console && pressed) Modifier.background(p.rule) else Modifier)
                .padding(horizontal = if (p.console) 4.dp else if (small) 12.dp else 16.dp, vertical = if (small) 7.dp else 11.dp),
        )
    }
}

/**
 * A section's rule: its title in small caps and a thin line running on to the right edge; the console draws
 * "── TITLE ──". With ONCLICK the title gets a chevron and the whole rule is a 48 dp target. TRAILING sits at the end.
 */
@Composable
fun SectionRule(title: String, modifier: Modifier = Modifier, alert: Boolean = false, onClick: (() -> Unit)? = null, trailing: @Composable () -> Unit = {}) {
    val p = LocalPalette.current
    val ink = if (alert) p.accent else if (p.neon) p.muted else p.pageInk.copy(alpha = 0.78f)
    Row(
        modifier.fillMaxWidth().padding(top = 8.dp).heightIn(min = if (onClick != null) 48.dp else 28.dp)
            .then(if (onClick != null) Modifier.semantics { role = Role.Button }.clickable(onClick = onClick) else Modifier),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val text = if (p.console) "── $title${if (onClick != null) " ›" else ""} " else title + if (onClick != null) "  ›" else ""
        Text(text, style = p.type.section.copy(color = ink), maxLines = 1)
        Spacer(Modifier.width(8.dp))
        Box(
            Modifier.weight(1f).height(if (p.console) 1.dp else 1.5.dp)
                .background(if (alert) p.accent.copy(alpha = 0.6f) else if (p.console) p.line else p.rule),
        )
        Row(verticalAlignment = Alignment.CenterVertically) { trailing() }
    }
}

/**
 * A blank on a form: a printed LABEL over a ruled ink underline, no box. The console prompts "label> ". ON is the
 * colour scheme it sits on: a docket's surface or the page.
 */
@Composable
fun RuledField(
    value: String, onValueChange: (String) -> Unit, label: String, modifier: Modifier = Modifier, placeholder: String = "",
    onDone: (() -> Unit)? = null, onSurface: Boolean = true, mono: Boolean = false,
) {
    val p = LocalPalette.current
    val ink = if (onSurface) p.surfaceInk else p.pageInk
    val muted = if (onSurface) p.surfaceMuted else p.muted
    val text = (if (mono) p.type.number.copy(fontSize = p.type.value.fontSize) else p.type.value).copy(color = ink)
    val keys = if (onDone != null) KeyboardOptions(imeAction = ImeAction.Done) else KeyboardOptions.Default
    if (p.console) {
        Row(modifier.fillMaxWidth().heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("${label.lowercase()}> ", style = text.copy(color = muted))
            BasicTextField(
                value, onValueChange, Modifier.weight(1f), textStyle = text, singleLine = true, cursorBrush = SolidColor(p.pageInk),
                keyboardOptions = keys, keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }),
                decorationBox = { inner -> Box { if (value.isEmpty()) Text(placeholder.ifEmpty { "_" }, style = text.copy(color = muted)); inner() } },
            )
        }
        return
    }
    Column(modifier.fillMaxWidth()) {
        Text(label.uppercase(), style = p.type.label.copy(color = muted))
        BasicTextField(
            value, onValueChange, Modifier.fillMaxWidth(), textStyle = text, singleLine = true,
            cursorBrush = SolidColor(if (p.neon) p.accent else ink), keyboardOptions = keys, keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }),
            decorationBox = { inner ->
                Box(
                    Modifier.fillMaxWidth().heightIn(min = 40.dp).drawBehind {
                        val w = (if (p.neon) 1.25f else 1.5f).dp.toPx()
                        drawLine(if (p.neon) p.line else ink.copy(alpha = 0.75f), Offset(0f, size.height - w), Offset(size.width, size.height - w), w)
                    }.padding(top = 6.dp, bottom = 7.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    if (value.isEmpty() && placeholder.isNotEmpty()) Text(placeholder, style = text.copy(color = muted.copy(alpha = 0.8f)))
                    inner()
                }
            },
        )
    }
}

/**
 * A multi-line reply on a lined memo pad: a faint rule under every line and a margin line at the left, as a pad of
 * paper has; in neon the rules glow faintly, in the console it is a framed "> " prompt.
 */
@Composable
fun MemoField(value: String, onValueChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier, lines: Int = 3) {
    val p = LocalPalette.current
    val style: TextStyle = p.type.body.copy(color = p.surfaceInk)
    val lineHeight = with(LocalDensity.current) { style.lineHeight.toPx() }
    val margin = if (p.console) 0.dp else 26.dp
    BasicTextField(
        value, onValueChange, modifier.fillMaxWidth(), textStyle = style, minLines = lines, cursorBrush = SolidColor(if (p.neon) p.accent else p.surfaceInk),
        decorationBox = { inner ->
            Row(
                Modifier.fillMaxWidth().inked(p.corner(4.dp), lift = if (p.console) 0.dp else 2.dp, width = if (p.neon) 1.5.dp else 1.75.dp)
                    .drawBehind {
                        if (p.console) return@drawBehind
                        val top = 10.dp.toPx()
                        val rule = if (p.neon) p.rule else Look.noteLine.copy(alpha = 0.28f)
                        var y = top + lineHeight
                        while (y < size.height - 4.dp.toPx()) { drawLine(rule, Offset(4.dp.toPx(), y), Offset(size.width - 4.dp.toPx(), y), 1.dp.toPx()); y += lineHeight }
                        val x = margin.toPx() - 6.dp.toPx()
                        drawLine(if (p.neon) p.accent.copy(alpha = 0.45f) else Color(0x66D8432F), Offset(x, 2.dp.toPx()), Offset(x, size.height - 2.dp.toPx()), 1.25.dp.toPx())
                    }
                    .padding(start = if (p.console) 8.dp else margin, end = 10.dp, top = 10.dp, bottom = 10.dp),
            ) {
                if (p.console) Text("> ", style = style.copy(color = p.surfaceMuted))
                Box(Modifier.weight(1f)) {
                    if (value.isEmpty()) Text(placeholder, style = style.copy(color = p.surfaceMuted))
                    inner()
                }
            }
        },
    )
}

/** The two app icons the tab bar and a docket's band share: Herdr's terminal and Emacs's pen over paper. */
enum class Glyph { Terminal, Editor }

/** Draw GLYPH on a 24-unit grid in INK, PAGE behind the pen so it cuts the sheet's edge. */
fun androidx.compose.ui.graphics.drawscope.DrawScope.glyph(glyph: Glyph, ink: Color, page: Color) {
    val line = Stroke(1.8f, cap = androidx.compose.ui.graphics.StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round)
    fun box(l: Float, t: Float, r: Float, b: Float, radius: Float) = drawRoundRect(ink, Offset(l, t), Size(r - l, b - t), CornerRadius(radius), style = line)
    fun stroke(vararg xy: Float) = drawPath(androidx.compose.ui.graphics.Path().apply { moveTo(xy[0], xy[1]); for (i in 2 until xy.size step 2) lineTo(xy[i], xy[i + 1]) }, ink, style = line)
    when (glyph) {
        // A command prompt: a window with a chevron and a cursor.
        Glyph.Terminal -> {
            box(2.5f, 4.5f, 21.5f, 19.5f, 2.5f)
            stroke(6.5f, 9f, 9.5f, 12f, 6.5f, 15f)
            stroke(11.5f, 15f, 16.5f, 15f)
        }
        // A pen over a square sheet of paper, matching the boxy weight of the other icons.
        Glyph.Editor -> {
            box(3.5f, 4.5f, 19f, 20f, 3.5f)
            stroke(6.8f, 8.8f, 11.2f, 8.8f)
            stroke(6.8f, 12.4f, 9.5f, 12.4f)
            stroke(6.8f, 16f, 15.7f, 16f)
            val pen = androidx.compose.ui.graphics.Path().apply {
                moveTo(19.14f, 4.04f); lineTo(21.26f, 6.16f)
                lineTo(15.46f, 11.96f); lineTo(12.3f, 13f); lineTo(13.34f, 9.84f); close()
            }
            drawPath(pen, page)
            drawPath(pen, page, style = Stroke(3.6f, cap = androidx.compose.ui.graphics.StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round))
            drawPath(pen, ink, style = line)
            stroke(17.94f, 5.24f, 20.06f, 7.36f)
        }
    }
}
