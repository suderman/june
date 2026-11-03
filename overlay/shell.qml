// June's Hyprland overlay: a resident Quickshell client that shows the one conversation as a comic strip above
// every window, fullscreen ones included, without taking the active window. It talks to the daemon over the WebSocket
// listener with a device token (see "Client protocol for graphical clients" in docs/architecture.org).
//
// Environment, set by the june-overlay wrapper: JUNE_OVERLAY_URL (wss://june.kit/), JUNE_OVERLAY_TOKEN_FILE (a 0600
// file holding this device's token), JUNE_OVERLAY_FONTS (a directory of the strip's fonts), and JUNE_OVERLAY_ART (avatar
// set directories, colon-separated, a personal set before the base one; see "Poses" in docs/interfaces.org).
// One key cycles the overlay (`june-overlay cycle`, for an Alt tap): hidden, live June in the corner, the full strip,
// hidden again. Esc dismisses either. `toggle`, `open`, `close`, and `mini` reach each directly.
import QtQuick
import QtQml.Models
import QtQuick.Controls
import QtWebSockets
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import Quickshell.Hyprland
import "strip.mjs" as Strip
import "compose.mjs" as Compose
import "live.mjs" as Live

ShellRoot {
  id: root

  property bool shown: false
  property var targetScreen: Quickshell.screens[0]
  property var view: Strip.emptyView()
  property bool linked: false
  // Closed before hello twice running: the token is wrong or revoked, so stop hammering and say so.
  property int refusals: 0
  property bool helloSeen: false
  property string toast: ""
  property int seq: 0

  readonly property string url: Quickshell.env("JUNE_OVERLAY_URL") || "wss://june.kit/"
  readonly property string host: (/^wss?:\/\/(?:june\.)?([^/:.]+)/.exec(url) ?? [null, "the server"])[1]
  readonly property string fonts: Quickshell.env("JUNE_OVERLAY_FONTS") || ""
  readonly property string activity: Strip.activity(view.state, linked)

  // June's poses from every avatar set, the first set winning a shared name, and each panel's side and pose, kept once
  // chosen so the strip does not rearrange itself as it grows.
  readonly property var artDirs: (Quickshell.env("JUNE_OVERLAY_ART") || "").split(":").filter(d => d !== "")
  property var artSets: ({})
  property var liveSets: ({})
  property var poses: []
  // Live June's art by state, the first set winning.
  property var liveArt: ({})
  property var sides: ({})
  property var poseIds: ({})

  Instantiator {
    model: root.artDirs
    delegate: FileView {
      required property string modelData
      path: modelData + "/manifest.json"
      blockLoading: true
    }
    onObjectAdded: (index, object) => root.addArt(index, root.artDirs[index], object.text())
  }

  function addArt(index, dir, text) {
    const sets = Object.assign({}, artSets);
    const lives = Object.assign({}, liveSets);
    try {
      const manifest = JSON.parse(text);
      sets[index] = Compose.readPoses(manifest, "file://" + dir + "/");
      lives[index] = Live.readLive(manifest, "file://" + dir + "/");
    }
    catch (e) { console.warn("june overlay: no usable avatar set in", dir); sets[index] = []; lives[index] = {}; }
    artSets = sets;
    liveSets = lives;
    const art = {};
    for (let i = artDirs.length - 1; i >= 0; i--) Object.assign(art, liveSets[i] ?? {});
    liveArt = art;
    const seen = {};
    const all = [];
    for (let i = 0; i < artDirs.length; i++)
      for (const pose of (artSets[i] ?? [])) if (!seen[pose.id]) { seen[pose.id] = true; all.push(pose); }
    poses = all;
    sync();
  }

  FontLoader { source: root.fonts ? "file://" + root.fonts + "/ShantellSans[BNCE,INFM,SPAC,wght].ttf" : "" }
  FontLoader { source: root.fonts ? "file://" + root.fonts + "/ShantellSans-Italic[BNCE,INFM,SPAC,wght].ttf" : "" }
  FontLoader { source: root.fonts ? "file://" + root.fonts + "/DelaGothicOne-Regular.ttf" : "" }
  FontLoader { source: root.fonts ? "file://" + root.fonts + "/ZenKakuGothicNew-Bold.ttf" : "" }
  FontLoader { source: root.fonts ? "file://" + root.fonts + "/ZenKakuGothicNew-Regular.ttf" : "" }

  ListModel { id: strip } // newest panel first, so the list grows upward from the input

  function focusedScreen() {
    const name = Hyprland.focusedMonitor?.name;
    return Quickshell.screens.find(s => s.name === name) || Quickshell.screens[0];
  }
  function show() {
    targetScreen = focusedScreen();
    hideMini();
    shown = true;
  }
  function hide() { shown = false; }

  // Live June, the minimised form. Summoned by the first Alt tap, she opens with the user's note ready; she also pops
  // up by herself with a reply that finishes while the strip is hidden, and tucks herself away after a while.
  property bool miniShown: false
  property bool miniSummoned: false
  property bool miniInput: false
  property bool miniMessage: false
  property string miniText: ""
  property var miniScreen: Quickshell.screens[0]
  // The newest desktop reply already shown, so each pops up once; null until the first view arrives.
  property var seenReply: null
  property real idleSince: Date.now()
  property bool wasRunning: false
  property var oneShot: null
  property real now: Date.now()
  readonly property string liveState: Live.liveState({ view: view, linked: linked, now: new Date(now), idleSince: idleSince, once: oneShot })
  readonly property var liveWords: ({ typing: "writing", thinking: "thinking", digging: "digging", delegating: "delegating", watching: "watching", tidying: "tidying up", listening: "listening", speaking: "speaking", offline: "offline" })

  Timer { interval: 30000; running: true; repeat: true; onTriggered: root.now = Date.now() }
  Timer { id: oneShotEnd; onTriggered: { root.oneShot = null; root.now = Date.now(); } }
  Timer {
    id: tuckAway
    interval: 15000
    onTriggered: {
      if (live.hovered || root.miniInput) { restart(); return; }
      root.miniMessage = false;
      if (!root.miniSummoned) root.miniShown = false;
    }
  }

  function playOnce(state, ms) {
    oneShot = { state: state, until: Date.now() + ms };
    now = Date.now();
    oneShotEnd.interval = ms;
    oneShotEnd.restart();
  }
  function showMini() {
    if (shown) return;
    miniScreen = focusedScreen();
    if (liveState === "snoozing") playOnce("waking", 1500);
    miniShown = true;
    miniSummoned = true;
    miniInput = true;
  }
  function hideMini() {
    miniShown = false;
    miniSummoned = false;
    miniInput = false;
    miniMessage = false;
    tuckAway.stop();
  }
  function popReply(item) {
    miniText = Live.excerpt(item.text);
    miniMessage = true;
    if (!miniShown) {
      miniScreen = focusedScreen();
      miniShown = true;
      miniSummoned = false;
      playOnce("pop-in", 1800);
    }
    tuckAway.restart();
  }
  // After each view change: note when a run ends, and pop up for a newly finished desktop reply while the strip is hidden.
  function watchLive() {
    const running = Boolean(view.state.running || view.state.compacting);
    if (wasRunning && !running) idleSince = Date.now();
    wasRunning = running;
    now = Date.now();
    const latest = Live.newReply(view.items, seenReply);
    if (seenReply === null) { seenReply = latest ? latest.id : ""; return; }
    if (!latest) return;
    seenReply = latest.id;
    if (!shown) popReply(latest);
  }

  IpcHandler {
    target: "june"
    function toggle(): void { root.shown ? root.hide() : root.show(); }
    function open(): void { root.show(); }
    function close(): void { root.hide(); }
    function mini(): void { root.miniShown ? root.hideMini() : root.showMini(); }
    // Hidden, then live June, then the full strip, then hidden: one key for everything.
    function cycle(): void {
      if (root.shown) root.hide();
      else if (root.miniShown) root.show();
      else root.showMini();
    }
  }

  LiveWindow {
    id: live
    screen: root.miniScreen
    shown: root.miniShown && !root.shown
    liveState: root.liveState
    art: root.liveArt[root.liveState] ?? root.liveArt["sipping"] ?? null
    status: root.liveWords[root.liveState] ?? ""
    message: root.miniText
    messageShown: root.miniMessage
    inputShown: root.miniInput
    onOpenStrip: root.show()
    onWantInput: { root.miniInput = true; tuckAway.restart(); }
    onDismissed: root.hideMini()
    onSubmitted: (text, followUp) => {
      if (root.submit(text, followUp)) { root.miniInput = false; root.miniMessage = false; root.miniSummoned = false; tuckAway.restart(); }
    }
  }

  FileView { id: tokenFile; path: Quickshell.env("JUNE_OVERLAY_TOKEN_FILE") || ""; blockLoading: true }

  WebSocket {
    id: ws
    url: root.url
    active: true
    onTextMessageReceived: message => {
      let reply;
      try { reply = JSON.parse(message); } catch (e) { return; }
      root.receive(reply);
    }
    onStatusChanged: () => {
      const status = ws.status;
      if (status === WebSocket.Open) {
        root.helloSeen = false;
        tokenFile.reload();
        ws.sendTextMessage(JSON.stringify({ op: "hello", requestId: root.rid(), token: tokenFile.text().trim(), protocol: 1 }));
      } else if (status === WebSocket.Closed || status === WebSocket.Error) {
        if (status === WebSocket.Error) console.warn("june overlay:", ws.errorString);
        if (root.linked || root.helloSeen) root.refusals = 0;
        else if (status === WebSocket.Closed) root.refusals += 1;
        root.linked = false;
        ws.active = false;
        reconnect.interval = root.refusals >= 2 ? 60000 : 2000;
        reconnect.restart();
      }
    }
  }
  Timer { id: reconnect; interval: 2000; onTriggered: ws.active = true }
  Timer { id: toastTimer; interval: 6000; onTriggered: root.toast = "" }

  function rid() { seq += 1; return "gui-" + Date.now() + "-" + seq; }
  function send(request) {
    if (!linked) return false;
    ws.sendTextMessage(JSON.stringify(request));
    return true;
  }
  function say(text) { toast = text; toastTimer.restart(); }

  function receive(reply) {
    if (reply.type === "hello") {
      helloSeen = true;
      linked = true;
      refusals = 0;
      send({ op: "attach", requestId: rid() });
      return;
    }
    if (reply.type === "view") {
      view = Strip.applyView(view, reply);
      sync();
      watchLive();
      return;
    }
    if (reply.type === "reply") say(reply.text);
    else if (reply.type === "error") say(reply.message);
  }

  // Bring the list model in step with the view, touching only panels that changed, so streaming redraws one panel.
  // Each panel gets June's pose and side here, oldest first: the side alternates from the panel before unless her pose
  // says otherwise, and both stay put once chosen. The panel she is answering in shows the pose of the moment instead.
  function sync() {
    const list = Strip.panels(view.items);
    let previousSide = undefined;
    let previousPose = "";
    const composed = list.map((p, i) => {
      const live = i === list.length - 1 && (view.state.running || view.state.compacting);
      // While she works or thinks, a pose showing that; while she writes, her expression; settled, the kept reaction.
      const doing = live ? Compose.liveActivity(view.state, p) : null;
      let pose = live ? Compose.choosePose(poses, doing ? { activity: doing, expression: "curious" } : Compose.standIn(p, true), previousPose, p.id) : (poses.find(x => x.id === poseIds[p.id]) ?? null);
      if (!pose && !live) {
        pose = Compose.choosePose(poses, Compose.standIn(p, false), previousPose, p.id);
        if (pose) poseIds[p.id] = pose.id;
      }
      if (!sides[p.id]) sides[p.id] = Compose.chooseSide(previousSide, pose);
      previousSide = sides[p.id];
      previousPose = pose ? pose.id : "";
      return Object.assign({}, p, { side: sides[p.id], pose: pose });
    });
    const rows = composed.reverse().map(p => ({ pid: p.id, json: JSON.stringify(p) }));
    let same = rows.length === strip.count;
    for (let i = 0; same && i < rows.length; i++) same = strip.get(i).pid === rows[i].pid;
    if (!same && rows.length === strip.count + 1) {
      let shifted = true;
      for (let i = 0; shifted && i < strip.count; i++) shifted = strip.get(i).pid === rows[i + 1].pid;
      if (shifted) { strip.insert(0, rows[0]); same = true; }
    }
    if (!same) {
      strip.clear();
      for (const row of rows) strip.append(row);
      return;
    }
    for (let i = 0; i < rows.length; i++) if (strip.get(i).json !== rows[i].json) strip.setProperty(i, "json", rows[i].json);
  }

  function submit(text, followUp) {
    const input = Strip.readInput(text);
    if (input.kind === "empty") return true;
    if (input.kind === "refuse") { say(input.message); return false; }
    if (!linked) { say("not connected to June; your balloon is kept"); return false; }
    if (input.kind === "command") send({ op: "command", requestId: rid(), name: input.name, args: input.args });
    else send({ op: "submit", requestId: rid(), text: input.text, source: "gui", whenBusy: followUp ? "followUp" : "steer" });
    return true;
  }

  PanelWindow {
    id: window
    visible: root.shown
    screen: root.targetScreen
    anchors { top: true; bottom: true; left: true; right: true }
    exclusionMode: ExclusionMode.Ignore
    color: Theme.backdrop
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.namespace: "june-overlay"
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    onVisibleChanged: if (visible) input.forceActiveFocus()

    // Esc hides from anywhere in the overlay, even after a click put the focus in a balloon to select its words.
    Shortcut { sequence: "Escape"; onActivated: root.hide() }

    MouseArea { anchors.fill: parent; onClicked: root.hide() }

    Rectangle {
      id: page
      anchors.horizontalCenter: parent.horizontalCenter
      anchors.top: parent.top
      anchors.bottom: parent.bottom
      width: Math.min(Theme.stripWidth, parent.width - 32)
      color: Theme.paper
      MouseArea { anchors.fill: parent } // clicks on the page stay on it

      Row {
        id: masthead
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.margins: 16
        height: 30
        spacing: 12
        Text { text: "june"; font.family: Theme.display; font.pixelSize: 22; color: Theme.ink; anchors.verticalCenter: parent.verticalCenter }
        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: !root.linked ? (root.refusals >= 2 ? "pairing needed: check this device's token" : "reconnecting to " + root.host + "…") : root.view.state.running || root.view.state.compacting ? root.activity : "on " + root.host
          font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13
          color: root.linked ? Theme.muted : Theme.accent
        }
        // Background briefs: a small inked "meanwhile" card, the comic's cutaway to work going on elsewhere.
        Rectangle {
          visible: root.linked && (root.view.state.background ?? 0) > 0
          anchors.verticalCenter: parent.verticalCenter
          width: meanwhile.implicitWidth + 20
          height: 26
          radius: 6
          color: Theme.cardFill
          border.color: Theme.cardLine
          border.width: 1.5
          Text {
            id: meanwhile
            anchors.centerIn: parent
            text: "meanwhile, on " + root.host + " · " + (root.view.state.background === 1 ? "1 brief" : root.view.state.background + " briefs")
            font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12
            color: Theme.cardBusy
          }
        }
      }

      ListView {
        id: list
        anchors.top: masthead.bottom
        anchors.bottom: composer.top
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.margins: 16
        verticalLayoutDirection: ListView.BottomToTop
        spacing: 14
        clip: true
        opacity: root.linked ? 1 : 0.5
        model: strip
        delegate: Panel {
          required property int index
          width: list.width
          newest: index === 0
          activity: root.activity
          poses: root.poses
        }
      }

      Rectangle {
        visible: root.toast !== ""
        anchors.bottom: composer.top
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottomMargin: 10
        width: Math.min(toastText.implicitWidth + 28, parent.width - 48)
        height: toastText.height + 14
        color: Theme.captionFill
        border.color: Theme.ink
        border.width: 2
        Text { id: toastText; anchors.centerIn: parent; width: Math.min(implicitWidth, page.width - 76); wrapMode: Text.Wrap; text: root.toast; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13; color: Theme.ink }
      }

      // The user's balloon: Enter steers, Shift+Enter queues, Alt+Enter adds a line, Ctrl+C stops June, Esc hides.
      Rectangle {
        id: composer
        anchors.bottom: parent.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.margins: 16
        height: Math.min(input.contentHeight + 34, 220)
        radius: Math.min(height / 2, 30)
        color: Theme.balloon
        border.color: Theme.ink
        border.width: 3

        ScrollView {
          anchors.fill: parent
          anchors.leftMargin: 26
          anchors.rightMargin: 26
          anchors.topMargin: 10
          anchors.bottomMargin: 10
          TextArea {
            id: input
            placeholderText: "your balloon…"
            wrapMode: TextEdit.Wrap
            font.family: Theme.lettering
            font.pixelSize: 19
            color: Theme.ink
            placeholderTextColor: "#9a958a"
            background: null
            Keys.onPressed: event => {
              if (event.key === Qt.Key_C && (event.modifiers & Qt.ControlModifier) && input.selectedText === "") {
                if (root.send({ op: "command", requestId: root.rid(), name: "stop" })) root.say("stopping");
                event.accepted = true;
                return;
              }
              if (event.key !== Qt.Key_Return && event.key !== Qt.Key_Enter) return;
              if (event.modifiers & Qt.AltModifier) { input.insert(input.cursorPosition, "\n"); event.accepted = true; return; }
              if (root.submit(input.text, event.modifiers & Qt.ShiftModifier)) input.clear();
              event.accepted = true;
            }
          }
        }
      }
    }
  }
}
