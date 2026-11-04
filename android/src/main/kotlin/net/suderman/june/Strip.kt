package net.suderman.june

import android.content.Context
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/** The base avatar set in the app's assets (built by Nix from templates/avatar), and its pictures, decoded on demand. */
class Avatar(private val context: Context) {
    val manifest: JSONObject = JSONObject(context.assets.open("avatar/manifest.json").bufferedReader().use { it.readText() })
    private val cache = LruCache<String, ImageBitmap>(12)

    suspend fun image(file: String): ImageBitmap? = cache.get(file) ?: withContext(Dispatchers.IO) {
        runCatching {
            // Half size is still sharper than any panel draws her on a phone, at a quarter of the memory.
            context.assets.open("avatar/$file").use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = 2 }) }?.asImageBitmap()
        }.getOrNull()
    }?.also { cache.put(file, it) }
}

/**
 * The conversation as a comic strip, drawn from the decisions the phone shares with the desktop (Decisions.kt): the
 * view's items become composed panels, each panel's elements are measured here with the overlay's faces and padding,
 * and the layout engine places them. See "What the phone shares with the desktop" in docs/interfaces.org.
 */
@Composable
fun Strip(link: Link, decisions: Decisions, avatar: Avatar, modifier: Modifier = Modifier) {
    var ready by remember { mutableStateOf(false) }
    LaunchedEffect(decisions) {
        decisions.call("setArt", avatar.manifest)
        ready = true
    }
    val panels by produceState(JSONArray(), ready, link.items, link.state) {
        if (ready) value = JSONArray(decisions.call("panels", JSONArray(link.items.map { it.raw }), link.state.raw, false))
    }
    BoxWithConstraints(modifier) {
        val width = maxWidth
        val metrics by produceState<JSONObject?>(null, width) { value = JSONObject(decisions.call("compose.metrics", width.value.toDouble())) }
        val m = metrics ?: return@BoxWithConstraints
        val count = panels.length()
        // Built from the bottom, newest first, as the overlay's list is: the newest panel stays in view as panels
        // arrive and settle their height, with no scrolling after them.
        LazyColumn(Modifier.fillMaxSize(), state = rememberLazyListState(), reverseLayout = true, verticalArrangement = Arrangement.spacedBy(14.dp)) {
            items(count, key = { panels.getJSONObject(count - 1 - it).getString("id") }) { i ->
                PanelView(panels.getJSONObject(count - 1 - i), newest = i == 0, width.value, m, decisions, avatar)
            }
        }
    }
}

/** An element as measured: its size for the layout engine, and what drawing it needs. */
private class Measured(val kind: String, val w: Float, val h: Float, val element: JSONObject, val textW: Float = 0f, val markerW: Float = 0f)

private val SOURCES = mapOf("tui" to "terminal", "kitty" to "terminal", "apk" to "phone", "telegram" to "telegram", "cli" to "command line")

private fun balloonStyle(newest: Boolean) = TextStyle(fontFamily = Look.lettering, fontWeight = FontWeight.Medium, fontSize = (if (newest) 19 else 17).sp, color = Look.ink)
private val noteMarker = TextStyle(fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 16.sp, color = Look.noteLine)
private val noteBody = TextStyle(fontFamily = Look.caption, fontWeight = FontWeight.Medium, fontSize = 16.sp, color = Look.noteInk)
private val chipStyle = TextStyle(fontFamily = Look.caption, fontWeight = FontWeight.Bold, fontSize = 13.sp, color = Look.chipInk)
private val cardMark = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 13.sp)
private val cardLine = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = Look.cardInk)
private val thoughtStyle = TextStyle(fontFamily = Look.lettering, fontStyle = FontStyle.Italic, fontSize = 14.sp, color = Look.thoughtInk)
private val burstStyle = TextStyle(fontFamily = Look.lettering, fontWeight = FontWeight.Bold, fontSize = 15.sp, color = Look.ink)

private fun kindOf(e: JSONObject) = if (e.optString("kind") == "tools") (if (e.getJSONArray("items").length() > 1) "card" else "chip") else e.optString("kind")

private fun juneText(e: JSONObject): AnnotatedString = buildAnnotatedString {
    append(markdown(e.optString("text"), code = Look.chipInk))
    if (e.optBoolean("streaming")) withStyle(SpanStyle(color = Look.accent)) { append(" ▍") }
}

private fun noteMarkerText(item: JSONObject): String {
    val source = item.optString("source")
    return (if (source.isNotEmpty() && source != "gui") "${SOURCES[source] ?: source} " else "") + "›"
}

private fun calls(e: JSONObject): List<JSONObject> = (0 until e.getJSONArray("items").length()).map { e.getJSONArray("items").getJSONObject(it) }

private fun callMark(call: JSONObject) = when (call.optString("status")) {
    "error" -> "✗" to Look.cardFail
    "running" -> "…" to Look.cardBusy
    else -> "✓" to Look.cardOk
}

/** Measure one element as the overlay's Panel.qml sizes it, in dp: the width its words take, padding, and minimums. */
private fun measure(e: JSONObject, newest: Boolean, textWidth: Float, measurer: TextMeasurer, density: Density): Measured {
    fun natural(text: AnnotatedString, style: TextStyle) = measurer.measure(text, style).size.width / density.density
    fun height(text: AnnotatedString, style: TextStyle, width: Float, lines: Int = Int.MAX_VALUE) =
        measurer.measure(text, style, maxLines = lines, overflow = TextOverflow.Ellipsis, constraints = Constraints(maxWidth = max(1, (width * density.density).toInt()))).size.height / density.density
    val kind = kindOf(e)
    return when (kind) {
        "june" -> {
            val text = juneText(e)
            val style = balloonStyle(newest)
            val words = min(natural(text, style) + 2, textWidth - 44)
            Measured(kind, ceil(max(words + 44, 120f)), ceil(max(height(text, style, words) + 28, 58f)), e, words)
        }
        "user" -> {
            val item = e.getJSONObject("item")
            val marker = natural(AnnotatedString(noteMarkerText(item)), noteMarker)
            val body = AnnotatedString(item.optString("text"))
            val bodyW = min(natural(body, noteBody) + 2, textWidth - 28 - marker - 8)
            val h = max(height(body, noteBody, bodyW), height(AnnotatedString("›"), noteMarker, marker))
            Measured(kind, ceil(min(marker + 8 + bodyW + 28, textWidth)), ceil(h + 20), e, bodyW, marker)
        }
        "chip" -> {
            val call = calls(e)[0]
            val label = AnnotatedString("∴ " + call.optString("caption") + if (call.optString("status") == "running") " …" else "")
            val w = min(natural(label, chipStyle), textWidth - 24)
            Measured(kind, ceil(min(w + 24, textWidth)), ceil(height(label, chipStyle, w, 1) + 10), e, w)
        }
        "card" -> {
            val all = calls(e)
            val limit = min(460f, textWidth)
            val shown = all.takeLast(5)
            var widest = 0f
            var total = 0f
            for (call in shown) {
                val mark = natural(AnnotatedString(callMark(call).first), cardMark)
                widest = max(widest, mark + 8 + natural(AnnotatedString(call.optString("caption")), cardLine))
                total += max(height(AnnotatedString(call.optString("caption")), cardLine, limit, 1), height(AnnotatedString("✓"), cardMark, 40f)) + 5
            }
            if (all.size > 5) total += height(AnnotatedString("+"), cardLine, limit) + 5
            Measured(kind, ceil(min(max(widest + 28, 180f), limit)), ceil(total - 5 + 24), e, limit)
        }
        "thought" -> {
            val text = AnnotatedString(e.getJSONObject("item").optString("text"))
            val words = min(natural(text, thoughtStyle), textWidth - 46)
            Measured(kind, ceil(words + 46), ceil(height(text, thoughtStyle, words) + 34), e, words)
        }
        "burst" -> {
            val item = e.getJSONObject("item")
            val text = AnnotatedString(item.optString("error").ifEmpty { item.optString("text") })
            val words = min(natural(text, burstStyle), textWidth - 46)
            Measured(kind, ceil(words + 46), ceil(height(text, burstStyle, words) + 46), e, words)
        }
        else -> Measured(kind, 0f, 0f, e)
    }
}

private fun path(d: String): Path = PathParser().parsePathString(d).toPath()

/** One panel: its ground, June framed into her clip, the words where the layout put them, and the frame over all. */
@Composable
private fun PanelView(panel: JSONObject, newest: Boolean, width: Float, m: JSONObject, decisions: Decisions, avatar: Avatar) {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val textWidth = m.getDouble("textWidth").toFloat()
    val key = panel.toString()
    val measured = remember(key, width, newest) {
        val elements = panel.getJSONArray("elements")
        List(elements.length()) { measure(elements.getJSONObject(it), newest, textWidth, measurer, density) }
    }
    val sizes = JSONArray(measured.map { JSONObject().put("kind", it.kind).put("w", it.w.toDouble()).put("h", it.h.toDouble()) })
    val layout by produceState<JSONObject?>(null, key, width, sizes.toString()) {
        value = runCatching { JSONObject(decisions.call("layout", panel, width.toDouble(), sizes)) }.getOrNull()
    }
    val l = layout
    if (l == null) {
        Spacer(Modifier.height(m.optDouble("minHeight", 140.0).dp))
        return
    }
    val pose = l.optJSONObject("pose")
    val image by produceState<ImageBitmap?>(null, pose?.optString("url")) { value = pose?.optString("url")?.takeIf { it.isNotEmpty() }?.let { avatar.image(it) } }
    Box(Modifier.width(width.dp).height(l.getDouble("height").dp).clipToBounds().background(Look.color(l.optString("tint")))) {
        val art = l.optJSONObject("art")
        val clip = l.getJSONObject("clip")
        val picture = image
        if (art != null && picture != null) {
            val mirror = l.optBoolean("mirror")
            Canvas(Modifier.fillMaxSize()) {
                val d = density.density
                clipRect(clip.getDouble("x").toFloat() * d, clip.getDouble("y").toFloat() * d, (clip.getDouble("x") + clip.getDouble("w")).toFloat() * d, (clip.getDouble("y") + clip.getDouble("h")).toFloat() * d) {
                    val x = art.getDouble("x").toFloat() * d
                    val y = art.getDouble("y").toFloat() * d
                    val w = art.getDouble("w").toFloat() * d
                    val h = art.getDouble("h").toFloat() * d
                    scale(if (mirror) -1f else 1f, 1f, pivot = Offset(x + w / 2, y + h / 2)) {
                        drawImage(picture, dstOffset = IntOffset(x.toInt(), y.toInt()), dstSize = IntSize(w.toInt(), h.toInt()))
                    }
                }
            }
        }
        val boxes = l.getJSONArray("elements")
        for (i in measured.indices) {
            val box = boxes.optJSONObject(i) ?: continue
            Box(Modifier.offset(box.getDouble("x").dp, box.getDouble("y").dp).size(measured[i].w.dp, measured[i].h.dp)) {
                ElementView(measured[i], box, newest)
            }
        }
        Box(Modifier.matchParentSize().border(3.dp, Look.ink))
    }
}

@Composable
private fun Outline(d: String, fill: Color, stroke: Float) {
    val shape = remember(d) { path(d) }
    Canvas(Modifier.fillMaxSize()) {
        scale(density, density, pivot = Offset.Zero) {
            drawPath(shape, fill)
            drawPath(shape, Look.ink, style = Stroke(width = stroke))
        }
    }
}

@Composable
private fun ElementView(e: Measured, box: JSONObject, newest: Boolean) {
    val el = e.element
    when (e.kind) {
        "june" -> {
            Outline(box.optString("path"), Look.balloon, if (newest) 3f else 2.5f)
            Box(Modifier.offset(max((e.w - e.textW) / 2, 22f).dp, 14.dp).width(e.textW.dp)) { Text(juneText(el), style = balloonStyle(newest)) }
        }
        "user" -> {
            val item = el.getJSONObject("item")
            Box(Modifier.fillMaxSize().background(Look.noteFill, RoundedCornerShape(14.dp)).border(2.dp, Look.noteLine, RoundedCornerShape(14.dp)))
            Text(noteMarkerText(item), style = noteMarker, modifier = Modifier.offset(14.dp, 10.dp))
            Text(item.optString("text"), style = noteBody, modifier = Modifier.offset((14 + e.markerW + 8).dp, 10.dp).width(e.textW.dp))
        }
        "chip" -> {
            val call = calls(el)[0]
            val failed = call.optString("status") == "error"
            Box(Modifier.fillMaxSize().background(if (failed) Look.burstFill else Look.chipFill, RoundedCornerShape(50)).border(1.5.dp, Look.chipInk.copy(alpha = 0.3f), RoundedCornerShape(50)))
            Text("∴ " + call.optString("caption") + if (call.optString("status") == "running") " …" else "", style = chipStyle, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.offset(12.dp, 5.dp).width(e.textW.dp))
        }
        "card" -> {
            val all = calls(el)
            Box(Modifier.fillMaxSize().background(Look.cardFill, RoundedCornerShape(10.dp)).border(2.dp, Look.cardLine, RoundedCornerShape(10.dp)))
            Column(Modifier.offset(14.dp, 12.dp).width((e.w - 28).dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                for (call in all.takeLast(5)) {
                    val (mark, color) = callMark(call)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(mark, style = cardMark.copy(color = color))
                        Text(call.optString("caption"), style = cardLine, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                if (all.size > 5) Text("+${all.size - 5} earlier", style = cardLine.copy(color = Color(0xFF9AA3B8), fontSize = 11.sp))
            }
        }
        "thought" -> {
            Outline(box.optString("path"), Look.balloon, 2f)
            Text(el.getJSONObject("item").optString("text"), style = thoughtStyle, modifier = Modifier.offset(23.dp, 17.dp).width(e.textW.dp))
            val trail = box.optJSONObject("trail")
            val dots = box.optJSONArray("trailDots")
            if (trail != null && dots != null) Canvas(Modifier.fillMaxSize()) {
                for (i in 0 until dots.length()) {
                    val dot = dots.getJSONObject(i)
                    val at = dot.getDouble("at").toFloat()
                    val size = dot.getDouble("size").toFloat()
                    val c = Offset((trail.getDouble("x").toFloat() + trail.getDouble("dx").toFloat() * at) * density, (trail.getDouble("y").toFloat() + trail.getDouble("dy").toFloat() * at) * density)
                    drawCircle(Look.balloon, size / 2 * density, c)
                    drawCircle(Look.ink, size / 2 * density, c, style = Stroke(2f * density))
                }
            }
        }
        "burst" -> {
            Outline(box.optString("path"), Look.burstFill, 2.5f)
            val item = el.getJSONObject("item")
            Text(item.optString("error").ifEmpty { item.optString("text") }, style = burstStyle, modifier = Modifier.offset(23.dp, 23.dp).width(e.textW.dp))
        }
    }
}
