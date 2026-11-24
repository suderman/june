package net.suderman.june

/**
 * libghostty-vt through June's JNI library (android/native/june_terminal_jni.cpp): one emulator per terminal on show.
 * The library is loaded only when a terminal opens, so the rest of June never depends on it.
 */
internal object TerminalBridge {
    init {
        System.loadLibrary("juneterm")
    }

    /** A new emulator with the given colours; PALETTE sets the first of the 256 colours (the desktop terminal's 16). */
    @JvmStatic external fun nativeCreate(cols: Int, rows: Int, cellWidth: Int, cellHeight: Int, fg: Int, bg: Int, cursor: Int, palette: IntArray): Long
    @JvmStatic external fun nativeDestroy(handle: Long)
    /** Feed program output; returns the emulator's own replies for the program. */
    @JvmStatic external fun nativeFeed(handle: Long, data: ByteArray, length: Int): ByteArray
    @JvmStatic external fun nativeResize(handle: Long, cols: Int, rows: Int, cellWidth: Int, cellHeight: Int)
    /** Scroll the viewport by DELTA rows (negative is back into history); 0 returns to the bottom. */
    @JvmStatic external fun nativeScroll(handle: Long, delta: Int)
    /** A drag of ROWS rows at cell (COL, ROW) as a scroll wheel: bytes for the program, or empty when the local history moved. */
    @JvmStatic external fun nativeWheel(handle: Long, rows: Int, col: Int, row: Int): ByteArray
    /** Encode a key for the program's current modes: KEY a GhosttyKey, MODS GhosttyMods, TEXT what it types. */
    @JvmStatic external fun nativeKey(handle: Long, key: Int, mods: Int, text: String?, unshifted: Int): ByteArray
    @JvmStatic external fun nativeSnapshot(handle: Long): ByteArray
}
