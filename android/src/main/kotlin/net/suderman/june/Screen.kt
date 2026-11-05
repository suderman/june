package net.suderman.june

import android.graphics.Bitmap
import android.util.Base64
import java.io.ByteArrayOutputStream

/**
 * What was on screen when Jon summoned June over an app: the picture Android hands the session, and the app's name.
 * It goes with his next message only, so she can answer about what he is looking at, a photo or a map as well as text.
 */
class Screen(val picture: Bitmap, val app: String) {
    /** The picture as base64 JPEG for the model, its long side at most 1568 px (the daemon fits it to the model's limits). */
    fun jpeg(): String {
        val soft = if (picture.config == Bitmap.Config.HARDWARE) picture.copy(Bitmap.Config.ARGB_8888, false) else picture
        val scale = minOf(1f, 1568f / maxOf(soft.width, soft.height))
        val sized = if (scale < 1f) Bitmap.createScaledBitmap(soft, (soft.width * scale).toInt(), (soft.height * scale).toInt(), true) else soft
        val out = ByteArrayOutputStream()
        sized.compress(Bitmap.CompressFormat.JPEG, 82, out)
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }
}
