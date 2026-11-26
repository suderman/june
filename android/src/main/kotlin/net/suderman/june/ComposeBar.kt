package net.suderman.june

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.MediaStore
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** One recent gallery image: its MediaStore row ID (so repeated taps skip already-attached ones) and content URI. */
data class GalleryImage(val id: Long, val uri: Uri)

/** Queries the device's gallery newest-first for one-tap screenshot/photo attaching. */
object RecentGallery {
    fun hasPermission(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED

    /** Returns the newest gallery image whose MediaStore ID is not in EXCLUDE, or null if none is accessible. */
    fun nextImage(context: Context, exclude: Set<Long>): GalleryImage? = runCatching {
        val collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        val projection = arrayOf(MediaStore.Images.Media._ID)
        val sort = "${MediaStore.Images.Media.DATE_ADDED} DESC, ${MediaStore.Images.Media._ID} DESC"
        context.contentResolver.query(collection, projection, null, null, sort)?.use { cursor ->
            val col = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            var checked = 0
            while (cursor.moveToNext() && checked < 60) {
                checked++
                val id = cursor.getLong(col)
                if (id !in exclude) return@use GalleryImage(id, ContentUris.withAppendedId(collection, id))
            }
            null
        }
    }.getOrNull()
}

/**
 * Shared Muse-style rounded compose bar used on both June's chat page and the embedded Terminal page:
 * plus button + one-tap recent-image button on the left, multi-line text field (onscreen Return inserts a newline)
 * in the middle, and a circular up-arrow send button on the right, all enclosed in one rounded bar.
 */
@Composable
fun ComposeBar(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    placeholder: String,
    palette: Look.Palette,
    canSend: Boolean,
    onSend: () -> Unit,
    onRecentImage: () -> Unit,
    modifier: Modifier = Modifier,
    fieldModifier: Modifier = Modifier,
    onFocusChange: ((Boolean) -> Unit)? = null,
    attachMenu: @Composable (dismiss: () -> Unit) -> Unit,
) {
    val context = LocalContext.current
    var menuOpen by remember { mutableStateOf(false) }
    val askPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) onRecentImage()
    }
    val ink = palette.pageInk
    val muted = palette.muted
    val pillBg = when {
        palette.neon -> Color(0xFF282242)
        palette.console && palette.dark -> Color(0xFF262A33)
        palette.console -> Color(0xFFE5E9EF)
        else -> Color(0xFFE7DFD0)
    }
    val action = when {
        palette.neon -> palette.line
        palette.console -> palette.user
        else -> palette.noteLine
    }
    val actionInk = if (palette.dark) palette.page else Color.White
    val fieldStyle = TextStyle(color = ink, fontSize = 15.sp, lineHeight = 20.sp)

    Row(
        modifier
            .fillMaxWidth()
            .background(palette.field, RoundedCornerShape(26.dp))
            .border(1.dp, palette.rule, RoundedCornerShape(26.dp))
            .padding(horizontal = 6.dp, vertical = 5.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        Box {
            Box(
                Modifier.size(36.dp).clickable { menuOpen = true },
                contentAlignment = Alignment.Center,
            ) { Icon(PlusIcon, "Attach", Modifier.size(22.dp), tint = ink) }
            DropdownMenu(menuOpen, onDismissRequest = { menuOpen = false }) {
                attachMenu { menuOpen = false }
            }
        }
        Box(
            Modifier.size(36.dp).clickable {
                if (RecentGallery.hasPermission(context) || RecentGallery.nextImage(context, emptySet()) != null) {
                    onRecentImage()
                } else {
                    askPermission.launch(Manifest.permission.READ_MEDIA_IMAGES)
                }
            },
            contentAlignment = Alignment.Center,
        ) { Icon(RecentImageIcon, "Attach recent image", Modifier.size(20.dp), tint = muted) }
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = fieldModifier
                .weight(1f)
                .padding(horizontal = 6.dp, vertical = 8.dp)
                .let { m -> if (onFocusChange != null) m.onFocusChanged { onFocusChange(it.isFocused) } else m },
            textStyle = fieldStyle,
            cursorBrush = SolidColor(ink),
            maxLines = 6,
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.Sentences,
                imeAction = ImeAction.Default,
            ),
            decorationBox = { inner ->
                Box {
                    if (value.text.isEmpty()) BasicText(placeholder, style = fieldStyle.copy(color = muted))
                    inner()
                }
            },
        )
        Box(
            Modifier
                .size(36.dp)
                .background(if (canSend) action else pillBg, CircleShape)
                .clickable(enabled = canSend, onClick = onSend),
            contentAlignment = Alignment.Center,
        ) {
            Icon(UpArrowIcon, "Send", Modifier.size(20.dp), tint = if (canSend) actionInk else muted)
        }
    }
}

private fun composeIcon(name: String, path: String): ImageVector =
    ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
        .addPath(PathParser().parsePathString(path).toNodes(), fill = SolidColor(Color.White))
        .build()

private val PlusIcon by lazy { composeIcon("Plus", "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z") }
private val UpArrowIcon by lazy { composeIcon("SendUp", "M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z") }
private val RecentImageIcon by lazy {
    composeIcon(
        "RecentImage",
        "M19 7v2.99s-1.99.01-2 0V7h-3s.01-1.99 0-2h3V2h2v3h3v2h-3zm-3 4V8h-3V5H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-8h-3zM5 19l3-4 2 3 3-4 4 5H5z",
    )
}
val StopSquareIcon by lazy { composeIcon("Stop", "M6 6h12v12H6z") }
