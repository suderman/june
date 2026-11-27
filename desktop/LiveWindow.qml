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
  // Each working session, as the agents board lists it (board.mjs agentsView working): its clanker's name, harness, title
  // and HOST|TERMINAL key.
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
  // recomputes only when its own item moves, so inside the rising content it kept the place it had below the window
  // and the shelf took neither hover nor clicks (Jon, 2026-11-27).
  Item {
    id: drawn
    x: content.x + win.margin
    y: shelfRow.y
    width: content.width - 2 * win.margin
    height: (win.inputShown ? composer.y + composer.height : panel.y + panel.height) - shelfRow.y
  }

  Item {
    id: content
    x: win.side
    width: parent.width - 2 * win.side
    height: parent.height
    implicitHeight: win.halo + shelfRow.height + win.gap + panel.height + (win.inputShown ? win.gap + composer.height : 0) + win.dock
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

    // Who is working: a clanker each, bobbing gently over its name (the clanker's, else the harness's); hover adds its task
    // beside it, inside the window, and a click visits it.
    Row {
      id: shelfRow
      x: win.margin + 10
      anchors.bottom: panel.top
      anchors.bottomMargin: win.gap
      spacing: 12
      height: win.shelf.length > 0 ? 54 : 0
      Repeater {
        model: win.shelf
        delegate: Item {
          id: bot
          required property var modelData
          required property int index
          z: botHover.hovered ? 1 : 0
          width: Math.max(34, tag.width)
          height: 54
          // Soft local shadow behind just this clanker and its name pill, instead of a dark band across the panel width.
          RectangularShadow {
            anchors.fill: parent
            anchors.topMargin: 2
            radius: 16
            blur: 16
            spread: 0
            color: Qt.rgba(0, 0, 0, 0.24)
          }
          Clanker {
            id: art
            harness: bot.modelData.harness ?? "other"
            size: 30
            claws: true
            anchors.horizontalCenter: parent.horizontalCenter
            SequentialAnimation on y {
              running: win.visible
              loops: Animation.Infinite
              PauseAnimation { duration: (bot.index * 370) % 900 }
              NumberAnimation { from: 6; to: 0; duration: 1300; easing.type: Easing.InOutSine }
              NumberAnimation { from: 0; to: 6; duration: 1300; easing.type: Easing.InOutSine }
            }
          }
          Rectangle {
            id: tag
            anchors.bottom: parent.bottom
            anchors.horizontalCenter: parent.horizontalCenter
            width: tagText.implicitWidth + 12
            height: 16
            radius: 8
            color: Theme.cardFill
            border.color: Theme.cardLine
            border.width: 1
            Text {
              id: tagText
              anchors.centerIn: parent
              text: bot.modelData.name || bot.modelData.agent || bot.modelData.harness || ""
              font.family: Theme.caption
              font.weight: Font.Bold
              font.pixelSize: 11
              color: Theme.cardBusy
            }
          }
          Rectangle {
            visible: botHover.hovered
            anchors.left: parent.right
            anchors.leftMargin: 6
            anchors.verticalCenter: art.verticalCenter
            width: Math.min(botLabel.implicitWidth + 14, win.width - 2 * win.margin - bot.x - bot.width - 16)
            height: 22
            radius: 6
            color: Theme.cardFill
            border.color: Theme.cardLine
            border.width: 1.5
            Text { id: botLabel; anchors.centerIn: parent; width: parent.width - 14; elide: Text.ElideRight; text: bot.modelData.title ?? ""; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12; color: Theme.cardBusy }
          }
          HoverHandler { id: botHover; cursorShape: Qt.PointingHandCursor }
          TapHandler {
            onTapped: {
              const at = String(bot.modelData.key ?? "").split("|");
              console.info("shelf: visit", bot.modelData.key ?? "");
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
