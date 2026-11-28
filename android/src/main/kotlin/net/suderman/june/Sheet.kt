package net.suderman.june

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/** How far a sheet is pulled down before letting go puts it away, and how fast a fling down does. */
private val DismissDistance = 120.dp
private const val DismissVelocity = 1800f

/**
 * A page of detail (a task, a clanker's card, a host) risen over its board as a layer, as on the desktop's Sheet.qml.
 * It goes away by its close button, Back, a tap on the board showing above it, or a pull down: on its handle, or on its
 * content once that is scrolled to the top. CONTENT is the page, scrolling itself; it stays drawn while the sheet
 * slides away, so callers keep what it shows until then.
 */
@Composable
internal fun DetailSheet(open: Boolean, onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val p = LocalPalette.current
    androidx.activity.compose.BackHandler(enabled = open, onBack = onDismiss)
    val scrim by animateFloatAsState(if (open) 0.28f else 0f, label = "scrim")
    Box(Modifier.fillMaxSize()) {
        if (scrim > 0.01f) Box(
            Modifier.fillMaxSize().background(p.pageInk.copy(alpha = scrim))
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, enabled = open) { onDismiss() },
        )
        AnimatedVisibility(
            open,
            enter = slideInVertically(initialOffsetY = { it }) + fadeIn(),
            exit = slideOutVertically(targetOffsetY = { it }) + fadeOut(),
        ) {
            val scope = rememberCoroutineScope()
            val limit = with(LocalDensity.current) { DismissDistance.toPx() }
            var pulled by remember { mutableFloatStateOf(0f) }
            // Let go: far or fast enough puts the sheet away, else it springs back.
            val release: (Float) -> Unit = { velocity ->
                if (pulled > limit || (pulled > 0f && velocity > DismissVelocity)) onDismiss()
                else scope.launch { animate(pulled, 0f) { v, _ -> pulled = v } }
            }
            // The content's own scrolling comes first; a pull down past its top moves the sheet instead.
            val pull = remember {
                object : NestedScrollConnection {
                    override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                        if (pulled <= 0f || available.y >= 0f) return Offset.Zero
                        val used = maxOf(available.y, -pulled)
                        pulled += used
                        return Offset(0f, used)
                    }

                    override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                        if (available.y <= 0f || source != NestedScrollSource.UserInput) return Offset.Zero
                        pulled += available.y
                        return Offset(0f, available.y)
                    }

                    override suspend fun onPreFling(available: Velocity): Velocity {
                        if (pulled <= 0f) return Velocity.Zero
                        release(available.y)
                        return available
                    }
                }
            }
            val shape = if (p.console) RectangleShape else RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp)
            val edge = 1.5.dp
            Column(
                Modifier.fillMaxSize().padding(top = 10.dp).offset { IntOffset(0, pulled.roundToInt()) }
                    // Wider than the page by its border, so only the top edge and its corners show a line.
                    .layout { measurable, constraints ->
                        val px = edge.roundToPx()
                        val w = constraints.maxWidth + 2 * px
                        val placeable = measurable.measure(constraints.copy(minWidth = w, maxWidth = w))
                        layout(constraints.maxWidth, placeable.height) { placeable.place(-px, 0) }
                    }
                    .nestedScroll(pull)
                    .background(p.page, shape).border(edge, p.pageInk, shape)
                    // Taps on the sheet stay on it, not the board behind.
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
            ) {
                // The handle, and close: pulling the handle moves the sheet whatever its content's scroll.
                Box(
                    Modifier.fillMaxWidth().height(44.dp).draggable(
                        rememberDraggableState { delta -> pulled = maxOf(0f, pulled + delta) },
                        Orientation.Vertical,
                        onDragStopped = { velocity -> release(velocity) },
                    ),
                ) {
                    if (!p.console) Box(Modifier.align(Alignment.Center).size(width = 40.dp, height = 4.dp).background(p.muted.copy(alpha = 0.6f), RoundedCornerShape(2.dp)))
                    PressTab("close", onDismiss, Modifier.align(Alignment.CenterEnd).padding(end = BoardMargin - 4.dp), kind = Press.Quiet, small = true)
                }
                Box(Modifier.weight(1f).fillMaxWidth().padding(horizontal = BoardMargin)) { content() }
            }
        }
    }
}

/**
 * A board's sections as a sub-navbar in the compose bar's place, so a page without one keeps the same height and its
 * navigation stays at the bottom: each section's name, the showing one filled. POSITION is the pager's place among the
 * sections (1.5 is halfway from the second to the third), so the fill follows a swipe. BADGES counts by section, as
 * the tab bar counts what needs the user. A tap on a section goes there; on the one showing, it resets it.
 */
@Composable
fun SectionBar(
    labels: List<String>,
    position: Float,
    palette: Look.Palette,
    badges: Map<Int, Int> = emptyMap(),
    modifier: Modifier = Modifier,
    framed: Boolean = true,
    onPick: (Int) -> Unit,
) {
    val p = palette
    val shape = if (p.console) RectangleShape else RoundedCornerShape(23.dp)
    val barModifier = if (framed) {
        modifier.fillMaxWidth().padding(top = 10.dp, bottom = 4.dp).height(46.dp)
            .background(p.field, shape).border(1.dp, p.rule, shape).padding(4.dp)
    } else {
        modifier.fillMaxWidth().height(46.dp).padding(4.dp)
    }
    androidx.compose.foundation.layout.BoxWithConstraints(barModifier) {
        val cell = maxWidth / labels.size
        // The fill, sliding with the pager.
        Box(
            Modifier.offset { IntOffset((cell * position.coerceIn(0f, (labels.size - 1).toFloat())).roundToPx(), 0) }
                .size(width = cell, height = maxHeight)
                .background(p.pageInk, if (p.console) RectangleShape else RoundedCornerShape(19.dp)),
        )
        androidx.compose.foundation.layout.Row(Modifier.fillMaxSize()) {
            labels.forEachIndexed { i, label ->
                // Ink turns to paper as the fill passes under the name.
                val under = (1f - kotlin.math.abs(position - i)).coerceIn(0f, 1f)
                val ink = androidx.compose.ui.graphics.lerp(p.pageInk, p.page, under)
                Box(
                    Modifier.weight(1f).fillMaxSize()
                        .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { onPick(i) }
                        .sectionTab(label, under > 0.5f),
                    contentAlignment = Alignment.Center,
                ) {
                    androidx.compose.foundation.layout.Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(4.dp)) {
                        androidx.compose.material3.Text(if (p.console && under > 0.5f) "[$label]" else label, style = p.type.button.copy(color = ink), maxLines = 1)
                        // What needs the user, after the name, as the tab bar counts it.
                        val n = badges[i] ?: 0
                        if (n > 0) androidx.compose.material3.Text(
                            "$n", fontSize = androidx.compose.ui.unit.TextUnit(10f, androidx.compose.ui.unit.TextUnitType.Sp),
                            fontWeight = androidx.compose.ui.text.font.FontWeight.Bold, color = p.page,
                            modifier = Modifier.background(p.accent, androidx.compose.foundation.shape.CircleShape).padding(horizontal = 5.dp),
                        )
                    }
                }
            }
        }
    }
}

/** A section's name as a tab for accessibility, selected when it shows. */
private fun Modifier.sectionTab(label: String, on: Boolean) =
    this.then(Modifier.semantics { contentDescription = label; role = Role.Tab; selected = on })
