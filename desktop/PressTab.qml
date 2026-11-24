// A button as a pressed tab: a chunky ink edge, a small radius and a hard shadow that collapses when pressed, so it
// sinks into the page. Neon makes it a glowing key, the console a bracketed command (the primary inverted). KIND is
// primary (one per view), secondary, danger, or quiet (a link). Matches the phone's PressTab.
import QtQuick

Item {
  id: tab
  property string text: ""
  property string kind: "secondary"
  property bool small: false
  signal clicked()

  readonly property real depth: small ? 2 : 3
  readonly property bool down: mouse.pressed
  readonly property real lift: down || !enabled || kind === "quiet" || Theme.consoleLook ? 0 : depth
  readonly property color danger: Theme.consoleLook ? Theme.consoleFail : Theme.tone("TODO")
  readonly property color edgeColour: kind === "danger" ? danger : kind === "primary" ? (Theme.neon ? Theme.accent : Theme.consoleLook ? Theme.edge : Theme.surface) : Theme.edge
  readonly property color fillColour: kind === "primary" ? (Theme.neon ? Theme.accent : Theme.consoleLook ? Theme.pageInk : Theme.edge) : Theme.surface
  readonly property color inkColour: kind === "primary" ? (Theme.neon || Theme.consoleLook ? Theme.paper : Theme.surface)
    : kind === "danger" ? danger : Theme.consoleLook || kind === "quiet" ? Theme.pageInk : Theme.surfaceInk

  implicitWidth: label.implicitWidth + (Theme.consoleLook ? 8 : small ? 22 : 30) + depth
  implicitHeight: (small ? 26 : 32) + depth
  opacity: enabled ? 1 : 0.45

  Item {
    id: key
    x: tab.down && !Theme.consoleLook ? tab.depth : 0
    y: x
    width: tab.width - tab.depth
    height: tab.height - tab.depth
    Inked {
      visible: tab.kind !== "quiet"
      anchors.fill: parent
      edge: tab.edgeColour
      fill: tab.fillColour
      filled: !(Theme.consoleLook && tab.kind !== "primary")
      lift: tab.lift
      lineWidth: tab.small ? 1.75 : 2
    }
    // The desktop's hover: a faint wash, and the console's pressed row.
    Rectangle {
      anchors.fill: parent
      anchors.margins: Theme.consoleLook ? 0 : 2
      radius: Theme.consoleLook ? 0 : 4
      visible: mouse.containsMouse && tab.enabled
      color: tab.kind === "primary" ? Qt.alpha(Theme.paper, 0.12) : Qt.alpha(Theme.consoleLook ? Theme.pageInk : Theme.surfaceInk, tab.down ? 0.14 : 0.07)
    }
    Words {
      id: label
      anchors.centerIn: parent
      role: "button"
      text: Theme.consoleLook ? "[ " + tab.text + " ]" : tab.text
      color: tab.inkColour
      font.underline: tab.kind === "quiet" && mouse.containsMouse && !Theme.consoleLook
    }
  }
  MouseArea {
    id: mouse
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: tab.clicked()
  }
}
