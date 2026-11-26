package net.suderman.june

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.text.InputType
import android.util.TypedValue
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import java.nio.ByteBuffer
import android.content.res.AssetManager
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor

/**
 * A live terminal drawn from libghostty-vt's viewport (see "Embedded terminal" in docs/interfaces.org). Bytes from
 * herdr-core go in through [feed]; keys and text come out through [onInput], encoded by Ghostty for the program's
 * current keyboard modes. The view is also the keyboard's target, through its own input connection. The grid follows
 * the view's size, reported through [onGrid]. The drawing and input handling follow T3 Code's Android terminal (MIT).
 */
/** The terminal grid's dark palette: always dark so TUIs stay readable, tuned to June's look. */
data class TerminalColors(val foreground: Int, val background: Int, val cursor: Int, val selection: Int, val ansi: IntArray) {
    companion object {
        private fun argb(vararg rgb: Int) = rgb.map { it or 0xFF000000.toInt() }.toIntArray()

        fun of(palette: Look.Palette): TerminalColors = when {
            palette.neon -> TerminalColors(
                foreground = 0xFFF4EEFF.toInt(),
                background = 0xFF12101C.toInt(),
                cursor = 0xFFB48CFF.toInt(),
                selection = 0xFF3A2B66.toInt(),
                ansi = argb(
                    0x1C1830, 0xFF5C7A, 0xA8F05A, 0xFFC247, 0x6FA8FF, 0xB48CFF, 0x3FE0F0, 0xF4EEFF,
                    0x584E82, 0xFF7591, 0xB8F573, 0xFFD166, 0x89BDFF, 0xC9A8FF, 0x6BEBF7, 0xFFFFFF,
                ),
            )
            palette.console && palette.dark -> TerminalColors(
                foreground = 0xFFD7DBE3.toInt(),
                background = 0xFF121418.toInt(),
                cursor = 0xFF8FB4FF.toInt(),
                selection = 0xFF2D3B55.toInt(),
                ansi = argb(
                    0x1A1D23, 0xFF8F80, 0x86E08F, 0xFFD36B, 0x8FB4FF, 0xC9A8FF, 0x6FD6C8, 0xD7DBE3,
                    0x5C6577, 0xFFA599, 0x9EE8A6, 0xFFDF8E, 0xA8C6FF, 0xD9C0FF, 0x8CE3D8, 0xFFFFFF,
                ),
            )
            else -> TerminalColors(
                foreground = 0xFFE4E8F2.toInt(),
                background = 0xFF1B1E2B.toInt(),
                cursor = 0xFF89B4FA.toInt(),
                selection = 0xFF3B4F7A.toInt(),
                ansi = argb(
                    0x1F2433, 0xF38BA8, 0xA6E3A1, 0xF9E2AF, 0x89B4FA, 0xCBA6F7, 0x94E2D5, 0xE4E8F2,
                    0x5B6683, 0xF38BA8, 0xA6E3A1, 0xF9E2AF, 0x89B4FA, 0xCBA6F7, 0x94E2D5, 0xFFFFFF,
                ),
            )
        }
    }
}

class TerminalView(context: Context, initialSp: Float = DEFAULT_SP, colors: TerminalColors = TerminalColors.of(Look.palette(console = false, dark = true))) : View(context) {
    /** Bytes for the program; AUTO marks the emulator's own replies rather than typing. */
    var onInput: (ByteArray, Boolean) -> Unit = { _, _ -> }
    /** The grid fits the view: columns and rows, and the cell size in pixels. */
    var onGrid: (Int, Int, Int, Int) -> Unit = { _, _, _, _ -> }
    /** Font size settled after a pinch-to-zoom or reset, in sp. */
    var onFontSize: (Float) -> Unit = {}
    /** Live font size during a pinch gesture, or null once the pinch ends. */
    var onZooming: (Float?) -> Unit = {}

    /** Sticky modifiers from the accessory row, applied to the next key or character. */
    var ctrl = false
    var alt = false
    var onModifiersUsed: () -> Unit = {}
    /** A tap, before the view takes the keyboard: the page lets go of its compose box. */
    var onTap: () -> Unit = {}
    /** A long press: the page offers copying and pasting. */
    var onLongPress: () -> Unit = {}
    /** An image from the keyboard (its clipboard, a screenshot, a sticker): the page sends it to the agent. */
    var onImage: (android.view.inputmethod.InputContentInfo, Int) -> Unit = { _, _ -> }

    // Dark terminal colours tuned to June's look (always dark so shared TUIs stay readable).
    var foreground = colors.foreground
        private set
    var background = colors.background
        private set
    var cursorColor = colors.cursor
        private set
    private var selectionColor = colors.selection
    private var palette = colors.ansi

    /** Apply a new palette; takes effect on background immediately and on native cells at next reset/attach. */
    fun setColors(colors: TerminalColors): Boolean {
        if (colors.background == background && colors.foreground == foreground && colors.cursor == cursorColor) return false
        foreground = colors.foreground
        background = colors.background
        cursorColor = colors.cursor
        selectionColor = colors.selection
        palette = colors.ansi
        setBackgroundColor(background)
        postInvalidateOnAnimation()
        return true
    }

    private val faces = Faces.load(context)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = faces.regular
    }
    private val fill = Paint()

    /** What the keyboard is composing (a swiped or spoken word), drawn at the cursor until it is committed. */
    var composing = ""
        set(value) {
            field = value
            postInvalidateOnAnimation()
        }
    var fontSp = initialSp.coerceIn(MIN_SP, MAX_SP)
        private set
    private var glyphAdvance = 1f
    private var runSpacing = 0f
    private var runChars = CharArray(256)
    var cellWidth = 1
        private set
    var cellHeight = 1
        private set
    private var baseline = 0f
    private var handle = 0L
    private val lock = Any()
    var cols = 0
        private set
    var rows = 0
        private set
    private var offsetX = 0
    /** The text's measure, for showing it elsewhere exactly as drawn here. */
    val textSize get() = paint.textSize
    val face: Typeface get() = faces.regular

    private fun updateMetrics(sp: Float) {
        fontSp = sp.coerceIn(MIN_SP, MAX_SP)
        paint.textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, fontSp, context.resources.displayMetrics)
        glyphAdvance = paint.measureText("M")
        cellWidth = ceil(glyphAdvance).toInt().coerceAtLeast(1)
        runSpacing = (cellWidth - glyphAdvance) / paint.textSize
        cellHeight = ceil(paint.fontMetrics.let { it.descent - it.ascent }).toInt().coerceAtLeast(1)
        baseline = -paint.fontMetrics.ascent
    }

    private fun recalcGrid() {
        val availW = width - paddingLeft - paddingRight
        val availH = height - paddingTop - paddingBottom
        if (availW <= 0 || availH <= 0) return
        val c = maxOf(1, availW / cellWidth)
        val r = maxOf(1, availH / cellHeight)
        // The grid centred: what is left over after whole cells splits evenly between the sides.
        offsetX = ((availW - c * cellWidth) / 2).coerceAtLeast(0)
        if (c == cols && r == rows) return
        cols = c
        rows = r
        synchronized(lock) {
            if (handle == 0L) handle = TerminalBridge.nativeCreate(cols, rows, cellWidth, cellHeight, foreground, background, cursorColor, palette)
            else TerminalBridge.nativeResize(handle, cols, rows, cellWidth, cellHeight)
        }
        onGrid(cols, rows, cellWidth, cellHeight)
    }

    /** Change the terminal's font size and resize the grid immediately. */
    fun setFontSize(sp: Float) {
        updateMetrics(sp)
        recalcGrid()
        onFontSize(fontSp)
        postInvalidateOnAnimation()
    }

    init {
        updateMetrics(initialSp)
        isFocusable = true
        isFocusableInTouchMode = true
        setBackgroundColor(background)
    }

    /** Start over with an empty emulator, as each attach sends a full first paint. */
    fun reset() = synchronized(lock) {
        if (handle != 0L) TerminalBridge.nativeDestroy(handle)
        handle = if (cols > 0) TerminalBridge.nativeCreate(cols, rows, cellWidth, cellHeight, foreground, background, cursorColor, palette) else 0L
        postInvalidateOnAnimation()
    }

    /** Program output, from any thread; returns the emulator's replies. */
    fun feed(data: ByteArray): ByteArray {
        val replies = synchronized(lock) { if (handle == 0L) ByteArray(0) else TerminalBridge.nativeFeed(handle, data, data.size) }
        postInvalidateOnAnimation()
        return replies
    }

    /** The screen and its history as text. */
    fun text(): String = synchronized(lock) { if (handle == 0L) "" else String(TerminalBridge.nativeText(handle), Charsets.UTF_8) }

    /** Paste TEXT as the program expects a paste, never as typed Enters. */
    fun paste(text: String) {
        val bytes = synchronized(lock) {
            if (handle == 0L) return
            TerminalBridge.nativeScroll(handle, 0)
            TerminalBridge.nativePaste(handle, text.toByteArray(Charsets.UTF_8))
        }
        if (bytes.isNotEmpty()) onInput(bytes, false)
    }

    /** A message from the compose box: one paste, then Enter a moment later, so the program has taken the paste first. */
    fun send(message: String) {
        if (message.isEmpty()) return
        paste(message)
        postDelayed({ press(58, 0) }, 60)
    }

    /** A file's PATH on the agent's machine, pasted as dropping a file on a desktop terminal pastes it, then a space. */
    fun pastePath(path: String) {
        val plain = path.all { it.isLetterOrDigit() || it in "/._-+~@" }
        paste(if (plain) path else "'" + path.replace("'", "'\\''") + "'")
        type(" ")
    }

    fun release() = synchronized(lock) {
        if (handle != 0L) TerminalBridge.nativeDestroy(handle)
        handle = 0L
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        recalcGrid()
    }

    override fun onDraw(canvas: Canvas) {
        val bytes = synchronized(lock) { if (handle == 0L) return else TerminalBridge.nativeSnapshot(handle) }
        if (bytes.size < 32) return
        val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        b.int; b.short
        val cs = b.short.toInt() and 0xFFFF
        val rs = b.short.toInt() and 0xFFFF
        val cx = b.short.toInt() and 0xFFFF
        val cy = b.short.toInt() and 0xFFFF
        val cursorShown = b.get().toInt() != 0
        val cursorStyle = b.get().toInt()
        b.get(); b.get()
        b.int
        val defaultBg = b.int
        val cursorArgb = b.int
        // A rectangle, not drawColor: Compose draws this view unclipped, and drawColor would paint the whole window.
        fill.color = defaultBg
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), fill)
        val left = (paddingLeft + offsetX).toFloat()
        val top = paddingTop.toFloat()
        val selectedBg = selectionColor
        if (runChars.size < cs) runChars = CharArray(cs)
        // Style flags that affect glyph rendering: bold, italic, strikethrough, underline.
        val styleMask = 1 or 2 or (1 shl 5) or (1 shl 7)
        for (y in 0 until rs) {
            val py = top + y * cellHeight
            val baseY = py + baseline
            val rowPos = b.position()
            // Pass 1: coalesce contiguous non-default background runs across the row.
            var bgColor = defaultBg
            var bgStart = -1
            var cellsRead = 0
            for (x in 0 until cs) {
                if (b.remaining() < 12) break
                b.int // fg
                val bg = b.int
                val flags = b.short.toInt()
                val len = b.short.toInt() and 0xFFFF
                if (b.remaining() < len) break
                b.position(b.position() + len)
                cellsRead = x + 1
                val cellBg = if (flags and (1 shl 8) != 0) selectedBg else bg
                if (cellBg != defaultBg) {
                    if (bgStart < 0) { bgColor = cellBg; bgStart = x }
                    else if (bgColor != cellBg) {
                        fill.color = bgColor
                        canvas.drawRect(left + bgStart * cellWidth, py, left + x * cellWidth, py + cellHeight, fill)
                        bgColor = cellBg
                        bgStart = x
                    }
                } else if (bgStart >= 0) {
                    fill.color = bgColor
                    canvas.drawRect(left + bgStart * cellWidth, py, left + x * cellWidth, py + cellHeight, fill)
                    bgStart = -1
                }
            }
            if (bgStart >= 0) {
                fill.color = bgColor
                canvas.drawRect(left + bgStart * cellWidth, py, left + cellsRead * cellWidth, py + cellHeight, fill)
            }
            // Pass 2: coalesce contiguous ASCII runs of matching style; draw non-ASCII graphemes at exact cells.
            val rowEnd = b.position()
            b.position(rowPos)
            var runLen = 0
            var runStart = 0
            var runFg = 0
            var runStyle = -1
            fun flushRun() {
                if (runLen == 0) return
                paint.color = runFg
                paint.typeface = faces.of(runStyle and 1 != 0)
                // Italic slants the upright face: the APK carries only regular and bold (2.4 MB each with Nerd Font icons).
                paint.textSkewX = if (runStyle and 2 != 0) -0.2f else 0f
                paint.isUnderlineText = runStyle and (1 shl 7) != 0
                paint.isStrikeThruText = runStyle and (1 shl 5) != 0
                paint.letterSpacing = runSpacing
                canvas.drawText(runChars, 0, runLen, left + runStart * cellWidth, baseY, paint)
                paint.letterSpacing = 0f
                runLen = 0
            }
            for (x in 0 until cellsRead) {
                val fg = b.int
                b.int // bg
                val flags = b.short.toInt()
                val len = b.short.toInt() and 0xFFFF
                val pos = b.position()
                b.position(pos + len)
                if (len == 0 || flags and (1 shl 4) != 0) {
                    flushRun()
                    continue
                }
                val ch = if (len == 1) bytes[pos].toInt() and 0xFF else -1
                val style = flags and styleMask
                if (ch == 0x20 && (style and ((1 shl 5) or (1 shl 7))) == 0) {
                    if (runLen > 0) runChars[runLen++] = ' '
                    continue
                }
                if (ch in 0x21..0x7E) {
                    if (runLen > 0 && (fg != runFg || style != runStyle || runStart + runLen != x)) flushRun()
                    if (runLen == 0) { runStart = x; runFg = fg; runStyle = style }
                    runChars[runLen++] = ch.toChar()
                } else {
                    flushRun()
                    if (ch == 0x20) continue
                    val text = String(bytes, pos, len, Charsets.UTF_8)
                    paint.color = fg
                    paint.typeface = faces.of(style and 1 != 0)
                    paint.textSkewX = if (style and 2 != 0) -0.2f else 0f
                    paint.isUnderlineText = style and (1 shl 7) != 0
                    paint.isStrikeThruText = style and (1 shl 5) != 0
                    paint.letterSpacing = 0f
                    canvas.drawText(text, left + x * cellWidth, baseY, paint)
                }
            }
            flushRun()
            b.position(rowEnd)
            if (cellsRead < cs) return
        }
        if (composing.isNotEmpty() && cx < cs && cy < rs) {
            // The word the keyboard is still composing, over the cursor, underlined as keyboards mark it.
            val px = left + cx * cellWidth
            val py = top + cy * cellHeight
            paint.typeface = faces.regular
            paint.textSkewX = 0f
            paint.isUnderlineText = true
            paint.isStrikeThruText = false
            val w = paint.measureText(composing)
            fill.color = defaultBg
            canvas.drawRect(px, py, px + w, py + cellHeight, fill)
            paint.color = cursorArgb
            canvas.drawText(composing, px, py + baseline, paint)
            paint.isUnderlineText = false
            return
        }
        if (cursorShown && cx < cs && cy < rs) {
            val px = left + cx * cellWidth
            val py = top + cy * cellHeight
            fill.color = cursorArgb
            when (cursorStyle) {
                0 -> canvas.drawRect(px, py, px + 2.5f * resources.displayMetrics.density, py + cellHeight, fill)
                2 -> canvas.drawRect(px, py + cellHeight - 2 * resources.displayMetrics.density, px + cellWidth, py + cellHeight, fill)
                else -> {
                    fill.alpha = 140
                    canvas.drawRect(px, py, px + cellWidth, py + cellHeight, fill)
                    fill.alpha = 255
                }
            }
        }
    }

    // Touch: a tap shows the keyboard; a vertical drag scrolls the history, a fling keeps it going, and a two-finger
    // pinch scales font size smoothly and resizes the grid once the pinch ends.
    private var downY = 0f
    private var lastY = 0f
    private var lastX = 0f
    private var dragging = false
    private var scaling = false
    private var scrollRemainder = 0f
    private var pressed = false
    private val longPress = Runnable { pressed = true; parent?.requestDisallowInterceptTouchEvent(true); performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS); onLongPress() }
    private val flinger = android.widget.OverScroller(context)
    private var flingY = 0
    private var velocity: android.view.VelocityTracker? = null
    private val scaleDetector = android.view.ScaleGestureDetector(context, object : android.view.ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScaleBegin(detector: android.view.ScaleGestureDetector): Boolean {
            scaling = true
            dragging = false
            removeCallbacks(longPress)
            flinger.forceFinished(true)
            parent?.requestDisallowInterceptTouchEvent(true)
            onZooming(fontSp)
            return true
        }

        override fun onScale(detector: android.view.ScaleGestureDetector): Boolean {
            val next = (fontSp * detector.scaleFactor).coerceIn(MIN_SP, MAX_SP)
            if (abs(next - fontSp) >= 0.05f) {
                updateMetrics(next)
                onZooming(fontSp)
                invalidate()
            }
            return true
        }

        override fun onScaleEnd(detector: android.view.ScaleGestureDetector) {
            recalcGrid()
            onFontSize(fontSp)
            onZooming(null)
            invalidate()
        }
    })

    /** Scroll by DY pixels of finger travel at X, Y: whole rows go to the program or the history, the rest waits. */
    private fun scrollBy(dy: Float, x: Float, y: Float) {
        scrollRemainder += dy / cellHeight
        val rowsMoved = floor(abs(scrollRemainder)).toInt() * if (scrollRemainder < 0) -1 else 1
        if (rowsMoved == 0) return
        scrollRemainder -= rowsMoved
        // A finger moving down shows older lines, as a wheel turned up does.
        val col = ((x - paddingLeft - offsetX) / cellWidth).toInt().coerceIn(0, maxOf(cols - 1, 0))
        val row = ((y - paddingTop) / cellHeight).toInt().coerceIn(0, maxOf(rows - 1, 0))
        val bytes = synchronized(lock) { if (handle == 0L) ByteArray(0) else TerminalBridge.nativeWheel(handle, -rowsMoved, col, row) }
        if (bytes.isNotEmpty()) onInput(bytes, false)
        postInvalidateOnAnimation()
    }

    override fun computeScroll() {
        if (!flinger.computeScrollOffset()) return
        val y = flinger.currY
        scrollBy((y - flingY).toFloat(), lastX, lastY)
        flingY = y
        postInvalidateOnAnimation()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        scaleDetector.onTouchEvent(event)
        if (event.pointerCount > 1 || scaleDetector.isInProgress) {
            scaling = true
            dragging = false
            removeCallbacks(longPress)
            flinger.forceFinished(true)
            parent?.requestDisallowInterceptTouchEvent(true)
            return true
        }
        if (scaling) {
            if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
                scaling = false
                velocity?.recycle(); velocity = null
            }
            return true
        }
        val tracker = velocity ?: android.view.VelocityTracker.obtain().also { velocity = it }
        tracker.addMovement(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                flinger.forceFinished(true)
                downY = event.y; lastY = event.y; lastX = event.x; dragging = false; scrollRemainder = 0f; pressed = false
                postDelayed(longPress, android.view.ViewConfiguration.getLongPressTimeout().toLong())
            }
            MotionEvent.ACTION_MOVE -> {
                if (!dragging && abs(event.y - downY) > cellHeight / 2) {
                    dragging = true
                    removeCallbacks(longPress)
                    // A vertical drag is the terminal's; until then a sideways one may still turn June's pages.
                    parent?.requestDisallowInterceptTouchEvent(true)
                }
                if (dragging) {
                    scrollBy(event.y - lastY, event.x, event.y)
                    lastY = event.y
                    lastX = event.x
                }
            }
            MotionEvent.ACTION_UP -> {
                removeCallbacks(longPress)
                if (dragging) {
                    val config = android.view.ViewConfiguration.get(context)
                    tracker.computeCurrentVelocity(1000, config.scaledMaximumFlingVelocity.toFloat())
                    val vy = tracker.yVelocity.toInt()
                    if (abs(vy) > config.scaledMinimumFlingVelocity) {
                        flingY = 0
                        flinger.fling(0, 0, 0, vy, 0, 0, Int.MIN_VALUE / 2, Int.MAX_VALUE / 2)
                        postInvalidateOnAnimation()
                    }
                } else if (!pressed) { onTap(); showKeyboard() }
                tracker.recycle(); velocity = null
            }
            MotionEvent.ACTION_CANCEL -> { removeCallbacks(longPress); tracker.recycle(); velocity = null }
        }
        return true
    }

    // The keyboard rising would otherwise have Android pan the whole window to keep this view in sight, pushing the
    // page's top line off the screen. The page makes room for the keyboard itself, so nothing here needs revealing.
    override fun getFocusedRect(r: android.graphics.Rect) = r.set(0, 0, 0, 0)

    fun hideKeyboard() {
        context.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(windowToken, 0)
    }

    fun showKeyboard() {
        requestFocus()
        context.getSystemService(InputMethodManager::class.java).showSoftInput(this, 0)
    }

    // Keys: Android key codes to Ghostty's (W3C order, include/ghostty/vt/key/event.h).
    private fun ghosttyKey(code: Int): Int = when (code) {
        in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> 20 + (code - KeyEvent.KEYCODE_A)
        in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> 6 + (code - KeyEvent.KEYCODE_0)
        KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> 58
        KeyEvent.KEYCODE_ESCAPE -> 120
        KeyEvent.KEYCODE_TAB -> 64
        KeyEvent.KEYCODE_DEL -> 53
        KeyEvent.KEYCODE_FORWARD_DEL -> 68
        KeyEvent.KEYCODE_SPACE -> 63
        KeyEvent.KEYCODE_DPAD_UP -> 78
        KeyEvent.KEYCODE_DPAD_DOWN -> 75
        KeyEvent.KEYCODE_DPAD_LEFT -> 76
        KeyEvent.KEYCODE_DPAD_RIGHT -> 77
        KeyEvent.KEYCODE_MOVE_HOME -> 71
        KeyEvent.KEYCODE_MOVE_END -> 69
        KeyEvent.KEYCODE_PAGE_UP -> 74
        KeyEvent.KEYCODE_PAGE_DOWN -> 73
        KeyEvent.KEYCODE_INSERT -> 72
        in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12 -> 121 + (code - KeyEvent.KEYCODE_F1)
        else -> 0
    }

    private fun unshifted(code: Int): Int = when (code) {
        in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> 'a'.code + (code - KeyEvent.KEYCODE_A)
        in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> '0'.code + (code - KeyEvent.KEYCODE_0)
        KeyEvent.KEYCODE_SPACE -> ' '.code
        else -> 0
    }

    /** Press KEY (a Ghostty key) with MODS (Ghostty mods: shift 1, ctrl 2, alt 4, super 8), typing TEXT. */
    fun press(key: Int, mods: Int, text: String? = null, unshifted: Int = 0) {
        val all = mods or (if (ctrl) 2 else 0) or (if (alt) 4 else 0)
        val bytes = synchronized(lock) {
            if (handle == 0L) return
            TerminalBridge.nativeScroll(handle, 0)
            TerminalBridge.nativeKey(handle, key, all, text, unshifted)
        }
        if (ctrl || alt) { ctrl = false; alt = false; onModifiersUsed() }
        if (bytes.isNotEmpty()) onInput(bytes, false)
    }

    /** Text from the keyboard, character by character so sticky modifiers and newlines encode as keys. */
    fun type(text: CharSequence) {
        if (text.isEmpty()) return
        // Several lines at once (the keyboard's clipboard, a dictated paragraph) are a paste, not Enter after each line.
        if (text.length > 1 && '\n' in text) return paste(text.toString())
        if (!ctrl && !alt && '\n' !in text) {
            synchronized(lock) { if (handle != 0L) TerminalBridge.nativeScroll(handle, 0) }
            onInput(text.toString().toByteArray(Charsets.UTF_8), false)
            return
        }
        var i = 0
        while (i < text.length) {
            val cp = Character.codePointAt(text, i)
            i += Character.charCount(cp)
            when {
                cp == '\n'.code -> press(58, 0)
                cp in 'a'.code..'z'.code -> press(20 + cp - 'a'.code, 0, String(Character.toChars(cp)), cp)
                cp in 'A'.code..'Z'.code -> press(20 + cp - 'A'.code, 1, String(Character.toChars(cp)), cp + 32)
                else -> if (ctrl || alt) press(0, 0, String(Character.toChars(cp)), cp) else onInput(String(Character.toChars(cp)).toByteArray(), false)
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) return super.onKeyDown(keyCode, event)
        val key = ghosttyKey(keyCode)
        var mods = 0
        if (event.isShiftPressed) mods = mods or 1
        if (event.isCtrlPressed) mods = mods or 2
        if (event.isAltPressed) mods = mods or 4
        if (event.isMetaPressed) mods = mods or 8
        val ch = event.getUnicodeChar(event.metaState and (KeyEvent.META_CTRL_MASK or KeyEvent.META_ALT_MASK).inv())
        val text = if (ch > 0 && mods and 6 == 0 && !ctrl && !alt) String(Character.toChars(ch)) else null
        if (key == 0) {
            if (ch <= 0) return super.onKeyDown(keyCode, event)
            if (text != null) type(text) else press(0, mods, String(Character.toChars(ch)), ch)
            return true
        }
        press(key, mods, if (keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_TAB || keyCode == KeyEvent.KEYCODE_DEL) null else text, unshifted(keyCode))
        return true
    }

    override fun onCheckIsTextEditor() = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        // Plain text without suggestions, so keyboards neither suggest nor correct. Not the visible-password type Termux
        // and T3 use: HeliBoard (GestureEnabler) turns swipe typing off for any password field.
        outAttrs.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING or EditorInfo.IME_ACTION_NONE
        // Keyboards may offer images here (their clipboard, screenshots), which go to the agent as files.
        outAttrs.contentMimeTypes = arrayOf("image/*")
        return object : BaseInputConnection(this, true) {
            override fun commitContent(inputContentInfo: android.view.inputmethod.InputContentInfo, flags: Int, opts: android.os.Bundle?): Boolean {
                onImage(inputContentInfo, flags)
                return true
            }

            // Composing text (a swiped or voiced word) waits in the editable until the keyboard commits it.
            override fun setComposingText(text: CharSequence, newCursorPosition: Int): Boolean {
                super.setComposingText(text, newCursorPosition)
                composing = editable?.toString() ?: ""
                return true
            }

            override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
                super.commitText(text, newCursorPosition)
                flush()
                return true
            }

            override fun finishComposingText(): Boolean {
                super.finishComposingText()
                flush()
                return true
            }

            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                val e = editable
                if (e != null && e.isNotEmpty()) return super.deleteSurroundingText(beforeLength, afterLength)
                repeat(beforeLength.coerceAtMost(64)) { press(53, 0) }
                return true
            }

            override fun performEditorAction(actionCode: Int): Boolean {
                press(58, 0)
                return true
            }

            override fun sendKeyEvent(event: KeyEvent): Boolean {
                if (event.action == KeyEvent.ACTION_DOWN) onKeyDown(event.keyCode, event)
                return true
            }

            private fun flush() {
                val e = editable ?: return
                if (e.isEmpty()) return
                val s = e.toString()
                e.clear()
                composing = ""
                type(s)
            }
        }
    }

    companion object {
        const val DEFAULT_SP = 12.5f
        const val MIN_SP = 8.5f
        const val MAX_SP = 22f
    }
}

/** The terminal's faces: CommitMono Nerd Font Mono from the APK's assets (android/default.nix), else the system's monospace. */
private class Faces(val regular: Typeface, val bold: Typeface) {
    fun of(bold: Boolean) = if (bold) this.bold else regular

    companion object {
        private var loaded: Faces? = null

        fun load(context: Context): Faces = loaded ?: run {
            val assets: AssetManager = context.assets
            fun face(name: String, style: Int) =
                runCatching { Typeface.createFromAsset(assets, "terminal/$name.otf") }.getOrElse { Typeface.create(Typeface.MONOSPACE, style) }
            Faces(face("Regular", Typeface.NORMAL), face("Bold", Typeface.BOLD)).also { loaded = it }
        }
    }
}
