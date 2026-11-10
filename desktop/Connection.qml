// The desktop client's WebSocket session, separate from the windows so connection recovery can be tested without a desktop.
import QtQuick
import QtWebSockets

QtObject {
  id: link

  required property string url
  // Read afresh on every hello, including after pairing or a token replacement.
  required property var token
  property bool linked: false
  property int refusals: 0
  property bool helloSeen: false
  property int seq: 0
  property int probeMs: 15000
  property int timeoutMs: 45000
  property int retryMs: 2000
  signal received(var reply)

  function rid() { seq += 1; return "link-" + Date.now() + "-" + seq; }
  function send(request) {
    if (!linked) return false;
    ws.sendTextMessage(JSON.stringify(request));
    return true;
  }
  function refresh() {
    linked = false;
    ws.active = false;
    deadline.stop();
    reconnect.interval = retryMs;
    reconnect.restart();
  }

  property WebSocket socket: WebSocket {
    id: ws
    url: link.url
    active: true
    onTextMessageReceived: message => {
      deadline.restart();
      let reply;
      try { reply = JSON.parse(message); } catch (e) { return; }
      if (reply.type === "hello") {
        link.helloSeen = true;
        link.linked = true;
        link.refusals = 0;
        link.send({ op: "attach", requestId: link.rid() });
      }
      link.received(reply);
    }
    onStatusChanged: () => {
      const status = ws.status;
      if (status === WebSocket.Connecting || status === WebSocket.Open) deadline.restart();
      if (status === WebSocket.Open) {
        link.helloSeen = false;
        ws.sendTextMessage(JSON.stringify({ op: "hello", requestId: link.rid(), token: link.token(), protocol: 1 }));
      } else if (status === WebSocket.Closed || status === WebSocket.Error) {
        if (status === WebSocket.Error) console.warn("june desktop:", ws.errorString);
        if (link.linked || link.helloSeen) link.refusals = 0;
        else if (status === WebSocket.Closed) link.refusals += 1;
        link.linked = false;
        ws.active = false;
        deadline.stop();
        reconnect.interval = link.refusals >= 2 ? 60000 : link.retryMs;
        reconnect.restart();
      }
    }
  }
  property Timer retry: Timer { id: reconnect; interval: link.retryMs; onTriggered: ws.active = true }
  // TCP can stay open locally after suspend while the daemon has dropped the peer.
  // A read-only request requires an application reply; server WebSocket pings alone do not prove this path works.
  property Timer probe: Timer {
    interval: link.probeMs; running: link.linked; repeat: true
    onTriggered: link.send({ op: "status", requestId: link.rid() })
  }
  property Timer watchdog: Timer {
    id: deadline
    interval: link.timeoutMs
    onTriggered: { console.warn("june desktop: connection timed out; reconnecting"); link.refresh(); }
  }
}
