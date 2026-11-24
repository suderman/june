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
class TerminalView(context: Context) : View(context) {
    /** Bytes for the program; AUTO marks the emulator's own replies rather than typing. */
    var onInput: (ByteArray, Boolean) -> Unit = { _, _ -> }
    /** The grid fits the view: columns and rows, and the cell size in pixels. */
    var onGrid: (Int, Int, Int, Int) -> Unit = { _, _, _, _ -> }

    /** Sticky modifiers from the accessory row, applied to the next key or character. */
    var ctrl = false
    var alt = false
    var onModifiersUsed: () -> Unit = {}

    // The desktop terminal's colours (kitty's theme on kit), so agents look as they do there.
    val foreground = Color.parseColor("#CDD6F4")
    val background = Color.parseColor("#1E1E2E")
    val cursorColor = Color.parseColor("#CDD6F4")
    private val palette = intArrayOf(
        0x1E1E2E, 0xF38BA8, 0xA6E3A1, 0xF9E2AF, 0x89B4FA, 0xCBA6F7, 0x94E2D5, 0xCDD6F4,
        0x45475A, 0xF38BA8, 0xA6E3A1, 0xF9E2AF, 0x89B4FA, 0xCBA6F7, 0x94E2D5, 0xB4BEFE,
    ).map { it or 0xFF000000.toInt() }.toIntArray()

    private val faces = Faces.load(context)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = faces.regular
        textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 12.5f, context.resources.displayMetrics)
    }
    private val fill = Paint()

    /** What the keyboard is composing (a swiped or spoken word), drawn at the cursor until it is committed. */
    var composing = ""
        set(value) {
            field = value
            postInvalidateOnAnimation()
        }
    var cellWidth = ceil(paint.measureText("M")).toInt()
        private set
    var cellHeight = ceil(paint.fontMetrics.let { it.descent - it.ascent }).toInt()
        private set
    private val baseline = -paint.fontMetrics.ascent
    private var handle = 0L
    private val lock = Any()
    var cols = 0
        private set
    var rows = 0
        private set

    init {
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

    fun release() = synchronized(lock) {
        if (handle != 0L) TerminalBridge.nativeDestroy(handle)
        handle = 0L
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        val c = maxOf(1, (w - paddingLeft - paddingRight) / cellWidth)
        val r = maxOf(1, (h - paddingTop - paddingBottom) / cellHeight)
        if (c == cols && r == rows) return
        cols = c
        rows = r
        synchronized(lock) {
            if (handle == 0L) handle = TerminalBridge.nativeCreate(cols, rows, cellWidth, cellHeight, foreground, background, cursorColor, palette)
            else TerminalBridge.nativeResize(handle, cols, rows, cellWidth, cellHeight)
        }
        onGrid(cols, rows, cellWidth, cellHeight)
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
        canvas.drawColor(defaultBg)
        val left = paddingLeft.toFloat()
        val top = paddingTop.toFloat()
        for (y in 0 until rs) {
            for (x in 0 until cs) {
                if (b.remaining() < 12) return
                val fg = b.int
                val bg = b.int
                val flags = b.short.toInt()
                val len = b.short.toInt() and 0xFFFF
                val px = left + x * cellWidth
                val py = top + y * cellHeight
                val selected = flags and (1 shl 8) != 0
                if (bg != defaultBg || selected) {
                    fill.color = if (selected) Color.parseColor("#3B4F7A") else bg
                    canvas.drawRect(px, py, px + cellWidth, py + cellHeight, fill)
                }
                if (len > 0) {
                    val text = String(bytes, b.position(), len, Charsets.UTF_8)
                    b.position(b.position() + len)
                    if (flags and (1 shl 4) != 0 || text == " ") continue
                    paint.color = fg
                    paint.typeface = faces.of(flags and 1 != 0, flags and 2 != 0)
                    paint.isUnderlineText = flags and (1 shl 7) != 0
                    paint.isStrikeThruText = flags and (1 shl 5) != 0
                    canvas.drawText(text, px, py + baseline, paint)
                }
            }
        }
        if (composing.isNotEmpty() && cx < cs && cy < rs) {
            // The word the keyboard is still composing, over the cursor, underlined as keyboards mark it.
            val px = left + cx * cellWidth
            val py = top + cy * cellHeight
            paint.typeface = faces.regular
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

    // Touch: a tap shows the keyboard; a vertical drag scrolls the history.
    private var downY = 0f
    private var lastY = 0f
    private var dragging = false
    private var scrollRemainder = 0f

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> { downY = event.y; lastY = event.y; dragging = false; scrollRemainder = 0f }
            MotionEvent.ACTION_MOVE -> {
                if (!dragging && abs(event.y - downY) > cellHeight / 2) dragging = true
                if (dragging) {
                    scrollRemainder += (event.y - lastY) / cellHeight
                    val rowsMoved = floor(abs(scrollRemainder)).toInt() * if (scrollRemainder < 0) -1 else 1
                    if (rowsMoved != 0) {
                        scrollRemainder -= rowsMoved
                        // A finger moving down shows older lines, as a wheel turned up does.
                        val col = ((event.x - paddingLeft) / cellWidth).toInt().coerceIn(0, maxOf(cols - 1, 0))
                        val row = ((event.y - paddingTop) / cellHeight).toInt().coerceIn(0, maxOf(rows - 1, 0))
                        val bytes = synchronized(lock) { if (handle == 0L) ByteArray(0) else TerminalBridge.nativeWheel(handle, -rowsMoved, col, row) }
                        if (bytes.isNotEmpty()) onInput(bytes, false)
                        postInvalidateOnAnimation()
                    }
                    lastY = event.y
                }
            }
            MotionEvent.ACTION_UP -> if (!dragging) showKeyboard()
        }
        return true
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
        return object : BaseInputConnection(this, true) {
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
}

/** The terminal's faces: CommitMono Nerd Font Mono from the APK's assets (android/default.nix), else the system's monospace. */
private class Faces(val regular: Typeface, val bold: Typeface, val italic: Typeface, val boldItalic: Typeface) {
    fun of(bold: Boolean, italic: Boolean) = when {
        bold && italic -> boldItalic
        bold -> this.bold
        italic -> this.italic
        else -> regular
    }

    companion object {
        private var loaded: Faces? = null

        fun load(context: Context): Faces = loaded ?: run {
            val assets: AssetManager = context.assets
            fun face(name: String, style: Int) =
                runCatching { Typeface.createFromAsset(assets, "terminal/$name.otf") }.getOrElse { Typeface.create(Typeface.MONOSPACE, style) }
            Faces(face("Regular", Typeface.NORMAL), face("Bold", Typeface.BOLD), face("Italic", Typeface.ITALIC), face("BoldItalic", Typeface.BOLD_ITALIC)).also { loaded = it }
        }
    }
}
