package net.suderman.june

import android.content.Intent
import android.os.Bundle
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.speech.RecognitionService
import android.speech.SpeechRecognizer
import android.util.Log

const val TAG = "June"

class JuneInteractionService : VoiceInteractionService() {
    override fun onReady() {
        super.onReady()
        Log.i(TAG, "interaction service ready")
    }
}

class JuneSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession = JuneSession(this)
}

// Speech recognition happens on the daemon host, so this only answers that it cannot help.
class JuneRecognitionService : RecognitionService() {
    override fun onStartListening(intent: Intent?, listener: Callback) {
        Log.i(TAG, "recognition requested; not supported")
        listener.error(SpeechRecognizer.ERROR_CLIENT)
    }

    override fun onCancel(listener: Callback) {}

    override fun onStopListening(listener: Callback) {}
}
