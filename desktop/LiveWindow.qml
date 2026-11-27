// Live June: the desktop client's minimised form, the bottom of the strip on its own (see "Live June, the minimised
// form" in docs/interfaces.org). Her newest panel, the strip's own at the strip's width, sits at the middle of the focused
// screen's bottom; summoned, the strip's compose bar is under it, where the strip has it, so neither moves when the full
// strip grows up out of them. Above the panel, a shelf holds one small clanker for each session at work. She rises from
// below the screen's edge when she shows and sinks back into it. Only what is drawn takes the mouse; the keyboard only
// while the compose bar is open, where Tab opens the full strip. The shell decides when she shows (see live.mjs).
import QtQuick
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
  // Each working session, as the agents board lists it (board.mjs agentsView working): its harness, title and HOST|TERMINAL key.
  property var shelf: []
  property bool inputShown: false
  // The compose bar's hooks, as the strip's has them.
  property var send: (text, followUp) => true
  property var stop: () => {}
  property var attachments: []
  property var unattach: (index) => {}
  property var paste: (fallback) => fallback()
  property var pick: () => {}
  readonly property bool hovered: hover.hovered
  // The draft, so it moves to the strip's compose bar and back.
  property alias draft: composer.text

  signal openStrip()
  signal visit(string host, string terminal)
  signal dismissed()

  // The strip's measures (shell.qml page): its width, its side margins, and the compose bar's place at the bottom.
  readonly property int margin: 16
  // 22, or above the tab bar where the strip has one (a screen too narrow for the boards beside it).
  property int dock: 22
  readonly property int gap: 8

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
  implicitWidth: Math.min(Theme.stripWidth, (win.screen ? win.screen.width : Theme.stripWidth + 32) - 32)
  implicitHeight: Math.min((win.screen ? win.screen.height : 900) - 40, content.implicitHeight)
  exclusionMode: ExclusionMode.Ignore
  color: "transparent"
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.namespace: "june-live"
  WlrLayershell.keyboardFocus: inputShown ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
  // Only what is drawn takes the mouse; the rest lets clicks through to the desktop.
  mask: Region { item: drawn }

  onInputShownChanged: if (inputShown) composer.focusInput()

  HoverHandler { id: hover }

  Item {
    id: content
    width: parent.width
    height: parent.height
    implicitHeight: shelfRow.height + win.gap + panel.height + (win.inputShown ? win.gap + composer.height : 0) + win.dock
    transform: Translate { y: (1 - win.rise) * (content.implicitHeight + 24) }

    // The span of what is drawn, for the mask.
    Item {
      id: drawn
      x: win.margin
      y: shelfRow.y
      width: parent.width - 2 * win.margin
      height: (win.inputShown ? composer.y + composer.height : panel.y + panel.height) - shelfRow.y
    }

    // Who is working: a clanker each, bobbing gently; hover names its task, a click visits it.
    Row {
      id: shelfRow
      x: win.margin + 10
      anchors.bottom: panel.top
      anchors.bottomMargin: win.gap
      spacing: 12
      height: win.shelf.length > 0 ? 52 : 0
      Repeater {
        model: win.shelf
        delegate: Item {
          id: bot
          required property var modelData
          required property int index
          width: 34
          height: 52
          Clanker {
            id: art
            harness: bot.modelData.harness ?? "other"
            size: 30
            claws: true
            x: 2
            SequentialAnimation on y {
              running: win.visible
              loops: Animation.Infinite
              PauseAnimation { duration: (bot.index * 370) % 900 }
              NumberAnimation { from: 6; to: 0; duration: 1300; easing.type: Easing.InOutSine }
              NumberAnimation { from: 0; to: 6; duration: 1300; easing.type: Easing.InOutSine }
            }
          }
          Rectangle {
            visible: botHover.hovered
            anchors.bottom: art.top
            anchors.left: parent.left
            width: botLabel.implicitWidth + 14
            height: 22
            radius: 6
            color: Theme.cardFill
            border.color: Theme.cardLine
            border.width: 1.5
            Text { id: botLabel; anchors.centerIn: parent; text: bot.modelData.title ?? ""; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12; color: Theme.cardBusy }
          }
          HoverHandler { id: botHover; cursorShape: Qt.PointingHandCursor }
          TapHandler {
            onTapped: {
              const at = String(bot.modelData.key ?? "").split("|");
              if (at.length === 2) win.visit(at[0], at[1]);
            }
          }
        }
      }
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
