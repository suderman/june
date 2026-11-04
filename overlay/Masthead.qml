// The strip's masthead: June's name, the connection or what she is doing, and a "meanwhile" card while briefs run.
import QtQuick

Row {
  id: masthead

  property bool linked: false
  property int refusals: 0
  property string host: ""
  property bool busy: false
  property string activity: ""
  property int background: 0

  height: 30
  spacing: 12
  Text { text: "june"; font.family: Theme.display; font.pixelSize: 22; color: Theme.ink; anchors.verticalCenter: parent.verticalCenter }
  Text {
    anchors.verticalCenter: parent.verticalCenter
    text: !masthead.linked ? (masthead.refusals >= 2 ? "pairing needed: check this device's token" : "reconnecting to " + masthead.host + "…") : masthead.busy ? masthead.activity : "on " + masthead.host
    font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13
    color: masthead.linked ? Theme.muted : Theme.accent
  }
  // Background briefs: a small inked "meanwhile" card, the comic's cutaway to work going on elsewhere.
  Rectangle {
    visible: masthead.linked && masthead.background > 0
    anchors.verticalCenter: parent.verticalCenter
    width: meanwhile.implicitWidth + 20
    height: 26
    radius: 6
    color: Theme.cardFill
    border.color: Theme.cardLine
    border.width: 1.5
    Text {
      id: meanwhile
      anchors.centerIn: parent
      text: "meanwhile, on " + masthead.host + " · " + (masthead.background === 1 ? "1 brief" : masthead.background + " briefs")
      font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12
      color: Theme.cardBusy
    }
  }
}
