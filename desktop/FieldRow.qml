// One printed row of a docket or card: a LABEL column, then its value or controls (the item's children), ruled off
// below unless LAST. With `clickable` the whole row is a button with a chevron.
import QtQuick

Item {
  id: row
  property string label: ""
  property bool last: false
  property bool clickable: false
  property bool selected: false
  property real labelWidth: 74
  signal clicked()
  default property alias content: box.data
  width: parent ? parent.width : 0
  implicitHeight: Math.max(36, box.childrenRect.height + 14)

  Rectangle {
    anchors.fill: parent
    visible: row.selected || (row.clickable && hover.containsMouse)
    color: row.selected ? Qt.alpha(Theme.accent, 0.14) : Qt.alpha(Theme.surfaceInk, 0.05)
  }
  Rectangle {
    visible: row.selected
    x: 2; y: 4; width: 3; height: parent.height - 8; radius: 1.5
    color: Theme.accent
  }
  Words {
    x: 10
    width: row.labelWidth
    anchors.verticalCenter: parent.verticalCenter
    role: "label"
    text: Theme.consoleLook ? row.label.toLowerCase() : row.label.toUpperCase()
    color: Theme.surfaceMuted
  }
  Item {
    id: box
    x: 10 + row.labelWidth
    width: row.width - x - (row.clickable ? 24 : 10)
    height: childrenRect.height
    anchors.verticalCenter: parent.verticalCenter
  }
  Words {
    visible: row.clickable
    anchors.right: parent.right
    anchors.rightMargin: 10
    anchors.verticalCenter: parent.verticalCenter
    role: "row"
    text: "›"
    color: Theme.surfaceMuted
  }
  Rectangle {
    visible: !row.last
    anchors.bottom: parent.bottom
    x: 10
    width: row.width - 20
    height: 1
    color: Theme.rule
  }
  MouseArea {
    id: hover
    anchors.fill: parent
    enabled: row.clickable
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: row.clicked()
  }
}
