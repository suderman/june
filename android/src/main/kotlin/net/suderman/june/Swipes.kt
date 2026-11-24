package net.suderman.june

import android.content.Context
import android.content.Intent
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs

/**
 * Swipes on June's header, in the assistant sheet and the full screen. What each direction does is set in June's
 * settings (MainActivity) and kept in the app's preferences, so both screens agree.
 */
object Swipes {
    /** Which way the finger moves. */
    enum class Direction(val key: String, val label: String) {
        UP("up", "Swipe up"),
        DOWN("down", "Swipe down"),
        RIGHT("right", "Swipe left to right"),
        LEFT("left", "Swipe right to left"),
    }

    /** Companion apps June opens from her tab bar, agenda widget and header swipes. */
    enum class AppSlot(val key: String, val name_: String, val settingLabel: String, val defaultPkg: String, val legacySwipeKey: String) {
        Terminal("terminal", "Terminal", "Terminal app", "dev.herdr.app", "right"),
        Editor("editor", "Editor", "Editor app", "org.gnu.emacs", "left"),
    }

    /** What a swipe does: nothing, June full screen, close June, or open the chosen Terminal or Editor app. */
    sealed interface Action {
        data object None : Action
        data object Full : Action
        data object Close : Action
        data class Slot(val slot: AppSlot) : Action
    }

    // Jon's agents app (Herdr) and his editor, read off his phone on 2026-11-20.
    private val defaults = mapOf(
        Direction.UP to Action.Full,
        Direction.DOWN to Action.Close,
        Direction.RIGHT to Action.Slot(AppSlot.Terminal),
        Direction.LEFT to Action.Slot(AppSlot.Editor),
    )

    private fun prefs(context: Context) = context.getSharedPreferences("swipes", Context.MODE_PRIVATE)

    /** The package chosen for Terminal or Editor, falling back to any earlier sideways-swipe choice, then the default. */
    fun app(context: Context, slot: AppSlot): String {
        val p = prefs(context)
        p.getString("slot:${slot.key}", null)?.let { return it }
        val legacy = p.getString(slot.legacySwipeKey, null)
        if (legacy != null && legacy.startsWith("app:")) return legacy.removePrefix("app:")
        return slot.defaultPkg
    }

    fun setApp(context: Context, slot: AppSlot, pkg: String) {
        prefs(context).edit().putString("slot:${slot.key}", pkg).apply()
        AgendaWidget.updateAll(context)
    }

    fun appLabel(context: Context, pkg: String): String = runCatching {
        context.packageManager.getApplicationLabel(context.packageManager.getApplicationInfo(pkg, 0)).toString()
    }.getOrDefault("$pkg (not installed)")

    fun get(context: Context, direction: Direction): Action = when (val saved = prefs(context).getString(direction.key, null)) {
        "none" -> Action.None
        "full" -> Action.Full
        "close" -> Action.Close
        "slot:terminal" -> Action.Slot(AppSlot.Terminal)
        "slot:editor" -> Action.Slot(AppSlot.Editor)
        else -> when {
            saved != null && saved.startsWith("app:") && direction == Direction.RIGHT -> Action.Slot(AppSlot.Terminal)
            saved != null && saved.startsWith("app:") && direction == Direction.LEFT -> Action.Slot(AppSlot.Editor)
            else -> defaults.getValue(direction)
        }
    }

    fun set(context: Context, direction: Direction, action: Action) {
        val value = when (action) {
            Action.None -> "none"
            Action.Full -> "full"
            Action.Close -> "close"
            is Action.Slot -> "slot:${action.slot.key}"
        }
        prefs(context).edit().putString(direction.key, value).apply()
    }

    /** Whether `action` does anything on a screen: June full screen does nothing on the full screen itself. */
    fun does(action: Action, fullScreen: Boolean): Boolean = action != Action.None && !(fullScreen && action == Action.Full)

    /** The action's name, as a swipe's hint shows it. */
    fun label(context: Context, action: Action): String = when (action) {
        Action.None -> "nothing"
        Action.Full -> "June full screen"
        Action.Close -> "close June"
        is Action.Slot -> appLabel(context, app(context, action.slot))
    }

    /** The action's name in settings, showing both the slot and the app currently chosen for it. */
    fun settingLabel(context: Context, action: Action): String = when (action) {
        is Action.Slot -> "${action.slot.name_} (${appLabel(context, app(context, action.slot))})"
        else -> label(context, action)
    }

    /** Open the app chosen for Terminal or Editor; returns why it could not be, or null. */
    fun openSlot(context: Context, slot: AppSlot): String? =
        // With terminals in June, Terminal is June's own page on the last terminal shown (june://terminal).
        if (slot == AppSlot.Terminal && Terminals.embedded(context)) runCatching {
            context.startActivity(
                Intent(Intent.ACTION_VIEW, android.net.Uri.parse("june://terminal")).setClass(context, ConversationActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            )
        }.exceptionOrNull()?.let { "June could not open it" }
        else open(context, app(context, slot))

    /** Open an app at its launcher entry; returns why it could not be, or null. */
    fun open(context: Context, pkg: String): String? {
        val intent = context.packageManager.getLaunchIntentForPackage(pkg) ?: return "$pkg is not installed"
        return runCatching {
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED))
        }.exceptionOrNull()?.let { "Could not open $pkg: ${it.message}" }
    }

    /** The launcher's apps other than June, one per package, as (package, label) by label: what settings offers. */
    fun apps(context: Context): List<Pair<String, String>> {
        val pm = context.packageManager
        return pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
            .map { it.activityInfo.packageName to it.loadLabel(pm).toString() }
            .filter { it.first != context.packageName }
            .distinctBy { it.first }
            .sortedBy { it.second.lowercase() }
    }
}

/** A swipe on June's header as it happens: how far the page has followed the finger, and along which axis. */
class Swipe {
    val offset = Animatable(Offset.Zero, Offset.VectorConverter)

    /** Locked at touch slop: true sideways, false up or down, null while no swipe is under way. */
    var horizontal by mutableStateOf<Boolean?>(null)

    /** The moving page's size, for the thresholds; its screen sets it. */
    var size = IntSize.Zero
}

/**
 * Where a swipe goes on release: past 25% of the page's height or 30% of its width, or flung that way faster than
 * `fling` pixels a second once past 8%. Null springs back; a zero velocity asks only whether it has gone far enough.
 */
internal fun swipeDirection(drag: Offset, velocity: Velocity, size: IntSize, horizontal: Boolean, fling: Float): Swipes.Direction? {
    val along = if (horizontal) drag.x else drag.y
    val speed = if (horizontal) velocity.x else velocity.y
    val span = (if (horizontal) size.width else size.height).toFloat()
    if (span <= 0f || along == 0f) return null
    val far = abs(along) > span * (if (horizontal) 0.3f else 0.25f)
    val flung = abs(along) > span * 0.08f && abs(speed) > fling && (speed > 0) == (along > 0)
    return if (far || flung) way(along, horizontal) else null
}

private fun way(along: Float, horizontal: Boolean) =
    if (horizontal) (if (along > 0) Swipes.Direction.RIGHT else Swipes.Direction.LEFT)
    else (if (along > 0) Swipes.Direction.DOWN else Swipes.Direction.UP)

/**
 * Make this the handle of a swipe. The page follows the finger along one axis; a direction that does nothing here only
 * gives a little. Crossing the threshold ticks, and letting go past it slides the page out and does `act`, or the page
 * springs back. Positions are read in root coordinates: the handle moves with the page, so its own would cancel the drag.
 */
@Composable
fun Modifier.swipeHandle(swipe: Swipe, allowed: (Swipes.Direction) -> Boolean, act: (Swipes.Direction) -> Unit): Modifier {
    val allow by rememberUpdatedState(allowed)
    val go by rememberUpdatedState(act)
    val haptic = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val fling = with(LocalDensity.current) { 1000.dp.toPx() }
    var coords by remember { mutableStateOf<LayoutCoordinates?>(null) }
    return onGloballyPositioned { coords = it }.pointerInput(swipe) {
        val tracker = VelocityTracker()
        var start = Offset.Zero
        var drag = Offset.Zero
        var pending: Swipes.Direction? = null
        detectDragGestures(
            onDragStart = { at ->
                start = coords?.localToRoot(at) ?: at
                drag = Offset.Zero
                pending = null
                tracker.resetTracking()
                swipe.horizontal = null
                scope.launch { swipe.offset.snapTo(Offset.Zero) }
            },
            onDragEnd = {
                val horizontal = swipe.horizontal ?: false
                val to = swipeDirection(drag, tracker.calculateVelocity(), swipe.size, horizontal, fling)?.takeIf { allow(it) }
                swipe.horizontal = null
                scope.launch {
                    if (to == null) {
                        swipe.offset.animateTo(Offset.Zero)
                        return@launch
                    }
                    val w = swipe.size.width.toFloat()
                    val h = swipe.size.height.toFloat()
                    val out = when (to) {
                        Swipes.Direction.UP -> Offset(0f, -h)
                        Swipes.Direction.DOWN -> Offset(0f, h)
                        Swipes.Direction.RIGHT -> Offset(w, 0f)
                        Swipes.Direction.LEFT -> Offset(-w, 0f)
                    }
                    swipe.offset.animateTo(out, tween(150))
                    go(to)
                    // The screen has gone, or another app is opening over it: back in place once out of sight.
                    delay(400)
                    swipe.offset.snapTo(Offset.Zero)
                }
            },
            onDragCancel = {
                swipe.horizontal = null
                scope.launch { swipe.offset.animateTo(Offset.Zero) }
            },
        ) { change, _ ->
            val root = coords?.localToRoot(change.position) ?: change.position
            change.consume()
            drag = root - start
            tracker.addPosition(change.uptimeMillis, root)
            // The drag starts where it passed touch slop, so its first move is nothing: the axis waits for a real one.
            if (swipe.horizontal == null && abs(drag.x) == abs(drag.y)) return@detectDragGestures
            val horizontal = swipe.horizontal ?: (abs(drag.x) > abs(drag.y)).also { swipe.horizontal = it }
            val along = if (horizontal) drag.x else drag.y
            val give = if (allow(way(along, horizontal))) along else along * 0.15f
            val now = swipeDirection(drag, Velocity.Zero, swipe.size, horizontal, fling)?.takeIf { allow(it) }
            if (now != null && now != pending) haptic.performHapticFeedback(HapticFeedbackType.GestureThresholdActivate)
            pending = now
            scope.launch { swipe.offset.snapTo(if (horizontal) Offset(give, 0f) else Offset(0f, give)) }
        }
    }
}

/**
 * Under a sideways swipe, the name of what letting go does, faint until the page passes the threshold. Drawn behind the
 * moving page, so it shows only in the strip the page uncovers. `label` names a direction's action, null for nothing.
 */
@Composable
fun BoxScope.SwipeHints(swipe: Swipe, palette: Look.Palette, label: (Swipes.Direction) -> String?) {
    var labels by remember { mutableStateOf<Pair<String?, String?>>(null to null) }
    // Read afresh at each sideways swipe, since settings may have changed while this screen stayed composed.
    LaunchedEffect(swipe.horizontal) { if (swipe.horizontal == true) labels = label(Swipes.Direction.RIGHT) to label(Swipes.Direction.LEFT) }
    for ((direction, text) in listOf(Swipes.Direction.RIGHT to labels.first, Swipes.Direction.LEFT to labels.second)) {
        if (text == null) continue
        Text(
            text, fontSize = 14.sp, color = palette.pageInk,
            modifier = Modifier.align(if (direction == Swipes.Direction.RIGHT) Alignment.CenterStart else Alignment.CenterEnd)
                .padding(horizontal = 16.dp)
                .graphicsLayer {
                    val x = swipe.offset.value.x
                    val progress = (if (direction == Swipes.Direction.RIGHT) x else -x) / (swipe.size.width * 0.3f).coerceAtLeast(1f)
                    alpha = if (progress >= 1f) 1f else (progress * 0.5f).coerceIn(0f, 0.5f)
                }
                .background(palette.page, RoundedCornerShape(50))
                .padding(horizontal = 12.dp, vertical = 6.dp),
        )
    }
}
