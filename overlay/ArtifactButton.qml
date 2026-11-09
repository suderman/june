import QtQuick

Rectangle {
  id: button
  property string label: ""
  signal clicked()
  width: Math.max(48, words.implicitWidth + 24)
  height: 40
  radius: 6
  color: area.containsMouse || activeFocus ? "#ffe27a" : "#ffffff"
  border.color: "#1b1a1f"
  border.width: activeFocus ? 3 : 1
  activeFocusOnTab: true
  Accessible.role: Accessible.Button
  Accessible.name: label
  Accessible.onPressAction: clicked()
  Keys.onReturnPressed: clicked()
  Keys.onSpacePressed: clicked()
  Text {
    id: words
    anchors.centerIn: parent
    text: button.label
    font.family: Theme.caption; font.pixelSize: 14; font.bold: true
    color: "#1b1a1f"
  }
  MouseArea {
    id: area
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: button.clicked()
  }
}
