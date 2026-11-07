package net.suderman.june

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import java.io.File

/**
 * An invisible step between June and the system's photo picker, file picker, or camera: the assistant sheet is a
 * session, not an activity, so it cannot receive what they return. What is chosen joins the Outbox, then this closes;
 * opened from the sheet, it shows the sheet again over the app Jon was in. None of the three needs a permission.
 */
class AttachActivity : ComponentActivity() {
    private val photos = registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(Outbox.MAX_PICTURES)) { done(it) }
    private val documents = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { done(it) }
    private val camera = registerForActivityResult(ActivityResultContracts.TakePicture()) { taken -> done(if (taken) listOf(shot()) else emptyList(), photo = true) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Recreated after a rotation or a trip to the background, the picker is already open: wait for its answer.
        if (savedInstanceState != null) return
        when (intent.getStringExtra(SOURCE)) {
            "photos" -> photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            "files" -> documents.launch(arrayOf("*/*"))
            "camera" -> camera.launch(FileProvider.getUriForFile(this, "$packageName.files", photoFile(this).also { it.delete() }))
            else -> finish()
        }
    }

    private fun shot(): Uri = Uri.fromFile(photoFile(this))

    private fun done(uris: List<Uri>, photo: Boolean = false) {
        if (uris.isEmpty()) return back()
        val app = applicationContext
        val waiting = Outbox.items
        Thread {
            val (added, refused) = if (photo) {
                val file = photoFile(app)
                val read = runCatching { Outbox.picture(android.graphics.ImageDecoder.decodeBitmap(android.graphics.ImageDecoder.createSource(file)) { d, _, _ -> d.allocator = android.graphics.ImageDecoder.ALLOCATOR_SOFTWARE }, "photo.jpg") }
                // The camera's full-size photo is only needed until it is read.
                file.delete()
                read.fold({ listOf(it) to emptyList() }, { Log.w(TAG, "photo unreadable: $it"); emptyList<Attachment>() to listOf("the photo could not be read") })
            } else Outbox.read(app, uris, waiting.count { it.picture }, waiting.count { !it.picture }, Outbox.base64())
            runOnUiThread {
                added.forEach(Outbox::add)
                Outbox.notice = refused.joinToString("; ")
                back()
            }
        }.start()
    }

    /**
     * Close, and bring the sheet back when this was opened from it; if Android has not bound the assistant service since
     * the app started, the full screen shows the same draft instead, so what was attached is never out of sight.
     */
    private fun back() {
        if (intent.getBooleanExtra(FROM_SHEET, false)) {
            val service = JuneInteractionService.current
            if (service != null) service.showSession(Bundle(), 0)
            else startActivity(Intent(this, ConversationActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        finish()
    }

    companion object {
        private const val SOURCE = "source"
        private const val FROM_SHEET = "fromSheet"

        fun open(context: Context, source: String, fromSheet: Boolean) {
            context.startActivity(
                Intent(context, AttachActivity::class.java).putExtra(SOURCE, source).putExtra(FROM_SHEET, fromSheet)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }

        /** Where the camera writes its photo, under the cache directory res/xml/files.xml shares. */
        private fun photoFile(context: Context) = File(context.cacheDir, "camera").also { it.mkdirs() }.resolve("photo.jpg")
    }
}
