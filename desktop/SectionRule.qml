// A section's rule: its title in small caps and a thin line running on to the right edge, with what TRAILS it (the
// item's children) at the end; the console draws "── TITLE ──". With `clickable` the title gets a chevron.
import QtQuick

Item {
  id: rule
  property string text: ""
  property bool alert: false
  property bool clickable: false
  signal clicked()
  default property alias trailing: trail.data
  width: parent ? parent.width : 0
  implicitHeight: Math.max(26, trail.implicitHeight)

  Words {
    id: title
    anchors.left: parent.left
    anchors.verticalCenter: parent.verticalCenter
    role: "section"
    text: (Theme.consoleLook ? "── " : "") + rule.text + (rule.clickable ? "  ›" : "")
    color: rule.alert ? Theme.accent : Theme.neon ? Theme.muted : Qt.alpha(Theme.pageInk, 0.8)
    font.underline: rule.clickable && hover.containsMouse
  }
  Rectangle {
    anchors.left: title.right
    anchors.leftMargin: 8
    anchors.right: trail.left
    anchors.rightMargin: trail.implicitWidth > 0 ? 8 : 0
    anchors.verticalCenter: parent.verticalCenter
    height: Theme.consoleLook ? 1 : 1.5
    color: rule.alert ? Qt.alpha(Theme.accent, 0.6) : Theme.consoleLook ? Theme.edge : Theme.rule
  }
  Row {
    id: trail
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    spacing: 6
  }
  MouseArea {
    id: hover
    anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom
    width: title.width
    enabled: rule.clickable
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: rule.clicked()
  }
}
