package net.suderman.june

import android.content.Context
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.animation.core.animateFloat
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
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
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
    // The clock, for panels lit by the hour now (a reply still streaming), ticking each minute; the daemon's sky.
    val now by produceState(System.currentTimeMillis()) { while (true) { kotlinx.coroutines.delay(60_000); value = System.currentTimeMillis() } }
    val sky = link.state.raw.optJSONObject("sky")
    BoxWithConstraints(modifier) {
        val width = maxWidth
        val metrics by produceState<JSONObject?>(null, width) { value = JSONObject(decisions.call("compose.metrics", width.value.toDouble())) }
        val m = metrics ?: return@BoxWithConstraints
        val count = panels.length()
        // Built from the bottom, newest first, as the overlay's list is: the newest panel stays in view as panels
        // arrive and settle their height, with no scrolling after them.
        LazyColumn(Modifier.fillMaxSize(), state = rememberLazyListState(), reverseLayout = true, verticalArrangement = Arrangement.spacedBy(14.dp)) {
            items(count, key = { panels.getJSONObject(count - 1 - it).getString("id") }) { i ->
                PanelView(panels.getJSONObject(count - 1 - i), newest = i == 0, width.value, m, decisions, avatar, now, sky)
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
private fun PanelView(panel: JSONObject, newest: Boolean, width: Float, m: JSONObject, decisions: Decisions, avatar: Avatar, now: Long, sky: JSONObject?) {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val textWidth = m.getDouble("textWidth").toFloat()
    val key = panel.toString()
    val measured = remember(key, width, newest) {
        val elements = panel.getJSONArray("elements")
        List(elements.length()) { measure(elements.getJSONObject(it), newest, textWidth, measurer, density) }
    }
    val sizes = JSONArray(measured.map { JSONObject().put("kind", it.kind).put("w", it.w.toDouble()).put("h", it.h.toDouble()) })
    val skyText = sky?.toString()
    val layout by produceState<JSONObject?>(null, key, width, sizes.toString(), now / 60_000, skyText) {
        value = runCatching { JSONObject(decisions.call("layout", panel, width.toDouble(), sizes, now.toDouble(), -1, sky)) }
            .onFailure { android.util.Log.w(TAG, "layout failed: $it") }.getOrNull()
    }
    val l = layout
    if (l == null) {
        Spacer(Modifier.height(m.optDouble("minHeight", 140.0).dp))
        return
    }
    val pose = l.optJSONObject("pose")
    val image by produceState<ImageBitmap?>(null, pose?.optString("url")) { value = pose?.optString("url")?.takeIf { it.isNotEmpty() }?.let { avatar.image(it) } }
    val scene = l.optJSONObject("scene")
    Box(Modifier.width(width.dp).height(l.getDouble("height").dp).clipToBounds().background(Look.color(scene?.optString("ground") ?: l.optString("tint")))) {
        if (scene != null) SceneView(scene, avatar, panel.optInt("seed"))
        scene?.optJSONObject("cutaway")?.let { CutawayView(it) }
        val art = l.optJSONObject("art")
        val clip = l.getJSONObject("clip")
        val picture = image
        if (art != null && picture != null) {
            val mirror = l.optBoolean("mirror")
            val figure = scene?.optJSONObject("figure")
            val grade = Look.color(scene?.optString("grade") ?: "#ffffff")
            val key = scene?.optJSONObject("key")
            // She takes the room's grade more gently, and the key light from the open side falls on her alone.
            val filter = remember(figure?.toString()) {
                figure?.let {
                    val m = androidx.compose.ui.graphics.ColorMatrix().apply { setToSaturation(it.optDouble("saturation", 1.0).toFloat()) }
                    val b = it.optDouble("brightness", 1.0).toFloat()
                    m.timesAssign(androidx.compose.ui.graphics.ColorMatrix().apply { setToScale(b, b, b, 1f) })
                    androidx.compose.ui.graphics.ColorFilter.colorMatrix(m)
                }
            }
            val side = panel.optString("side")
            Canvas(Modifier.fillMaxSize().graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)) {
                val d = density.density
                clipRect(clip.getDouble("x").toFloat() * d, clip.getDouble("y").toFloat() * d, (clip.getDouble("x") + clip.getDouble("w")).toFloat() * d, (clip.getDouble("y") + clip.getDouble("h")).toFloat() * d) {
                    val x = art.getDouble("x").toFloat() * d
                    val y = art.getDouble("y").toFloat() * d
                    val w = art.getDouble("w").toFloat() * d
                    val h = art.getDouble("h").toFloat() * d
                    scale(if (mirror) -1f else 1f, 1f, pivot = Offset(x + w / 2, y + h / 2)) {
                        drawImage(picture, dstOffset = IntOffset(x.toInt(), y.toInt()), dstSize = IntSize(w.toInt(), h.toInt()), colorFilter = filter)
                    }
                    if (figure != null) drawRect(grade.copy(alpha = figure.optDouble("grade", 0.0).toFloat().coerceIn(0f, 1f)), blendMode = BlendMode.SrcAtop)
                    if (key != null) {
                        val glow = Look.color(key.optString("colour"))
                        val clear = glow.copy(alpha = 0f)
                        val strength = (key.optDouble("strength", 0.0) * 0.4).toFloat().coerceIn(0f, 1f)
                        drawRect(Brush.horizontalGradient(if (side == "left") listOf(clear, glow) else listOf(glow, clear)), alpha = strength, blendMode = BlendMode.SrcAtop)
                    }
                }
            }
        }
        // Marks that reinforce her pose, beside her face, under the words (compose.mjs MARK_SHAPES).
        val marks = l.optJSONArray("marks")
        if (marks != null && marks.length() > 0) MarksView(marks, l.optJSONObject("markShapes"))
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

/** Stars in the window's sky, at fractions of it, as Scenery.qml places them. */
private val STARS = listOf(0.12f to 0.2f, 0.44f to 0.1f, 0.7f to 0.26f, 0.3f to 0.36f, 0.86f to 0.12f, 0.58f to 0.4f)

/**
 * What stands behind her (the glue's `scene`): an abstract pattern on the ground, or her room with its window's sky,
 * sun or moon, stars, view, and weather, the room cut around it, and the props, graded by the hour as one print and out
 * of focus behind a close framing; then the lamp's warm pool after dark.
 */
@Composable
private fun SceneView(scene: JSONObject, avatar: Avatar, seed: Int) {
    val density = LocalDensity.current.density
    scene.optJSONObject("pattern")?.let { pattern ->
        val shape = remember(pattern.optString("path")) { path(pattern.optString("path")) }
        Canvas(Modifier.fillMaxSize()) {
            scale(density, density, pivot = Offset.Zero) {
                val alpha = pattern.optDouble("opacity", 1.0).toFloat()
                if (pattern.optString("fill") != "transparent") drawPath(shape, Look.color(pattern.optString("fill")), alpha = alpha)
                if (pattern.optString("stroke") != "transparent") drawPath(shape, Look.color(pattern.optString("stroke")), alpha = alpha, style = Stroke(pattern.optDouble("width", 1.0).toFloat(), cap = androidx.compose.ui.graphics.StrokeCap.Round))
            }
        }
    }
    val room = scene.optJSONObject("room")
    if (room != null) {
        val place = room.getJSONObject("place")
        val win = scene.optJSONObject("window")
        val sky = scene.getJSONObject("sky")
        val plate = scene.optJSONObject("plate")
        val props = scene.optJSONArray("props") ?: JSONArray()
        val roomImage by produceState<ImageBitmap?>(null, room.optString("url")) { value = avatar.image(room.optString("url")) }
        val plateImage by produceState<ImageBitmap?>(null, plate?.optString("url")) { value = plate?.optString("url")?.let { avatar.image(it) } }
        val propImages by produceState(emptyMap<String, ImageBitmap>(), props.toString()) {
            value = (0 until props.length()).mapNotNull { i -> props.getJSONObject(i).optString("url").let { url -> avatar.image(url)?.let { url to it } } }.toMap()
        }
        val falling = remember(scene.optString("falling")) { scene.optString("falling").takeIf { it.isNotEmpty() }?.let { path(it) } }
        val grade = Look.color(scene.optString("grade"))
        val amount = scene.optDouble("gradeAmount", 0.0).toFloat().coerceIn(0f, 1f)
        val blur = scene.optDouble("blur", 0.0).toFloat()
        Canvas(Modifier.fillMaxSize().then(if (blur > 0) Modifier.blur((blur * 12).dp) else Modifier).graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)) {
            val d = density
            if (win != null) {
                val wx = win.getDouble("x").toFloat() * d
                val wy = win.getDouble("y").toFloat() * d
                val ww = win.getDouble("w").toFloat() * d
                val wh = win.getDouble("h").toFloat() * d
                clipRect(wx, wy, wx + ww, wy + wh) {
                    drawRect(Brush.verticalGradient(listOf(Look.color(sky.optString("top")), Look.color(sky.optString("bottom"))), startY = wy, endY = wy + wh), topLeft = Offset(wx, wy), size = androidx.compose.ui.geometry.Size(ww, wh))
                    val stars = sky.optDouble("stars", 0.0).toFloat()
                    if (stars > 0) for ((fx, fy) in STARS) drawCircle(Color.White.copy(alpha = stars.coerceIn(0f, 1f)), 1.5f * d, Offset(wx + fx * ww, wy + fy * wh))
                    val sunOpacity = sky.optDouble("sunOpacity", 0.0).toFloat()
                    if (sunOpacity > 0) drawCircle(Look.color(sky.optString("sun")).copy(alpha = sunOpacity.coerceIn(0f, 1f)), max(8f * d, min(ww, wh) * 0.09f), Offset(wx + sky.optDouble("sunX", 0.5).toFloat() * ww, wy + sky.optDouble("sunY", 0.3).toFloat() * wh))
                    plateImage?.let { img ->
                        val ph = max(wh * 0.5f, ww * plate!!.getDouble("height").toFloat() / plate.getDouble("width").toFloat())
                        drawImage(img, dstOffset = IntOffset(wx.toInt(), (wy + wh - ph).toInt()), dstSize = IntSize(ww.toInt(), ph.toInt()))
                    }
                    if (falling != null) translate(wx, wy) {
                        scale(d, d, pivot = Offset.Zero) {
                            if (sky.optString("falling") == "snow") drawPath(falling, Color.White) else drawPath(falling, Color(0xFFC9D6E8), style = Stroke(2f, cap = androidx.compose.ui.graphics.StrokeCap.Round))
                        }
                    }
                }
            }
            roomImage?.let { img ->
                val x = place.getDouble("x").toFloat() * d
                val y = place.getDouble("y").toFloat() * d
                val w = place.getDouble("w").toFloat() * d
                val h = place.getDouble("h").toFloat() * d
                scale(if (place.optBoolean("mirror")) -1f else 1f, 1f, pivot = Offset(x + w / 2, y + h / 2)) {
                    drawImage(img, dstOffset = IntOffset(x.toInt(), y.toInt()), dstSize = IntSize(w.toInt(), h.toInt()))
                }
            }
            for (i in 0 until props.length()) {
                val prop = props.getJSONObject(i)
                val img = propImages[prop.optString("url")] ?: continue
                drawImage(img, dstOffset = IntOffset((prop.getDouble("x") * d).toInt(), (prop.getDouble("y") * d).toInt()), dstSize = IntSize((prop.getDouble("w") * d).toInt(), (prop.getDouble("h") * d).toInt()))
            }
            // The hour's grade over the whole room, as one print under coloured light.
            if (amount > 0) drawRect(grade.copy(alpha = amount), blendMode = BlendMode.SrcAtop)
        }
    }
    val lamp = scene.optDouble("lamp", 0.0).toFloat()
    val face = scene.optJSONObject("faceCentre")
    if (lamp > 0 && face != null) Canvas(Modifier.fillMaxSize()) {
        val centre = Offset(face.getDouble("x").toFloat() * density, (face.getDouble("y").toFloat() + 40) * density)
        val r = max(size.width, size.height) * 0.45f
        drawRect(Brush.radialGradient(listOf(Color(0x8CFFC478), Color(0x00FFC478)), center = centre, radius = r), alpha = lamp.coerceIn(0f, 1f))
    }
}

@Composable
private fun MarksView(marks: JSONArray, shapes: JSONObject?) {
    val paths = remember(shapes) { mutableMapOf<String, Path>() }
    Canvas(Modifier.fillMaxSize()) {
        for (i in 0 until marks.length()) {
            val mark = marks.getJSONObject(i)
            val shape = shapes?.optJSONObject(mark.optString("kind")) ?: continue
            val d = shape.optString("path")
            if (d.isEmpty()) continue
            val outline = paths.getOrPut(d) { path(d) }
            val stroke = shape.optString("stroke").let { if (it == "ink") Look.ink else Look.color(it) }
            val fill = shape.optString("fill")
            val unit = mark.getDouble("size").toFloat() / 100f * density
            translate(mark.getDouble("x").toFloat() * density, mark.getDouble("y").toFloat() * density) {
                scale(unit, unit, pivot = Offset.Zero) {
                    if (fill != "transparent" && fill.isNotEmpty()) drawPath(outline, Look.color(fill))
                    drawPath(outline, stroke, style = Stroke(width = 7f, cap = androidx.compose.ui.graphics.StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round))
                }
            }
        }
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

/**
 * The strip in the console look (console.mjs and ConsolePanel.qml on the desktop): each panel's lines in monospace, a
 * prefix in its colour and the words after it, her face as an emoticon after her name, tool lines marked by status,
 * and a quiet status line while she works. Newest at the bottom, as the comic strip.
 */
@Composable
fun ConsoleStrip(link: Link, decisions: Decisions, palette: Look.Palette, modifier: Modifier = Modifier) {
    val strip by produceState(JSONArray(), link.items, link.state) {
        value = runCatching { JSONArray(decisions.call("consoleStrip", JSONArray(link.items.map { it.raw }), link.state.raw, false)) }
            .onFailure { android.util.Log.w(TAG, "console strip failed: $it") }.getOrDefault(value)
    }
    val count = strip.length()
    LazyColumn(modifier, state = rememberLazyListState(), reverseLayout = true, verticalArrangement = Arrangement.spacedBy(14.dp)) {
        items(count, key = { strip.getJSONObject(count - 1 - it).getString("id") }) { i ->
            val panel = strip.getJSONObject(count - 1 - i)
            val lines = panel.getJSONArray("lines")
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (j in 0 until lines.length()) ConsoleLine(lines.getJSONObject(j), palette)
                if (panel.optBoolean("live") && link.state.activity.isNotEmpty()) Text("… " + link.state.activity, color = palette.busy, fontFamily = FontFamily.Monospace, fontSize = 13.sp)
            }
        }
    }
}

@Composable
private fun ConsoleLine(line: JSONObject, palette: Look.Palette) {
    val kind = line.optString("kind")
    val quiet = kind == "tool" || kind == "thought"
    val prefixColour = when (kind) {
        "user" -> palette.user
        "june" -> palette.june
        "tool" -> when (line.optString("status")) { "error" -> palette.fail; "running" -> palette.busy; else -> palette.ok }
        "burst" -> palette.accent
        else -> palette.muted
    }
    val text = buildAnnotatedString {
        val prefix = line.optString("prefix")
        if (prefix.isNotEmpty()) {
            withStyle(SpanStyle(color = prefixColour, fontWeight = FontWeight.Bold)) { append(prefix) }
            append(" ")
        }
        if (kind == "june") append(markdown(line.optString("text"), code = palette.june))
        else withStyle(SpanStyle(color = if (quiet) palette.muted else palette.ink)) { append(line.optString("text")) }
        if (line.optBoolean("streaming")) withStyle(SpanStyle(color = palette.accent)) { append(" ▍") }
    }
    Text(text, color = palette.ink, fontFamily = FontFamily.Monospace, fontSize = if (quiet) 13.sp else 15.sp)
}

/**
 * Live June in the status line: what she is doing now as her live art (live.mjs on the desktop), bobbing gently and
 * quicker while she works, and her brief reaction when the daemon picks a face for a new reply: that face's chibi for
 * a moment, then back. A still from the set until real loops exist.
 */
@Composable
fun LiveBadge(link: Link, decisions: Decisions, avatar: Avatar) {
    var ready by remember { mutableStateOf(false) }
    LaunchedEffect(decisions) {
        decisions.call("setArt", avatar.manifest)
        ready = true
    }
    // When her last run ended, for her idle moods; she settles from busy to idle as runs finish.
    var idleSince by remember { mutableStateOf(System.currentTimeMillis()) }
    var wasRunning by remember { mutableStateOf(false) }
    val running = link.state.running || link.state.compacting
    LaunchedEffect(running) {
        if (wasRunning && !running) idleSince = System.currentTimeMillis()
        wasRunning = running
    }
    val minute by produceState(System.currentTimeMillis()) { while (true) { kotlinx.coroutines.delay(30_000); value = System.currentTimeMillis() } }
    val linked = link.status is LinkStatus.Linked
    val now by produceState(JSONObject(), ready, link.items, link.state, linked, idleSince, minute) {
        if (ready) value = runCatching { JSONObject(decisions.call("liveNow", JSONArray(link.items.map { it.raw }), link.state.raw, linked, idleSince.toDouble(), minute.toDouble())) }.getOrDefault(value)
    }
    // Her reaction to a newly picked face: none for faces already there when she opened.
    var seen by remember { mutableStateOf<String?>(null) }
    var reaction by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(ready, link.items) {
        if (!ready) return@LaunchedEffect
        val latest = link.items.lastOrNull { it.kind == "assistant" && it.expression.isNotEmpty() }?.id ?: ""
        if (seen == null) { seen = latest; return@LaunchedEffect }
        val face = JSONObject(decisions.call("reactionTo", JSONArray(link.items.map { it.raw }), seen))
        if (!face.has("id")) return@LaunchedEffect
        seen = face.getString("id")
        reaction = face.optString("url").takeIf { it.isNotEmpty() && it != "null" } ?: return@LaunchedEffect
        kotlinx.coroutines.delay(2600)
        reaction = null
    }
    val url = reaction ?: now.optJSONObject("art")?.optString("url")
    val image by produceState<ImageBitmap?>(null, url) { value = url?.let { avatar.image(it) } }
    val busy = now.optString("state") in setOf("typing", "thinking", "digging", "delegating", "watching", "tidying", "listening", "speaking")
    val bob = androidx.compose.animation.core.rememberInfiniteTransition(label = "bob").animateFloat(
        0f, 3f, androidx.compose.animation.core.infiniteRepeatable(androidx.compose.animation.core.tween(if (busy) 380 else 900), androidx.compose.animation.core.RepeatMode.Reverse), label = "bob",
    )
    Box(Modifier.size(40.dp)) {
        image?.let { Canvas(Modifier.fillMaxSize()) { drawImage(it, dstOffset = IntOffset(0, (bob.value * density).toInt()), dstSize = IntSize(size.width.toInt(), size.height.toInt())) } }
    }
}

/**
 * A cutaway to the work while she does it (light.mjs `cutaway`, Backdrop.qml on the desktop): delegating, a pane per
 * brief named by its narration with the run's calls as a chain coloured by status; digging, the places her calls
 * looked as labelled drawers on archive shelves. Never graded: it is the work, lit by its own screens.
 */
@Composable
private fun CutawayView(cut: JSONObject) {
    val label = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Color(0xFFE4E8F2))
    if (cut.optString("scene") == "delegating") {
        val panes = cut.optJSONArray("panes") ?: JSONArray()
        for (i in 0 until panes.length()) {
            val pane = panes.getJSONObject(i)
            val w = pane.getDouble("w").toFloat()
            Box(
                Modifier.offset(pane.getDouble("x").dp, pane.getDouble("y").dp).size(w.dp, 69.dp).rotate(pane.getDouble("r").toFloat())
                    .background(Color(0xFF2B3247), RoundedCornerShape(8.dp)).border(2.dp, Color(0xFF5B6683), RoundedCornerShape(8.dp)),
            ) {
                Row(Modifier.offset(2.dp, 2.dp).size((w - 4).dp, 22.dp).background(Color(0xFF353D56)), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    Spacer(Modifier.width(8.dp))
                    Box(Modifier.size(8.dp).background(Look.color(pane.optString("dot")), RoundedCornerShape(50)))
                    Spacer(Modifier.width(6.dp))
                    Text(pane.optString("name"), style = label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                val lines = pane.optJSONArray("lines") ?: JSONArray()
                Column(Modifier.offset(10.dp, 32.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    for (k in 0 until lines.length()) Box(Modifier.size(((w - 20) * lines.getDouble(k).toFloat() / 100).dp, 6.dp).background(Color(0xFF7C8AA8).copy(alpha = 0.7f), RoundedCornerShape(3.dp)))
                }
            }
        }
        val chain = cut.optString("path")
        val nodes = cut.optJSONArray("nodes") ?: JSONArray()
        val outline = remember(chain) { chain.takeIf { it.isNotEmpty() }?.let { path(it) } }
        Canvas(Modifier.fillMaxSize()) {
            scale(density, density, pivot = Offset.Zero) {
                outline?.let { drawPath(it, Color(0xFF86E08F), style = Stroke(3f)) }
                for (i in 0 until nodes.length()) {
                    val node = nodes.getJSONObject(i)
                    val c = Offset(node.getDouble("x").toFloat(), node.getDouble("y").toFloat())
                    drawCircle(Look.color(node.optString("fill")), 14f, c)
                    drawCircle(Look.ink, 14f, c, style = Stroke(2.5f))
                }
            }
        }
    } else {
        Canvas(Modifier.fillMaxSize()) { for (i in 1..3) drawRect(Color(0xFFCBBDA6), topLeft = Offset(0f, size.height * i / 4), size = androidx.compose.ui.geometry.Size(size.width, 3f * density)) }
        val drawers = cut.optJSONArray("drawers") ?: JSONArray()
        for (i in 0 until drawers.length()) {
            val drawer = drawers.getJSONObject(i)
            val w = drawer.getDouble("w").toFloat()
            val fill = Look.color(drawer.optString("fill"))
            Box(Modifier.offset(drawer.getDouble("x").dp, drawer.getDouble("y").dp).size(w.dp, (w * 0.69f).dp).rotate(drawer.getDouble("r").toFloat())) {
                Box(Modifier.offset(14.dp, (-14).dp).size(60.dp, 18.dp).background(fill, RoundedCornerShape(6.dp)).border(2.5.dp, Look.ink, RoundedCornerShape(6.dp)))
                Box(Modifier.fillMaxSize().background(fill, RoundedCornerShape(6.dp)).border(2.5.dp, Look.ink, RoundedCornerShape(6.dp)))
                Text(drawer.optString("label"), style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp, fontWeight = FontWeight.Bold, color = Look.ink), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.offset(12.dp, 14.dp).width((w - 24).dp))
            }
        }
    }
}
