// An Org state as a small chip in its own colours (board.mjs CHIPS), or an empty space of the same width when there
// is none, so rows line up. `count` adds a number, for the counts by state.
import QtQuick
import "board.mjs" as Board

Rectangle {
  id: chip

  property string orgState: ""
  property int count: -1
  property bool big: false
  signal clicked()

  readonly property var colours: Board.CHIPS[orgState] ?? null

  implicitWidth: count >= 0 ? label.implicitWidth + 16 : (big ? 52 : 40)
  implicitHeight: big ? 26 : 20
  radius: 6
  color: colours ? colours.fill : "transparent"
  border.color: colours ? colours.ink : "transparent"
  border.width: 1.5

  Text {
    id: label
    anchors.centerIn: parent
    visible: chip.colours !== null
    text: chip.count >= 0 ? chip.orgState + " " + chip.count : chip.orgState
    color: chip.colours ? chip.colours.ink : "transparent"
    font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: chip.big ? 12 : 11
  }
  MouseArea {
    anchors.fill: parent
    enabled: chip.count >= 0
    cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
    onClicked: chip.clicked()
  }
}
