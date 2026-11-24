// A printed panel's stock, edge and shadow, drawn behind its content: on paper, FILL with an ink edge over a hard,
// unblurred shadow LIFT down and right; in neon, a dark panel with a thin stroke in EDGE (its meaning colour) and a
// soft glow LIFT out; in the console, a square one-pixel frame. Matches the phone's Modifier.inked.
import QtQuick

Item {
  id: inked
  property real radius: 6
  property color edge: Theme.edge
  property color fill: Theme.surface
  property bool filled: true
  property real lift: 3
  property real lineWidth: 2
  // Corners each panel may square off, as a folder tab's bottom does.
  property bool squareBottom: false
  readonly property real r: Theme.consoleLook ? 0 : radius

  Rectangle {
    visible: !Theme.consoleLook && !Theme.neon && inked.lift > 0
    x: inked.lift; y: inked.lift
    width: parent.width; height: parent.height
    radius: inked.r
    color: Theme.shadow
  }
  // Neon's glow: three widening, fading rings, offset a little as the shadow would be.
  Repeater {
    model: Theme.neon && inked.lift > 0 ? [[3.4, 0.07], [2, 0.13], [1, 0.24]] : []
    delegate: Rectangle {
      required property var modelData
      readonly property real w: inked.lift * modelData[0]
      readonly property real shift: inked.lift * 0.6
      x: shift - w / 2; y: shift - w / 2
      width: inked.width + w; height: inked.height + w
      radius: inked.r + w / 2
      color: "transparent"
      border.color: inked.edge
      border.width: w
      opacity: modelData[1]
    }
  }
  Rectangle {
    anchors.fill: parent
    topLeftRadius: inked.r; topRightRadius: inked.r
    bottomLeftRadius: inked.squareBottom ? 0 : inked.r; bottomRightRadius: inked.squareBottom ? 0 : inked.r
    color: inked.filled ? inked.fill : "transparent"
    border.color: inked.edge
    border.width: Theme.consoleLook ? 1 : Theme.neon ? inked.lineWidth * 0.7 : inked.lineWidth
  }
}
