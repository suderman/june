// The strip in an ordinary window, for the launcher: the same conversation and panels as the overlay, with a row of
// toggles for this device's state (nothing written to config). Narrowed below 480 px it shows the strip's stacked
// layout, the phone's. Ctrl+N and Ctrl+P page, Ctrl+W closes. See "The windowed strip" in docs/interfaces.org.
import QtQuick
import QtQuick.Controls
import Quickshell
import "desktop.mjs" as Desktop

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
    if (visible) { strip.landOnNewest(); composer.focusInput(); }
    else shell.windowShown = false;
  }
  onClosed: shell.windowShown = false

  Shortcut { sequence: "Ctrl+N"; onActivated: strip.page(1) }
  Shortcut { sequence: "Ctrl+P"; onActivated: strip.page(-1) }
  Shortcut { sequence: "Ctrl+W"; onActivated: win.shell.windowShown = false }

  // The column the strip lives in: the window's width, up to the overlay's, centred on a wide window.
  Item {
    id: column
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    anchors.horizontalCenter: parent.horizontalCenter
    width: Math.min(parent.width, Theme.stripWidth)

    Masthead {
      id: masthead
      anchors.top: parent.top
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.margins: 16
      linked: win.shell.linked
      refusals: win.shell.refusals
      host: win.shell.host
      busy: Boolean(win.shell.view.state.running || win.shell.view.state.compacting)
      activity: win.shell.activity
      background: win.shell.view.state.background ?? 0
      quiet: win.shell.quiet
    }

    // This device's toggles: state for now, gone when the overlay restarts.
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

    StripList {
      id: strip
      anchors.top: toggles.bottom
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
    }
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
