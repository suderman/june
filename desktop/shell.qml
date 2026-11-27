// June's desktop client: a resident Quickshell client that shows the one conversation as a comic strip above
// every window, fullscreen ones included, without taking the active window. It talks to the daemon over the WebSocket
// listener with a device token (see "Client protocol for graphical clients" in docs/architecture.org).
//
// Environment, set by the june-desktop wrapper: JUNE_DESKTOP_URL (wss://june.kit/), JUNE_DESKTOP_TOKEN_FILE (a 0600
// file holding this device's token), JUNE_DESKTOP_FONTS (a directory of the strip's fonts), and JUNE_DESKTOP_ART (avatar
// set directories, colon-separated, a personal set before the base one; see "Poses" in docs/interfaces.org).
// One key cycles the desktop client (`june-desktop cycle`, for an Alt tap): hidden, live June in the corner with her note
// open, the full strip, hidden again; if she popped up by herself, the first press opens her note. Esc dismisses either. `toggle`, `open`, `close`, and `mini` reach each directly.
// `window` opens the same strip in an ordinary window with this device's toggles (StripWindow.qml).
// Shared modules must run in QML's JS engine too. Node-only array helpers can blank both looks.
import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
import QtQml.Models
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import Quickshell.Hyprland
import "strip.mjs" as Strip
import "compose.mjs" as Compose
import "live.mjs" as Live
import "scenery.mjs" as Scenery
import "console.mjs" as Console
import "desktop.mjs" as Desktop
import "attach.mjs" as Attach
import "board.mjs" as Board

ShellRoot {
  id: root

  property bool shown: false
  // The windowed strip, and this device's toggles: state while the desktop client runs, never written to config.
  property bool windowShown: false
  // In a narrow window or narrow overlay, which of chat and the two boards shows: chat, agents, or projects.
  property string windowTab: "chat"
  property string overlayTab: "chat"
  // Live June in the corner: off, she never pops up and the key goes straight between hidden and the strip.
  property bool liveEnabled: true
  // The comic strip, or the console look for when June should look professional (a client meeting).
  property string look: "comic"
  Binding { target: Theme; property: "consoleLook"; value: root.look === "console" }

  // The desktop's say, polled over D-Bus (desktop.mjs): mako's modes, null without mako, and the portal's colour scheme.
  property var systemModes: null
  property var systemScheme: null
  // This device's colour scheme: follow the system, or hold to dark or light.
  property string scheme: "system"
  Binding { target: Theme; property: "dark"; value: Desktop.isDark(root.scheme, root.systemScheme) }
  // Do not disturb: she never pops up by herself, though summoning her works as ever. It is mako's mode, so the
  // desktop and June keep one switch; without mako it is this device's alone.
  property bool localQuiet: false
  // The mode asked of mako, shown at once until mako's own modes say it took, or the call fails.
  property var askedQuiet: null
  readonly property bool quiet: askedQuiet !== null ? askedQuiet : systemModes === null ? localQuiet : Desktop.quietIn(systemModes)
  // Bumped after Hyprland events and refreshes so `juneWindow` re-evaluates against fresh monitor/toplevel state.
  property int hyprTick: 0
  Timer { id: hyprSettle; interval: 120; onTriggered: root.hyprTick += 1 }
  function refreshHyprWindow() {
    if (!Hyprland.requestSocketPath) return;
    Hyprland.refreshMonitors();
    Hyprland.refreshToplevels();
    hyprTick += 1;
    hyprSettle.restart();
  }
  onWindowShownChanged: if (windowShown) refreshHyprWindow()
  Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (root.windowShown && Desktop.HYPR_REFRESH_EVENTS.includes(event.name)) root.refreshHyprWindow();
    }
  }
  function readJuneWindow() {
    const mons = [];
    const monValues = Hyprland.monitors ? Hyprland.monitors.values : [];
    for (let i = 0; i < monValues.length; i++) {
      const m = monValues[i];
      const ipc = m.lastIpcObject || {};
      mons.push({
        id: m.id,
        activeWorkspaceId: m.activeWorkspace ? m.activeWorkspace.id : (ipc.activeWorkspace ? ipc.activeWorkspace.id : 0),
        specialWorkspaceId: ipc.specialWorkspace ? ipc.specialWorkspace.id : 0,
      });
    }
    const tls = [];
    const tlValues = Hyprland.toplevels ? Hyprland.toplevels.values : [];
    for (let i = 0; i < tlValues.length; i++) {
      const t = tlValues[i];
      const ipc = t.lastIpcObject || {};
      const ws = t.workspace;
      tls.push({
        address: t.address || ipc.address || "",
        title: t.title || ipc.title || "",
        appId: t.wayland ? (t.wayland.appId || "") : "",
        className: ipc.class || "",
        pid: ipc.pid || 0,
        workspaceId: ws ? ws.id : (ipc.workspace ? ipc.workspace.id : 0),
        workspaceActive: ws ? Boolean(ws.active) : false,
        workspaceHasFullscreen: ws ? Boolean(ws.hasFullscreen) : false,
        mapped: ipc.mapped !== false,
        hidden: Boolean(ipc.hidden),
        fullscreen: Boolean(ipc.fullscreen),
      });
    }
    return Desktop.juneWindowVisibility({
      windowShown: root.windowShown,
      windowWidth: stripWindow.width,
      windowHeight: stripWindow.height,
      windowFocused: stripWindow.focused,
      pid: Quickshell.processId,
      appId: Quickshell.appId,
      monitors: mons,
      toplevels: tls,
    });
  }
  readonly property var juneWindow: {
    const _dep = root.hyprTick
      + (root.windowShown ? 1 : 0)
      + stripWindow.width
      + stripWindow.height
      + (stripWindow.focused ? 1 : 0)
      + (Hyprland.focusedWorkspace ? Hyprland.focusedWorkspace.id : 0)
      + (Hyprland.focusedMonitor ? Hyprland.focusedMonitor.id : 0)
      + (Hyprland.activeToplevel ? 1 : 0);
    return root.readJuneWindow();
  }
  readonly property bool windowVisible: juneWindow.visible
  function focusJuneWindow() {
    if (miniShown) hideMini();
    const state = readJuneWindow();
    if (state.address !== "") {
      const req = Desktop.focusWindowDispatch(state.address, Boolean(Hyprland.usingLua));
      if (req !== "") Hyprland.dispatch(req);
    }
    stripWindow.focusComposer(true);
  }
  onQuietChanged: if (quiet && miniShown && !miniSummoned) hideMini()
  onWindowVisibleChanged: if (windowVisible && miniShown && !miniSummoned) hideMini()
  onSystemModesChanged: if (askedQuiet !== null && !quietSetter.running && systemModes !== null && Desktop.quietIn(systemModes) === askedQuiet) askedQuiet = null
  function setQuiet(on) {
    if (systemModes === null) { localQuiet = on; return; }
    if (quietSetter.running) return;
    askedQuiet = on;
    quietSetter.command = Desktop.setQuietCall(systemModes, on);
    quietSetter.running = true;
  }
  Process {
    id: modesReader
    command: Desktop.MODES_CALL
    stdout: StdioCollector { onStreamFinished: root.systemModes = Desktop.parseModes(text) }
    onExited: (code, status) => { if (code !== 0) root.systemModes = null; }
  }
  Process {
    id: schemeReader
    command: Desktop.SCHEME_CALL
    stdout: StdioCollector { onStreamFinished: root.systemScheme = Desktop.parseScheme(text) }
  }
  Process {
    id: quietSetter
    // A failed call puts back what mako says.
    onExited: (code, status) => { if (code !== 0) root.askedQuiet = null; else quietSettle.restart(); modesReader.running = true; }
  }
  // However the call went, mako's own modes are the truth a few seconds on.
  Timer { id: quietSettle; interval: 4000; onTriggered: root.askedQuiet = null }
  // Opens a herdr link (herdr-link focuses or resumes the agent's pane in kitty) or a file link (emacsclient).
  Process { id: linker }
  // Focuses or launches Terminal (Herdr) or Editor (Emacs) from the icon shortcuts.
  Process { id: appLauncher }
  function openApp(app) {
    if (appLauncher.running) return false;
    const cmd = Desktop.appLaunchCommand(app, {
      JUNE_DESKTOP_TERMINAL: Quickshell.env("JUNE_DESKTOP_TERMINAL") || "",
      JUNE_DESKTOP_EDITOR: Quickshell.env("JUNE_DESKTOP_EDITOR") || "",
    });
    if (!cmd) return false;
    appLauncher.command = cmd;
    appLauncher.running = true;
    return true;
  }
  // Opens a link from June's words as Strip.linkKind allows: a web page in the browser, an agent's session through
  // herdr-link, a file in Emacs through emacsclient. Returns whether it opened, so the desktop client can step aside for what did.
  function openLink(url) {
    const kind = Strip.linkKind(url);
    if (kind === "web") return Qt.openUrlExternally(url);
    // A moment in June's history opens here, in the strip, which stays.
    if (kind === "moment") {
      openMoment(Strip.momentOf(url));
      if (!shown && !windowShown) show();
      return false;
    }
    if (kind === null || linker.running) return false;
    linker.command = kind === "herdr" ? ["herdr-link", "jump", url] : Strip.emacsCall(url);
    linker.running = true;
    return true;
  }
  Timer {
    interval: 3000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: { modesReader.running = true; schemeReader.running = true; }
  }
  property alias stripModel: strip
  property var targetScreen: Quickshell.screens[0]
  property var view: Strip.emptyView()
  property alias linked: connection.linked
  property var taking: ({})
  onLinkedChanged: if (!linked) taking = ({})
  // Closed before hello twice running: the token is wrong or revoked, so stop hammering and say so.
  property alias refusals: connection.refusals
  property string toast: ""
  property int seq: 0

  readonly property string url: Quickshell.env("JUNE_DESKTOP_URL") || "wss://june.kit/"
  readonly property string host: (/^wss?:\/\/(?:june\.)?([^/:.]+)/.exec(url) ?? [null, "the server"])[1]
  readonly property string fonts: Quickshell.env("JUNE_DESKTOP_FONTS") || ""
  // A past day shows no live activity: what she is doing now belongs to today.
  readonly property string activity: past ? "" : Strip.activity(view.state, linked)

  // Browsing June's history (Browse.qml): the days with conversation and the day it is now, from the daemon; the past
  // day on show, fixed, or null for today's live view; and the latest search's hits. A day starts at June's wake.
  property var days: []
  property string today: ""
  property var past: null
  property var hits: []
  property bool hitsMore: false
  property bool searchDone: false
  property string searchId: ""
  // The agenda and agents boards (src/board.ts), fetched once something shows them and again whenever their revision
  // in the view state moves; asking keeps them fresh in the daemon for this connection. See "Agents and projects" in
  // docs/interfaces.org.
  property bool boardsWanted: false
  property var agendaBoard: null
  property var agentsBoard: null
  property var boardRevisions: ({ agenda: "", agents: "" })
  property real boardNow: Date.now()
  readonly property var agendaView: Board.agendaView(agendaBoard, pendingEdits, agentsBoard?.user ?? "")
  readonly property var agentsView: Board.agentsView(agentsBoard, boardNow, agendaBoard?.today ?? "", agentsBoard?.user ?? "", pendingEdits)
  function wantBoards() {
    if (boardsWanted) return;
    boardsWanted = true;
    fetchBoards(true, true);
  }
  // The user's edits from a task's page (src/board-edit.ts), and what the last one said.
  // Each task has an outbox (board.mjs entryChanges): an edit shows as made the moment it is tapped; one goes to the
  // daemon at a time, and taps meanwhile queue behind it, the same kind settling on the last. A refusal drops it and
  // all queued behind it, a dropped connection or no answer does too, and the board's state shows again; once saved,
  // the overlay goes when the boards that carry the edit arrive.
  // pendingEdits: { [key]: { applied, change, queue, id, done, at, undo } }, and seen: the reviews opened since the
  // last agents board.
  property var taskNotice: ({ key: "", text: "", pending: "", from: "", undo: null })
  // The roster's clankers (board.mjs rosterView), for handing a task to one from the projects board's pages too.
  readonly property var rosterCards: Board.rosterView(agentsBoard).cards
  property var pendingEdits: ({})
  property var rosterNotice: ({ text: "", busy: false, seq: 0, saved: "", deleted: false })
  property string rosterPendingId: ""
  property bool rosterDeleting: false
  function editRoster(edit) {
    const id = rid();
    if (!send({ op: "roster", requestId: id, edit: edit })) {
      rosterNotice = { text: "not connected", busy: false, seq: rosterNotice.seq + 1, saved: "", deleted: false };
      return;
    }
    rosterPendingId = id;
    rosterDeleting = edit.action === "delete";
    rosterNotice = { text: "", busy: true, seq: rosterNotice.seq + 1, saved: "", deleted: false };
  }
  // A deploy from the boards (src/deploy.ts) on its way, and why the last one failed; its session then shows in the
  // Herdr app here (Desktop.showDeployedCommand).
  property var deployNotice: ({ text: "", busy: false })
  property string deployPendingId: ""
  function deploy(request) {
    const id = rid();
    if (!send(Object.assign({ op: "deploy", requestId: id }, request))) {
      deployNotice = { text: "not connected", busy: false };
      return;
    }
    deployPendingId = id;
    deployNotice = { text: "", busy: true };
  }
  // Showing a session in herdr-app; a failure is logged with its words, since nothing else shows it.
  Process {
    id: shower
    property string showing: ""
    stderr: StdioCollector { id: showerErrors }
    onExited: (code) => {
      if (code !== 0) console.warn("showing", showing, "failed with", code + ":", showerErrors.text.trim());
    }
  }
  function showSession(host, terminal) {
    if (shower.running) {
      console.warn("showing", host + "/" + terminal, "skipped: showing", shower.showing, "is still running");
      return;
    }
    console.info("showing", host + "/" + terminal);
    shower.showing = host + "/" + terminal;
    shower.command = Desktop.showDeployedCommand(host, terminal);
    shower.running = true;
    hide();
  }
  Timer { id: rosterNoticeFade; interval: 4000; onTriggered: if (root.rosterNotice.text === "saved") root.rosterNotice = { text: "", busy: false, seq: root.rosterNotice.seq + 1, saved: "", deleted: false } }
  property bool agentsFetching: false
  function setPending(next) { pendingEdits = next; }
  function editTask(key, change) {
    const held = pendingEdits[key];
    if (held && !held.done) {
      const next = Object.assign({}, pendingEdits);
      next[key] = Object.assign({}, held, { queue: Board.enqueue(held.queue ?? [], change) });
      setPending(next);
      return;
    }
    // As shown: a saved edit the board has yet to carry counts.
    const task = Board.applyEntry(Board.findTask(Object.assign({}, agendaBoard?.tasks ?? {}, agentsBoard?.tasks ?? {}), key), held, "");
    // A state change or handoff can be put back, as board.mjs undoOf says.
    const undo = Board.undoOf(change, task);
    // A saved edit the board has yet to show stays drawn under the new one.
    sendEdit(key, change, held ? (held.applied ?? []).concat([held.change]) : [], [], undo);
  }
  function sendEdit(key, change, applied, queue, undo) {
    const id = rid();
    const next = Object.assign({}, pendingEdits);
    if (!send({ op: "task", requestId: id, key: key, edit: change })) {
      delete next[key];
      setPending(next);
      taskNotice = { key: key, text: "not connected", pending: "", from: "", undo: null };
      return;
    }
    next[key] = { applied: applied, change: change, queue: queue, id: id, done: false, at: Date.now(), undo: undo };
    setPending(next);
    taskNotice = { key: key, text: "", pending: id, from: "", undo: null };
  }
  function pendingById(id) {
    for (const key in pendingEdits) if (key !== "seen" && pendingEdits[key].id === id) return key;
    return "";
  }
  function dropPending(keys) {
    if (keys.length === 0) return;
    const next = Object.assign({}, pendingEdits);
    for (const key of keys) delete next[key];
    setPending(next);
  }
  // Saved edits stop overlaying once a board newer than the save has arrived.
  function settlePending() {
    if (agentsFetching) return;
    const next = Object.assign({}, pendingEdits);
    for (const k of Object.keys(pendingEdits)) {
      if (k === "seen") continue;
      if (pendingEdits[k].done) delete next[k];
      else if ((pendingEdits[k].applied ?? []).length > 0) next[k] = Object.assign({}, pendingEdits[k], { applied: [] });
    }
    setPending(next);
  }
  Timer {
    interval: 1000; repeat: true; running: Object.keys(root.pendingEdits).length > 0
    onTriggered: {
      const now = Date.now();
      const keys = Object.keys(root.pendingEdits).filter(k => k !== "seen");
      // No answer in 30 s: show the board as it stands. A save whose boards never moved settles after 6 s.
      const lost = keys.filter(k => !root.pendingEdits[k].done && now - root.pendingEdits[k].at > 30000);
      if (lost.length > 0) root.taskNotice = { key: lost[0], text: "June didn't answer; this is what the board says", pending: "", from: "", undo: null };
      root.dropPending(lost.concat(keys.filter(k => root.pendingEdits[k].done && now - root.pendingEdits[k].at > 6000)));
    }
  }
  // "saved" and its undo fade after a few seconds; refusals stay until the next edit.
  Timer { id: noticeFade; interval: 5000; onTriggered: if (root.taskNotice.text === "saved") root.taskNotice = { key: root.taskNotice.key, text: "", pending: "", from: "", undo: null } }
  // A review or question the user opened is seen everywhere at once; the daemon answers with the agents board.
  function markSeen(key) {
    const next = Object.assign({}, pendingEdits);
    next.seen = (pendingEdits.seen ?? []).concat([key]);
    setPending(next);
    send({ op: "seen", requestId: rid(), keys: [key] });
  }
  function fetchBoards(agenda, agents) {
    if (agenda) send({ op: "agenda", requestId: rid() });
    if (agents && send({ op: "agents", requestId: rid() })) agentsFetching = true;
  }
  // "3 min ago" moves on without a new board.
  Timer { interval: 60000; running: root.boardsWanted; repeat: true; onTriggered: root.boardNow = Date.now() }
  // The panel holding the moment opened, marked in the strip; "" for none.
  property string markedPanel: ""
  // Each strip lands on a day as it opens: on its newest panel, or on the panel holding the moment.
  signal landed(string panel)
  function listDays() { send({ op: "days", requestId: rid() }); }
  function openDay(date) {
    if (date === today) backToToday();
    else send({ op: "day", requestId: rid(), date: date });
  }
  function openMoment(id) { if (id !== undefined) send({ op: "day", requestId: rid(), at: id }); }
  function backToToday() {
    if (past === null) return;
    past = null;
    markedPanel = "";
    sync();
    landed("");
  }
  function search(words) {
    searchId = rid();
    hits = [];
    hitsMore = false;
    searchDone = words.trim() === "";
    if (!searchDone) send({ op: "search", requestId: searchId, query: words, limit: 50 });
  }
  // The masthead's plain phrase and the tasks she follows.
  // Tasks the user dismissed at their signal, for this run of the desktop client.
  property var seen: []
  readonly property var status: Strip.status(view.state, host, seen)
  function dismiss(key) {
    const live = (view.state.follows ?? []).map(f => Strip.followKey(f));
    seen = seen.filter(k => live.includes(k)).concat([key]);
  }

  // June's poses from every avatar set, the first set winning a shared name. The wrapper names the local sets, a
  // personal one (when this machine has it) before the base set from the package; without a local personal set, the
  // daemon's comes first, loaded over HTTP from the path its hello gives this device.
  readonly property var artDirs: (Quickshell.env("JUNE_DESKTOP_ART") || "").split(":").filter(d => d !== "")
  readonly property bool localPersonal: artDirs.length > 1
  // Each set read, by its place in the order: the daemon's at -1, then the local ones from 0.
  property var artSources: ({})
  property var poses: []
  // Live June's art by state, the first set winning.
  // Rooms, window views, and props from every set, the first set winning a shared id.
  property var scenery: ({ rooms: [], plates: [], props: [] })

  Instantiator {
    model: root.artDirs
    delegate: FileView {
      required property string modelData
      path: modelData + "/manifest.json"
      blockLoading: true
    }
    onObjectAdded: (index, object) => root.addArt(index, "file://" + root.artDirs[index] + "/", object.text())
  }

  // The daemon's set, when this machine has no personal set of its own: its manifest from the hello's path, on the
  // listener's host. A daemon without a set answers 404 and the local sets stand alone.
  // The pictures the user's messages brought, on the listener's host under the hello's path; "" without one.
  property string attached: ""
  function attachedUrl(path) {
    const origin = /^(wss?):\/\/([^/]+)/.exec(url);
    return origin && typeof path === "string" && path !== "" ? (origin[1] === "wss" ? "https://" : "http://") + origin[2] + path : "";
  }

  function fetchArt(path) {
    if (localPersonal || typeof path !== "string" || path === "") return;
    const origin = /^(wss?):\/\/([^/]+)/.exec(url);
    if (!origin) return;
    const base = (origin[1] === "wss" ? "https://" : "http://") + origin[2] + path;
    const request = new XMLHttpRequest();
    request.onreadystatechange = () => {
      if (request.readyState !== XMLHttpRequest.DONE) return;
      if (request.status === 200) addArt(-1, base, request.responseText);
      else if (request.status !== 404) console.warn("june desktop: the daemon's avatar set did not load:", request.status);
    };
    request.open("GET", base + "manifest.json");
    request.send();
  }

  function addArt(order, base, text) {
    const sources = Object.assign({}, artSources);
    try {
      const manifest = JSON.parse(text);
      sources[order] = { poses: Compose.readPoses(manifest, base), scenery: Scenery.readScenery(manifest, base) };
    }
    catch (e) { console.warn("june desktop: no usable avatar set at", base); sources[order] = { poses: [], scenery: null }; }
    artSources = sources;
    const ordered = Object.keys(sources).map(Number).sort((a, b) => a - b).map(k => sources[k]);
    scenery = Scenery.mergeScenery(ordered.map(s => s.scenery));
    // Real art only, once there is any: the base set's drawn placeholders are left out (Compose.mergePoses).
    poses = Compose.mergePoses(ordered.map(s => s.poses));
    sync();
  }

  FontLoader { source: root.fonts ? "file://" + root.fonts + "/ShantellSans[BNCE,INFM,SPAC,wght].ttf" : "" }
  FontLoader { source: root.fonts ? "file://" + root.fonts + "/ShantellSans-Italic[BNCE,INFM,SPAC,wght].ttf" : "" }
  FontLoader { source: root.fonts ? "file://" + root.fonts + "/DelaGothicOne-Regular.ttf" : "" }
  FontLoader { source: root.fonts ? "file://" + root.fonts + "/ZenKakuGothicNew-Bold.ttf" : "" }
  FontLoader { source: root.fonts ? "file://" + root.fonts + "/ZenKakuGothicNew-Regular.ttf" : "" }

  ListModel { id: strip } // newest panel first, so the list grows upward from the input
  // The newest panel's JSON, which live June shows on its own (a ListModel's rows do not notify a binding).
  property string newestPanel: ""

  readonly property var currentScreen: {
    const name = Hyprland.focusedMonitor ? Hyprland.focusedMonitor.name : "";
    return Quickshell.screens.find(s => s.name === name) || Quickshell.screens[0];
  }
  readonly property bool focusedFullscreen: Boolean(Hyprland.focusedWorkspace && Hyprland.focusedWorkspace.hasFullscreen)
  function focusedScreen() {
    return currentScreen;
  }
  // The unfold: 0 is live June alone (her newest panel and compose bar), 1 the full strip around them. About a quarter
  // second either way.
  property real unfold: 0
  // The compose bar stays put through the unfold when it is already on screen, coming from live June.
  property bool cardSteady: false
  // Between live June and the full strip both show for the length of the unfold, her panel and compose bar where the
  // strip's are, so nothing blinks: she goes once the strip has grown around her, and comes at once as it shrinks.
  property bool miniBridge: false
  NumberAnimation {
    id: unfolding
    target: root
    property: "unfold"
    duration: 220
    easing.type: Easing.OutQuart
    onFinished: {
      if (root.unfold > 0.001) {
        if (root.miniBridge) { root.miniBridge = false; live.instant = true; root.hideMini(); Qt.callLater(() => live.instant = false); }
        return;
      }
      root.shown = false;
      if (root.miniBridge) { root.miniBridge = false; live.refocus(); Qt.callLater(() => live.instant = false); }
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
    // A draft started in live June carries on in the strip.
    if (fromMini && live.draft !== "") { composer.text = live.draft; live.draft = ""; }
    if (fromMini) miniBridge = true;
    else hideMini();
    shown = true;
    list.landOnNewest();
    unfoldTo(1);
  }
  function hide() {
    if (!shown) return;
    cardSteady = false;
    miniBridge = false;
    unfoldTo(0);
  }
  // Tab in the strip's compose bar: shrink back into live June, her compose bar open with any draft.
  function toMini() {
    if (!shown) return;
    if (!liveEnabled) { hide(); return; }
    miniScreen = targetScreen;
    if (composer.text !== "") { live.draft = composer.text; composer.clear(); }
    live.instant = true;
    miniShown = true;
    miniSummoned = true;
    miniInput = true;
    miniBridge = true;
    cardSteady = true;
    unfoldTo(0);
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
  readonly property string liveState: Live.liveState({ view: view, linked: linked, now: new Date(now), idleSince: idleSince, once: oneShot })

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
    wantBoards();
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
  // After each view change: note when a run ends, and pop up for a newly finished desktop reply while the strip is
  // hidden.
  function watchLive() {
    const running = Boolean(view.state.running || view.state.compacting);
    if (wasRunning && !running) idleSince = Date.now();
    wasRunning = running;
    now = Date.now();
    const latest = Live.newReply(view.items, seenReply);
    if (seenReply === null) { seenReply = latest ? latest.id : ""; return; }
    if (!latest) return;
    seenReply = latest.id;
    miniText = Live.excerpt(latest.text);
    miniTextAt = Date.now();
    if (Live.shouldPopReply({ overlayShown: shown, windowVisible: root.readJuneWindow().visible, liveEnabled: liveEnabled, quiet: quiet })) popReply(latest);
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
    function refresh(): void { root.refresh(); }
    function close(): void { root.hide(); }
    // The other size (Hyprland's long press of Alt while June shows, Jon 2026-11-26): the full strip shrinks into live
    // June and she grows into it, as Tab does; with neither showing, live June comes.
    function mini(): void {
      if (root.shown) root.toMini();
      else if (root.miniShown && root.liveEnabled) root.show();
      else root.showMini();
    }
    // Lights every panel as if at this hour (0 to 24, fractional), to preview the day's light; a negative hour or
    // "now" goes back to each panel's own.
    function light(hour: string): void { const h = Number(hour); root.lightHour = hour === "now" || isNaN(h) ? -1 : h; }
    // The strip in an ordinary window, for the launcher.
    function window(): void { root.windowShown = true; }
    // The windowed strip on one of its tabs: chat (or legacy strip), agents, or projects.
    function tab(name: string): void { const t = Desktop.normalizeTab(name); if (t) root.windowTab = t; root.windowShown = true; }
    // June's history: a day by its date (YYYY-MM-DD), a moment by its entry id, or back to today.
    function day(date: string): void { root.openDay(date); }
    function at(id: string): void { root.openMoment(Strip.momentOf("june:at/" + id)); }
    function today(): void { root.backToToday(); }
    // Live June on, off, or flipped (anything else), as the window's toggle does.
    function live(state: string): void { root.liveEnabled = state === "on" ? true : state === "off" ? false : !root.liveEnabled; }
    // Do not disturb on or off (mako's mode when mako runs); anything else flips it.
    function quiet(state: string): void { root.setQuiet(state === "on" ? true : state === "off" ? false : !root.quiet); }
    // Follow the system's colour scheme, or hold to dark or light.
    function scheme(name: string): void { if (Desktop.SCHEMES.includes(name)) root.scheme = name; }
    // The comic strip or the console look; anything else flips between them.
    function look(name: string): void { root.look = Console.LOOKS.includes(name) ? name : root.look === "console" ? "comic" : "console"; }
    // The Alt tap (Jon, 2026-11-26): live June on and off, her compose bar open; Tab there opens the full strip. When
    // she has popped up by herself, the tap opens her compose bar under her news, as if she had been summoned; from
    // the full strip it puts everything away. With live June off, it opens and closes the strip.
    function cycle(): void {
      const action = Live.cycleAction({
        overlayShown: root.shown,
        windowVisible: root.readJuneWindow().visible,
        liveEnabled: root.liveEnabled,
        miniShown: root.miniShown,
        miniInput: root.miniInput,
      });
      if (action === "hide") root.hide();
      else if (action === "focusWindow") root.focusJuneWindow();
      else if (action === "show") root.show();
      else if (action === "hideMini") root.hideMini();
      else if (action === "answerMini") root.answerMini();
      else root.showMini();
    }
  }

  LiveWindow {
    id: live
    screen: root.miniScreen
    shown: root.miniShown && (!root.shown || root.miniBridge) && root.liveEnabled
    panelJson: root.newestPanel
    activity: root.activity
    poses: root.poses
    now: root.now
    hourOverride: root.lightHour
    scenery: root.scenery
    sky: root.view.state.sky ?? null
    attached: root.attached
    inputShown: root.miniInput
    // Where the strip's compose bar is on her screen: on its tab bar when the boards do not fit beside the strip.
    dock: Board.overlayBoards((root.miniScreen ? root.miniScreen.width : 1920) - Math.min(Theme.stripWidth, (root.miniScreen ? root.miniScreen.width : 1920) - 32)).fits ? 22 : 10 + 46 + 8
    // Sent from her compose bar: it closes, and she stays a while to show the answer coming.
    send: (text, followUp) => {
      if (!root.submit(text, followUp)) return false;
      root.miniInput = false; root.miniMessage = false; root.miniSummoned = false;
      tuckAway.interval = 8000; tuckAway.restart();
      return true;
    }
    stop: () => root.stopJune()
    attachments: root.outbox
    unattach: index => root.unattach(index)
    paste: fallback => root.pasteInto(fallback)
    onOpenStrip: root.show()
    onDismissed: root.hideMini()
  }

  // Persistent patrolling clanker shelf: rests in Hyprland's bottom margin gap on the focused monitor while minimised
  // June is away, and rides smoothly up onto her panel when she rises.
  ShelfWindow {
    id: shelf
    screen: live.visible ? root.miniScreen : root.currentScreen
    shelf: root.agentsView.working ?? []
    active: root.liveEnabled && !root.shown && (live.visible || !root.focusedFullscreen)
    perched: live.shown
    perchBottom: live.panelTopFromBottom
    onVisit: (host, terminal) => root.showSession(host, terminal)
  }

  FileView { id: tokenFile; path: Quickshell.env("JUNE_DESKTOP_TOKEN_FILE") || ""; blockLoading: true }

  Connection {
    id: connection
    url: root.url
    token: () => { tokenFile.reload(); return tokenFile.text().trim(); }
    onReceived: reply => root.receive(reply)
  }
  Timer { id: toastTimer; interval: 6000; onTriggered: root.toast = "" }

  function rid() { seq += 1; return "gui-" + Date.now() + "-" + seq; }
  function send(request) { return connection.send(request); }
  function refresh() { connection.refresh(); }
  function take(action) {
    if (!linked || taking[action.reply]) return;
    const requestId = rid();
    if (!send({ op: action.op, requestId: requestId, reply: action.reply, revision: action.revision })) return;
    const pending = Object.assign({}, taking);
    pending[action.reply] = requestId;
    taking = pending;
    say(action.op === "retake" ? "choosing another take…" : action.op === "restore" ? "restoring the previous take…" : "restoring the next take…");
  }
  function say(text) { toast = text; toastTimer.restart(); }

  // Pictures and files waiting for the next message, shared by the desktop client's balloon and the strip window's: pasted,
  // dropped or picked, read by attach.sh, held to the daemon's limits by attach.mjs, and sent with the words.
  property var outbox: []
  property var pasteFallback: null
  readonly property string attachScript: Quickshell.shellPath("attach.sh")
  Process {
    id: attacher
    stdout: StdioCollector { onStreamFinished: root.attachRead(text) }
    // Exit 1 from a paste: the clipboard holds words, so they go into the balloon as before.
    onExited: (code, status) => { if (code !== 0 && root.pasteFallback) root.pasteFallback(); root.pasteFallback = null; }
  }
  function attachPaths(paths) {
    if (attacher.running || paths.length === 0) return;
    pasteFallback = null;
    attacher.command = Attach.readCommand(attachScript, paths);
    attacher.running = true;
  }
  function pasteInto(fallback) {
    if (attacher.running) return;
    pasteFallback = fallback;
    attacher.command = Attach.pasteCommand(attachScript);
    attacher.running = true;
  }
  // Not `attached`, which already names where the daemon serves what messages brought.
  function attachRead(text) {
    const read = Attach.parse(text);
    if (read.items.length === 0 && read.refused.length === 0) return;
    pasteFallback = null;
    const admitted = Attach.admit(outbox, read.items);
    outbox = admitted.outbox;
    const refused = read.refused.concat(admitted.refused);
    if (refused.length > 0) say("not attached: " + refused.join("; "));
  }
  function unattach(index) { outbox = outbox.filter((_, i) => i !== index); }
  // file:// URLs from a picker or a drop, as paths.
  function pathsOf(urls) { return Array.from(urls).map(u => decodeURIComponent(String(u).replace(/^file:\/\//, ""))).filter(p => p.startsWith("/")); }

  function receive(reply) {
    if (reply.type === "hello") {
      fetchArt(reply.avatar);
      root.attached = attachedUrl(reply.attached);
      // A new connection must ask again to keep the boards fresh; an edit sent on the old one may never be answered.
      const unanswered = Object.keys(pendingEdits).filter(k => k !== "seen" && !pendingEdits[k].done);
      if (unanswered.length > 0) taskNotice = { key: unanswered[0], text: "The connection dropped; this is what the board says", pending: "", from: "", undo: null };
      dropPending(unanswered);
      if (rosterPendingId !== "") {
        rosterPendingId = "";
        rosterDeleting = false;
        rosterNotice = { text: "The connection dropped", busy: false, seq: rosterNotice.seq + 1, saved: "", deleted: false };
      }
      if (deployPendingId !== "") {
        deployPendingId = "";
        deployNotice = { text: "The connection dropped; look on the hosts tab before deploying again", busy: false };
      }
      agentsFetching = false;
      if (boardsWanted) fetchBoards(true, true);
      else if (liveEnabled) wantBoards();
      return;
    }
    if (reply.type === "agenda") {
      agendaBoard = reply.agenda;
      boardRevisions = Object.assign({}, boardRevisions, { agenda: reply.revision });
      settlePending();
      return;
    }
    if (reply.type === "task") {
      const key = pendingById(reply.requestId);
      if (key === "") return;
      const held = pendingEdits[key];
      const next = Object.assign({}, pendingEdits);
      delete next[key];
      const rest = Board.nextQueued(held.change, held.queue ?? []);
      setPending(next);
      // What was tapped meanwhile goes next, against what this one wrote.
      if (rest.length > 0) {
        sendEdit(reply.key, rest[0], (held.applied ?? []).concat([held.change]), rest.slice(1), held.undo);
        if (reply.from) taskNotice = Object.assign({}, taskNotice, { from: reply.from });
        return;
      }
      next[reply.key] = Object.assign({}, held, { queue: [], done: true, at: Date.now() });
      setPending(Object.assign({}, next));
      taskNotice = { key: reply.key, from: reply.from ?? "", text: "saved", pending: "", undo: held.undo };
      noticeFade.restart();
      return;
    }
    if (reply.type === "deploy" && reply.requestId === deployPendingId) {
      deployPendingId = "";
      deployNotice = { text: "", busy: false };
      fetchBoards(false, true);
      showSession(reply.host, reply.terminal);
      return;
    }
    if (reply.type === "error" && reply.requestId !== undefined && reply.requestId === deployPendingId) {
      deployPendingId = "";
      deployNotice = { text: reply.message, busy: false };
      return;
    }
    if (reply.type === "roster" && reply.requestId === rosterPendingId) {
      rosterPendingId = "";
      const del = rosterDeleting;
      rosterDeleting = false;
      rosterNotice = { text: del ? "" : "saved", busy: false, seq: rosterNotice.seq + 1, saved: reply.slug ?? "", deleted: del };
      if (!del) rosterNoticeFade.restart();
      fetchBoards(false, true);
      return;
    }
    if (reply.type === "error" && reply.requestId !== undefined && reply.requestId === rosterPendingId) {
      rosterPendingId = "";
      rosterDeleting = false;
      rosterNotice = { text: reply.message, busy: false, seq: rosterNotice.seq + 1, saved: "", deleted: false };
      return;
    }
    if (reply.type === "error" && reply.requestId !== undefined && pendingById(reply.requestId) !== "") {
      const key = pendingById(reply.requestId);
      dropPending([key]);
      taskNotice = { key: key, text: reply.message, pending: "", from: "", undo: null };
      return;
    }
    if (reply.type === "agents") {
      agentsBoard = reply.agents;
      boardNow = Date.now();
      boardRevisions = Object.assign({}, boardRevisions, { agents: reply.revision });
      agentsFetching = false;
      if ((pendingEdits.seen ?? []).length > 0) { const next = Object.assign({}, pendingEdits); delete next.seen; setPending(next); }
      settlePending();
      return;
    }
    if (reply.type === "view") {
      view = Strip.applyView(view, reply);
      const revisions = view.state?.boards;
      if (boardsWanted && revisions) {
        const agenda = (revisions.agenda ?? "") !== "" && revisions.agenda !== boardRevisions.agenda;
        const agents = (revisions.agents ?? "") !== "" && revisions.agents !== boardRevisions.agents;
        // Asked once per revision: a streaming reply sends the same state many times a second.
        if (agenda || agents) boardRevisions = { agenda: revisions.agenda ?? boardRevisions.agenda, agents: revisions.agents ?? boardRevisions.agents };
        fetchBoards(agenda, agents);
      }
      // A fresh view, on attach or at the day's start: the days may have moved on.
      if (reply.reset === true) listDays();
      sync();
      watchLive();
      return;
    }
    if (reply.type === "days") {
      days = reply.days;
      today = reply.today;
      return;
    }
    if (reply.type === "day") {
      if (reply.today && reply.at === undefined) { backToToday(); return; }
      past = { date: reply.date, items: reply.items, at: reply.at ?? "" };
      sync();
      markedPanel = past.at === "" ? "" : Strip.panelOf(Strip.panels(past.items), past.at);
      landed(markedPanel);
      return;
    }
    if (reply.type === "search") {
      if (reply.requestId !== searchId) return;
      hits = reply.hits;
      hitsMore = reply.more;
      searchDone = true;
      return;
    }
    if (reply.type === "reply" || reply.type === "error") {
      const pending = Object.assign({}, taking);
      for (const id of Object.keys(pending)) if (pending[id] === reply.requestId) delete pending[id];
      taking = pending;
    }
    if (reply.type === "reply") say(reply.text);
    else if (reply.type === "error") say(reply.message);
  }

  // Bring the list model in step with the view, touching only panels that changed, so streaming redraws one panel.
  // Each panel gets its recorded pose and side; legacy choices derive from its id and the art available then.
  // The panel she is answering in shows the pose of the moment instead.
  // When a run ends, the panel she answered in keeps her talking pose until her real face arrives (expression.ts picks
  // it a few seconds later), so no guessed face shows in between; after this long, a stand-in.
  readonly property int faceHoldMs: 6000
  property real faceHoldUntil: 0
  property bool syncWasRunning: false
  // Per-screen presentation state, including the live pose to hold, for composeStrip in compose.mjs.
  property var composeMemory: ({ sides: {}, poseIds: {}, livePoses: {} })
  Timer { id: faceHold; onTriggered: root.sync() }

  function sync() {
    // A past day is fixed: nothing runs in it.
    const list = Strip.panels(past ? past.items : view.items);
    const running = !past && Boolean(view.state.running || view.state.compacting);
    if (syncWasRunning && !running) {
      faceHoldUntil = Date.now() + faceHoldMs;
      faceHold.interval = faceHoldMs + 50;
      faceHold.restart();
    }
    syncWasRunning = running;
    const composed = Compose.composeStrip(list, past ? Strip.emptyView().state : view.state, poses, composeMemory, !past && Date.now() < faceHoldUntil);
    const rows = composed.reverse().map(p => ({ pid: p.id, json: JSON.stringify(p) }));
    newestPanel = rows.length > 0 ? rows[0].json : "";
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
    if (input.kind === "empty" && outbox.length === 0) return true;
    if (input.kind === "refuse") { say(input.message); return false; }
    if (!linked) { say("not connected to June; your balloon is kept"); return false; }
    if (input.kind === "command") send({ op: "command", requestId: rid(), name: input.name, args: input.args });
    else {
      const extra = Attach.payload(outbox);
      // QML's JavaScript has no object spread, so the attachments are set one by one.
      const request = { op: "submit", requestId: rid(), text: input.kind === "empty" ? "" : input.text, source: "gui", whenBusy: followUp ? "followUp" : "steer" };
      if (extra.images.length > 0) request.images = extra.images;
      if (extra.files.length > 0) request.files = extra.files;
      send(request);
      outbox = [];
      // Sent from a past day, the message joins today's conversation, so the strip follows it there.
      backToToday();
    }
    return true;
  }

  StripWindow { id: stripWindow; shell: root }

  // Max mode: the strip at the screen's right edge, full height, unfolding out of live June's card, which stays in the
  // same corner as in min mode. See "Live June" in docs/interfaces.org.
  PanelWindow {
    id: window
    visible: root.shown
    screen: root.targetScreen
    // The screen's size, which the window takes once mapped; the layout keys on it rather than the window's own, which is
    // 100 × 100 while hidden and 0 for a moment each time it maps (see page).
    readonly property real screenWidth: root.targetScreen ? root.targetScreen.width : width
    readonly property real screenHeight: root.targetScreen ? root.targetScreen.height : height
    anchors { top: true; bottom: true; left: true; right: true }
    exclusionMode: ExclusionMode.Ignore
    color: "transparent"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.namespace: "june-desktop"
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    onVisibleChanged: {
      if (visible) {
        if (boardsPaper.fits || root.overlayTab === "chat") composer.focusInput();
        root.wantBoards();
      }
    }
    Connections {
      target: root
      function onOverlayTabChanged() {
        if (!boardsPaper.fits && root.overlayTab !== "chat") composer.blurInput();
        else if (window.visible) composer.focusInput();
      }
    }

    // Esc closes a preview first, then the sheet open on the board under the pointer, then hides from anywhere in the
    // desktop client, even after a click put the focus in a balloon to select its words.
    function dismissHoveredSheet() {
      for (const b of [overlayAgents, overlayProjects, wideAgents, wideProjects])
        if (b.visible && b.hovered && b.dismissSheet()) return true;
      return false;
    }
    Shortcut {
      sequence: "Escape"
      onActivated: {
        if (preview.open) preview.close();
        else if (!window.dismissHoveredSheet()) root.hide();
      }
    }
    // The arrow keys turn a PDF's pages in the preview, then step through what the message brought.
    Shortcut { sequences: ["Right", "PgDown"]; enabled: preview.paging || preview.stepping; onActivated: preview.next() }
    Shortcut { sequences: ["Left", "PgUp"]; enabled: preview.paging || preview.stepping; onActivated: preview.previous() }
    // Page through the strip: Ctrl+N toward newer panels, Ctrl+P toward earlier ones.
    Shortcut { sequence: "Ctrl+N"; onActivated: list.page(1) }
    Shortcut { sequence: "Ctrl+P"; onActivated: list.page(-1) }
    Shortcut { sequence: "Ctrl+R"; onActivated: root.refresh() }
    Shortcut { sequence: "Alt+1"; onActivated: if (root.openApp("terminal")) root.hide() }
    Shortcut { sequence: "Alt+2"; enabled: !boardsPaper.fits; onActivated: root.overlayTab = "agents" }
    Shortcut { sequence: "Alt+3"; enabled: !boardsPaper.fits; onActivated: root.overlayTab = "chat" }
    Shortcut { sequence: "Alt+4"; enabled: !boardsPaper.fits; onActivated: root.overlayTab = "projects" }
    Shortcut { sequence: "Alt+5"; onActivated: if (root.openApp("editor")) root.hide() }

    // The backdrop dims as the strip unfolds; a click on it puts everything away.
    Rectangle { anchors.fill: parent; color: Theme.backdrop; opacity: root.unfold }
    MouseArea { anchors.fill: parent; onClicked: root.hide() }

    // The strip in the middle of the screen, as the window and the phone have it, the boards either side.
    Item {
      id: page
      anchors.horizontalCenter: parent.horizontalCenter
      anchors.top: parent.top
      // The screen's size, not the window's: the window measures 0 for a moment each time it maps, before the compositor
      // sizes it, and the strip would then throw away its panels and draw them again, June's poses and all.
      height: window.screenHeight
      width: Math.min(Theme.stripWidth, window.screenWidth - 32)
      // A picker for +, drawn inside the desktop client: as a window of its own it would open under the desktop client's layer.
      FileDialog {
        id: filePicker
        title: "Attach for June"
        fileMode: FileDialog.OpenFiles
        popupType: Popup.Item
        onAccepted: root.attachPaths(root.pathsOf(selectedFiles))
      }
      // Files dropped anywhere on the strip go with the next message.
      DropArea {
        anchors.fill: parent
        keys: ["text/uri-list"]
        onDropped: drop => { root.attachPaths(root.pathsOf(drop.urls)); drop.accept(Qt.CopyAction); }
      }
      // The unfold in two overlapping beats: the input grows out of her card, then the strip fades in, rising a little.
      readonly property real inputPhase: Math.min(1, root.unfold / 0.4)
      readonly property real stripPhase: Math.max(0, Math.min(1, (root.unfold - 0.2) / 0.8))

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
            background: root.view.state.background ?? 0
            status: root.status.text
            detail: root.status.detail
            onDismissed: (key) => root.dismiss(key)
            quiet: root.quiet
            browser: root
            showDays: boardsPaper.fits || root.overlayTab === "chat"
          }

          AgentsBoard {
            id: overlayAgents
            compact: true
            visible: !boardsPaper.fits && root.overlayTab === "agents"
            anchors.top: masthead.bottom
            anchors.bottom: overlayTabBar.top
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.margins: 16
            anchors.bottomMargin: 8
            view: root.agentsView
            onSeen: key => root.markSeen(key)
            notice: root.taskNotice
            rosterNotice: root.rosterNotice
            onRosterEdit: edit => root.editRoster(edit)
            deployNotice: root.deployNotice
            onDeploy: request => root.deploy(request)
            onVisit: (host, terminal) => root.showSession(host, terminal)
            dispatch: root.agentsBoard?.dispatch ?? null
            pending: root.pendingEdits
            onEdit: (key, change) => root.editTask(key, change)
            tasks: Object.assign({}, root.agendaBoard?.tasks ?? {}, root.agentsBoard?.tasks ?? {})
            user: root.agentsBoard?.user ?? ""
            today: root.agendaBoard?.today ?? ""
            loaded: root.agentsBoard !== null
            onOpen: link => { if (root.openLink(link)) root.hide(); }
          }

          ProjectsBoard {
            id: overlayProjects
            compact: true
            visible: !boardsPaper.fits && root.overlayTab === "projects"
            anchors.top: masthead.bottom
            anchors.bottom: overlayTabBar.top
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.margins: 16
            anchors.bottomMargin: 8
            view: root.agendaView
            notice: root.taskNotice
            dispatch: root.agentsBoard?.dispatch ?? null
            roster: root.rosterCards
            pending: root.pendingEdits
            onEdit: (key, change) => root.editTask(key, change)
            user: root.agentsBoard?.user ?? ""
            agenda: root.agendaBoard
            loaded: root.agendaBoard !== null
            host: root.host
            generatedAt: root.agendaBoard?.generatedAt ?? 0
            onOpen: link => { if (root.openLink(link)) root.hide(); }
          }

          StripList {
            id: list
            visible: boardsPaper.fits || root.overlayTab === "chat"
            anchors.top: masthead.bottom
            anchors.bottom: parent.bottom
            // Its newest panel ends just above the compose bar, as live June's does.
            anchors.bottomMargin: page.height - composer.y + 8
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
            taking: root.taking
            onTake: action => root.take(action)
            attached: root.attached
            onPreview: item => preview.show(item)
        onCopyText: text => Quickshell.clipboardText = text
            onLink: url => { if (root.openLink(url)) root.hide(); }
            marked: root.markedPanel
            Connections { target: root; function onLanded(panel) { list.land(panel); } }
          }

          Toast {
            anchors.bottom: list.bottom
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.bottomMargin: 6
            text: root.toast
          }

          NavBar {
            id: overlayTabBar
            visible: !boardsPaper.fits
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            anchors.leftMargin: 16
            anchors.rightMargin: 16
            anchors.bottomMargin: 10
            height: 46
            tab: root.overlayTab
            needs: root.agentsView.needs.length
            onChooseTab: name => {
              if (root.overlayTab === name) {
                if (name === "agents") overlayAgents.resetHome();
                else if (name === "projects") overlayProjects.resetHome();
                else if (name === "chat") root.backToToday();
              } else root.overlayTab = name;
            }
            onLaunch: app => { if (root.openApp(app)) root.hide(); }
          }
        }
      }

      // The compose bar across the strip, where live June has hers: the strip grows up out of it and her newest panel,
      // and shrinks back down into them. In the narrow layout it sits on the tab bar.
      Composer {
        id: composer
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.leftMargin: 16
        anchors.rightMargin: 16
        anchors.bottom: parent.bottom
        anchors.bottomMargin: boardsPaper.fits ? 22 : 10 + 46 + 8
        visible: boardsPaper.fits || root.overlayTab === "chat"
        // Already on screen when the strip grows out of live June or shrinks back to her; otherwise it fades in with it.
        opacity: root.cardSteady ? 1 : page.inputPhase
        send: (text, followUp) => root.submit(text, followUp)
        stop: () => root.stopJune()
        attachments: root.outbox
        unattach: index => root.unattach(index)
        paste: fallback => root.pasteInto(fallback)
        pick: () => filePicker.open()
        tabAction: () => root.toMini()
      }
    }

    // A wide screen has room either side of the strip for the boards, agents on the left and projects on the right, on
    // paper that unfolds with it (see "Agents and projects" in docs/interfaces.org). What a board opens takes the
    // desktop client away, as a link does.
    Rectangle {
      id: boardsPaper
      readonly property var layout: Board.overlayBoards(window.screenWidth - page.width)
      readonly property bool fits: layout.fits
      visible: fits && page.stripPhase > 0
      anchors.right: page.left
      anchors.top: parent.top
      anchors.bottom: parent.bottom
      width: layout.width
      color: Theme.paper
      opacity: page.stripPhase
      transform: Translate { y: (1 - page.stripPhase) * 56 }
      MouseArea { anchors.fill: parent } // clicks on the boards stay on them
      onFitsChanged: if (fits && root.shown) root.wantBoards()
      Rectangle { anchors.right: parent.right; anchors.top: parent.top; anchors.bottom: parent.bottom; width: 1.5; color: Theme.pageInk; opacity: 0.25 }
      Item {
        anchors.fill: parent
        anchors.margins: Board.GAP
        anchors.topMargin: 16
        // The compose bar's line, so the section bars end where it does.
        anchors.bottomMargin: 22
        AgentsBoard {
          id: wideAgents
          width: boardsPaper.layout.side
          height: parent.height
          view: root.agentsView
    onSeen: key => root.markSeen(key)
    notice: root.taskNotice
    rosterNotice: root.rosterNotice
    onRosterEdit: edit => root.editRoster(edit)
            deployNotice: root.deployNotice
            onDeploy: request => root.deploy(request)
            onVisit: (host, terminal) => root.showSession(host, terminal)
    dispatch: root.agentsBoard?.dispatch ?? null
    pending: root.pendingEdits
    onEdit: (key, change) => root.editTask(key, change)
    tasks: Object.assign({}, root.agendaBoard?.tasks ?? {}, root.agentsBoard?.tasks ?? {})
    user: root.agentsBoard?.user ?? ""
    today: root.agendaBoard?.today ?? ""
          loaded: root.agentsBoard !== null
          showLaunch: true
          onLaunchTerminal: { if (root.openApp("terminal")) root.hide(); }
          onOpen: link => { if (root.openLink(link)) root.hide(); }
        }
      }
    }
    Rectangle {
      id: projectsPaper
      visible: boardsPaper.visible
      anchors.left: page.right
      anchors.top: parent.top
      anchors.bottom: parent.bottom
      width: boardsPaper.layout.width
      color: Theme.paper
      opacity: page.stripPhase
      transform: Translate { y: (1 - page.stripPhase) * 56 }
      MouseArea { anchors.fill: parent } // clicks on the boards stay on them
      Rectangle { anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom; width: 1.5; color: Theme.pageInk; opacity: 0.25 }
      Item {
        anchors.fill: parent
        anchors.margins: Board.GAP
        anchors.topMargin: 16
        // The compose bar's line, so the section bars end where it does.
        anchors.bottomMargin: 22
        ProjectsBoard {
          id: wideProjects
          width: boardsPaper.layout.side
          height: parent.height
          view: root.agendaView
    notice: root.taskNotice
    dispatch: root.agentsBoard?.dispatch ?? null
    roster: root.rosterCards
    pending: root.pendingEdits
    onEdit: (key, change) => root.editTask(key, change)
    user: root.agentsBoard?.user ?? ""
          agenda: root.agendaBoard
          loaded: root.agendaBoard !== null
          host: root.host
          generatedAt: root.agendaBoard?.generatedAt ?? 0
          showLaunch: true
          onLaunchEditor: { if (root.openApp("editor")) root.hide(); }
          onOpen: link => { if (root.openLink(link)) root.hide(); }
        }
      }
    }

    // A picture or file a note brought, over everything in the desktop client until closed.
    Preview {
      id: preview
      anchors.fill: parent
      onExternal: url => { preview.close(); Qt.openUrlExternally(url); }
      onCopyText: text => Quickshell.clipboardText = text
    }
  }
}
