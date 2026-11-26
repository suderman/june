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
      if (win.layout.columns || win.tab === "chat") composer.focusInput();
      shell.wantBoards();
    } else shell.windowShown = false;
  }

  readonly property var layout: Board.boardLayout(width)
  // In a narrow window, which of chat and the two boards shows (the shell keeps it, for `june-desktop tab`).
  readonly property string tab: shell.windowTab
  property bool settingsOpen: false
  onClosed: shell.windowShown = false
  onTabChanged: {
    if (!win.layout.columns && win.tab !== "chat") composer.blurInput();
    else if (win.visible) composer.focusInput();
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
  Shortcut { sequence: "Escape"; enabled: preview.open; onActivated: preview.close() }
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
        font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13
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
    dispatch: win.shell.agentsBoard?.dispatch ?? null
    pending: win.shell.pendingEdits
    onEdit: (key, change) => win.shell.editTask(key, change)
    tasks: Object.assign({}, win.shell.agendaBoard?.tasks ?? {}, win.shell.agentsBoard?.tasks ?? {})
    user: win.shell.agentsBoard?.user ?? ""
    today: win.shell.agendaBoard?.today ?? ""
      loaded: win.shell.agentsBoard !== null
      onOpen: link => win.shell.openLink(link)
    }
    ProjectsBoard {
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
      onChooseTab: name => win.shell.windowTab = name
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
    dispatch: win.shell.agentsBoard?.dispatch ?? null
    pending: win.shell.pendingEdits
    onEdit: (key, change) => win.shell.editTask(key, change)
    tasks: Object.assign({}, win.shell.agendaBoard?.tasks ?? {}, win.shell.agentsBoard?.tasks ?? {})
    user: win.shell.agentsBoard?.user ?? ""
    today: win.shell.agendaBoard?.today ?? ""
    loaded: win.shell.agentsBoard !== null
    showLaunch: true
    onLaunchTerminal: win.shell.openApp("terminal")
    onOpen: link => win.shell.openLink(link)
  }
  ProjectsBoard {
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
    onLaunchEditor: win.shell.openApp("editor")
    onOpen: link => win.shell.openLink(link)
  }

  // A picture or file a note brought, over the whole window until closed.
  Preview {
    id: preview
    anchors.fill: parent
    onExternal: url => { preview.close(); Qt.openUrlExternally(url); }
    onCopyText: text => Quickshell.clipboardText = text
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
      font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13
      color: pill.on ? Theme.paper : Theme.pageInk
    }
    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: pill.clicked() }
  }
}
