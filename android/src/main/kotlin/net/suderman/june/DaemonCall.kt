package net.suderman.june

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * One request to the daemon on a short connection of its own, for the widget, the reminders and the background
 * refresh, which run while June's screen is closed: hello with the phone's pairing, the request, its answer. It
 * blocks, so it runs off the main thread. It does not attach a view, so the daemon still pushes replies to ntfy.
 */
object DaemonCall {
    private val client = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).build()

    /** The answer to REQUEST (an op without a requestId), or null when unpaired, unreachable or out of time. */
    fun request(context: Context, request: JSONObject, timeoutMs: Long = 20_000): JSONObject? {
        val pairing = Pairing.load(context.applicationContext) ?: return null
        val id = "bg-${UUID.randomUUID()}"
        val done = CountDownLatch(1)
        var answer: JSONObject? = null
        val socket = client.newWebSocket(Request.Builder().url(pairing.url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(JSONObject().put("op", "hello").put("requestId", "bg-hello").put("token", pairing.token).put("protocol", 1).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val reply = runCatching { JSONObject(text) }.getOrNull() ?: return
                when {
                    reply.optString("type") == "hello" -> webSocket.send(JSONObject(request.toString()).put("requestId", id).toString())
                    reply.optString("requestId") == id -> { answer = reply; done.countDown() }
                    reply.optString("type") == "error" && reply.optString("requestId") == "bg-hello" -> done.countDown()
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = done.countDown()
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = done.countDown()
        })
        done.await(timeoutMs, TimeUnit.MILLISECONDS)
        socket.close(1000, "done")
        return answer
    }
}
