// Live June: the desktop client's minimised form, the bottom of the strip on its own (see "Live June, the minimised
// form" in docs/interfaces.org). Her newest panel, the strip's own at the strip's width, sits at the middle of the focused
// screen's bottom; summoned, the strip's compose bar is under it, where the strip has it, so neither moves when the full
// strip grows up out of them. Above the panel, a shelf holds one small clanker for each session at work. She rises from
// below the screen's edge when she shows and sinks back into it. Only what is drawn takes the mouse; the keyboard only
// while the compose bar is open, where Tab opens the full strip. The shell decides when she shows (see live.mjs).
import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Wayland

PanelWindow {
  id: win

  property bool shown: false
  // The strip's newest panel (shell.qml strip.get(0).json), and what Panel draws it with.
  property string panelJson: ""
  property string activity: ""
  property var poses: []
  property real now: Date.now()
  property real hourOverride: -1
  property var scenery: ({ rooms: [], plates: [], props: [] })
  property var sky: null
  property string attached: ""
  property bool inputShown: false
  // The compose bar's hooks, as the strip's has them.
  property var send: (text, followUp) => true
  property var stop: () => {}
  property var attachments: []
  property var unattach: (index) => {}
  property var paste: (fallback) => fallback()
  property var pick: () => {}
  readonly property bool hovered: hover.hovered
  // Height from the screen's bottom edge to the top of June's panel, for ShelfWindow to perch right on it.
  readonly property real panelTopFromBottom: (cell.item ? panel.height : 0) + (inputShown ? gap + composer.height : 0) + dock + gap
  // The draft, so it moves to the strip's compose bar and back.
  property alias draft: composer.text

  signal openStrip()
  signal dismissed()

  // The strip's measures (shell.qml page): its width, its side margins, and the compose bar's place at the bottom.
  readonly property int margin: 16
  // 22, or above the tab bar where the strip has one (a screen too narrow for the boards beside it).
  property int dock: 22
  readonly property int gap: 8
  // Room around what is drawn for the shadow behind her panel and the shelf, as far as the screen allows; the content
  // sits inside it, so the panel and the compose bar stay where the strip has them.
  readonly property int halo: 28
  readonly property real stripSpan: Math.min(Theme.stripWidth, (win.screen ? win.screen.width : Theme.stripWidth + 32) - 32)
  readonly property real side: Math.max(0, Math.min(halo, ((win.screen ? win.screen.width : stripSpan) - stripSpan) / 2))

  // Rising from below the edge, and sinking back before the window goes; INSTANT skips it, when she trades places
  // with the full strip (shell.qml miniBridge).
  property real rise: 0
  property bool instant: false
  Behavior on rise { enabled: !win.instant; NumberAnimation { duration: 190; easing.type: Easing.OutCubic } }
  visible: shown || rise > 0.001
  onShownChanged: {
    rise = shown ? 1 : 0;
    if (shown && inputShown) Qt.callLater(() => composer.focusInput());
  }

  anchors { bottom: true }
  implicitWidth: stripSpan + 2 * side
  implicitHeight: Math.min((win.screen ? win.screen.height : 900) - 40, content.implicitHeight)
  exclusionMode: ExclusionMode.Ignore
  color: "transparent"
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.namespace: "june-live"
  WlrLayershell.keyboardFocus: inputShown && !regrab ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
  // Ask for the keyboard again, as when the full strip, which held it, has just gone: Hyprland does not hand it on to a
  // layer that asked while another held it (Jon, 2026-11-26: the third Tab went nowhere).
  property bool regrab: false
  function refocus() {
    if (!inputShown) return;
    regrab = true;
    Qt.callLater(() => { regrab = false; composer.focusInput(); });
  }
  // Only what is drawn takes the mouse; the rest lets clicks through to the desktop.
  mask: Region { item: drawn }

  onInputShownChanged: if (inputShown) composer.focusInput()

  HoverHandler { id: hover }

  // The span of what is drawn, for the mask, where the content comes to rest. Outside the content: Quickshell's Region
  // recomputes only when its own item moves, so inside the rising content it kept the place it had below the window.
  Item {
    id: drawn
    x: content.x + win.margin
    y: panel.y
    width: content.width - 2 * win.margin
    height: (win.inputShown ? composer.y + composer.height : panel.y + panel.height) - panel.y
  }

  Item {
    id: content
    x: win.side
    width: parent.width - 2 * win.side
    height: parent.height
    implicitHeight: win.halo + panel.height + (win.inputShown ? win.gap + composer.height : 0) + win.dock
    transform: Translate { y: (1 - win.rise) * (content.implicitHeight + 24) }

    // A soft shadow behind her panel. Not in the mask: clicks pass through it.
    RectangularShadow {
      visible: cell.item !== null
      x: panel.x
      y: panel.y
      width: panel.width
      height: panel.height
      radius: 8
      blur: 20
      spread: 0
      color: Qt.rgba(0, 0, 0, 0.42)
    }

    // Her newest panel, the strip's own; a click opens the full strip around it.
    Item {
      id: panel
      x: win.margin
      width: parent.width - 2 * win.margin
      height: cell.item ? cell.item.height : 0
      anchors.bottom: win.inputShown ? composer.top : parent.bottom
      anchors.bottomMargin: win.inputShown ? win.gap : win.dock
      Loader {
        id: cell
        width: parent.width
        active: win.panelJson !== ""
        sourceComponent: Theme.consoleLook ? consoleCell : comicCell
      }
      Component {
        id: comicCell
        Panel {
          json: win.panelJson
          width: panel.width
          newest: true
          activity: win.activity
          poses: win.poses
          now: win.now
          hourOverride: win.hourOverride
          scenery: win.scenery
          sky: win.sky
          attached: win.attached
        }
      }
      Component {
        id: consoleCell
        ConsolePanel {
          json: win.panelJson
          width: panel.width
          newest: true
          activity: win.activity
        }
      }
      TapHandler { onTapped: win.openStrip() }
    }

    // The strip's compose bar, where the strip has it. Tab opens the strip; Esc puts her away.
    Composer {
      id: composer
      visible: win.inputShown
      x: win.margin
      width: parent.width - 2 * win.margin
      anchors.bottom: parent.bottom
      anchors.bottomMargin: win.dock
      send: win.send
      stop: win.stop
      attachments: win.attachments
      unattach: win.unattach
      paste: win.paste
      pick: win.pick
      tabAction: () => win.openStrip()
      escAction: () => win.dismissed()
    }
  }
}
