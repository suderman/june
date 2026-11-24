// A docket's or card's header band: a small-caps LABEL on screentone and a NUMBER ("№ 4F2A") at the right, then what
// TRAILS it (the item's children), over a rule. The console opens its frame: "┌─ label".
import QtQuick

Item {
  id: band
  property string label: ""
  property string number: ""
  default property alias trailing: trail.data
  width: parent ? parent.width : 0
  height: 32

  Item {
    anchors.fill: parent
    anchors.margins: Theme.consoleLook ? 0 : 2
    clip: true
    Screentone { anchors.fill: parent; density: 0.13 }
  }
  Words {
    anchors.left: parent.left
    anchors.leftMargin: 10
    anchors.right: num.left
    anchors.rightMargin: 6
    anchors.verticalCenter: parent.verticalCenter
    role: "label"
    elide: Text.ElideRight
    text: Theme.consoleLook ? "┌─ " + band.label.toLowerCase() : band.label.toUpperCase()
    color: Qt.alpha(Theme.surfaceInk, 0.85)
  }
  Words {
    id: num
    anchors.right: trail.left
    anchors.rightMargin: band.number !== "" ? 6 : 0
    anchors.verticalCenter: parent.verticalCenter
    role: "number"
    text: band.number === "" ? "" : (Theme.consoleLook ? band.number : "№ " + band.number)
    color: Theme.surfaceMuted
  }
  Row {
    id: trail
    anchors.right: parent.right
    anchors.rightMargin: 4
    anchors.verticalCenter: parent.verticalCenter
    spacing: 2
  }
  Rectangle {
    anchors.bottom: parent.bottom
    width: parent.width
    height: Theme.neon || Theme.consoleLook ? 1 : 1.5
    color: Theme.neon ? Qt.alpha(Theme.edge, 0.6) : Theme.edge
  }
}
