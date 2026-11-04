// June's Hyprland overlay: a resident Quickshell client that shows the one conversation as a comic strip above
// every window, fullscreen ones included, without taking the active window. It talks to the daemon over the WebSocket
// listener with a device token (see "Client protocol for graphical clients" in docs/architecture.org).
//
// Environment, set by the june-overlay wrapper: JUNE_OVERLAY_URL (wss://june.kit/), JUNE_OVERLAY_TOKEN_FILE (a 0600
// file holding this device's token), JUNE_OVERLAY_FONTS (a directory of the strip's fonts), and JUNE_OVERLAY_ART (avatar
// set directories, colon-separated, a personal set before the base one; see "Poses" in docs/interfaces.org).
// One key cycles the overlay (`june-overlay cycle`, for an Alt tap): hidden, live June in the corner with her note
// open, the full strip, hidden again; if she popped up by herself, the first press opens her note. Esc dismisses either. `toggle`, `open`, `close`, and `mini` reach each directly.
// `window` opens the same strip in an ordinary window with this device's toggles (StripWindow.qml).
import QtQuick
import QtQml.Models
import QtWebSockets
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import Quickshell.Hyprland
import "strip.mjs" as Strip
import "compose.mjs" as Compose
import "live.mjs" as Live
import "scenery.mjs" as Scenery
import "console.mjs" as Console

ShellRoot {
  id: root

  property bool shown: false
  // The windowed strip, and this device's toggles: state while the overlay runs, never written to config.
  property bool windowShown: false
  // Live June in the corner: off, she never pops up and the key goes straight between hidden and the strip.
  property bool liveEnabled: true
  // The comic strip, or the console look for when June should look professional (a client meeting).
  property string look: "comic"
  Binding { target: Theme; property: "consoleLook"; value: root.look === "console" }
  property alias stripModel: strip
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
  // Live June's chibi reactions by expression, the first set winning.
  property var chibiSets: ({})
  property var chibiArt: ({})
  // Rooms, window views, and props by set, and all of them merged, the first set winning a shared id.
  property var scenerySets: ({})
  property var scenery: ({ rooms: [], plates: [], props: [] })
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
      const chibis = Object.assign({}, chibiSets);
      chibis[index] = Live.readChibi(manifest, "file://" + dir + "/");
      chibiSets = chibis;
      const scenes = Object.assign({}, scenerySets);
      scenes[index] = Scenery.readScenery(manifest, "file://" + dir + "/");
      scenerySets = scenes;
    }
    catch (e) { console.warn("june overlay: no usable avatar set in", dir); sets[index] = []; lives[index] = {}; }
    artSets = sets;
    liveSets = lives;
    const art = {};
    for (let i = artDirs.length - 1; i >= 0; i--) Object.assign(art, liveSets[i] ?? {});
    liveArt = art;
    const chibi = {};
    for (let i = artDirs.length - 1; i >= 0; i--) Object.assign(chibi, chibiSets[i] ?? {});
    chibiArt = chibi;
    const sceneList = [];
    for (let i = 0; i < artDirs.length; i++) sceneList.push(scenerySets[i] ?? null);
    scenery = Scenery.mergeScenery(sceneList);
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
  // The unfold: 0 is her card alone in the corner, 1 the full strip at the right edge. About a quarter second either way.
  property real unfold: 0
  // Her card stays put through the unfold when it is already on screen (from min mode, or back to it).
  property bool cardSteady: false
  property bool toMiniAfter: false
  NumberAnimation {
    id: unfolding
    target: root
    property: "unfold"
    duration: 320
    easing.type: Easing.OutQuart
    onFinished: {
      if (root.unfold > 0.001) return;
      root.shown = false;
      if (root.toMiniAfter) {
        root.toMiniAfter = false;
        root.miniShown = true;
        root.miniSummoned = true;
        root.miniInput = true;
      }
    }
  }
  function unfoldTo(target) {
    unfolding.stop();
    unfolding.from = unfold;
    unfolding.to = target;
    unfolding.start();
  }
  function show() {
    const fromMini = miniShown;
    targetScreen = fromMini ? miniScreen : focusedScreen();
    cardSteady = fromMini;
    // A draft started in the corner carries on in the strip.
    if (fromMini && live.draft !== "") { composer.text = live.draft; live.draft = ""; }
    hideMini();
    toMiniAfter = false;
    shown = true;
    list.landOnNewest();
    unfoldTo(1);
  }
  function hide() {
    if (!shown) return;
    if (!toMiniAfter) cardSteady = false;
    unfoldTo(0);
  }
  // Shrink the strip back into her card, the note open with any draft.
  function toMini() {
    if (!liveEnabled) { hide(); return; }
    miniScreen = targetScreen;
    if (composer.text !== "") { live.draft = composer.text; composer.clear(); }
    toMiniAfter = true;
    cardSteady = true;
    hide();
  }

  // Live June, the minimised form. Summoned by the first Alt tap, she opens with the user's note ready; she also pops
  // up by herself with a reply that finishes while the strip is hidden, and tucks herself away after a while.
  property bool miniShown: false
  property bool miniSummoned: false
  property bool miniInput: false
  property bool miniMessage: false
  property string miniText: ""
  // When her latest desktop reply arrived; a recent one shows again above the note when she is summoned.
  property real miniTextAt: 0
  property var miniScreen: Quickshell.screens[0]
  // The newest desktop reply already shown, so each pops up once; null until the first view arrives.
  property var seenReply: null
  property real idleSince: Date.now()
  property bool wasRunning: false
  property var oneShot: null
  property real now: Date.now()
  // An hour that lights every panel, set through the `light` IPC call to preview the day; -1 for each panel's own.
  property real lightHour: -1
  // Her latest picked face, for the console's text face.
  readonly property string faceExpression: {
    for (let i = view.items.length - 1; i >= 0; i--) if (view.items[i].kind === "assistant" && view.items[i].expression) return view.items[i].expression;
    return "idle";
  }
  readonly property string liveFace: Console.liveFace(liveState, faceExpression)
  readonly property string liveState: Live.liveState({ view: view, linked: linked, now: new Date(now), idleSince: idleSince, once: oneShot })
  readonly property var liveWords: ({ typing: "writing", thinking: "thinking", digging: "digging", delegating: "delegating", watching: "watching", tidying: "tidying up", listening: "listening", speaking: "speaking", offline: "offline" })

  Timer { interval: 30000; running: true; repeat: true; onTriggered: root.now = Date.now() }
  Timer { id: oneShotEnd; onTriggered: { root.oneShot = null; root.now = Date.now(); } }
  Timer {
    id: tuckAway
    // Set per reply: longer to read, longer to stay (see readingTime in live.mjs).
    interval: 8000
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
    if (!liveEnabled) { show(); return; }
    miniScreen = focusedScreen();
    if (liveState === "snoozing") playOnce("waking", 1500);
    miniShown = true;
    miniSummoned = true;
    miniInput = true;
    miniMessage = miniText !== "" && Live.recent(miniTextAt, Date.now());
  }
  // Open the note under whatever she is showing, and keep her until the user sends or dismisses it.
  function answerMini() {
    miniSummoned = true;
    miniInput = true;
    tuckAway.stop();
  }
  function hideMini() {
    miniShown = false;
    miniSummoned = false;
    miniInput = false;
    miniMessage = false;
    tuckAway.stop();
  }
  function popReply(item) {
    miniMessage = true;
    if (!miniShown) {
      miniScreen = focusedScreen();
      miniShown = true;
      miniSummoned = false;
      playOnce("pop-in", 1800);
    }
    tuckAway.interval = Live.readingTime(miniText);
    tuckAway.restart();
  }
  // Live June's reaction: when a reply's face is picked, she shows its chibi for a moment, then goes back to her loop.
  property var reaction: null
  property var seenFace: null
  Timer { id: reactionEnd; interval: Live.REACTION_MS; onTriggered: root.reaction = null }
  function react(expression) {
    const art = Live.reactionArt(chibiArt, Compose.chain(expression));
    if (!art) return;
    reaction = { url: art.url, plain: ["serious", "gentle"].includes(expression) };
    reactionEnd.restart();
  }

  // After each view change: note when a run ends, react to a newly picked face, and pop up for a newly finished
  // desktop reply while the strip is hidden.
  function watchLive() {
    const running = Boolean(view.state.running || view.state.compacting);
    if (wasRunning && !running) idleSince = Date.now();
    wasRunning = running;
    now = Date.now();
    const face = Live.newFace(view.items, seenFace);
    if (seenFace === null) {
      // On first sight, the faces already there are history: no reaction to them.
      let latestFace = "";
      for (let i = view.items.length - 1; i >= 0; i--) if (view.items[i].kind === "assistant" && view.items[i].expression) { latestFace = view.items[i].id; break; }
      seenFace = latestFace;
    } else if (face) {
      seenFace = face.id;
      if (miniShown || shown) react(face.expression);
    }
    const latest = Live.newReply(view.items, seenReply);
    if (seenReply === null) { seenReply = latest ? latest.id : ""; return; }
    if (!latest) return;
    seenReply = latest.id;
    miniText = Live.excerpt(latest.text);
    miniTextAt = Date.now();
    if (!shown && liveEnabled) popReply(latest);
  }
  // Turning live June off puts her away at once.
  onLiveEnabledChanged: if (!liveEnabled) hideMini()

  function stopJune() {
    if (send({ op: "command", requestId: rid(), name: "stop" })) say("stopping");
  }

  IpcHandler {
    target: "june"
    function toggle(): void { root.shown ? root.hide() : root.show(); }
    function open(): void { root.show(); }
    function close(): void { root.hide(); }
    function mini(): void { root.miniShown ? root.hideMini() : root.showMini(); }
    // Lights every panel as if at this hour (0 to 24, fractional), to preview the day's light; a negative hour or
    // "now" goes back to each panel's own.
    function light(hour: string): void { const h = Number(hour); root.lightHour = hour === "now" || isNaN(h) ? -1 : h; }
    // The strip in an ordinary window, for the launcher.
    function window(): void { root.windowShown = true; }
    // Live June on, off, or flipped (anything else), as the window's toggle does.
    function live(state: string): void { root.liveEnabled = state === "on" ? true : state === "off" ? false : !root.liveEnabled; }
    // The comic strip or the console look; anything else flips between them.
    function look(name: string): void { root.look = Console.LOOKS.includes(name) ? name : root.look === "console" ? "comic" : "console"; }
    // Hidden, then live June with the note open, then the full strip, then hidden: one key for everything. When she has
    // popped up by herself, the first press opens her note under her reply, as if she had been summoned.
    function cycle(): void {
      if (root.shown) root.hide();
      else if (!root.liveEnabled) root.show();
      else if (root.miniShown && root.miniInput) root.show();
      else if (root.miniShown) root.answerMini();
      else root.showMini();
    }
  }

  LiveWindow {
    id: live
    screen: root.miniScreen
    shown: root.miniShown && !root.shown && root.liveEnabled
    liveState: root.liveState
    art: root.liveArt[root.liveState] ?? root.liveArt["sipping"] ?? null
    reaction: root.reaction
    face: root.liveFace
    status: root.liveWords[root.liveState] ?? ""
    message: root.miniText
    messageShown: root.miniMessage
    inputShown: root.miniInput
    onOpenStrip: root.show()
    onWantInput: root.answerMini()
    onDismissed: root.hideMini()
    onSubmitted: (text, followUp) => {
      if (root.submit(text, followUp)) { root.miniInput = false; root.miniMessage = false; root.miniSummoned = false; tuckAway.interval = 8000; tuckAway.restart(); }
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
  // When a run ends, the panel she answered in keeps her talking pose until her real face arrives (expression.ts picks
  // it a few seconds later), so no guessed face shows in between; after this long, a stand-in.
  readonly property int faceHoldMs: 6000
  property real faceHoldUntil: 0
  property bool syncWasRunning: false
  property var livePoses: ({})
  Timer { id: faceHold; onTriggered: root.sync() }

  function sync() {
    const list = Strip.panels(view.items);
    const running = Boolean(view.state.running || view.state.compacting);
    if (syncWasRunning && !running) {
      faceHoldUntil = Date.now() + faceHoldMs;
      faceHold.interval = faceHoldMs + 50;
      faceHold.restart();
    }
    syncWasRunning = running;
    let previousSide = undefined;
    let previousPose = "";
    const composed = list.map((p, i) => {
      const live = i === list.length - 1 && (view.state.running || view.state.compacting);
      // While she works or thinks, a pose showing that; while she writes, her expression; settled, the face the daemon
      // picked for her reply, or a kept stand-in until it arrives.
      const doing = live ? Compose.liveActivity(view.state, p) : null;
      const face = live ? null : Compose.picked(p);
      const holding = !live && !face && i === list.length - 1 && Date.now() < faceHoldUntil && livePoses[p.id] !== undefined;
      let pose = live ? Compose.choosePose(poses, doing ? { activity: doing, expression: "curious" } : Compose.standIn(p, true), previousPose, p.id)
        : face ? Compose.choosePose(poses, face, previousPose, p.id)
        : holding ? (poses.find(x => x.id === livePoses[p.id]) ?? null)
        : (poses.find(x => x.id === poseIds[p.id]) ?? null);
      if (live && pose) livePoses[p.id] = pose.id;
      if (!pose && !live) {
        pose = Compose.choosePose(poses, Compose.standIn(p, false), previousPose, p.id);
        if (pose) poseIds[p.id] = pose.id;
      }
      if (!sides[p.id]) sides[p.id] = Compose.chooseSide(previousSide, pose);
      previousSide = sides[p.id];
      previousPose = pose ? pose.id : "";
      return Object.assign({}, p, { side: sides[p.id], pose: pose, live: live });
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

  StripWindow { shell: root }

  // Max mode: the strip at the screen's right edge, full height, unfolding out of live June's card, which stays in the
  // same corner as in min mode. See "Live June" in docs/interfaces.org.
  PanelWindow {
    id: window
    visible: root.shown
    screen: root.targetScreen
    anchors { top: true; bottom: true; left: true; right: true }
    exclusionMode: ExclusionMode.Ignore
    color: "transparent"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.namespace: "june-overlay"
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    onVisibleChanged: if (visible) composer.focusInput()

    // Esc hides from anywhere in the overlay, even after a click put the focus in a balloon to select its words.
    Shortcut { sequence: "Escape"; onActivated: root.hide() }
    // Page through the strip: Ctrl+N toward newer panels, Ctrl+P toward earlier ones.
    Shortcut { sequence: "Ctrl+N"; onActivated: list.page(1) }
    Shortcut { sequence: "Ctrl+P"; onActivated: list.page(-1) }

    // The backdrop dims as the strip unfolds; a click on it puts everything away.
    Rectangle { anchors.fill: parent; color: Theme.backdrop; opacity: root.unfold }
    MouseArea { anchors.fill: parent; onClicked: root.hide() }

    Item {
      id: page
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.bottom: parent.bottom
      width: Math.min(Theme.stripWidth, parent.width - 32)
      // The unfold in two overlapping beats: the input grows out of her card, then the strip fades in, rising a little.
      readonly property real inputPhase: Math.min(1, root.unfold / 0.4)
      readonly property real stripPhase: Math.max(0, Math.min(1, (root.unfold - 0.2) / 0.8))
      readonly property int dockHeight: 150 + 22

      // The paper fades in behind the input, rising the last few dozen pixels into place: a short, soft move rather than
      // a wipe across the whole screen.
      Rectangle {
        id: paper
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        height: page.height
        color: Theme.paper
        clip: true
        opacity: page.stripPhase
        transform: Translate { y: (1 - page.stripPhase) * 56 }
        MouseArea { anchors.fill: parent } // clicks on the page stay on it

        // Laid out at full height, so the strip does not re-lay itself out as it moves.
        Item {
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.bottom: parent.bottom
          height: page.height

          Masthead {
            id: masthead
            anchors.top: parent.top
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.margins: 16
            linked: root.linked
            refusals: root.refusals
            host: root.host
            busy: Boolean(root.view.state.running || root.view.state.compacting)
            activity: root.activity
            background: root.view.state.background ?? 0
          }

          StripList {
            id: list
            anchors.top: masthead.bottom
            anchors.bottom: parent.bottom
            anchors.bottomMargin: page.dockHeight + 8
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.leftMargin: 16
            anchors.rightMargin: 16
            anchors.topMargin: 16
            model: strip
            activity: root.activity
            poses: root.poses
            now: root.now
            hourOverride: root.lightHour
            scenery: root.scenery
            sky: root.view.state.sky ?? null
            linked: root.linked
          }

          Toast {
            anchors.bottom: list.bottom
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.bottomMargin: 6
            text: root.toast
          }
        }
      }

      // Live June's card, in the corner where min mode keeps her; a click shrinks the strip back down to her.
      LiveCard {
        id: maxCard
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.rightMargin: 22
        anchors.bottomMargin: 22
        liveState: root.liveState
        art: root.liveArt[root.liveState] ?? root.liveArt["sipping"] ?? null
        reaction: root.reaction
        face: root.liveFace
        running: root.shown
        // Already on screen when the strip grows out of min mode or shrinks back to it; otherwise she fades in with it.
        opacity: root.cardSteady ? 1 : Math.min(1, root.unfold * 3)
        onClicked: root.toMini()
      }

      // The user's balloon, growing leftward out of her card; Ctrl+N and Ctrl+P page through the strip, Esc hides.
      Composer {
        id: composer
        anchors.right: maxCard.left
        anchors.rightMargin: 14
        anchors.bottom: maxCard.bottom
        anchors.bottomMargin: 44
        width: Math.max(0, maxCard.x - 14 - 16) * page.inputPhase
        visible: width > 30
        send: (text, followUp) => root.submit(text, followUp)
        stop: () => root.stopJune()
      }
    }
  }
}
