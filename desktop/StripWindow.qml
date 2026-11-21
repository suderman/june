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
    if (visible) { strip.landOnNewest(); composer.focusInput(); shell.wantBoards(); }
    else shell.windowShown = false;
  }

  readonly property var layout: Board.boardLayout(width)
  // In a narrow window, which of the strip and the two boards shows (the shell keeps it, for `june-desktop tab`).
  readonly property string tab: shell.windowTab
  onClosed: shell.windowShown = false

  Shortcut { sequence: "Ctrl+N"; onActivated: strip.page(1) }
  Shortcut { sequence: "Ctrl+P"; onActivated: strip.page(-1) }
  Shortcut { sequence: "Ctrl+W"; onActivated: win.shell.windowShown = false }
  Shortcut { sequence: "Ctrl+R"; onActivated: win.shell.refresh() }
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

    Masthead {
      id: masthead
      anchors.top: parent.top
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.margins: 16
      linked: win.shell.linked
      refusals: win.shell.refusals
      host: win.shell.host
      background: win.shell.view.state.background ?? 0
      status: win.shell.status.text
      detail: win.shell.status.detail
      onDismissed: (key) => win.shell.dismiss(key)
      quiet: win.shell.quiet
      browser: win.shell
    }

    // This device's toggles: state for now, gone when the desktop client restarts.
    Flow {
      id: toggles
      anchors.top: masthead.bottom
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.leftMargin: 16
      anchors.rightMargin: 16
      anchors.topMargin: 10
      spacing: 8

      Pill {
        text: "console"
        on: win.shell.look === "console"
        onClicked: win.shell.look = win.shell.look === "console" ? "comic" : "console"
      }
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
          border.color: Theme.ink
          border.width: 2
        }
      }
    }

    // Narrow, the boards are tabs beside the strip.
    Row {
      id: tabs
      visible: !win.layout.columns
      anchors.top: toggles.bottom
      anchors.left: parent.left
      anchors.leftMargin: 16
      anchors.topMargin: visible ? 10 : 0
      height: visible ? 30 : 0
      spacing: 8
      Pill { text: "strip"; on: win.tab === "strip"; onClicked: win.shell.windowTab = "strip" }
      Pill {
        text: win.shell.agentsView.needs.length > 0 ? "agents · " + win.shell.agentsView.needs.length : "agents"
        on: win.tab === "agents"
        onClicked: win.shell.windowTab = "agents"
      }
      Pill { text: "projects"; on: win.tab === "projects"; onClicked: win.shell.windowTab = "projects" }
    }

    AgentsBoard {
      visible: !win.layout.columns && win.tab === "agents"
      anchors.top: tabs.bottom
      anchors.bottom: composer.top
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.margins: 16
      view: win.shell.agentsView
    notice: win.shell.taskNotice
    onEdit: (key, change) => win.shell.editTask(key, change)
    tasks: Object.assign({}, win.shell.agendaBoard?.tasks ?? {}, win.shell.agentsBoard?.tasks ?? {})
    user: win.shell.agentsBoard?.user ?? ""
    today: win.shell.agendaBoard?.today ?? ""
      loaded: win.shell.agentsBoard !== null
      onOpen: link => win.shell.openLink(link)
    }
    ProjectsBoard {
      visible: !win.layout.columns && win.tab === "projects"
      anchors.top: tabs.bottom
      anchors.bottom: composer.top
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.margins: 16
      view: win.shell.agendaView
    notice: win.shell.taskNotice
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
      visible: win.layout.columns || win.tab === "strip"
      anchors.top: tabs.bottom
      anchors.bottom: composer.top
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.margins: 16
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
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      anchors.margins: 16
      send: (text, followUp) => win.shell.submit(text, followUp)
      stop: () => win.shell.stopJune()
      attachments: win.shell.outbox
      unattach: index => win.shell.unattach(index)
      paste: fallback => win.shell.pasteInto(fallback)
      pick: () => windowPicker.open()
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
    notice: win.shell.taskNotice
    onEdit: (key, change) => win.shell.editTask(key, change)
    tasks: Object.assign({}, win.shell.agendaBoard?.tasks ?? {}, win.shell.agentsBoard?.tasks ?? {})
    user: win.shell.agentsBoard?.user ?? ""
    today: win.shell.agendaBoard?.today ?? ""
    loaded: win.shell.agentsBoard !== null
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
    onEdit: (key, change) => win.shell.editTask(key, change)
    user: win.shell.agentsBoard?.user ?? ""
    agenda: win.shell.agendaBoard
    loaded: win.shell.agendaBoard !== null
    host: win.shell.host
    generatedAt: win.shell.agendaBoard?.generatedAt ?? 0
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
