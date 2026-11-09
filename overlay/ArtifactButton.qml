import QtQuick

Rectangle {
  id: button
  property string label: ""
  property string icon: "preview"
  property bool showLabel: false
  property color ink: "#e4e8f2"
  signal clicked()
  width: 48; height: 48
  radius: 7
  color: area.pressed ? "#514460" : area.containsMouse || activeFocus ? "#3c354b" : "transparent"
  border.color: "#cfb9f0"
  border.width: activeFocus ? 2 : 0
  activeFocusOnTab: visible
  Accessible.role: Accessible.Button
  Accessible.name: label
  Accessible.onPressAction: clicked()
  Keys.onReturnPressed: clicked()
  Keys.onSpacePressed: clicked()
  ArtifactIcon {
    x: button.showLabel ? 12 : (parent.width - width) / 2
    anchors.verticalCenter: parent.verticalCenter
    name: button.icon; ink: button.ink
  }
  Text {
    visible: button.showLabel
    x: 42; anchors.verticalCenter: parent.verticalCenter
    width: parent.width - 54
    elide: Text.ElideRight
    text: button.label; textFormat: Text.PlainText
    font.family: Theme.caption; font.pixelSize: 14; font.weight: Font.Medium
    color: button.ink
  }
  MouseArea {
    id: area
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: button.clicked()
  }
}
