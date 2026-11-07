package net.suderman.june

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.io.ByteArrayOutputStream

/** A picture or file waiting to go with the next message: pictures as base64 JPEG, files as they are. */
class Attachment(val name: String, val mimeType: String, val data: String, val thumb: Bitmap?) {
    val picture get() = thumb != null
}

/**
 * The next message as it is being written: the words and what goes with them. Kept in the app's process rather than one
 * screen, so it survives the assistant sheet hiding while a picker or the camera shows, and the full screen shares it.
 * Limits are the daemon's (src/images.ts, src/inbox.ts), checked here so an attachment it would refuse never leaves.
 */
object Outbox {
    const val MAX_PICTURES = 10
    const val MAX_FILES = 10
    const val MAX_FILE_BYTES = 20L * 1024 * 1024
    const val MAX_BASE64 = 30L * 1024 * 1024
    /** Pictures go at most this long on their long side, as the screen offer does; the daemon fits them to the model. */
    private const val LONG_SIDE = 1568

    var draft by mutableStateOf("")
    var items by mutableStateOf(emptyList<Attachment>())
        private set
    /** Why something was not attached, until the next change. */
    var notice by mutableStateOf("")

    val pictures get() = items.filter { it.picture }
    val files get() = items.filterNot { it.picture }

    fun add(item: Attachment) {
        items = items + item
    }

    fun remove(item: Attachment) {
        items = items - item
        notice = ""
    }

    fun clear() {
        draft = ""
        items = emptyList()
        notice = ""
    }

    /**
     * Read what a picker or the camera chose: pictures (any image Android can decode) as JPEG, everything else as a
     * file. Slow for big files, so call it off the main thread; returns the attachments and why any were refused.
     */
    fun read(context: Context, uris: List<Uri>, alreadyPictures: Int, alreadyFiles: Int, alreadyBase64: Long): Pair<List<Attachment>, List<String>> {
        val added = mutableListOf<Attachment>()
        val refused = mutableListOf<String>()
        var pictures = alreadyPictures
        var files = alreadyFiles
        var base64 = alreadyBase64
        for (uri in uris) {
            val (name, size) = describe(context, uri)
            val type = context.contentResolver.getType(uri) ?: "application/octet-stream"
            val isPicture = type.startsWith("image/")
            val why = when {
                isPicture && pictures >= MAX_PICTURES -> "at most $MAX_PICTURES pictures a message"
                !isPicture && files >= MAX_FILES -> "at most $MAX_FILES files a message"
                !isPicture && size != null && size > MAX_FILE_BYTES -> "over 20 MiB"
                else -> null
            }
            if (why != null) {
                refused.add("$name: $why")
                continue
            }
            val item = runCatching {
                if (isPicture) picture(context, uri, name)
                else context.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                    .takeIf { it.size <= MAX_FILE_BYTES }
                    ?.let { Attachment(name, type, Base64.encodeToString(it, Base64.NO_WRAP), null) }
            }.getOrNull()
            when {
                item == null -> refused.add(if (isPicture) "$name: could not be read" else "$name: over 20 MiB or unreadable")
                base64 + item.data.length > MAX_BASE64 -> refused.add("$name: one message carries at most 30 MiB of attachments")
                else -> {
                    base64 += item.data.length
                    if (isPicture) pictures++ else files++
                    added.add(item)
                }
            }
        }
        return added to refused
    }

    /** The base64 the attachments already waiting carry. */
    fun base64(): Long = items.sumOf { it.data.length.toLong() }

    /** A picture as JPEG at most LONG_SIDE on its long side, with a small thumbnail for the strip above the input. */
    fun picture(context: Context, uri: Uri, name: String): Attachment {
        val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) { decoder, info, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            val scale = minOf(1f, LONG_SIDE.toFloat() / maxOf(info.size.width, info.size.height))
            if (scale < 1f) decoder.setTargetSize((info.size.width * scale).toInt(), (info.size.height * scale).toInt())
        }
        return picture(bitmap, name)
    }

    fun picture(bitmap: Bitmap, name: String): Attachment {
        val soft = if (bitmap.config == Bitmap.Config.HARDWARE) bitmap.copy(Bitmap.Config.ARGB_8888, false) else bitmap
        val scale = minOf(1f, LONG_SIDE.toFloat() / maxOf(soft.width, soft.height))
        val sized = if (scale < 1f) Bitmap.createScaledBitmap(soft, (soft.width * scale).toInt(), (soft.height * scale).toInt(), true) else soft
        val out = ByteArrayOutputStream()
        sized.compress(Bitmap.CompressFormat.JPEG, 82, out)
        val t = 120f / maxOf(sized.width, sized.height)
        val thumb = Bitmap.createScaledBitmap(sized, maxOf(1, (sized.width * t).toInt()), maxOf(1, (sized.height * t).toInt()), true)
        return Attachment(name, "image/jpeg", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP), thumb)
    }

    private fun describe(context: Context, uri: Uri): Pair<String, Long?> {
        var name = uri.lastPathSegment ?: "file"
        var size: Long? = null
        runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getString(0)?.let { name = it }
                    if (!c.isNull(1)) size = c.getLong(1)
                }
            }
        }
        return name to size
    }
}
