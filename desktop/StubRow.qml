// A docket stub: one ruled line of a pad with its LEAD (a time or day) in a column, a clanker for HARNESS, its title,
// a quoted last word, its meta, and a state STAMP at the end. Rows without a lead or stamp take no space for one.
// Clicking says clicked() when the row opens somewhere.
import QtQuick

Item {
  id: stub
  property string title: ""
  property string meta: ""
  property string lead: ""
  property real leadWidth: 0
  property string harness: ""
  property real artSize: 28
  property string stamp: ""
  property string quote: ""
  property bool overdue: false
  property bool first: false
  property bool opens: true
  signal clicked()
  width: parent ? parent.width : 0
  implicitHeight: Math.max(40, lines.implicitHeight + 16)

  Rectangle { visible: !stub.first; x: 10; width: stub.width - 20; height: 1; color: Theme.rule }
  Rectangle { anchors.fill: parent; anchors.margins: 2; radius: 3; visible: stub.opens && hover.containsMouse; color: Qt.alpha(Theme.surfaceInk, 0.05) }
  Words {
    id: leadText
    visible: stub.leadWidth > 0
    x: 10
    width: stub.leadWidth
    anchors.verticalCenter: parent.verticalCenter
    role: "number"
    text: stub.lead
    color: stub.overdue ? Theme.accent : Theme.surfaceMuted
  }
  Clanker {
    id: art
    visible: stub.harness !== ""
    x: stub.leadWidth > 0 ? 10 + stub.leadWidth + 8 : 10
    anchors.verticalCenter: parent.verticalCenter
    size: stub.artSize
    claws: stub.artSize >= 30
    harness: stub.harness !== "" ? stub.harness : "other"
  }
  Column {
    id: lines
    x: stub.harness !== "" ? art.x + art.width + 8 : stub.leadWidth > 0 ? 10 + stub.leadWidth + 8 : 10
    width: stub.width - x - (stamped.visible ? stamped.width + 18 : 10)
    anchors.verticalCenter: parent.verticalCenter
    spacing: 1
    Words { width: parent.width; role: "row"; wrapMode: Text.Wrap; maximumLineCount: 3; elide: Text.ElideRight; text: stub.title }
    Words { visible: stub.quote !== ""; width: parent.width; role: "lettering"; font.pixelSize: 12; wrapMode: Text.Wrap; maximumLineCount: 3; elide: Text.ElideRight; text: "“" + stub.quote + "”"; color: Theme.surfaceMuted }
    Words { visible: stub.meta !== ""; width: parent.width; role: "meta"; elide: Text.ElideRight; text: stub.meta; color: stub.overdue ? Theme.accent : Theme.surfaceMuted }
  }
  Stamp {
    id: stamped
    visible: stub.stamp !== ""
    anchors.right: parent.right
    anchors.rightMargin: 10
    anchors.verticalCenter: parent.verticalCenter
    text: stub.stamp
    tone: Theme.tone(stub.stamp)
  }
  MouseArea { id: hover; anchors.fill: parent; enabled: stub.opens; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: stub.clicked() }
}
