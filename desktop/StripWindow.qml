// The strip in an ordinary window, for the launcher: the same conversation and panels as the desktop client, with a row of
// toggles for this device's state (nothing written to config). Narrowed below 480 px it shows the strip's stacked
// layout, the phone's. Wide enough (board.mjs boardLayout, about 1300 px), the agents take the left margin and the
// projects the right; narrower, tabs switch between the strip and either board. Ctrl+N and Ctrl+P page, Ctrl+R
// refreshes, Ctrl+W closes. See "The windowed strip" and "Agents and projects" in docs/interfaces.org.
import QtQuick
import QtQuick.Dialogs
import QtQuick.Controls
import Quickshell
import "desktop.mjs" as Desktop
import "board.mjs" as Board
import "keys.mjs" as KeyNav

FloatingWindow {
  id: win

  required property var shell

  title: "June"
  implicitWidth: 620
  implicitHeight: 880
  minimumSize: Qt.size(340, 480)
  color: Theme.paper
  visible: shell.windowShown
  onVisibleChanged: {
    if (visible) {
      strip.landOnNewest();
      shell.wantBoards();
      if (KeyNav.initialNormalMode({ tab: win.tab, narrow: !win.layout.columns, past: shell.past !== null })) enterNormal();
      else enterInsert();
    } else shell.windowShown = false;
  }

  readonly property var layout: Board.boardLayout(width)
  // True only while this window is both shown and the compositor's active window (Window.active can stay true while hidden).
  readonly property bool focused: visible && column.Window.active
  // Modal keyboard state: INSERT (typing in composer) ↔ NORMAL (hjkl/np/Z/[/]/SPC/?).
  property bool normalMode: false
  property string focusColumn: "chat"
  property bool leader: false
  property bool helpOpen: false
  property var hints: []
  property string hintTyped: ""
  readonly property string activeColumn: win.layout.columns ? focusColumn : win.tab

  function clearHints() { hints = []; hintTyped = ""; }
  function enterNormal() {
    normalMode = true;
    leader = false;
    clearHints();
    composer.blurInput();
    normalCatcher.forceActiveFocus();
  }
  function enterInsert() {
    if (!win.layout.columns && win.tab !== "chat") win.shell.windowTab = "chat";
    normalMode = false;
    leader = false;
    helpOpen = false;
    clearHints();
    focusColumn = "chat";
    composer.focusInput();
  }
  function focusComposer(flash) {
    enterInsert();
    if (flash) composer.flash();
  }
  // In a narrow window, which of chat and the two boards shows (the shell keeps it, for `june-desktop tab`).
  readonly property string tab: shell.windowTab
  property bool settingsOpen: false
  onClosed: shell.windowShown = false
  onTabChanged: {
    if (!win.layout.columns && win.tab !== "chat") enterNormal();
    else if (win.visible && !win.normalMode) composer.focusInput();
  }

  Item {
    id: normalCatcher
    focus: win.normalMode
    Keys.onPressed: event => { if (win.normalMode) win.handleNormalKey(event); }
  }
  function activeAgentsBoard() { return win.layout.columns ? wideAgents : narrowAgents; }
  function activeProjectsBoard() { return win.layout.columns ? wideProjects : narrowProjects; }
  function activateFocusedPanel() {
    const p = strip.focusedPanel();
    if (!p) return;
    const acts = KeyNav.panelActions(p, win.shell.attached);
    if (acts.length === 0) return;
    const first = acts[0];
    if (first.kind === "artifact" || first.kind === "file") preview.show(first.item);
    else if (first.kind === "link") win.shell.openLink(first.url);
  }
  function activateHint(h) {
    if (!h) return;
    if (h.kind === "artifact" || h.kind === "file") preview.show(h.item);
    else if (h.kind === "link" && h.url) win.shell.openLink(h.url);
    else if (h.kind === "toggleTool" && typeof h.toggle === "function") h.toggle();
  }
  function handleNormalKey(event) {
    const ev = win.shell.keyEv(event);
    if (win.hints.length > 0) {
      event.accepted = true;
      if (ev.key === "Escape") { win.clearHints(); return; }
      if (event.key === Qt.Key_Backspace) { win.hintTyped = win.hintTyped.slice(0, -1); return; }
      if (ev.text && ev.text.length === 1 && /^[a-zA-Z]$/.test(ev.text)) {
        const next = win.hintTyped + ev.text.toLowerCase();
        const m = KeyNav.matchHint(win.hints, next);
        if (m.kind === "exact") { win.clearHints(); win.activateHint(m.hint); }
        else if (m.kind === "prefix") win.hintTyped = next;
        else win.clearHints();
        return;
      }
      win.clearHints();
      return;
    }
    if (!win.helpOpen && !win.leader && !preview.open) {
      if (win.activeColumn === "agents") {
        const ab = activeAgentsBoard();
        if (ab.sheetOpen && ab.handleSheetKey(ev)) { event.accepted = true; return; }
        if (!ab.sheetOpen && ab.handleBoardKey(ev)) { event.accepted = true; return; }
      } else if (win.activeColumn === "projects") {
        const pb = activeProjectsBoard();
        if (pb.sheetOpen && pb.handleSheetKey(ev)) { event.accepted = true; return; }
      }
    }
    const res = KeyNav.dispatchNormalKey(ev, {
      surface: "window",
      column: win.activeColumn,
      leader: win.leader,
      helpOpen: win.helpOpen,
      previewOpen: preview.open,
    });
    if (!res) return;
    event.accepted = true;
    if (res.action === "noop") return;
    if (res.action === "closeHelp") { win.helpOpen = false; return; }
    if (res.action === "toggleHelp") { win.helpOpen = !win.helpOpen; win.leader = false; return; }
    if (res.action === "openHelp") { win.helpOpen = true; win.leader = false; return; }
    if (res.action === "openLeader") { win.leader = true; return; }
    if (res.action === "cancelLeader") { win.leader = false; return; }
    win.leader = false;
    if (res.action === "closePreview") { preview.close(); return; }
    if (res.action === "previewPrev") { if (preview.paging || preview.stepping) preview.previous(); return; }
    if (res.action === "previewNext") { if (preview.paging || preview.stepping) preview.next(); return; }
    if (res.action === "previewScroll") { preview.scrollStep(res.delta); return; }
    if (res.action === "previewPage") { preview.scrollPage(res.delta); return; }
    if (res.action === "previewBottomTop") { preview.toggleBottomTop(); return; }
    if (res.action === "previewCopy") { if (preview.kind === "artifact" && preview.what?.text) { Quickshell.clipboardText = preview.what.text; win.shell.say("copied"); } return; }
    if (res.action === "previewExternal") { if (preview.kind !== "artifact" && preview.what?.url) { preview.close(); Qt.openUrlExternally(preview.what.url); } return; }
    if (res.action === "enterInsert") { win.enterInsert(); return; }
    if (res.action === "escape" || res.action === "quit") {
      if (preview.open) { preview.close(); return; }
      if (win.activeColumn === "agents" && activeAgentsBoard().dismissSheet()) return;
      if (win.activeColumn === "projects") {
        if (activeProjectsBoard().dismissSheet()) return;
        if (activeProjectsBoard().mode === "state") { activeProjectsBoard().mode = "tasks"; activeProjectsBoard().drill = ""; return; }
      }
      win.dismissHoveredSheet();
      return;
    }
    if (res.action === "moveColumn") {
      const ab = activeAgentsBoard();
      const pb = activeProjectsBoard();
      const dest = KeyNav.stepHorizontal({
        column: win.activeColumn,
        agentSection: ab.mode,
        projectSection: pb.mode,
        delta: res.delta,
      });
      if (win.layout.columns) win.focusColumn = dest.column; else win.shell.windowTab = dest.column;
      if (dest.section !== "") {
        if (dest.column === "agents") ab.setSection(dest.section);
        else if (dest.column === "projects") pb.setSection(dest.section);
      }
      return;
    }
    if (res.action === "setColumn") {
      if (win.layout.columns) win.focusColumn = res.column; else win.shell.windowTab = res.column;
      return;
    }
    if (res.action === "cycleSection") {
      if (win.activeColumn === "agents") activeAgentsBoard().cycleSection(res.delta);
      else if (win.activeColumn === "projects") activeProjectsBoard().cycleSection(res.delta);
      else masthead.stepDay(res.delta);
      return;
    }
    if (res.action === "tradeSize") { win.settingsOpen = !win.settingsOpen; return; }
    if (res.action === "toggleBottomTop") {
      if (win.activeColumn === "chat") strip.toggleBottomTop();
      else if (win.activeColumn === "agents") activeAgentsBoard().toggleBottomTop();
      else activeProjectsBoard().toggleBottomTop();
      return;
    }
    if (res.action === "step") {
      if (win.activeColumn === "chat") strip.stepPanel(res.delta);
      else if (win.activeColumn === "agents") activeAgentsBoard().stepRow(res.delta);
      else activeProjectsBoard().stepRow(res.delta);
      return;
    }
    if (res.action === "page") {
      if (win.activeColumn === "chat") strip.page(res.delta);
      else if (win.activeColumn === "agents") activeAgentsBoard().pageRows(res.delta);
      else activeProjectsBoard().pageRows(res.delta);
      return;
    }
    if (res.action === "copy") {
      const txt = KeyNav.panelCopyText(strip.focusedPanel());
      if (txt !== "") { Quickshell.clipboardText = txt; win.shell.say("copied"); }
      return;
    }
    if (res.action === "activate") {
      if (win.activeColumn === "chat") activateFocusedPanel();
      else if (win.activeColumn === "agents") activeAgentsBoard().activateCurrent();
      else activeProjectsBoard().activateCurrent();
      return;
    }
    if (res.action === "fold") {
      if (win.activeColumn === "agents") activeAgentsBoard().foldCurrent();
      else if (win.activeColumn === "projects") activeProjectsBoard().foldCurrent();
      return;
    }
    if (res.action === "hint") {
      if (strip.visible) {
        const found = strip.collectVisibleHints(win.contentItem);
        if (found.length > 0) { win.hints = found; win.hintTyped = ""; }
        else win.shell.say("no links or actions in view");
      }
      return;
    }
    if (res.action === "search" || res.action === "calendar") { masthead.openBrowse(); return; }
    if (res.action === "stepDay") { masthead.stepDay(res.delta); return; }
    if (res.action === "today") { win.shell.backToToday(); return; }
    if (res.action === "undo") {
      if (win.shell.taskNotice?.undo && win.shell.taskNotice?.key) win.shell.editTask(win.shell.taskNotice.key, win.shell.taskNotice.undo);
      return;
    }
    if (res.action === "attach") { windowPicker.open(); return; }
    win.shell.runLeaderCommand(res.action, res.app ?? "", false);
  }

  Shortcut { sequence: "Ctrl+N"; onActivated: strip.page(1) }
  Shortcut { sequence: "Ctrl+P"; onActivated: strip.page(-1) }
  Shortcut { sequence: "Ctrl+W"; onActivated: win.shell.windowShown = false }
  Shortcut { sequence: "Ctrl+R"; onActivated: win.shell.refresh() }
  Shortcut { sequence: "Alt+1"; onActivated: win.shell.openApp("terminal") }
  Shortcut { sequence: "Alt+2"; enabled: !win.layout.columns; onActivated: win.shell.windowTab = "agents" }
  Shortcut { sequence: "Alt+3"; enabled: !win.layout.columns; onActivated: win.shell.windowTab = "chat" }
  Shortcut { sequence: "Alt+4"; enabled: !win.layout.columns; onActivated: win.shell.windowTab = "projects" }
  Shortcut { sequence: "Alt+5"; onActivated: win.shell.openApp("editor") }
  // Esc closes a preview first, then the sheet open on the board under the pointer; the window stays.
  function dismissHoveredSheet() {
    for (const b of [narrowAgents, narrowProjects, wideAgents, wideProjects])
      if (b.visible && b.hovered && b.dismissSheet()) return true;
    return false;
  }
  Connections {
    target: masthead
    function onBrowseOpenChanged() {
      if (!masthead.browseOpen && win.visible) {
        if (win.normalMode) normalCatcher.forceActiveFocus();
        else composer.focusInput();
      }
    }
  }
  Shortcut {
    sequence: "Escape"
    enabled: !win.normalMode && !masthead.browseOpen
    onActivated: {
      if (preview.open) preview.close();
      else if (!win.dismissHoveredSheet()) win.enterNormal();
    }
  }
  Shortcut { sequences: ["Right", "PgDown"]; enabled: preview.paging || preview.stepping; onActivated: preview.next() }
  Shortcut { sequences: ["Left", "PgUp"]; enabled: preview.paging || preview.stepping; onActivated: preview.previous() }

  // The column the strip lives in: the window's width, up to the desktop client's, centred on a wide window.
  Item {
    id: column
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    anchors.horizontalCenter: parent.horizontalCenter
    // The column pads its contents 16 px, so with the boards beside it, it is the strip plus that padding.
    width: win.layout.columns ? win.layout.strip + 32 : Math.min(parent.width, Theme.stripWidth)

    Row {
      id: topControls
      anchors.top: parent.top
      anchors.right: parent.right
      anchors.margins: 16
      height: 30
      spacing: 10
      z: 6

      Pill {
        anchors.verticalCenter: parent.verticalCenter
        text: "console"
        on: win.shell.look === "console"
        onClicked: win.shell.look = win.shell.look === "console" ? "comic" : "console"
      }
      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: win.settingsOpen ? "settings ▴" : "settings"
        font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: Theme.type.meta.size
        color: win.settingsOpen ? Theme.pageInk : Theme.muted
        MouseArea { anchors.fill: parent; anchors.margins: -4; cursorShape: Qt.PointingHandCursor; onClicked: win.settingsOpen = !win.settingsOpen }
      }
    }

    Masthead {
      id: masthead
      anchors.top: parent.top
      anchors.left: parent.left
      anchors.right: topControls.left
      anchors.leftMargin: 16
      anchors.topMargin: 16
      anchors.rightMargin: 8
      linked: win.shell.linked
      refusals: win.shell.refusals
      host: win.shell.host
      background: win.shell.view.state.background ?? 0
      status: win.shell.status.text
      detail: win.shell.status.detail
      onDismissed: (key) => win.shell.dismiss(key)
      quiet: win.shell.quiet
      browser: win.shell
      showDays: win.layout.columns || win.tab === "chat"
    }

    // This device's toggles: tucked under settings (like Android), gone when the desktop client restarts.
    Flow {
      id: toggles
      visible: win.settingsOpen
      anchors.top: masthead.bottom
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.leftMargin: 16
      anchors.rightMargin: 16
      anchors.topMargin: visible ? 10 : 0
      height: visible ? implicitHeight : 0
      spacing: 8

      Pill {
        text: "do not disturb"
        on: win.shell.quiet
        onClicked: win.shell.setQuiet(!win.shell.quiet)
      }
      Pill {
        text: win.shell.scheme === "system" ? (Theme.dark ? "dark · system" : "light · system") : win.shell.scheme
        on: win.shell.scheme !== "system"
        onClicked: win.shell.scheme = Desktop.SCHEMES[(Desktop.SCHEMES.indexOf(win.shell.scheme) + 1) % Desktop.SCHEMES.length]
      }
      Pill {
        text: "live June"
        on: win.shell.liveEnabled
        onClicked: win.shell.liveEnabled = !win.shell.liveEnabled
      }
      // The console has no light to preview.
      Pill {
        visible: !Theme.consoleLook
        text: win.shell.lightHour < 0 ? "light: each panel's hour" : "light: " + win.clock(win.shell.lightHour)
        on: win.shell.lightHour >= 0
        onClicked: win.shell.lightHour = win.shell.lightHour < 0 ? Math.round(new Date().getHours() + new Date().getMinutes() / 60) % 24 : -1
      }
      Slider {
        id: hour
        visible: win.shell.lightHour >= 0 && !Theme.consoleLook
        width: Math.min(220, toggles.width)
        height: 30
        from: 0
        to: 24
        stepSize: 0.25
        value: Math.max(0, win.shell.lightHour)
        onMoved: win.shell.lightHour = value
        background: Rectangle {
          x: hour.leftPadding
          y: hour.topPadding + hour.availableHeight / 2 - height / 2
          width: hour.availableWidth
          height: 4
          radius: 2
          color: Theme.muted
          Rectangle { width: hour.visualPosition * parent.width; height: parent.height; radius: 2; color: Theme.pageInk }
        }
        handle: Rectangle {
          x: hour.leftPadding + hour.visualPosition * (hour.availableWidth - width)
          y: hour.topPadding + hour.availableHeight / 2 - height / 2
          width: 18
          height: 18
          radius: 9
          color: Theme.balloon
          border.color: Theme.balloonLine
          border.width: 2
        }
      }
    }

    AgentsBoard {
      id: narrowAgents
      compact: true
      visible: !win.layout.columns && win.tab === "agents"
      anchors.top: toggles.bottom
      anchors.bottom: tabBar.top
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.leftMargin: 16
      anchors.rightMargin: 16
      anchors.topMargin: 10
      anchors.bottomMargin: 8
      view: win.shell.agentsView
    onSeen: key => win.shell.markSeen(key)
    notice: win.shell.taskNotice
    rosterNotice: win.shell.rosterNotice
    onRosterEdit: edit => win.shell.editRoster(edit)
      deployNotice: win.shell.deployNotice
      onDeploy: request => win.shell.deploy(request)
      onVisit: (host, terminal) => win.shell.showSession(host, terminal)
    dispatch: win.shell.agentsBoard?.dispatch ?? null
    pending: win.shell.pendingEdits
    onEdit: (key, change) => win.shell.editTask(key, change)
    tasks: Object.assign({}, win.shell.agendaBoard?.tasks ?? {}, win.shell.agentsBoard?.tasks ?? {})
    user: win.shell.agentsBoard?.user ?? ""
    today: win.shell.agendaBoard?.today ?? ""
      loaded: win.shell.agentsBoard !== null
      keyboardFocused: win.normalMode && win.activeColumn === "agents"
      onCopyText: text => { Quickshell.clipboardText = text; win.shell.say("copied"); }
      onRestoreFocus: if (win.normalMode) normalCatcher.forceActiveFocus()
      onOpen: link => win.shell.openLink(link)
    }
    ProjectsBoard {
      id: narrowProjects
      compact: true
      visible: !win.layout.columns && win.tab === "projects"
      anchors.top: toggles.bottom
      anchors.bottom: tabBar.top
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.leftMargin: 16
      anchors.rightMargin: 16
      anchors.topMargin: 10
      anchors.bottomMargin: 8
      view: win.shell.agendaView
    notice: win.shell.taskNotice
    dispatch: win.shell.agentsBoard?.dispatch ?? null
    pending: win.shell.pendingEdits
    onEdit: (key, change) => win.shell.editTask(key, change)
    user: win.shell.agentsBoard?.user ?? ""
      agenda: win.shell.agendaBoard
      loaded: win.shell.agendaBoard !== null
      host: win.shell.host
      generatedAt: win.shell.agendaBoard?.generatedAt ?? 0
      keyboardFocused: win.normalMode && win.activeColumn === "projects"
      onCopyText: text => { Quickshell.clipboardText = text; win.shell.say("copied"); }
      onRestoreFocus: if (win.normalMode) normalCatcher.forceActiveFocus()
      onOpen: link => win.shell.openLink(link)
    }

    StripList {
      id: strip
      visible: win.layout.columns || win.tab === "chat"
      anchors.top: toggles.bottom
      anchors.bottom: composer.top
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.leftMargin: 16
      anchors.rightMargin: 16
      anchors.topMargin: 10
      anchors.bottomMargin: 16
      model: win.shell.stripModel
      activity: win.shell.activity
      poses: win.shell.poses
      now: win.shell.now
      hourOverride: win.shell.lightHour
      scenery: win.shell.scenery
      sky: win.shell.view.state.sky ?? null
      linked: win.shell.linked
      taking: win.shell.taking
      onTake: action => win.shell.take(action)
      attached: win.shell.attached
      onPreview: item => preview.show(item)
      onCopyText: text => Quickshell.clipboardText = text
      onLink: url => win.shell.openLink(url)
      marked: win.shell.markedPanel
      keyboardFocused: win.normalMode && win.activeColumn === "chat"
      Connections { target: win.shell; function onLanded(panel) { strip.land(panel); } }
    }

    Toast {
      anchors.bottom: strip.bottom
      anchors.horizontalCenter: parent.horizontalCenter
      anchors.bottomMargin: 6
      text: win.shell.toast
    }

    Composer {
      id: composer
      visible: win.layout.columns || win.tab === "chat"
      normalMode: win.normalMode
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.bottom: win.layout.columns ? parent.bottom : tabBar.top
      anchors.leftMargin: 16
      anchors.rightMargin: 16
      anchors.bottomMargin: win.layout.columns ? 16 : 8
      send: (text, followUp) => win.shell.submit(text, followUp)
      stop: () => win.shell.stopJune()
      attachments: win.shell.outbox
      unattach: index => win.shell.unattach(index)
      paste: fallback => win.shell.pasteInto(fallback)
      pick: () => windowPicker.open()
      tabAction: () => win.enterNormal()
      escAction: () => win.enterNormal()
      onEnteredInsert: win.enterInsert()
    }

    NavBar {
      id: tabBar
      visible: !win.layout.columns
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      anchors.leftMargin: 16
      anchors.rightMargin: 16
      anchors.bottomMargin: 6
      tab: win.tab
      needs: win.shell.agentsView.needs.length
      onChooseTab: name => {
        if (win.tab === name) {
          if (name === "agents") narrowAgents.resetHome();
          else if (name === "projects") narrowProjects.resetHome();
          else if (name === "chat") win.shell.backToToday();
        } else win.shell.windowTab = name;
      }
      onLaunch: app => win.shell.openApp(app)
    }
    // A picker for +, inside this window: a dialog needs a window to open in.
    FileDialog {
      id: windowPicker
      title: "Attach for June"
      fileMode: FileDialog.OpenFiles
      onAccepted: win.shell.attachPaths(win.shell.pathsOf(selectedFiles))
    }
    // Files dropped anywhere on the window go with the next message.
    DropArea {
      anchors.fill: parent
      keys: ["text/uri-list"]
      onDropped: drop => { win.shell.attachPaths(win.shell.pathsOf(drop.urls)); drop.accept(Qt.CopyAction); }
    }
  }

  // Wide, the boards take the margins on either side of the strip.
  AgentsBoard {
    id: wideAgents
    visible: win.layout.columns
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    anchors.right: column.left
    anchors.topMargin: 16
    anchors.bottomMargin: 16
    anchors.rightMargin: win.layout.gap - 16
    width: win.layout.side
    view: win.shell.agentsView
    onSeen: key => win.shell.markSeen(key)
    notice: win.shell.taskNotice
    rosterNotice: win.shell.rosterNotice
    onRosterEdit: edit => win.shell.editRoster(edit)
      deployNotice: win.shell.deployNotice
      onDeploy: request => win.shell.deploy(request)
      onVisit: (host, terminal) => win.shell.showSession(host, terminal)
    dispatch: win.shell.agentsBoard?.dispatch ?? null
    pending: win.shell.pendingEdits
    onEdit: (key, change) => win.shell.editTask(key, change)
    tasks: Object.assign({}, win.shell.agendaBoard?.tasks ?? {}, win.shell.agentsBoard?.tasks ?? {})
    user: win.shell.agentsBoard?.user ?? ""
    today: win.shell.agendaBoard?.today ?? ""
    loaded: win.shell.agentsBoard !== null
    showLaunch: true
    keyboardFocused: win.normalMode && win.activeColumn === "agents"
    onCopyText: text => { Quickshell.clipboardText = text; win.shell.say("copied"); }
    onRestoreFocus: if (win.normalMode) normalCatcher.forceActiveFocus()
    onLaunchTerminal: win.shell.openApp("terminal")
    onOpen: link => win.shell.openLink(link)
  }
  ProjectsBoard {
    id: wideProjects
    visible: win.layout.columns
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    anchors.left: column.right
    anchors.topMargin: 16
    anchors.bottomMargin: 16
    anchors.leftMargin: win.layout.gap - 16
    width: win.layout.side
    view: win.shell.agendaView
    notice: win.shell.taskNotice
    dispatch: win.shell.agentsBoard?.dispatch ?? null
    pending: win.shell.pendingEdits
    onEdit: (key, change) => win.shell.editTask(key, change)
    user: win.shell.agentsBoard?.user ?? ""
    agenda: win.shell.agendaBoard
    loaded: win.shell.agendaBoard !== null
    host: win.shell.host
    generatedAt: win.shell.agendaBoard?.generatedAt ?? 0
    showLaunch: true
    keyboardFocused: win.normalMode && win.activeColumn === "projects"
    onCopyText: text => { Quickshell.clipboardText = text; win.shell.say("copied"); }
    onRestoreFocus: if (win.normalMode) normalCatcher.forceActiveFocus()
    onLaunchEditor: win.shell.openApp("editor")
    onOpen: link => win.shell.openLink(link)
  }

  // Subtle top focus rail indicating which wide column owns NORMAL-mode keys.
  Rectangle {
    visible: win.normalMode && win.layout.columns
    y: 0; height: 3; z: 25
    x: win.focusColumn === "agents" ? wideAgents.x : win.focusColumn === "projects" ? wideProjects.x : column.x + 16
    width: win.focusColumn === "agents" ? wideAgents.width : win.focusColumn === "projects" ? wideProjects.width : column.width - 32
    color: Theme.accent
    Behavior on x { NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }
    Behavior on width { NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }
  }

  // A picture or file a note brought, over the whole window until closed.
  Preview {
    id: preview
    anchors.fill: parent
    onExternal: url => { preview.close(); Qt.openUrlExternally(url); }
    onCopyText: text => Quickshell.clipboardText = text
  }

  KeyOverlay {
    anchors.fill: parent
    leader: win.leader
    helpOpen: win.helpOpen
    hints: win.hints
    hintTyped: win.hintTyped
    surface: "window"
    column: win.activeColumn
    sheet: win.activeColumn === "agents" ? win.activeAgentsBoard().activeSheet : win.activeColumn === "projects" ? win.activeProjectsBoard().activeSheet : ""
    onCloseHelp: win.helpOpen = false
  }

  /** An hour as a clock reading, 16.5 as 16:30. */
  function clock(hour) {
    const h = Math.floor(hour);
    const m = Math.round((hour - h) * 60);
    return String(h % 24).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }

  // A toggle in the strip's lettering.
  component Pill: Rectangle {
    id: pill
    property string text: ""
    property bool on: false
    signal clicked()
    width: label.implicitWidth + 24
    height: 30
    radius: 15
    // Outlined when off, filled when on, so either reads on any page.
    color: on ? Theme.pageInk : "transparent"
    border.color: Theme.pageInk
    border.width: 2
    Text {
      id: label
      anchors.centerIn: parent
      text: pill.text
      font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: Theme.type.button.size
      color: pill.on ? Theme.paper : Theme.pageInk
    }
    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: pill.clicked() }
  }
}
